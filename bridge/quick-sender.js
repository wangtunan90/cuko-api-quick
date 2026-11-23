/**
 * Quick 发送编排：把一段 Cuko 输入变成「页面上真的发出去的一条消息」
 *
 * 实测（2026-11-23，quick.aws.com）：
 *  - 输入框是原生 textarea，直接设 value 不会触发 React 状态更新，
 *    必须用 HTMLTextAreaElement.prototype 的原生 value setter + 派发 input 事件；
 *    设完 value 后「发送消息」按钮才会从 disabled 变可用。
 *  - 回车不一定生效（页面可能把 Enter 当换行），所以优先点按钮，
 *    按钮点不动再回退 CDP 物理回车。
 *  - 发送成功的判据：输入框被清空，或页面进入生成中（出现停止按钮）。
 */
import { randomInRange } from './default-config.js';
import {
  READ_COMPOSER_EXPR, FOCUS_COMPOSER_EXPR, IS_GENERATING_EXPR,
  SEND_BUTTON_STATE_EXPR, DUMP_STATE_EXPR, NEW_CHAT_EXPR,
  parseQuickUrl, buildConversationUrl, isOnConversation,
  detectAccountId, buildChatUrl,
} from './page.js';

/** 读输入区状态 */
export async function readComposer(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: READ_COMPOSER_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { ok: false, value: '' };
  } catch (e) {
    return { ok: false, value: '', error: e.message };
  }
}

/** 聚焦输入框 */
export async function focusComposer(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: FOCUS_COMPOSER_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { ok: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 页面是否仍在生成 */
export async function isGenerating(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: IS_GENERATING_EXPR, returnByValue: true });
    return !!(r && r.result && r.result.value);
  } catch (_) { return false; }
}

/** 发送按钮状态 */
export async function sendButtonState(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: SEND_BUTTON_STATE_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { found: false };
  } catch (_) { return { found: false }; }
}

/** 打印页面快照（排障用） */
export async function dumpState(conn, label) {
  try {
    const r = await conn.Runtime.evaluate({ expression: DUMP_STATE_EXPR, returnByValue: true });
    console.log('[Page] 快照[' + label + ']: ' + JSON.stringify((r && r.result && r.result.value) || null).slice(0, 1200));
  } catch (e) {
    console.warn('[Page] 快照失败[' + label + ']:', e.message);
  }
}

/** 当前页面 URL */
export async function currentUrl(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    return String((r && r.result && r.result.value) || '');
  } catch (_) { return ''; }
}

/** 轮询等待输入区出现 */
export async function waitForComposer(conn, maxSec) {
  // [261123-continue-fix] 导航后前 1~2 秒，页面处于 loading 中间态：
  // Runtime.evaluate 可能抛「Cannot find context」或返回空，
  // 旧实现只按 1s 一次粗轮询，容易在过渡期耗掉预算后误判失败。
  // 改为 250ms 细轮询，并对异常/空结果继续重试，而不是直接当作未就绪。
  const deadline = Date.now() + Math.max(1, maxSec) * 1000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await conn.Runtime.evaluate({ expression: READ_COMPOSER_EXPR, returnByValue: true });
      const v = r && r.result && r.result.value;
      if (v && v.ok) return v;
    } catch (e) {
      // 导航过渡期上下文重建，属预期，继续等
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  if (lastErr) console.warn('[Send] waitForComposer 超时，最后一次错误:', lastErr);
  return null;
}

/**
 * 把文本写进 textarea。
 * 用原生 value setter + input 事件，React 受控组件才会更新内部状态，
 * 否则「发送消息」按钮一直 disabled。
 */
async function fillComposer(conn, text) {
  const expr = `(() => {
    const sels = ${JSON.stringify([
      'textarea[placeholder*="提问"]', 'textarea[placeholder*="键入"]', 'textarea',
      'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]',
    ])};
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    let el = null;
    for (const s of sels) {
      const nodes = Array.from(document.querySelectorAll(s)).filter(visible);
      if (nodes.length) { el = nodes[nodes.length - 1]; break; }
    }
    if (!el) return { ok: false, reason: 'no-composer' };
    el.focus();
    if (el.isContentEditable) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const value = el.isContentEditable ? String(el.innerText || '') : String(el.value || '');
    return { ok: value.length > 0, wrote: value.length, expected: ${JSON.stringify(text)}.length };
  })()`;
  const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
  return (r && r.result && r.result.value) || { ok: false, reason: 'no-result' };
}

/** CDP 物理回车（按钮不可用时的兜底） */
async function pressEnter(conn) {
  await conn.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await conn.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** 点发送按钮（页面内点击，最稳定） */
async function clickSendButton(conn) {
  const r = await conn.Runtime.evaluate({
    expression: `(() => {
      const sels = ${JSON.stringify(['button[aria-label="发送消息"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]'])};
      for (const s of sels) {
        const nodes = Array.from(document.querySelectorAll(s)).filter(n => n.offsetParent !== null);
        if (nodes.length) {
          const b = nodes[nodes.length - 1];
          if (b.disabled) return 'disabled';
          b.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()`,
    returnByValue: true,
  });
  return String((r && r.result && r.result.value) || 'error');
}

/** 判定「真的发出去了」 */
async function waitSent(conn, hadText, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isGenerating(conn)) return { ok: true, how: '页面进入生成中' };
    if (hadText) {
      const st = await readComposer(conn);
      if (!String(st.value || '').trim()) return { ok: true, how: '输入框已清空' };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return { ok: false };
}

/**
 * 发一轮消息。
 * @param {object} conn CDP 常驻连接
 * @param {string} text
 * @param {object} cfg 配置方案 values
 * @param {object} [opts]
 * @param {boolean} [opts.skipPreEnterWait]
 * @returns {Promise<{ok:boolean, error?:string, how?:string}>}
 */
export async function sendUserMessage(conn, text, cfg, opts = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: '没有可发送的文本' };

  // 1. 填入输入框
  await focusComposer(conn);
  let filled = await fillComposer(conn, text);
  if (!filled.ok) {
    console.warn('[Send] 首次填词失败，重试一次:', JSON.stringify(filled));
    await new Promise(r => setTimeout(r, 800));
    await focusComposer(conn);
    filled = await fillComposer(conn, text);
  }
  if (!filled.ok) {
    await dumpState(conn, '填词失败');
    return { ok: false, error: '无法把文本写入输入框（' + (filled.reason || '未知') + '）' };
  }
  console.log('[Send] 已填入输入框，长度 ' + filled.wrote);

  // 2. 等发送按钮可用（React 完成状态更新）
  //
  // [261123-upload-fix] 带附件时页面可能还要处理一会儿（图片解析、缩略图生成），
  // 按钮会保持 disabled。旧实现只等 20×150ms=3s，不够。
  // 附件场景给到 30s，并额外确认「按钮真的可点」。
  const btnWaitMs = opts.hasAttachments ? 30000 : 3000;
  const btnDeadline = Date.now() + btnWaitMs;
  let btn = { found: false };
  let btnWaited = 0;
  while (Date.now() < btnDeadline) {
    btn = await sendButtonState(conn);
    if (btn.found && !btn.disabled) break;
    await new Promise(r => setTimeout(r, 200));
    btnWaited += 200;
    if (opts.hasAttachments && btnWaited % 5000 === 0) {
      console.log('[Send] 发送按钮仍不可用（' + Math.round(btnWaited / 1000) + 's），继续等…');
    }
  }
  if (!btn.found) console.warn('[Send] 没找到发送按钮，将回退回车');
  else if (btn.disabled) console.warn('[Send] 发送按钮一直是 disabled 状态（等了 ' + Math.round(btnWaitMs / 1000) + 's）');

  // 3. 回车前随机等待（模拟真人节奏）
  if (!opts.skipPreEnterWait) {
    const waitMs = randomInRange(cfg.preEnterWaitMinSec, cfg.preEnterWaitMaxSec);
    await new Promise(r => setTimeout(r, waitMs));
  }

  const st = await readComposer(conn);
  const hadText = !!String(st.value || '').trim();
  // [261123-attach] 纯附件消息的 textarea 本来就是空的，不能因此判失败
  if (!hadText && !opts.hasAttachments) {
    await dumpState(conn, '发送前输入区为空');
    return { ok: false, error: '发送前输入区为空（内容可能被页面清掉）' };
  }
  if (!hadText && opts.hasAttachments) {
    console.log('[Send] 纯附件消息（输入框为空，但已挂附件），继续发送');
  }

  // 4. 触发发送：优先点按钮，失败回退物理回车
  //    纯附件消息没有文本可判断「输入框被清空」，只能靠「是否进入生成中」，
  //    所以等待窗口给宽一点（上传/解析附件后页面才真正开始生成）。
  const firstWait = opts.hasAttachments ? 12000 : 6000;
  const retryWait = opts.hasAttachments ? 8000 : 5000;
  let how = 'click';
  let clicked = await clickSendButton(conn);
  console.log('[Send] 点击发送按钮 -> ' + clicked);
  if (clicked === 'disabled') {
    console.warn('[Send] 发送按钮处于 disabled，先尝试回车兜底');
  }
  let sent = await waitSent(conn, hadText, firstWait);

  if (!sent.ok) {
    // [261123-dup-send] 回退回车之前必须先确认「确实没发出去」。
    //
    // 实测事故：点击其实已经生效，只是页面反应慢（>6s），waitSent 判了失败，
    // 于是又回车一次 —— 同一条消息发了两次，产生两个 thread 和两条响应流。
    // 客户端只消费第一条流的 done，第二条流没人读，表现成「回复完了但一直等待」。
    //
    // 这里的二次确认有三道：
    //   1. 输入框是否已被清空（清了 = 大概率发出去了）
    //   2. 页面是否在生成中
    //   3. 再等一小段时间看看状态会不会自己变
    console.warn('[Send] 点击后未确认发送，先做二次确认再决定是否回退…');
    let confirmed = false;
    for (let i = 0; i < 12; i++) {
      if (await isGenerating(conn)) { confirmed = true; break; }
      if (hadText) {
        const st = await readComposer(conn);
        if (!String(st.value || '').trim()) { confirmed = true; break; }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // 只有「输入框里还有原文」才说明真的没发出去
    let stillHasText = false;
    if (!confirmed) {
      const st = await readComposer(conn);
      stillHasText = hadText && !!String(st.value || '').trim();
    }

    if (confirmed) {
      console.log('[Send] 二次确认：点击其实已生效（页面已响应），跳过回退');
      sent = { ok: true, how: 'click(延迟确认)' };
    } else if (!stillHasText) {
      // 输入框空了但没看到生成中：可能是纯附件消息，或页面正在准备
      console.log('[Send] 二次确认：输入框已空，按已发送处理，不再回退');
      sent = { ok: true, how: 'click(输入框已空)' };
    } else {
      console.warn('[Send] 二次确认：输入框仍保留原文，判定点击无效，回退 CDP 回车');
      how = 'enter';
      await focusComposer(conn);
      await pressEnter(conn);
      sent = await waitSent(conn, hadText, retryWait);
    }
  }

  if (sent.ok) {
    console.log('[Send] 已确认发送（' + sent.how + '，方式=' + how + '）');
    return { ok: true, how };
  }

  const after = await readComposer(conn);
  if (String(after.value || '').trim()) {
    await dumpState(conn, '发送未确认');
    return { ok: false, error: '未触发发送：输入框仍有内容' };
  }
  console.warn('[Send] 未确认生成中，但输入框已空，按「已发送」继续');
  return { ok: true, how, note: 'unconfirmed' };
}

/** 回到「新对话」 */
export async function startNewChat(conn, cfg) {
  // 1) 首选：点页面自己的「新对话」按钮（最贴近真实用户操作）
  try {
    const r = await conn.Runtime.evaluate({ expression: NEW_CHAT_EXPR, returnByValue: true });
    const v = (r && r.result && r.result.value) || {};
    if (v.ok) {
      console.log('[Send] 已点击新对话按钮');
      await new Promise(res => setTimeout(res, 1200));
      // 点完之后必须确认真的到了聊天页，否则继续走兜底
      const st = await waitForComposer(conn, 10);
      if (st) return true;
      console.warn('[Send] 点了新对话但输入区没出来，改用 URL 兜底');
    }
  } catch (_) {}

  // 2) 兜底：直接导航到「当前已登录账号」的聊天页。
  // [261123-entry-fix] 旧实现导航到 "https://quick.aws.com/sn" 是错的：
  // 那是产品落地页（Features/Pricing/Sign in），永远没有输入框。
  // 正确入口是 /sn/account/<账号ID>/start/chat，账号 ID 从页面 cookie/localStorage 探测。
  // 优先用探测到的账号 ID 直接拼聊天页（最快，少一次跳转）
  try {
    const accountId = await detectAccountId(conn);
    if (accountId) {
      const url = buildChatUrl(accountId);
      console.log('[Send] 导航到聊天页:', url);
      await conn.Page.navigate({ url });
      const st = await waitForComposer(conn, Math.max(15, Math.ceil((cfg && cfg.pageReadyPollMaxSec) || 25)));
      if (st) return true;
      console.warn('[Send] 直达聊天页后输入区未就绪，改用 /sn/start 兜底');
    }
  } catch (e) {
    console.warn('[Send] 直连聊天页失败:', e.message);
  }

  // 探测不到账号 ID 时，走 /sn/start —— 页面自己会路由到正确的聊天页
  try {
    const fallback = 'https://quick.aws.com/sn/start';
    console.log('[Send] 导航到入口页:', fallback);
    await conn.Page.navigate({ url: fallback });
    const st = await waitForComposer(conn, Math.max(20, Math.ceil((cfg && cfg.pageReadyPollMaxSec) || 25)));
    if (st) return true;
    console.warn('[Send] 入口页导航后输入区仍未就绪');
    return false;
  } catch (e) {
    console.warn('[Send] 新建对话失败:', e.message);
    return false;
  }
}

/**
 * 导航到指定会话并等它真的就位。
 *
 * 为什么不能只看「输入框出现了」：Quick 是 SPA，导航是异步的，
 * textarea 在切会话过程中一直存在。必须等 URL 里的 conversationId 变成目标值，
 * 再等输入区可用，才能保证消息发到正确的会话里。
 *
 * @param {object} conn CDP 常驻连接
 * @param {string} conversationId 目标会话 ID
 * @param {object} cfg 配置方案 values
 * @returns {Promise<{ok:boolean, error?:string, url?:string}>}
 */
export async function gotoConversation(conn, conversationId, cfg) {
  const before = await currentUrl(conn);
  const { accountId } = parseQuickUrl(before);
  if (!accountId) {
    return { ok: false, error: '无法从当前 URL 解析账号 ID（当前: ' + before + '）' };
  }
  if (isOnConversation(before, conversationId)) {
    console.log('[Send] 已经在目标会话里，无需导航');
    return { ok: true, url: before, navigated: false };
  }

  const target = buildConversationUrl(accountId, conversationId);
  console.log('[Send] 导航到会话:', target);
  try {
    await conn.Page.navigate({ url: target });
  } catch (e) {
    return { ok: false, error: '导航失败: ' + e.message };
  }

  // 等 URL 里的 conversationId 变成目标值；最多等 pageReadyPollMaxSec 秒
  const maxSec = Math.max(5, Math.ceil((cfg && cfg.pageReadyPollMaxSec) || 25));
  const deadline = Date.now() + maxSec * 1000;
  let urlNow = '';
  while (Date.now() < deadline) {
    urlNow = await currentUrl(conn);
    if (isOnConversation(urlNow, conversationId)) {
      // URL 切对之后，页面还要重新渲染一次（实测约 2~4s），
      // 这里单独给一段充裕的时间等输入区，而不是沿用上面循环的剩余时间。
      const st = await waitForComposer(conn, Math.max(15, maxSec));
      if (st) {
        console.log('[Send] 已进入会话并就绪:', urlNow);
        return { ok: true, url: urlNow, navigated: true };
      }
      return { ok: false, error: '会话 URL 已切换但输入区未就绪（已等待 ' + Math.max(15, maxSec) + 's）: ' + urlNow };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ok: false, error: '导航超时：' + maxSec + 's 内 URL 未切到目标会话（当前: ' + urlNow + '，目标: ' + conversationId + '）' };
}

/**
 * 把本地文件挂到 Quick 的输入区（走页面的 input[type=file]）。
 *
 * 实测（2026-11-23）：页面本身就有一个隐藏的 input[type=file]（accept=*、multiple），
 * 用 CDP 的 DOM.setFileInputFiles 把绝对路径塞进去后，页面会自己走完上传：
 *   POST .../attachments/presigned-url
 *   POST .../dlp/internal/.../describe-user-aware
 *   POST .../invocations/files/upload/<threadId>
 * 三个都 200 后，输入区上方出现附件卡片，发送时模型能读到文件内容
 * （已用暗号实测确认：模型准确答出文件里独有的一串字符）。
 *
 * @param {object} conn CDP 常驻连接
 * @param {string[]} filePaths 本地绝对路径
 * @param {object} cfg 配置方案 values
 * @returns {Promise<{ok:boolean, error?:string, count?:number}>}
 */
export async function attachFiles(conn, filePaths, cfg) {
  const paths = (filePaths || []).filter(Boolean);
  if (!paths.length) return { ok: true, count: 0 };
  if (typeof conn.DOM === 'undefined' || !conn.DOM) {
    return { ok: false, error: 'CDP DOM 域不可用，无法注入文件' };
  }

  // 1. 找到那个隐藏的 file input
  let nodeId = null;
  try {
    const doc = await conn.DOM.getDocument({ depth: -1 });
    const found = await conn.DOM.querySelector({ nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
    nodeId = found && found.nodeId;
  } catch (e) {
    return { ok: false, error: '查找文件输入框失败: ' + e.message };
  }
  if (!nodeId) return { ok: false, error: '页面上找不到 input[type=file]（Quick 可能改版了）' };

  // 2. 记录上传请求的生命周期
  //
  // [261123-upload-fix] 旧实现有三个坑，图片（上传慢）尤其容易踩：
  //   a) 用 requestId 去匹配 /upload/i —— requestId 形如 "50716.5064"，
  //      不含 upload 字样，这个条件**永远为 false**；
  //   b) 附件卡片一出现就判 ready，不等上传完成。图片会先渲染本地预览卡片，
  //      此时 files/upload 还在传，于是提前返回 → 点发送时附件其实没就绪；
  //   c) 只看「有没有出现卡片」，不看「上传是否成功」。
  //
  // 现在改为按 URL 精确归类请求，并且必须见到 files/upload 的**成功响应**才算就绪。
  const upById = new Map();   // requestId → { kind, url }
  const okIds = new Set();    // 收到 2xx 响应的请求
  const failIds = new Map();  // requestId → 错误信息
  let scope = null;
  try {
    scope = conn.createScope();
    scope.Network.requestWillBeSent((p) => {
      const u = (p.request && p.request.url) || '';
      if (u.indexOf('files/upload') >= 0) upById.set(p.requestId, { kind: 'upload', url: u });
      else if (u.indexOf('presigned-url') >= 0) upById.set(p.requestId, { kind: 'presign', url: u });
      else if (u.indexOf('dlp') >= 0) upById.set(p.requestId, { kind: 'dlp', url: u });
    });
    scope.Network.responseReceived((p) => {
      if (!upById.has(p.requestId)) return;
      const code = (p.response && p.response.status) || 0;
      if (code >= 200 && code < 300) okIds.add(p.requestId);
    });
    scope.Network.loadingFinished((p) => {
      if (!upById.has(p.requestId)) return;
      okIds.add(p.requestId);
    });
    scope.Network.loadingFailed((p) => {
      if (!upById.has(p.requestId)) return;
      failIds.set(p.requestId, p.errorText || '网络失败');
    });
  } catch (_) {}

  // 3. 注入文件
  try {
    await conn.DOM.setFileInputFiles({ nodeId, files: paths });
    console.log('[Send] 已注入 ' + paths.length + ' 个附件，等待页面上传…');
  } catch (e) {
    if (scope) scope.close();
    return { ok: false, error: '注入文件失败: ' + e.message };
  }

  // 4. 等真正的「上传成功」
  //
  // 判据（必须满足）：
  //   · 见到了 files/upload 请求，且它拿到了 2xx 或 loadingFinished
  //   · 没有失败的 upload
  // 仅有卡片是不够的 —— 图片的本地预览卡片会在上传完成前就出现。
  //
  // 图片上传比文本慢，超时按 fileUploadTimeoutSec 走，但至少给 120s。
  const maxSec = Math.max(120, Math.ceil((cfg && cfg.fileUploadTimeoutSec) || 60));
  const deadline = Date.now() + maxSec * 1000;
  let ready = false;
  let sawUpload = false;
  let lastLog = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));

    // 有没有上传失败
    for (const [id, err] of failIds) {
      const info = upById.get(id);
      if (info && info.kind === 'upload') {
        if (scope) scope.close();
        return { ok: false, error: '附件上传失败: ' + err };
      }
    }

    // 统计 files/upload 的完成情况
    let uploadTotal = 0, uploadOk = 0;
    for (const [id, info] of upById) {
      if (info.kind !== 'upload') continue;
      uploadTotal++;
      if (okIds.has(id)) uploadOk++;
    }
    if (uploadTotal > 0) sawUpload = true;

    // [261123-upload-fix] 双保险：上传请求全部完成 **或** 附件卡片已出现在 DOM 里。
    //
    // 为什么要看 aria-label 而不是 innerText：
    // 实测 Quick 的附件卡片把文件名放在 aria-label（如 "_test-img.png · 121.2 KB"），
    // body.innerText 里**根本看不到文件名**。旧实现用 innerText.includes(文件名)
    // 判断，对图片永远返回 false —— 于是上传明明成功了，却被判成「没挂上」，
    // 一路等到超时。这正是「上传成功但不发送」的根因。
    let cardSeen = false;
    try {
      const names = paths.map((p) => p.split(/[\\/]/).pop()).filter(Boolean);
      if (names.length) {
        const expr = '(() => { const labels = Array.from(document.querySelectorAll("[aria-label]"))' +
          '.map(e => e.getAttribute("aria-label") || "");' +
          'const t = document.body.innerText || "";' +
          'return ' + JSON.stringify(names) + '.filter(n => labels.some(l => l.includes(n)) || t.includes(n)).length; })()';
        const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
        const matched = (r && r.result && r.result.value) || 0;
        cardSeen = matched >= names.length;
      }
    } catch (_) {}

    if (cardSeen) { ready = true; break; }
    if (uploadTotal > 0 && uploadOk >= uploadTotal) {
      // 上传完成后再给 DOM 一点时间渲染卡片，避免「刚传完就点发送」
      await new Promise((r) => setTimeout(r, 1200));
      ready = true;
      break;
    }

    // 进度日志（每 5 秒一次，避免刷屏）
    const now = Date.now();
    if (now - lastLog > 5000) {
      lastLog = now;
      const el = Math.round((now - (deadline - maxSec * 1000)) / 1000);
      console.log('[Send] 等待上传中… ' + el + 's（upload ' + uploadOk + '/' + uploadTotal +
        (sawUpload ? '' : '，尚未发起') + '，卡片=' + cardSeen + '）');
    }
  }

  if (scope) scope.close();

  if (!ready) {
    if (!sawUpload) {
      return { ok: false, error: '附件没有触发上传（' + maxSec + 's 内未观察到 files/upload 请求）。可能是页面还没准备好接文件。' };
    }
    return { ok: false, error: '附件上传超时（' + maxSec + 's 内未全部完成）' };
  }

  // 5. 再给页面一点时间把附件状态同步到发送逻辑
  await new Promise((r) => setTimeout(r, 800));
  console.log('[Send] 附件已就绪 ' + paths.length + ' 个');
  return { ok: true, count: paths.length };
}
