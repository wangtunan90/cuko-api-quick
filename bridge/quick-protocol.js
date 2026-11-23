/**
 * Amazon Quick 聊天 WebSocket 协议编解码
 *
 * 传输结构（浏览器 ↔ Quick 服务端，桌面端与网页端同构）：
 *   上行 binary frame = UTF8 JSON
 *     { "eventType": "rawInputEvent", "payload": { "payload": "<base64(utf8(inner JSON))>" } }
 *   下行 binary frame = AWS event-stream 消息
 *     headers: :message-type=event, :event-type=rawOutputEvent
 *     body   = JSON { "payload": "<base64(utf8(inner JSON))>" }
 *
 * inner JSON 形如 { "type": "text_delta", "thread_id": "...", "payload": {...} }
 *
 * 本模块只做纯解码 + 状态归并，不碰 CDP / HTTP，便于单测。
 * 协议细节见 docs/quick-protocol.md。
 */

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

// ============ AWS event-stream 帧解析 ============
// 12B prelude(totalLen/headersLen/preludeCrc) + headers + payload + 4B messageCrc
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const HV = { BOOL_TRUE: 0, BOOL_FALSE: 1, BYTE: 2, SHORT: 3, INT: 4, LONG: 5, BYTES: 6, STRING: 7, TIMESTAMP: 8, UUID: 9 };

/**
 * 从字节缓冲区里尽可能多地取出完整 event-stream 消息。
 * @param {Uint8Array} buffer
 * @returns {{ messages: Array<{headers: object, payload: Uint8Array}>, consumed: number }}
 */
export function esDrain(buffer) {
  const messages = [];
  const n = buffer.length;
  let pos = 0;
  while (pos + 16 <= n) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + pos);
    const totalLen = view.getUint32(0, false);
    // 长度不合法：说明流已错位（或不是 event-stream），逐个字节前移重新同步
    if (totalLen < 16 || totalLen > 16 * 1024 * 1024) { pos += 1; continue; }
    if (pos + totalLen > n) break; // 还没收全
    const headersLen = view.getUint32(4, false);
    const hstart = pos + 12;
    const hend = hstart + headersLen;
    const headers = {};
    let j = hstart;
    try {
      while (j < hend) {
        const nl = buffer[j++];
        const name = td.decode(buffer.slice(j, j + nl)); j += nl;
        const vt = buffer[j++];
        if (vt === HV.BOOL_TRUE) headers[name] = true;
        else if (vt === HV.BOOL_FALSE) headers[name] = false;
        else if (vt === HV.BYTE) { headers[name] = buffer[j]; j += 1; }
        else if (vt === HV.SHORT) { headers[name] = (buffer[j] << 8) | buffer[j + 1]; j += 2; }
        else if (vt === HV.INT) { headers[name] = new DataView(buffer.buffer, buffer.byteOffset + j).getUint32(0, false); j += 4; }
        else if (vt === HV.LONG || vt === HV.TIMESTAMP) {
          let v = 0; for (let k = 0; k < 8; k++) v = v * 256 + buffer[j + k];
          headers[name] = v; j += 8;
        } else if (vt === HV.BYTES || vt === HV.STRING) {
          const l = (buffer[j] << 8) | buffer[j + 1]; j += 2;
          const raw = buffer.slice(j, j + l); j += l;
          headers[name] = vt === HV.STRING ? td.decode(raw) : raw;
        } else if (vt === HV.UUID) { headers[name] = buffer.slice(j, j + 16); j += 16; }
        else break;
      }
      const payload = buffer.slice(hend, pos + totalLen - 4);
      messages.push({ headers, payload });
    } catch { /* 畸形消息：跳过 */ }
    pos += totalLen;
  }
  return { messages, consumed: pos };
}

// ============ CBOR 编解码 ============
// 实测（quick.aws.com 网页端，2026-11-23）：下行帧 header 为
//   :content-type = application/cbor
// payload 是一个 CBOR map：{ "payload": <byte string，内容是 inner JSON 的 UTF-8 字节> }
// 桌面端用的是 JSON+base64，两者都要兼容，所以这里按 content-type 分支处理。
// 只实现本协议用到的子集：map / text / byte string / array / 无符号/负数，固化长度与不定长都支持。

/**
 * 解一条 CBOR 值。
 * @param {Uint8Array|Buffer} buf
 * @param {number} [offset]
 * @returns {{ value: any, offset: number }}
 */
export function cborDecodeAt(buf, offset = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const initial = buf[offset++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  // 读长度 / 立即数
  let len = info;
  if (info === 24) { len = buf[offset]; offset += 1; }
  else if (info === 25) { len = dv.getUint16(offset); offset += 2; }
  else if (info === 26) { len = dv.getUint32(offset); offset += 4; }
  else if (info === 27) { len = Number(dv.getBigUint64(offset)); offset += 8; }
  else if (info === 31) len = -1; // 不定长

  switch (major) {
    case 0: return { value: len, offset };                                  // 无符号整数
    case 1: return { value: -1 - len, offset };                             // 负整数
    case 2: {                                                               // byte string
      if (len === -1) {
        const chunks = [];
        while (buf[offset] !== 0xff) {
          const r = cborDecodeAt(buf, offset);
          chunks.push(Buffer.from(r.value));
          offset = r.offset;
        }
        return { value: Buffer.concat(chunks), offset: offset + 1 };
      }
      return { value: Buffer.from(buf.subarray(offset, offset + len)), offset: offset + len };
    }
    case 3: {                                                               // text string
      if (len === -1) {
        let out = '';
        while (buf[offset] !== 0xff) {
          const r = cborDecodeAt(buf, offset);
          out += r.value;
          offset = r.offset;
        }
        return { value: out, offset: offset + 1 };
      }
      return { value: td.decode(buf.subarray(offset, offset + len)), offset: offset + len };
    }
    case 4: {                                                               // array
      const arr = [];
      if (len === -1) {
        while (buf[offset] !== 0xff) {
          const r = cborDecodeAt(buf, offset);
          arr.push(r.value);
          offset = r.offset;
        }
        return { value: arr, offset: offset + 1 };
      }
      for (let i = 0; i < len; i++) {
        const r = cborDecodeAt(buf, offset);
        arr.push(r.value);
        offset = r.offset;
      }
      return { value: arr, offset };
    }
    case 5: {                                                               // map
      const obj = {};
      const readPair = () => {
        const k = cborDecodeAt(buf, offset); offset = k.offset;
        const v = cborDecodeAt(buf, offset); offset = v.offset;
        obj[String(k.value)] = v.value;
      };
      if (len === -1) {
        while (buf[offset] !== 0xff) readPair();
        return { value: obj, offset: offset + 1 };
      }
      for (let i = 0; i < len; i++) readPair();
      return { value: obj, offset };
    }
    case 6: {                                                               // tag：忽略标签，解其后的值
      return cborDecodeAt(buf, offset);
    }
    case 7: {                                                               // 简单值
      if (info === 20) return { value: false, offset };
      if (info === 21) return { value: true, offset };
      if (info === 22) return { value: null, offset };
      return { value: null, offset };
    }
    default:
      throw new Error('不支持的 CBOR 主类型: ' + major);
  }
}

/** 解一条 CBOR 值（顶层） */
export function cborDecode(buf) {
  return cborDecodeAt(buf, 0).value;
}

/**
 * 编码本协议用的最小 CBOR：{ payload: <byte string> }
 * @param {string} innerJson inner JSON 文本
 * @returns {Uint8Array}
 */
export function cborEncodePayload(innerJson) {
  const body = Buffer.from(innerJson, 'utf8');
  const head = [0xa1, 0x67]; // map(1)
  for (const ch of 'payload') head.push(ch.charCodeAt(0));
  if (body.length < 24) head.push(0x40 | body.length);
  else if (body.length < 256) head.push(0x58, body.length);
  else if (body.length < 65536) head.push(0x59, (body.length >> 8) & 0xff, body.length & 0xff);
  else head.push(0x5a, (body.length >>> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff);
  return new Uint8Array(Buffer.concat([Buffer.from(head), body]));
}

/**
 * 把 event-stream 的 payload 还原成 inner JSON 对象。
 * 兼容两种线上格式：
 *  - application/cbor：CBOR map { payload: bytes(inner JSON) }
 *  - application/json：{ payload: base64(inner JSON) }（桌面端）
 * @param {Uint8Array} payload
 * @param {string} [contentType]
 * @returns {object|null}
 */
export function decodeOuterPayload(payload, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const tryJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

  if (ct.includes('cbor')) {
    let outer;
    try { outer = cborDecode(Buffer.from(payload)); } catch { outer = null; }
    if (!outer || !outer.payload) return null;
    const inner = Buffer.isBuffer(outer.payload) ? outer.payload.toString('utf8') : String(outer.payload);
    return tryJson(inner);
  }

  // JSON 分支（桌面端 / 兼容）
  const outer = tryJson(td.decode(payload));
  if (!outer || !outer.payload) return null;
  if (typeof outer.payload === 'string') {
    // 可能是 base64，也可能直接是 inner JSON 文本
    if (outer.payload.trim().startsWith('{')) return tryJson(outer.payload);
    try { return tryJson(Buffer.from(outer.payload, 'base64').toString('utf8')); } catch { return null; }
  }
  return null;
}

// ============ base64 helper（Node 与浏览器都可用） ============
const b64encode = (str) => Buffer.from(str, 'utf8').toString('base64');
const b64decode = (s) => Buffer.from(s, 'base64').toString('utf8');

/**
 * 上行帧编码：构造完整的 AWS event-stream 消息（binary frame）
 *
 * 实测（quick.aws.com 网页端，2026-11-23）上行也是 event-stream：
 *   headers: :event-type=rawInputEvent, :content-type=application/cbor, :message-type=event
 *   payload: CBOR map { payload: <inner JSON 的 UTF-8 字节> }
 * 桌面端用的是 JSON base64 版本，这里统一按实测的 CBOR 版本产出。
 *
 * @param {object|string} innerJson
 * @returns {Uint8Array} 完整 binary frame
 */
export function encodeUplinkFrame(innerJson) {
  const json = typeof innerJson === 'string' ? innerJson : JSON.stringify(innerJson);
  return buildEventStreamFrame(
    { ':event-type': 'rawInputEvent', ':content-type': 'application/cbor', ':message-type': 'event' },
    cborEncodePayload(json),
  );
}

/**
 * 构造一条 AWS event-stream 消息。
 * @param {Record<string,string>} headers 全部按 string 类型编码
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function buildEventStreamFrame(headers, payload) {
  const parts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(String(value), 'utf8');
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    h[o++] = n.length; n.copy(h, o); o += n.length;
    h[o++] = 7; // string 类型
    h.writeUInt16BE(v.length, o); o += 2;
    v.copy(h, o);
    parts.push(h);
  }
  const headersBuf = Buffer.concat(parts);
  const total = 12 + headersBuf.length + payload.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headersBuf.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const body = Buffer.concat([prelude, headersBuf, Buffer.from(payload)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return new Uint8Array(Buffer.concat([body, tail]));
}

/**
 * 下行帧 → inner 事件对象。
 * @param {{headers: object, payload: Uint8Array}} esMessage
 * @returns {{kind:'event'|'error'|'skip', event?: object, code?: string, message?: string}}
 */
export function decodeEventStreamMessage(esMessage) {
  const mt = esMessage.headers[':message-type'];
  if (mt === 'error' || mt === 'exception') {
    return {
      kind: 'error',
      code: String(esMessage.headers[':error-code'] || esMessage.headers[':exception-type'] || 'error'),
      message: String(esMessage.headers[':error-message'] || td.decode(esMessage.payload).slice(0, 300)),
    };
  }
  if (esMessage.headers[':event-type'] !== 'rawOutputEvent' || esMessage.payload.length === 0) {
    return { kind: 'skip' };
  }
  const evt = decodeOuterPayload(esMessage.payload, esMessage.headers[':content-type']);
  if (!evt) return { kind: 'skip' };
  return { kind: 'event', event: evt };
}

/**
 * 上行帧解码（用于从 CDP webSocketFrameSent 里认出我们发出的 user_message）。
 * @param {string} payloadData CDP 给的 payloadData（opcode=2 时是 base64）
 * @param {number} opcode 1=text, 2=binary
 * @returns {object|null} inner JSON
 */
export function decodeUplinkFrame(payloadData, opcode) {
  try {
    let bytes;
    if (opcode === 1) bytes = te.encode(String(payloadData));
    else {
      const raw = Buffer.from(String(payloadData), 'base64');
      bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    // 上行是完整 event-stream 消息：先拆外层，再按 content-type 解 payload
    const { messages } = esDrain(bytes);
    for (const m of messages) {
      const evt = decodeOuterPayload(m.payload, m.headers[':content-type']);
      if (evt) return evt;
    }
    // 兼容裸 JSON 帧
    return JSON.parse(td.decode(bytes));
  } catch { return null; }
}

/** 下行一帧里可能有多条 event-stream 消息，统一拆成 inner 事件数组 */
export function extractInnerEvents(buffer, incomingBytes) {
  const merged = new Uint8Array(buffer.length + incomingBytes.length);
  merged.set(buffer); merged.set(incomingBytes, buffer.length);
  const { messages, consumed } = esDrain(merged);
  const events = [];
  const errors = [];
  for (const m of messages) {
    const r = decodeEventStreamMessage(m);
    if (r.kind === 'event') events.push(r.event);
    else if (r.kind === 'error') errors.push({ code: r.code, message: r.message });
  }
  return { rest: merged.slice(consumed), events, errors };
}

// ============ 事件归并状态机 ============
/** 这些事件代表本轮彻底结束 */
const TERMINAL_EVENTS = new Set(['stream_ended', 'turn_aborted']);
/** 这些事件代表失败 */
const FAILURE_EVENTS = new Set(['error', 'guardrail_blocked', 'stream_truncated']);

/**
 * 把 Quick 的下行事件流归并成 Cuko 需要的 { text, think, finished, ... }。
 *
 * 归并规则（依据 docs/quick-protocol.md §4.4）：
 *  - text_delta 逐字追加到当前 assistant 消息
 *  - message_complete 且 continuation_expected !== true → 本轮结束
 *  - agentic 多步时会有多个 message_start…message_complete 循环，
 *    每段正文之间用空行分隔
 *  - text_complete / message_complete 的 payload.text 是全文兜底，
 *    比已累积的长时用差分补发
 */
export class QuickTurnExtractor {
  constructor() {
    this._text = '';
    this._think = '';
    /** [261123-finish-fix] 是否收到过 continuation_expected:true（表示还有后续步骤） */
    this._awaitingContinuation = false;
    /** 最后一次收到事件的时间戳，用于「后续步骤迟迟不来」的兜底判定 */
    this._lastEventAt = 0;
    /** 当前消息已累积的正文（用于和 message_complete 的全文做差分） */
    this._curMsg = '';
    /** 已经推给客户端的正文长度（跨消息累计） */
    this._emittedLen = 0;
    this._msgCount = 0;
    this._finished = false;
    this._error = null;
    this._usage = null;
    this._threadId = '';
    this._eventCounts = Object.create(null);
  }

  /** 本段消息开始前插入分隔（多段 agentic 输出之间） */
  _sepIfNeeded() {
    if (this._msgCount > 0 && this._text.length > 0 && !this._text.endsWith('\n\n')) {
      this._text += '\n\n';
    }
    this._msgCount++;
    this._curMsg = '';
  }

  _appendText(delta) {
    if (typeof delta !== 'string' || !delta) return;
    this._text += delta;
    this._curMsg += delta;
  }

  _appendThink(delta) {
    if (typeof delta !== 'string' || !delta) return;
    this._think += delta;
  }

  /**
   * 消费一条 inner 事件。
   * @param {object} evt inner JSON
   */
  consume(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = String(evt.type || '');
    this._eventCounts[type] = (this._eventCounts[type] || 0) + 1;
    this._lastEventAt = Date.now();
    if (evt.thread_id) this._threadId = evt.thread_id;
    const p = (evt.payload && typeof evt.payload === 'object') ? evt.payload : {};

    switch (type) {
      case 'message_start':
        // [261123-finish-fix] 关键：message_start 表示「又开始了新的一段」。
        // 实测 agent 多步任务里会出现：
        //   message_complete（第一段，不带 continuation_expected）
        //   → message_start（下一段开始）
        // 如果按「收到 message_complete 就结束」处理，会过早收尾，
        // 或者反过来 —— 第一段完成后已经 finish，后续内容全部丢失。
        // 这里收到 message_start 时撤销 finished 标记，让这一轮继续。
        if (this._finished) {
          this._finished = false;
          this._eventCounts['__reopened'] = (this._eventCounts['__reopened'] || 0) + 1;
        }
        this._sepIfNeeded();
        break;

      case 'text_delta':
        this._appendText(p.delta != null ? p.delta : p.text);
        break;

      case 'thinking_delta':
        this._appendThink(p.delta != null ? p.delta : p.text);
        break;

      case 'thinking_complete':
        if (typeof p.thinking === 'string' && p.thinking.length > this._think.length) this._think = p.thinking;
        break;

      case 'text_complete':
        this._reconcileMessageText(p.text);
        break;

      case 'message_complete': {
        this._reconcileMessageText(p.text);
        if (Array.isArray(p.tool_calls) && p.tool_calls.length) {
          // Quick 自带工具由服务端执行，这里只记录，不进正文
        }
        // [261123-finish-fix] continuation_expected:true 表示后面还有步骤。
        // 但如果后续步骤因为超时/丢帧/服务端提前收尾而永远不来，
        // 旧实现会永远停在 finished=false，客户端表现成「回复完了但一直等待」。
        // 这里记下这个状态，由上层按「末段时间」兜底收尾。
        if (p.continuation_expected === true) {
          this._awaitingContinuation = true;
        } else {
          this._finished = true;
          this._awaitingContinuation = false;
        }
        break;
      }

      case 'turn_usage': {
        const input = Number(p.input_tokens);
        const output = Number(p.output_tokens);
        const total = Number(p.total_tokens);
        this._usage = {
          input_tokens: Number.isFinite(input) ? input : 0,
          output_tokens: Number.isFinite(output) ? output : 0,
          total_tokens: Number.isFinite(total) ? total : ((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)),
        };
        if (Number.isFinite(Number(p.cache_read_tokens))) this._usage.cache_read_tokens = Number(p.cache_read_tokens);
        if (p.resolved_model_id || p.served_model_id) this._usage.model = p.served_model_id || p.resolved_model_id;
        break;
      }

      case 'stream_ended':
      case 'turn_aborted':
        this._finished = true;
        break;

      case 'error':
        this._error = p.message || p.error || p.reason || 'Quick 返回错误';
        break;

      case 'guardrail_blocked':
        this._error = p.message || '内容被安全策略拦截';
        break;

      case 'stream_truncated':
        this._error = p.message || '响应被截断';
        break;

      default:
        break;
    }

    if (FAILURE_EVENTS.has(type) && !this._error) this._error = 'Quick 返回 ' + type;
    if (TERMINAL_EVENTS.has(type)) this._finished = true;
  }

  /**
   * 用服务端给的全文校正当前消息：
   * 正常情况正文由 text_delta 给全，这里只处理「delta 缺失/更短」的兜底。
   */
  _reconcileMessageText(fullText) {
    if (typeof fullText !== 'string' || !fullText) return;
    if (fullText.length > this._curMsg.length && fullText.startsWith(this._curMsg)) {
      const rest = fullText.slice(this._curMsg.length);
      this._text += rest;
      this._curMsg = fullText;
    }
  }

  /** 尚未推送给客户端的增量正文 */
  takeTextDelta() {
    if (this._text.length <= this._emittedLen) return '';
    const d = this._text.slice(this._emittedLen);
    this._emittedLen = this._text.length;
    return d;
  }

  get text() { return this._text; }
  get think() { return this._think; }
  get finished() { return this._finished; }
  /** 是否有「未兑现的后续步骤」 */
  get awaitingContinuation() { return this._awaitingContinuation; }
  /** 最后一次收到事件的时间戳 */
  get lastEventAt() { return this._lastEventAt; }
  get error() { return this._error; }
  get usage() { return this._usage; }
  get threadId() { return this._threadId; }
  get eventCounts() { return { ...this._eventCounts }; }
}

/** 白名单：哪些 Quick 事件类型需要写日志（避免 PII 与噪音） */
export const LOGGABLE_EVENT_TYPES = [
  'session_established', 'connected', 'status', 'message_start', 'text_delta',
  'thinking_delta', 'thinking_complete', 'text_complete', 'message_complete',
  'turn_usage', 'message_split', 'title_generated', 'error', 'guardrail_blocked',
  'stream_truncated', 'turn_aborted', 'stream_ended', 'keepalive',
  'tool_start', 'tool_arguments', 'tool_progress', 'tool_result', 'tool_error',
];
