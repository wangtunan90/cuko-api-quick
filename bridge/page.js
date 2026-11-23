/**
 * Quick 网页版页面交互（选择器与操作都基于 2026-11-23 实测的真实 DOM）
 *
 * 实测结构（登录后，quick.aws.com/sn/account/<id>/start/chat）：
 *   输入框   textarea，placeholder「提问或键入 @ 以提醒代理...」，无 id/class
 *            祖先：div.mention-highlight-wrapper > div.input-card-body > div.input-card
 *                  > div.home-input-anchor（对话页里换成消息区锚点）
 *   发送按钮 button[aria-label="发送消息"]，空内容时 disabled
 *   停止按钮 生成中出现（aria-label 含"停止"）
 *   新对话   button，文本「新对话」
 *   模式     按钮 title「智能 模式」（fast/balanced/smart/advanced）
 *
 * 注意：类名多为构建产物的普通类名（input-card 等），仍可能随发版变化，
 * 因此所有选择器都按「语义属性优先、结构类名兜底」排序。
 */

/** 输入框候选（按可靠性排序） */
export const COMPOSER_CANDIDATES = [
  'textarea[placeholder*="提问"]',
  'textarea[placeholder*="ask" i]',
  'textarea[placeholder*="键入"]',
  'textarea',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
];

/** 发送按钮候选 */
export const SEND_BUTTON_CANDIDATES = [
  'button[aria-label="发送消息"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send" i]',
  'button[data-testid*="send" i]',
];

/**
 * 停止生成按钮候选
 *
 * [261123-dom-end] 实测（用户提供的真实 DOM）：
 *   生成中：<button aria-label="停止生成" data-automation-id="chat-stop">
 *   可发送：<button aria-label="发送消息" data-automation-id="chat-send" aria-busy="false">
 *   空输入：<button aria-label="发送消息" disabled>
 *
 * data-automation-id 是给自动化测试用的稳定标识，不随语言/文案变化，
 * 比 aria-label 靠得住（中文 UI 换成英文就失效了）。
 * 所以优先用它，aria-label 只作兜底。
 */
export const STOP_BUTTON_CANDIDATES = [
  'button[data-automation-id="chat-stop"]',
  'button[aria-label*="停止"]',
  'button[aria-label*="Stop" i]',
];

/** 发送按钮候选（同样优先用稳定标识） */
export const SEND_BUTTON_CANDIDATES_STRICT = [
  'button[data-automation-id="chat-send"]',
  'button[aria-label="发送消息"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send" i]',
];

/** 新对话按钮 */
export const NEW_CHAT_EXPR = `(() => {
  const labels = ['新对话', 'new chat', '新建对话', 'new conversation'];
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  for (const el of nodes) {
    if (el.offsetParent === null) continue;
    const text = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    if (labels.some(l => text.includes(l.toLowerCase()))) {
      el.click();
      return { ok: true, how: 'clicked' };
    }
  }
  return { ok: false };
})()`;

/** 公共前置：可见性判断 */
const VISIBLE_FN = `const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
};`;

/** 读输入区状态 */
export const READ_COMPOSER_EXPR = `(() => {
  ${VISIBLE_FN}
  const sels = ${JSON.stringify(COMPOSER_CANDIDATES)};
  let el = null, usedSel = null;
  for (const s of sels) {
    const nodes = Array.from(document.querySelectorAll(s)).filter(n => visible(n) && !n.disabled && !n.readOnly);
    if (nodes.length) { el = nodes[nodes.length - 1]; usedSel = s; break; }
  }
  if (!el) return { ok: false, value: '', focused: false, tag: null, sel: null };
  const editable = el.isContentEditable === true;
  const value = editable ? String(el.innerText || el.textContent || '') : String(el.value == null ? '' : el.value);
  const active = document.activeElement;
  return {
    ok: true, value, sel: usedSel, tag: el.tagName, editable,
    focused: active === el || (active && el.contains && el.contains(active)),
    disabled: !!el.disabled, readOnly: !!el.readOnly,
  };
})()`;

/** 聚焦输入框并把光标放到末尾 */
export const FOCUS_COMPOSER_EXPR = `(() => {
  ${VISIBLE_FN}
  const sels = ${JSON.stringify(COMPOSER_CANDIDATES)};
  for (const s of sels) {
    const nodes = Array.from(document.querySelectorAll(s)).filter(n => visible(n));
    if (!nodes.length) continue;
    const el = nodes[nodes.length - 1];
    el.focus();
    try {
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    } catch (e) {}
    return { ok: true, sel: s, tag: el.tagName };
  }
  return { ok: false };
})()`;

/** 是否仍在生成 */
export const IS_GENERATING_EXPR = `(() => {
  ${VISIBLE_FN}
  const sels = ${JSON.stringify(STOP_BUTTON_CANDIDATES)};
  for (const s of sels) {
    try {
      const nodes = Array.from(document.querySelectorAll(s));
      if (nodes.some(n => visible(n))) return true;
    } catch (e) {}
  }
  return false;
})()`;

/** 发送按钮状态（用于「内容已就绪」判定与回车失败时兜底点击） */
export const SEND_BUTTON_STATE_EXPR = `(() => {
  ${VISIBLE_FN}
  const sels = ${JSON.stringify(SEND_BUTTON_CANDIDATES)};
  for (const s of sels) {
    const nodes = Array.from(document.querySelectorAll(s)).filter(n => visible(n));
    if (nodes.length) {
      const b = nodes[nodes.length - 1];
      const r = b.getBoundingClientRect();
      return { found: true, disabled: !!b.disabled, sel: s,
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
  }
  return { found: false };
})()`;

/** 输入区快照（排障用） */
export const DUMP_STATE_EXPR = `(() => {
  ${VISIBLE_FN}
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  const info = (el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, cls: clip(typeof el.className === 'string' ? el.className : '', 40),
      ph: clip(el.placeholder, 24), aria: el.getAttribute('aria-label'),
      w: Math.round(r.width), h: Math.round(r.height), vis: visible(el) };
  };
  return {
    url: location.href,
    editables: Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).slice(0, 6).map(info),
    sendButtons: Array.from(document.querySelectorAll('button[aria-label*="发送"],button[aria-label*="Send"]')).slice(0, 4)
      .map(b => ({ aria: b.getAttribute('aria-label'), disabled: !!b.disabled, vis: visible(b) })),
    active: document.activeElement ? document.activeElement.tagName : null,
  };
})()`;

/** Quick 对话 URL 的固定形态（实测）：
 *  https://quick.aws.com/sn/account/<awsAccountId>/start/chat?conversationId=<uuid>
 */
const URL_RE = /^https:\/\/quick\.aws\.com\/sn\/account\/([^/?#]+)\/start\/chat/i;

/**
 * 从页面 URL 里解析出账号 ID 和会话 ID。
 * @param {string} url
 * @returns {{ accountId: string|null, conversationId: string|null }}
 */
export function parseQuickUrl(url) {
  const u = String(url || '');
  const m = u.match(URL_RE);
  const accountId = m ? m[1] : null;
  let conversationId = null;
  try {
    const q = u.indexOf('?');
    if (q >= 0) conversationId = new URLSearchParams(u.slice(q + 1)).get('conversationId');
  } catch (_) {}
  // 兜底：查询参数没解析到就取最后一个 UUID 形态的片段（兼容多级路径）
  if (!conversationId) {
    const seg = u.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (seg) conversationId = seg[0];
  }
  return { accountId, conversationId };
}

/** 只要会话 ID（兼容旧调用点） */
export function extractThreadIdFromUrl(url) {
  return parseQuickUrl(url).conversationId;
}

/**
 * 构造某个会话的 URL。
 * @param {string} accountId AWS 账号 ID
 * @param {string} conversationId 会话 ID
 */
export function buildConversationUrl(accountId, conversationId) {
  return 'https://quick.aws.com/sn/account/' + accountId + '/start/chat?conversationId=' + encodeURIComponent(conversationId);
}

/**
 * 判定「当前页面是否已经在目标会话里」。
 * 都用 conversationId 精确比对，避免把「同账号的别的会话」误判成已就位。
 * @param {string} currentUrl
 * @param {string} wantConversationId
 */
export function isOnConversation(currentUrl, wantConversationId) {
  if (!wantConversationId) return false;
  return parseQuickUrl(currentUrl).conversationId === String(wantConversationId);
}

/**
 * 从页面读出 AWS 账号 ID（用于拼聊天页 URL）。
 *
 * 实测（2026-11-23）有三条可靠来源，按优先级取：
 *   1. cookie `qs-directory-alias`       —— 最直接，形如 "261414899405"
 *   2. cookie `aws-directoryUserInfo`    —— JSON，里面有 alias 字段
 *   3. localStorage `quickwork-web-last-user` —— ARN，形如
 *      arn:aws:quicksight::<accountId>:user-internal/...
 *
 * 注意：document.cookie 读不到 httpOnly 的，所以 cookie 走 CDP 的
 * Network.getAllCookies；页面内的 localStorage 用 Runtime.evaluate 读。
 */
export const READ_ACCOUNT_FROM_STORAGE_EXPR = `(() => {
  const out = { alias: null, fromArn: null };
  try {
    const raw = localStorage.getItem('quickwork-web-last-user') || '';
    const m = raw.match(/arn:aws:[a-z]+::(\d{8,}):/i);
    if (m) out.fromArn = m[1];
  } catch (e) {}
  try {
    const saved = localStorage.getItem('qs-saved-accounts');
    // qs-saved-accounts 有时在 cookie 里，有时在 localStorage，格式 {"a":[{"id":"..."}]}
    if (saved) {
      const j = JSON.parse(saved);
      const first = j && Array.isArray(j.a) ? j.a[0] : null;
      if (first) out.alias = String(first.id || first.an || '') || null;
    }
  } catch (e) {}
  return out;
})()`;

/**
 * 探测当前登录账号的 AWS 账号 ID。
 * @param {object} conn CDP 常驻连接
 * @returns {Promise<string|null>}
 */
export async function detectAccountId(conn) {
  // 1) 当前 URL 里已经有就直接用（最快最准）
  const urlNow = await conn.Runtime
    .evaluate({ expression: 'location.href', returnByValue: true })
    .then((r) => (r && r.result && r.result.value) || '')
    .catch(() => '');
  const fromUrl = parseQuickUrl(urlNow).accountId;
  if (fromUrl) return fromUrl;

  // 2) cookie（需要 CDP Network 域，httpOnly 也能读）
  try {
    const res = await conn.Network.getAllCookies();
    const cookies = (res && res.cookies) || [];
    const pick = (name) => {
      const c = cookies.find((k) => k.name === name && String(k.domain || '').includes('quick.aws.com'));
      return c ? String(c.value || '') : '';
    };
    const alias = pick('qs-directory-alias');
    if (/^\d{8,}$/.test(alias)) return alias;

    const dirInfo = pick('aws-directoryUserInfo');
    if (dirInfo) {
      try {
        const j = JSON.parse(decodeURIComponent(dirInfo));
        if (j && j.alias && /^\d{8,}$/.test(String(j.alias))) return String(j.alias);
      } catch (_) {}
    }
    const saved = pick('qs-saved-accounts');
    if (saved) {
      try {
        const j = JSON.parse(decodeURIComponent(saved));
        const first = j && Array.isArray(j.a) ? j.a[0] : null;
        const id = first && (first.id || first.an);
        if (id && /^\d{8,}$/.test(String(id))) return String(id);
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[Page] 读取 cookie 失败:', e.message);
  }

  // 3) localStorage（ARN 兜底）
  try {
    const r = await conn.Runtime.evaluate({ expression: READ_ACCOUNT_FROM_STORAGE_EXPR, returnByValue: true });
    const v = (r && r.result && r.result.value) || {};
    if (v.alias && /^\d{8,}$/.test(String(v.alias))) return String(v.alias);
    if (v.fromArn && /^\d{8,}$/.test(String(v.fromArn))) return String(v.fromArn);
  } catch (e) {
    console.warn('[Page] 读取 localStorage 失败:', e.message);
  }

  return null;
}

/**
 * 构造聊天页 URL（不带会话）。
 * @param {string} accountId
 */
export function buildChatUrl(accountId) {
  return accountId
    ? 'https://quick.aws.com/sn/account/' + accountId + '/start/chat'
    // [261123-entry-fix] 没有账号 ID 时用 /sn/start（会自动路由到聊天页），
    // 不能用 /sn —— 那是落地页。
    : 'https://quick.aws.com/sn/start';
}

/**
 * Quick 会话 ID 的形态判别。
 *
 * [261123-branch-fix] 实测发现：当用户在页面上「编辑消息 / 重新生成」时，
 * Quick 会给这次操作分配一个**临时分支 ID**，形如 `branch-498dd9e9`，
 * 而不是主会话的 UUID。分支 ID 与主会话 UUID 没有包含关系，是并列的。
 *
 * 我们按 providerSessionId 做严格比对时，会把 `branch-*` 误判成「另一个会话」，
 * 从而报「会话不一致」。所以这里要能识别出它是「同一会话的临时分支」。
 */

/** 主会话 ID 形态：标准 UUID */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 临时分支形态：branch-<8位十六进制> */
const BRANCH_RE = /^branch-[0-9a-z]+$/i;

/** 是否主会话 UUID */
export function isMainSessionId(id) {
  return UUID_RE.test(String(id || ''));
}

/** 是否临时分支 ID（编辑消息 / 重新生成时出现） */
export function isBranchSessionId(id) {
  return BRANCH_RE.test(String(id || ''));
}

/**
 * 判断事件里的 thread_id 是否「可接受」。
 *
 * 可接受的情况：
 *   1. 完全相等（正常续接）
 *   2. 事件是 branch-* 形式 —— 用户在页面上编辑/重新生成产生的临时分支，
 *      内容仍属于同一个对话，不应判失败
 *
 * @param {string} evtThread 事件里的 thread id
 * @param {string} expected 请求携带的 providerSessionId
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isThreadAcceptable(evtThread, expected) {
  if (!evtThread) return { ok: true };                       // 拿不到 thread，放行
  if (!expected) return { ok: true };                        // 没指定期望值，放行
  if (String(evtThread) === String(expected)) return { ok: true };
  if (isBranchSessionId(evtThread)) return { ok: true, reason: 'branch' };
  return { ok: false, reason: 'mismatch' };
}

/**
 * 「新对话真的就绪」的判定
 *
 * [261123-newchat-ready] 为什么不能用「输入框存在」来判断：
 * 实测点击「新对话」按钮后，textarea 从头到尾都在（ta 恒为 true），
 * 用它做就绪判定等于永远立即返回 —— 而页面其实还在重渲染，
 * React 状态没重置完就发消息，第一条（尤其是带系统提示词的长消息）容易发不出去。
 *
 * 实测到的真实变化：
 *   t+0.0s  bodyLen=633  msgCount=19   ← 旧对话里
 *   t+0.3s  bodyLen=626  msgCount=1    ← 已切到空对话（消息清空）
 *   t+1.8s  bodyLen=726                ← 页面完成重渲染（欢迎语/建议卡片出现）
 *
 * 所以判定用「URL 无 conversationId + 消息区已清空 + 没有生成中」这几项组合。
 */
export const NEW_CHAT_READY_EXPR = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  // 1) URL 里不应该再有 conversationId（点了新对话就该清掉）
  const hasConv = /[?&]conversationId=/.test(location.href);

  // 2) 输入框必须存在且可用
  const sels = ['textarea[placeholder*="提问"]', 'textarea[placeholder*="键入"]', 'textarea'];
  let ta = null;
  for (const sel of sels) {
    const nodes = Array.from(document.querySelectorAll(sel)).filter(visible);
    if (nodes.length) { ta = nodes[nodes.length - 1]; break; }
  }
  const hasTa = !!ta && !ta.disabled && !ta.readOnly;

  // 3) 输入框必须是空的（新对话不该残留内容）
  const taEmpty = ta ? String(ta.value || '').trim().length === 0 : false;

  // 4) 不应该还在生成中（停止按钮存在 = 还在跑）
  const generating = Array.from(document.querySelectorAll('button'))
    .some(b => {
      const a = (b.getAttribute('aria-label') || '');
      return visible(b) && (a.includes('停止') || /stop/i.test(a));
    });

  // 5) 消息区应该已清空（用正文长度 + 是否有「助手」气泡双重判断）
  //    这里不追求精确，只要能区分「旧对话残留」和「空对话」即可。
  const bodyLen = (document.body.innerText || '').length;

  return {
    ready: !hasConv && hasTa && taEmpty && !generating,
    hasConv, hasTa, taEmpty, generating, bodyLen,
    url: location.href,
  };
})()`;

/**
 * 等「新对话真正就绪」。
 * @param {object} conn CDP 连接
 * @param {number} maxSec 最长等待秒数
 * @param {object} [opts]
 * @param {number} [opts.settleMs] 判定就绪后再额外静置多久（默认 800ms）
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{ok:boolean, waitedMs:number, last?:object}>}
 */
export async function waitForNewChatReady(conn, maxSec, opts = {}) {
  const log = opts.log || (() => {});
  const settleMs = opts.settleMs == null ? 800 : opts.settleMs;
  const deadline = Date.now() + Math.max(1, maxSec) * 1000;
  const started = Date.now();
  let last = null;
  let okSince = 0;
  let firstSample = null;

  while (Date.now() < deadline) {
    try {
      const r = await conn.Runtime.evaluate({ expression: NEW_CHAT_READY_EXPR, returnByValue: true });
      last = (r && r.result && r.result.value) || null;
      if (!firstSample) firstSample = last;
      if (last && last.ready) {
        // 连续两次判定就绪再算稳定，避免抓到重渲染的中间态
        if (!okSince) {
          okSince = Date.now();
        } else if (Date.now() - okSince >= settleMs) {
          return { ok: true, waitedMs: Date.now() - started, last };
        }
      } else {
        okSince = 0;
      }
    } catch (_) {
      // 导航/重渲染期间 evaluate 可能失败，属预期，继续等
      okSince = 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, waitedMs: Date.now() - started, last };
}

/**
 * 快速判断：当前是否已经在「干净的新对话」里（无需点击/等待）。
 * @param {object} conn CDP 连接
 * @returns {Promise<boolean>}
 */
export async function isAlreadyFreshChat(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: NEW_CHAT_READY_EXPR, returnByValue: true });
    const v = (r && r.result && r.result.value) || null;
    return !!(v && v.ready && !v.hasConv && v.taEmpty);
  } catch (_) {
    return false;
  }
}

/**
 * 【核心】用 DOM 判断「这一轮是否真的结束了」
 *
 * [261123-dom-end] 用户提供了真实 DOM，三个状态可以精确区分：
 *
 *   ① 空输入框（没内容、也没在生成）：
 *      <button aria-label="发送消息" disabled>
 *
 *   ② 有内容待发（用户输入了但没发）：
 *      <button aria-label="发送消息" data-automation-id="chat-send" aria-busy="false">
 *
 *   ③ AI 正在回复：
 *      <button aria-label="停止生成" data-automation-id="chat-stop">
 *
 * 判断「本轮结束」的可靠条件：
 *   - 没有 chat-stop 按钮（不在生成中）
 *   - 有 chat-send 按钮且 disabled（输入框空 = 我们的消息已被消费）
 *
 * 这比等 message_complete 可靠得多 —— 即使结束帧丢了，
 * 只要页面变成「停止按钮消失 + 发送按钮回到 disabled」，就说明它真的干完了。
 */
export const TURN_ENDED_EXPR = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  // 1) 停止按钮：存在 = 正在生成
  const stopBtn = document.querySelector('button[data-automation-id="chat-stop"]');
  const generating = !!stopBtn && visible(stopBtn);

  // 2) 发送按钮：disabled = 输入框空（我们的消息被消费掉了）
  const sendBtn = document.querySelector('button[data-automation-id="chat-send"]')
    || document.querySelector('button[aria-label="发送消息"]');
  const hasSend = !!sendBtn && visible(sendBtn);
  const sendDisabled = hasSend ? !!sendBtn.disabled : null;

  // 3) 输入框是否为空
  const ta = document.querySelector('textarea[placeholder*="提问"]')
    || document.querySelector('textarea');
  const taEmpty = ta ? String(ta.value || '').trim().length === 0 : false;

  // 「本轮已结束」= 不在生成 且 输入框空
  // （输入框空说明我们发的那条已经被页面吃掉了，不会是「还没发出去」）
  const ended = !generating && taEmpty;

  return {
    ended,
    generating,
    hasSend,
    sendDisabled,
    taEmpty,
    hasStopSelector: !!stopBtn,
    url: location.href,
  };
})()`;

/**
 * 用 DOM 判断这一轮是否已结束。
 * @param {object} conn CDP 连接
 * @returns {Promise<{ended:boolean, generating:boolean, taEmpty:boolean, [k:string]:any}>}
 */
export async function isTurnEndedByDom(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: TURN_ENDED_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { ended: false, generating: false, taEmpty: false };
  } catch (_) {
    return { ended: false, generating: false, taEmpty: false, error: true };
  }
}
