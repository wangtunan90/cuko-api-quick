/**
 * Quick 聊天传输层：经 CDP 观测 / 注入聊天 WebSocket 帧
 *
 * 为什么不自己从 Node 连 wss：
 *  - 聊天 WS 的 URL 带 id_token（约 1 小时轮换一次）、ws_host（按租户不同）、
 *    outpostId / workingSessionId / surfaceType 等握手字段；
 *  - 页面自己已经维护着一条可用连接，凭据、刷新、重连都由它负责。
 * 直接经 CDP 复用页面的会话，既不复制登录态，也不承担 token 生命周期。
 *
 * 两级策略（自动选择）：
 *  A. observe（默认）：驱动页面 UI 发送消息，页面自己发上行帧；
 *     我们只通过 Network.webSocketFrameReceived 观测下行帧。
 *     —— 不依赖任何页面内部字段，只要页面能正常聊天就能工作。
 *  B. inject：页面还没有可用连接，或调用方要求「不碰 UI」时，
 *     在页面上下文里自建一条聊天 WebSocket，我们自己收发帧。
 *     —— 需要能从页面存储里读到 id_token / ws_host，读不到就报错。
 *
 * 帧编解码见 quick-protocol.js，协议说明见 docs/quick-protocol.md。
 */
import { encodeUplinkFrame, extractInnerEvents } from './quick-protocol.js';

/** 聊天 WebSocket 的 URL 特征 */
export const CHAT_WS_MARK = 'quickwork-chat-bidirectional-stream';

/** 看见这些事件才认为「这是一条聊天帧」，用于过滤无关 WebSocket 噪音 */
const CHAT_EVENT_HINTS = new Set([
  'session_established', 'connected', 'message_start', 'text_delta', 'thinking_delta',
  'thinking_start', 'thinking_complete', 'text_complete', 'message_complete', 'message_split',
  'turn_usage', 'title_generated', 'stream_ended', 'turn_aborted', 'guardrail_blocked',
  'stream_truncated', 'tool_start', 'tool_arguments', 'tool_progress', 'tool_result',
  'tool_error', 'keepalive', 'message_sources',
  // [261123-event-whitelist] 这些是 agent 多步任务的常规事件，
  // 之前没进白名单会被直接丢弃。虽然不是「结束」事件，但丢了对状态判断有影响。
  'runs_updated', 'task_list_update', 'migrationStatus', 'federate_auth_status',
  'federate_auth_status', 'flows_list_submitted_drafts_result',
]);

/** 判断一条 inner 事件是否属于聊天流 */
export function looksLikeChatEvent(evt) {
  if (!evt || typeof evt !== 'object') return false;
  const t = String(evt.type || '');
  if (CHAT_EVENT_HINTS.has(t)) return true;
  if (t === 'status' && evt.payload && typeof evt.payload === 'object') return true;
  if (t === 'error' && (evt.thread_id || evt.payload)) return true;
  // [261123-event-whitelist] 兜底：带 thread_id 且 payload 是对象的事件，
  // 基本都属于聊天流。白名单是硬编码的，Quick 新增事件类型时
  // 靠这条避免被静默丢弃（曾经因为漏了 thinking_start 导致状态判断出错）。
  if (evt.thread_id && evt.payload && typeof evt.payload === 'object') return true;
  return false;
}

/**
 * 一次请求独占一个通道：挂帧监听、把 chat 事件回调出去。
 */
export class QuickChannel {
  /**
   * @param {object} scope CDP 事件作用域（cdp-connection.createScope()）
   * @param {object} [opts]
   * @param {(evt:object)=>void} [opts.onEvent]
   * @param {(err:object)=>void} [opts.onError]
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor(scope, opts = {}) {
    this.scope = scope;
    this.log = opts.log || console.log;
    this.onEvent = opts.onEvent || null;
    this.onError = opts.onError || null;
    this.buffer = new Uint8Array(0);
    this.closed = false;
    this.frameCount = 0;
    /** 仅统计：见过的 WebSocket URL（调试用） */
    this.seenSockets = new Set();
    /** 若指定，只接受该 requestId 的帧；默认接受所有聊天帧 */
    this.requestId = null;
    this._started = false;
  }

  /** 开始监听 */
  attach() {
    if (this._started) return this;
    this._started = true;

    // 实测（2026-11-23）：页面早在 CDP 连上之前就建好了聊天 WebSocket，
    // webSocketCreated 不会再触发；webSocketFrameReceived 却照常到达。
    // 所以这里不依赖 webSocketCreated 做 gate，只按「事件内容像不像聊天帧」过滤。
    this.scope.Network.webSocketCreated((params) => {
      if (String(params.url || '').includes(CHAT_WS_MARK)) {
        this.seenSockets.add(params.requestId);
        this.log('[Quick] 观察到聊天 WebSocket:', params.requestId);
      }
    });

    this.scope.Network.webSocketFrameReceived((params) => {
      if (this.closed) return;
      if (this.requestId && params.requestId !== this.requestId) return;
      const resp = params.response || {};
      const payload = resp.payloadData;
      if (!payload) return;

      let bytes;
      if (resp.opcode === 1) bytes = new TextEncoder().encode(String(payload));
      else bytes = Uint8Array.from(Buffer.from(String(payload), 'base64'));

      let parsed;
      try {
        parsed = extractInnerEvents(this.buffer, bytes);
      } catch (e) {
        this.log('[Quick] 帧解析异常:', e.message);
        return;
      }
      this.buffer = parsed.rest;
      for (const err of parsed.errors) {
        this.frameCount++;
        if (this.onError) this.onError({ code: err.code, message: err.message });
      }
      for (const evt of parsed.events) {
        const accepted = looksLikeChatEvent(evt);
        // [261123-end-diag] 只记录关键事件和「被过滤」的情况，避免逐帧日志刷屏。
        // message_complete 是否到达是排查「页面结束但客户端收不到」的核心线索。
        if (!accepted) {
          this.log('[帧] 过滤掉未知事件 type=' + String(evt && evt.type));
        } else if (evt && (evt.type === 'message_complete' || evt.type === 'stream_ended' || evt.type === 'turn_aborted')) {
          this.log('[帧] 收到结束类事件 type=' + evt.type + ' thread=' + String(evt.thread_id || ''));
        }
        if (!accepted) continue;
        this.frameCount++;
        if (this.onEvent) this.onEvent(evt);
      }
    });

    this.scope.Network.webSocketClosed((params) => {
      if (this.closed) return;
      if (this.requestId && params.requestId !== this.requestId) return;
      this.log('[Quick] WebSocket 关闭:', params.requestId);
      if (this.onError) this.onError({ code: 'ws_closed', message: '聊天连接已断开' });
    });

    return this;
  }

  /**
   * 在页面里自建一条聊天 WebSocket（策略 B）。
   * 成功返回 'ok'，失败返回具体原因字符串。
   */
  async injectSocket(conn, surfaceType = 'QUICK_WORK_WEB') {
    const script = buildInjectScript(surfaceType);
    let r;
    try {
      r = await conn.Runtime.evaluate({ expression: script, returnByValue: true, awaitPromise: true });
    } catch (e) {
      return 'evaluate 失败: ' + e.message;
    }
    const v = r && r.result && r.result.value;
    if (v !== 'ok') return String(v || '未知失败');
    // 自建 socket 的 requestId 由 webSocketCreated 捕获；这里等它出现
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (this.seenSockets.size) break;
      await new Promise(res => setTimeout(res, 200));
    }
    return 'ok';
  }

  /**
   * 通过页面里自建的 socket 发一条 inner JSON 消息（inject 模式备用）。
   * @param {object} conn CDP 连接
   * @param {object} inner
   */
  async sendViaInjected(conn, inner) {
    // 上行帧同样是 CBOR 包裹的 { payload: <inner JSON 字节> }
    const frame = encodeUplinkFrame(inner);
    const b64 = Buffer.from(frame).toString('base64');
    const expr = [
      '(function () {',
      '  var ws = window.__cukoQuickWs;',
      '  if (!ws || ws.readyState !== 1) return "not-open:" + (ws ? ws.readyState : "null");',
      '  var bin = atob("' + b64 + '");',
      '  var buf = new Uint8Array(bin.length);',
      '  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);',
      '  ws.send(buf.buffer);',
      '  return "ok";',
      '})()',
    ].join('\n');
    const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
    return (r && r.result && r.result.value) === 'ok';
  }

  close() {
    this.closed = true;
  }
}

/**
 * 生成「在页面上下文里建聊天 WebSocket」的注入脚本。
 * id_token / ws_host 从页面存储读取，主进程不持有凭据。
 */
function buildInjectScript(surfaceType) {
  return [
    '(async function () {',
    '  if (window.__cukoQuickWs && window.__cukoQuickWs.readyState === 1) return "ok";',
    '  var looksJwt = function (v) { return typeof v === "string" && v.length > 200 && v.split(".").length === 3; };',
    '  var stores = [];',
    '  try { stores.push(window.localStorage); } catch (e) {}',
    '  try { stores.push(window.sessionStorage); } catch (e) {}',
    '  var pick = function (names, pred) {',
    '    for (var i = 0; i < stores.length; i++) {',
    '      for (var k = 0; k < names.length; k++) {',
    '        try { var v = stores[i].getItem(names[k]); if (v && (!pred || pred(v))) return v; } catch (e) {}',
    '      }',
    '    }',
    '    return null;',
    '  };',
    '  var token = pick(["id_token", "idToken", "quickwork:id_token", "cognito:id_token"], looksJwt);',
    '  if (!token) {',
    '    for (var i = 0; i < stores.length && !token; i++) {',
    '      try {',
    '        for (var j = 0; j < stores[i].length; j++) {',
    '          var key = stores[i].key(j); var val = stores[i].getItem(key);',
    '          if (looksJwt(val)) { token = val; break; }',
    '        }',
    '      } catch (e) {}',
    '    }',
    '  }',
    '  if (!token) return "no-token";',
    '  var wsHost = pick(["ws_host", "wsHost", "quickwork:ws_host"]);',
    '  if (!wsHost) return "no-ws-host";',
    '  var base = /^wss?:\\/\\//.test(wsHost) ? wsHost.replace(/\\/+$/, "") : "wss://" + wsHost;',
    '  var url = base + "/streaming/quickwork-chat-bidirectional-stream"',
    '    + "?surfaceType=" + encodeURIComponent("' + surfaceType + '")',
    '    + "&token=" + encodeURIComponent(token)',
    '    + "&workingSessionId=" + encodeURIComponent(crypto.randomUUID())',
    '    + "&channel=prod";',
    '  var ws = new WebSocket(url);',
    '  ws.binaryType = "arraybuffer";',
    '  window.__cukoQuickWs = ws;',
    '  var opened = await new Promise(function (resolve) {',
    '    var t = setTimeout(function () { resolve(false); }, 20000);',
    '    ws.addEventListener("open", function () { clearTimeout(t); resolve(true); });',
    '    ws.addEventListener("error", function () { clearTimeout(t); resolve(false); });',
    '  });',
    '  if (!opened) return "connect-failed";',
    '  return "ok";',
    '})()',
  ].join('\n');
}
