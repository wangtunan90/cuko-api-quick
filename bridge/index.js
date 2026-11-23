/**
 * cuko-api-quick —— 把 Amazon Quick（quick.aws.com）网页版聊天，暴露成 Cuko API
 *
 * 架构：
 *   客户端 --(HTTP/SSE)--> bridge/index.js --(CDP)--> 独立 Chrome --user-data-dir--> quick.aws.com
 *
 * 端点：
 *   GET  /v1/models                      模型（账号）列表
 *   POST /v1/responses                   发送消息（SSE 流式）
 *   GET  /api/accounts                   账号列表
 *   POST /api/accounts                   新增账号（自动启动 Chrome）
 *   PUT  /api/accounts/:id               改名 / 绑配置方案
 *   DELETE /api/accounts/:id             删除账号（含独立数据目录）
 *   POST /api/accounts/:id/open          打开 Chrome
 *   GET  /api/accounts/:id/health        账号健康检查
 *   GET  /api/profiles                   配置方案
 *   POST /api/profiles                   新建方案
 *   PUT  /api/profiles/:id               修改方案
 *   DELETE /api/profiles/:id             删除方案
 *
 * 协议见 docs/cuko-api-v1.md，Quick 侧细节见 docs/quick-protocol.md。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getAccounts, saveAccounts, getProfiles, saveProfiles, resolveProfile,
  ensureDataDirs, initLogFile, teeConsoleToFile, PROFILES_DIR, getAccountHealth, saveAccountHealth } from './store.js';
import { DEFAULT_PROFILE_VALUES, FIELD_LABELS, validateProfile } from './default-config.js';
import { readUiIndexHtml } from './app-paths.js';
import { launchChrome, probePort, resolveChromePath, ensureConnection } from './chrome.js';
import { getConnection, closeConnection, closeAllConnections } from './cdp-connection.js';
import { handleChat } from './chat.js';
import { handleCompress } from './compress.js';
import { checkAccountHealth } from './health.js';
import { normalizeInputItems } from './input.js';
// [261123-attach] 超长文本转附件：客户端发来的工具调用结果动辄几万字符，
// 直接塞进输入框既慢又容易被页面截断，改成落文件走 Quick 的附件通道。详见 docs/quick-protocol.md
import { splitOversizedTexts, materializeFileItems, TEXT_TO_FILE_THRESHOLD } from './attachments.js';
// [261123-port-config] 运行时配置（端口/监听地址）：配置文件 + 环境变量。
// 双击 exe 的用户没法设环境变量，所以支持改 data/config.json 后重启生效。
import { resolveRuntimeConfig, ensureRuntimeConfigFile, portInUseHint, RUNTIME_CONFIG_FILE } from './runtime-config.js';
// [261123-open-admin] 启动后自动打开管理后台
import { openInBrowser } from './open-browser.js';
// [261123-version] 版本号：exe 里不能运行时读 package.json，改由构建时注入
import { getVersion } from './version.js';

const BASE_DEBUG_PORT = 9222;

ensureDataDirs();
const runtimeCfg = resolveRuntimeConfig();
const HTTP_PORT = runtimeCfg.port;
const HTTP_HOST = runtimeCfg.host;
if (ensureRuntimeConfigFile()) console.log('[config] 已生成默认配置文件:', RUNTIME_CONFIG_FILE);
const LOG_FILE = initLogFile();
teeConsoleToFile();
console.log('[bridge] 日志落盘:', LOG_FILE);

/** 每个模型同一时间只允许一轮对话 */
const activeModels = new Set();

/** 统一的 JSON 响应 */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 读取请求体 */
async function readBody(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  return body;
}

/** 分配调试端口（当前最大值 +1） */
function allocDebugPort(accounts) {
  let maxPort = BASE_DEBUG_PORT;
  for (const a of accounts) if (a.debugPort && a.debugPort > maxPort) maxPort = a.debugPort;
  return maxPort + 1;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  // 管理台
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = readUiIndexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('管理页读取失败: ' + e.message);
    }
    return;
  }

  // [261123-port-config] 让管理台能显示「当前实际监听地址」，
  // 用户改完端口不知道填什么时可对照。
  if (req.method === 'GET' && pathname === '/api/info') {
    sendJson(res, 200, {
      port: HTTP_PORT,
      host: HTTP_HOST,
      baseUrl: 'http://127.0.0.1:' + HTTP_PORT,
      portSource: runtimeCfg.portSource,
      configFile: RUNTIME_CONFIG_FILE,
      version: getVersion(),
      // [261123-chrome-ui] 把 Chrome 探测结果暴露给管理台。
      // 探测不到时管理台要引导用户手动填写路径，而不是等添加账号失败才报错。
      chrome: (() => {
        const p = resolveChromePath(DEFAULT_PROFILE_VALUES);
        return { found: !!p, path: p || null };
      })(),
    });
    return;
  }

  // ============ Cuko API ============
  if (req.method === 'GET' && pathname === '/v1/models') {
    const accounts = getAccounts();
    sendJson(res, 200, {
      data: accounts.map(a => ({ id: a.modelId, name: a.modelName || a.modelId })),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/responses') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { sendJson(res, 400, { code: 'invalid_request', message: 'Bad JSON' }); return; }

    const account = getAccounts().find(a => a.modelId === payload.model);
    if (!account) {
      sendJson(res, 404, { code: 'invalid_request', message: 'Model not found: ' + payload.model });
      return;
    }

    // 健康闸门：已知限额/封号/未登录时直接拒绝，避免白等
    const health = getAccountHealth()[account.modelId];
    if (health && health.state && health.state !== 'ok') {
      const now = Date.now();
      if (health.state === 'login_required' && health.checkedAt && (now - health.checkedAt) < 30 * 60 * 1000) {
        sendJson(res, 401, { code: 'authentication_required', message: '账号未登录或登录失效，请重新登录 quick.aws.com 后再试' });
        return;
      }
      if (health.state === 'quota_exceeded' && health.resetAt && health.resetAt > now) {
        sendJson(res, 429, { code: 'rate_limit_exceeded', message: '账号额度已用完，预计 ' + new Date(health.resetAt).toLocaleString('sv-SE') + ' 恢复' });
        return;
      }
    }

    if (activeModels.has(payload.model)) {
      sendJson(res, 429, { code: 'rate_limit_exceeded', message: '同一模型只能同时进行一轮对话' });
      return;
    }

    // 归一化输入
    const norm = normalizeInputItems(payload.input);
    if (norm.unknown.length) console.warn('[input] 未识别的输入项:', norm.unknown.join(', '));

    // [261123-attach] 超过阈值的单个文本项转成附件，正文只留摘要
    const split = splitOversizedTexts(norm.items, TEXT_TO_FILE_THRESHOLD);
    const parts = [...split.inlineTexts, ...split.summaryNotes];
    const text = parts.join('\n\n');

    if (split.files.length) {
      console.log('[input] ' + split.files.length + ' 个超长文本已转为附件');
    }

    // [261123-attach] Cuko 的 file 项（base64）落盘后走同一条附件通道
    const fileItems = norm.items.filter(i => i.kind === 'file');
    const materialized = materializeFileItems(fileItems);
    if (materialized.errors.length) {
      console.warn('[input] 部分文件项处理失败:', materialized.errors.join('; '));
    }
    if (materialized.files.length) {
      console.log('[input] ' + materialized.files.length + ' 个文件项已落盘，将作为附件发送');
    }

    // 只有文件、没有文本时，给模型一句简短说明，避免「空消息」
    let finalText = text;
    if (!finalText && materialized.files.length) {
      finalText = '【附件】共 ' + materialized.files.length + ' 个文件：' +
        materialized.files.map(f => f.fileName).join('、') + '，请查看附件内容。';
    }

    const allFiles = [...split.files, ...materialized.files];
    if (!finalText && !allFiles.length) {
      sendJson(res, 400, { code: 'invalid_request', message: '输入为空：没有可识别的文本/文件项' });
      return;
    }

    payload._text = finalText;
    payload._attachFiles = allFiles.map(f => f.filePath);
    payload._attachMeta = allFiles;

    activeModels.add(payload.model);
    const release = () => activeModels.delete(payload.model);

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    const profile = resolveProfile(account);
    try {
      // [261123-autolaunch] Chrome 被关掉时自动拉起，而不是把 ECONNREFUSED 甩给客户端。
      const conn = await ensureConnection(account, profile.values, getConnection, 'quick.aws.com');
      if (payload.type === 'compress') {
        await handleCompress({ res, payload, account, conn, cfg: profile.values, profile, release });
      } else {
        await handleChat({ res, payload, account, conn, cfg: profile.values, profile, release });
      }
    } catch (e) {
      console.error('[bridge] 处理请求失败:', e.message);
      release();
      if (!res.writableEnded) {
        try {
          res.write('event: error\n');
          res.write('data: ' + JSON.stringify({ code: 'internal_error', message: e.message }) + '\n\n');
          res.end();
        } catch (_) {}
      }
    }
    return;
  }

  // ============ 管理 API：账号 ============
  if (req.method === 'GET' && pathname === '/api/accounts') {
    const accounts = getAccounts();
    const healthMap = getAccountHealth();
    for (const acc of accounts) {
      acc.status = (await probePort(acc.debugPort)) ? 'online' : 'offline';
      const eff = resolveProfile(acc);
      acc.profileId = acc.profileId || 'default';
      acc.profileName = eff.name;
      acc.health = healthMap[acc.modelId] || null;
    }
    sendJson(res, 200, accounts);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/accounts') {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    if (!data.modelId || !data.modelName) { sendJson(res, 400, { error: '缺少 modelId / modelName' }); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(data.modelId)) { sendJson(res, 400, { error: 'modelId 仅支持英文、数字、下划线、中划线' }); return; }

    const accounts = getAccounts();
    if (accounts.find(a => a.modelId === data.modelId)) { sendJson(res, 409, { error: '该 ID 已存在' }); return; }

    let profileId = 'default';
    if (data.profileId && data.profileId !== 'default') {
      if (!getProfiles().find(p => p.id === data.profileId)) { sendJson(res, 400, { error: '指定的配置方案不存在' }); return; }
      profileId = data.profileId;
    }

    const account = { modelId: data.modelId, modelName: data.modelName, debugPort: allocDebugPort(accounts), profileId, createdAt: Date.now() };
    accounts.push(account);
    saveAccounts(accounts);
    launchChrome(account, resolveProfile(account).values);
    sendJson(res, 200, { success: true, account });
    return;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/accounts/')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    const accounts = getAccounts();
    const acc = accounts.find(a => a.modelId === modelId);
    if (!acc) { sendJson(res, 404, { error: 'Not found' }); return; }
    if (data.modelName) acc.modelName = data.modelName;
    if (data.profileId !== undefined) {
      if (!data.profileId || data.profileId === 'default') acc.profileId = 'default';
      else if (!getProfiles().find(p => p.id === data.profileId)) { sendJson(res, 400, { error: '指定的配置方案不存在' }); return; }
      else acc.profileId = data.profileId;
    }
    saveAccounts(accounts);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/accounts/')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    let accounts = getAccounts();
    if (!accounts.find(a => a.modelId === modelId)) { sendJson(res, 404, { error: 'Not found' }); return; }
    accounts = accounts.filter(a => a.modelId !== modelId);
    saveAccounts(accounts);
    try { await closeConnection(modelId); } catch (_) {}
    try {
      const dir = path.join(PROFILES_DIR, modelId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch (e) { console.error('[accounts] 删除数据目录失败:', e.message); }
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/open')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    const account = getAccounts().find(a => a.modelId === modelId);
    if (!account) { sendJson(res, 404, { error: 'Not found' }); return; }
    launchChrome(account, resolveProfile(account).values);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/health')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    const account = getAccounts().find(a => a.modelId === modelId);
    if (!account) { sendJson(res, 404, { error: 'Not found' }); return; }
    try {
      const cfg = resolveProfile(account).values;
      const r = await checkAccountHealth(account, cfg);
      const record = { modelId, ...r, checkedAt: Date.now() };
      const map = getAccountHealth();
      map[modelId] = record;
      saveAccountHealth(map);
      sendJson(res, 200, record);
    } catch (e) {
      sendJson(res, 500, { modelId, state: 'error', message: e.message, checkedAt: Date.now() });
    }
    return;
  }

  // [261123-chrome-ui] 探测系统里的 Chrome 并返回候选路径，供管理台引导用户。
  if (req.method === 'GET' && pathname === '/api/chrome/detect') {
    const found = resolveChromePath(DEFAULT_PROFILE_VALUES);
    let candidates = [];
    try {
      // 让用户看到「试过哪些位置」，找不着时也能照着填
      const { chromeCandidatesForUi } = await import('./chrome.js');
      candidates = chromeCandidatesForUi();
    } catch (_) {}
    sendJson(res, 200, {
      found: !!found,
      path: found || null,
      candidates: candidates.map((p) => ({ path: p, exists: fs.existsSync(p) })),
    });
    return;
  }

  // [261123-chrome-ui] 保存用户手填的 Chrome 路径。
  // 不绑到某个配置方案，而是直接写进 data/config.json 的 chromePath 覆盖项，
  // 这样「默认方案」也能生效（默认方案本身是只读的，不能改它的 values）。
  if (req.method === 'POST' && pathname === '/api/chrome/path') {
    let data;
    try {
      const body = await readBody(req);
      data = JSON.parse(body || '{}');
    } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }

    const p = String(data.path || '').trim();
    if (!p) { sendJson(res, 400, { error: '请填写完整路径' }); return; }
    if (!fs.existsSync(p)) { sendJson(res, 400, { error: '文件不存在：' + p }); return; }
    if (!/\.exe$/i.test(p)) { sendJson(res, 400, { error: '请填到 .exe 可执行文件（不是文件夹）' }); return; }

    try {
      const cur = JSON.parse(fs.existsSync(RUNTIME_CONFIG_FILE) ? fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8') : '{}');
      cur.chromePath = p;
      fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8');
      console.log('[Chrome] 用户指定路径已保存:', p);
      sendJson(res, 200, { ok: true, path: p });
    } catch (e) {
      sendJson(res, 500, { error: '保存失败: ' + e.message });
    }
    return;
  }

  // ============ 管理 API：配置方案 ============
  if (req.method === 'GET' && pathname === '/api/profiles') {
    sendJson(res, 200, {
      default: { id: 'default', name: '默认方案', isDefault: true, values: DEFAULT_PROFILE_VALUES },
      profiles: getProfiles(),
      labels: FIELD_LABELS,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profiles') {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    const name = String(data.name || '').trim();
    if (!name) { sendJson(res, 400, { error: '缺少方案名称' }); return; }
    let values;
    try { values = data.values ? validateProfile(data.values) : validateProfile({ ...DEFAULT_PROFILE_VALUES }); }
    catch (e) { sendJson(res, 400, { error: e.message }); return; }
    const profiles = getProfiles();
    const created = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, values, createdAt: Date.now() };
    profiles.push(created);
    saveProfiles(profiles);
    sendJson(res, 200, created);
    return;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/profiles/')) {
    const id = decodeURIComponent(pathname.split('/')[3] || '');
    if (id === 'default') { sendJson(res, 403, { error: '默认方案不可修改' }); return; }
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    const profiles = getProfiles();
    const p = profiles.find(x => x.id === id);
    if (!p) { sendJson(res, 404, { error: 'Not found' }); return; }
    if (data.name !== undefined) {
      const name = String(data.name || '').trim();
      if (!name) { sendJson(res, 400, { error: '名称不能为空' }); return; }
      p.name = name;
    }
    if (data.values !== undefined) {
      try { p.values = validateProfile(data.values); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
    }
    saveProfiles(profiles);
    sendJson(res, 200, p);
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
    const id = decodeURIComponent(pathname.split('/')[3] || '');
    if (id === 'default') { sendJson(res, 403, { error: '默认方案不可删除' }); return; }
    const profiles = getProfiles();
    if (!profiles.find(x => x.id === id)) { sendJson(res, 404, { error: 'Not found' }); return; }
    saveProfiles(profiles.filter(x => x.id !== id));
    const accounts = getAccounts();
    let affected = 0;
    for (const acc of accounts) if (acc.profileId === id) { acc.profileId = 'default'; affected++; }
    if (affected) saveAccounts(accounts);
    sendJson(res, 200, { success: true, affectedAccounts: affected });
    return;
  }

  sendJson(res, 404, { code: 'invalid_request', message: 'Not Found' });
});

// [261123-port-config] 端口被占用时不要甩一堆栈，直接给出可操作的解决步骤
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('\n[Cuko Provider] ' + portInUseHint(HTTP_PORT) + '\n');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error('\n[Cuko Provider] 没有权限监听端口 ' + HTTP_PORT + '。请换一个 1024 以上的端口：编辑 ' + RUNTIME_CONFIG_FILE + '\n');
    process.exit(1);
  }
  console.error('\n[Cuko Provider] 启动失败:', err && err.message, '\n');
  process.exit(1);
});

server.listen(HTTP_PORT, HTTP_HOST, async () => {
  const adminUrl = 'http://127.0.0.1:' + HTTP_PORT + '/';
  console.log('[Cuko Provider] 运行在 http://' + HTTP_HOST + ':' + HTTP_PORT + (runtimeCfg.portSource === '默认值' ? '' : '（端口来源：' + runtimeCfg.portSource + '）'));
  console.log('[Cuko Provider] 管理台: ' + adminUrl);
  console.log('[Cuko Provider] 配置文件: ' + RUNTIME_CONFIG_FILE);
  const chrome = resolveChromePath(DEFAULT_PROFILE_VALUES);
  if (!chrome) console.warn('[Cuko Provider] 未探测到 Chrome，请在配置方案里指定 chromePath');

  // [261123-open-admin] 自动打开管理后台。
  // 监听地址是 0.0.0.0 时，日志里仍用 127.0.0.1 拼地址（本机浏览器能访问）。
  // 打开失败不影响服务，只提示手动访问。
  if (runtimeCfg.autoOpenAdmin) {
    const ok = await openInBrowser(adminUrl);
    if (ok) console.log('[Cuko Provider] 已尝试打开管理台（若没弹出请手动访问上面的地址）');
    else console.warn('[Cuko Provider] 自动打开浏览器失败，请手动访问: ' + adminUrl);
  } else {
    console.log('[Cuko Provider] autoOpenAdmin 已关闭，请手动打开上面的地址');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[bridge] 收到 ' + sig + '，正在关闭…');
    try { await closeAllConnections(); } catch (_) {}
    process.exit(0);
  });
}
