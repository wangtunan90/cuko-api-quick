#!/usr/bin/env node
/**
 * 打包 Windows 单文件 exe
 * 用法：npm run build:exe
 *
 * 流程：
 *   1. esbuild 把 bridge/index.js 及其依赖打成单个 ESM 文件（build/sea-main.mjs）
 *   2. Node 的 --build-sea 把该文件 + ui/index.html 注入 node 二进制，
 *      产出 dist/cuko-api-quick.exe（自带 Node 运行时，目标机不用装 Node）
 *   3. data/ 不打进 exe：首次运行时在 exe 同目录自动创建
 *
 * 注意：必须用「支持 --build-sea 的 node」执行。
 *       本机 DeepSeek Harness 内置的 node 是 v24（不支持），
 *       系统 PATH 上的 node 是 v26（支持），脚本会自己找。
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');
const BUNDLE = path.join(BUILD_DIR, 'sea-main.mjs');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const EXE_NAME = 'cuko-api-quick.exe';

function log(...args) { console.log('[build:exe]', ...args); }
function die(msg) { console.error('\n[build:exe] 失败：' + msg + '\n'); process.exit(1); }

// ---------- 找一个支持 --build-sea 的 node ----------
function nodeSupportsSea(exe) {
  try {
    const v = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
    const [maj, min] = v.split('.').map(Number);
    return { ok: maj > 25 || (maj === 25 && min >= 5), version: v };
  } catch (_) { return { ok: false, version: null }; }
}

function findSeaNode() {
  const candidates = [
    process.execPath,
    ...(process.env.NODE_SEA_BIN ? [process.env.NODE_SEA_BIN] : []),
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\d\\DevelopmentTools\\node\\node.exe',
  ];
  // PATH 上的 node
  try {
    const which = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    candidates.push(...which);
  } catch (_) {}
  const tried = [];
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    const r = nodeSupportsSea(c);
    tried.push(c + ' (v' + r.version + ')');
    if (r.ok) return c;
  }
  die('找不到支持 --build-sea 的 Node.js（需要 >= 25.5）。\n  试过：\n    ' + tried.join('\n    ') +
      '\n  可通过环境变量 NODE_SEA_BIN 指定 node 路径。');
}

if (process.platform !== 'win32') die('该脚本只用于生成 Windows exe，请在 Windows 上运行');
const NODE_EXE = findSeaNode();
log('使用 Node', execFileSync(NODE_EXE, ['--version'], { encoding: 'utf8' }).trim(), '→', EXE_NAME);

// ---------- 0) 清理 ----------
for (const dir of [BUILD_DIR, DIST_DIR]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { die('无法清理 ' + dir + '（exe 是否正在运行？）：' + e.message); }
}
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// ---------- 1) 打包成单文件 ESM ----------
log('打包 bridge/index.js ...');
// [261123-version] 把版本号在构建时注入。
// exe 运行时读不到 package.json（cwd / exe 目录都没有），只能靠 define 烧进去。
const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
log('版本号：' + appVersion);

await build({
  entryPoints: [path.join(ROOT, 'bridge', 'index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'esnext',
  outfile: BUNDLE,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // ws 的可选原生加速模块：没装时自动回退 JS 实现，不能让 esbuild 去解析
  external: ['bufferutil', 'utf-8-validate'],
  // esbuild 把 CJS 依赖打进 ESM 产物时，require('events') 之类会被 shim 成
  // 「Dynamic require is not supported」。在顶部注入 createRequire，
  // 让这些 require 落到 Node 内置模块上（SEA 里 import.meta.url 指向 exe，同样可用）。
  banner: { js: "import { createRequire as __seaCreateRequire } from 'node:module';\nconst require = __seaCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
log('bundle 完成：' + (fs.statSync(BUNDLE).size / 1024).toFixed(0) + ' KB');

// ---------- 2) SEA 配置（UI 作为 asset 内嵌） ----------
fs.writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  mainFormat: 'module',
  output: path.join(DIST_DIR, EXE_NAME),
  disableExperimentalSEAWarning: true,
  assets: {
    'ui/index.html': path.join(ROOT, 'ui', 'index.html'),
  },
}, null, 2), 'utf8');

// ---------- 3) 生成 exe ----------
log('生成 exe（Node SEA，约 1-3 分钟）...');
try {
  execFileSync(NODE_EXE, ['--build-sea=' + SEA_CONFIG], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  die('--build-sea 执行失败：' + e.message);
}

const exePath = path.join(DIST_DIR, EXE_NAME);
if (!fs.existsSync(exePath)) die('未生成 exe：' + exePath);
log('exe 生成：' + exePath + '（' + (fs.statSync(exePath).size / 1024 / 1024).toFixed(1) + ' MB）');

// ---------- 4) 附带使用说明 ----------
fs.writeFileSync(path.join(DIST_DIR, '使用说明.txt'), [
  'cuko-api-quick 单文件版',
  '',
  '【这是什么】',
  '  把 Amazon Quick 网页版（quick.aws.com）的聊天能力，暴露成 Cuko API。',
  '',
  '【怎么用】',
  '  1. 双击 cuko-api-quick.exe 启动（会弹出一个命令行窗口，别关它）',
  '  2. 浏览器打开 http://127.0.0.1:3000/ 进入管理台',
  '  3. 填模型 ID（如 quick-main）+ 显示名称，点「添加并启动 Chrome」',
  '  4. 在弹出的 Chrome 窗口里登录 quick.aws.com',
  '  5. 回管理台点「检查」，看到 ok 就可以用了',
  '  6. 在支持 Cuko API 的客户端里填中转地址 http://127.0.0.1:3000/，Token 留空',
  '',
  '【数据在哪】',
  '  所有运行时数据（账号、配置方案、Chrome 登录态、日志）都在 exe 同级的 data/ 目录。',
  '  整个文件夹拷贝即可迁移。请放在有写权限的目录，不要放 Program Files。',
  '',
  '【环境要求】',
  '  - 本机已安装 Chrome（会自动探测 Program Files 下的路径）',
  '  - 不需要装 Node.js',
  '',
  '【环境变量】',
  '  CUKO_HTTP_PORT   修改监听端口（默认 3000）',
  '',
  '【常见问题】',
  '  - exe 未签名，SmartScreen 提示时选择「更多信息 → 仍要运行」',
  '  - 端口被占用：设 CUKO_HTTP_PORT 换一个',
  '  - 「页面输入区未就绪」：确认那个 Chrome 窗口已登录且停在聊天页',
  '  - 同一账号同时只能跑一轮对话，并发会返回 429',
  '',
  '【免责声明】',
  '  本项目通过自动化驱动网页界面工作，与 Amazon / AWS 无任何关联，非官方实现。',
  '  请仅在你拥有或获得明确授权的账号上使用，并遵守相关服务条款。',
].join('\r\n'), 'utf8');

log('完成。产物：' + DIST_DIR);
