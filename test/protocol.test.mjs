/**
 * 协议层回归测试（用真实抓包样本）
 *
 * 样本：test/fixtures/quick-turn-in.json（下行）/ quick-turn-out.json（上行）
 * 抓取时间：2026-11-23，quick.aws.com 网页版真实对话
 *
 * 运行：npm test
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  esDrain, decodeOuterPayload, decodeEventStreamMessage, decodeUplinkFrame,
  encodeUplinkFrame, extractInnerEvents, QuickTurnExtractor,
} from '../bridge/quick-protocol.js';
import { parseQuickUrl, buildConversationUrl, isOnConversation, extractThreadIdFromUrl, buildChatUrl, isMainSessionId, isBranchSessionId, isThreadAcceptable } from '../bridge/page.js';
import { DEFAULT_PROFILE_VALUES, validateProfile } from '../bridge/default-config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../bridge/runtime-config.js';
import { getVersion } from '../bridge/version.js';
import { splitOversizedTexts, materializeFileItems, TEXT_TO_FILE_THRESHOLD, safeFileName, cleanupAttachments } from '../bridge/attachments.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

const FIX = path.join(import.meta.dirname, 'fixtures');
const loadFrames = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const toBytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

test('拆帧：单条下行消息结构正确', () => {
  const frames = loadFrames('quick-turn-in.json');
  const { messages, consumed } = esDrain(toBytes(frames[0].b64));
  assert.equal(messages.length, 1);
  assert.equal(consumed, Buffer.from(frames[0].b64, 'base64').length);
  assert.equal(messages[0].headers[':event-type'], 'rawOutputEvent');
  assert.equal(messages[0].headers[':content-type'], 'application/cbor');
});

test('CBOR 解码：第一条是 message_start', () => {
  const frames = loadFrames('quick-turn-in.json');
  const { messages } = esDrain(toBytes(frames[0].b64));
  const evt = decodeOuterPayload(messages[0].payload, messages[0].headers[':content-type']);
  assert.equal(evt.type, 'message_start');
  assert.equal(evt.payload.role, 'assistant');
  assert.ok(/^[0-9a-f-]{36}$/.test(evt.thread_id), 'thread_id 应是 UUID');
});

test('完整一轮：正文 / 用量 / 结束 / threadId', () => {
  const frames = loadFrames('quick-turn-in.json');
  const ex = new QuickTurnExtractor();
  let count = 0;
  for (const f of frames) {
    for (const m of esDrain(toBytes(f.b64)).messages) {
      const r = decodeEventStreamMessage(m);
      if (r.kind === 'event') { count++; ex.consume(r.event); }
    }
  }
  assert.ok(count >= 20, '事件数应 >= 20，实际 ' + count);
  assert.ok(ex.text.indexOf('AWS Quick') >= 0, '正文应包含 AWS Quick');
  assert.equal(ex.finished, true);
  assert.equal(ex.error, null);
  assert.equal(ex.usage.total_tokens, 70310);
  assert.equal(ex.threadId, '3e079448-101e-4a95-a95b-a3a942443ba8');
});

test('分片重组：按 7 字节切片结果一致且无残留', () => {
  const frames = loadFrames('quick-turn-in.json');
  const bytes = new Uint8Array(Buffer.concat(frames.map((f) => Buffer.from(f.b64, 'base64'))));
  let buf = new Uint8Array(0);
  const events = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const r = extractInnerEvents(buf, bytes.subarray(i, Math.min(i + 7, bytes.length)));
    buf = r.rest;
    events.push(...r.events);
  }
  assert.equal(buf.length, 0);
  const ex = new QuickTurnExtractor();
  for (const e of events) ex.consume(e);
  assert.ok(ex.text.indexOf('AWS Quick') >= 0);
  assert.equal(ex.finished, true);
});

test('上行帧：编码后能被自己解回', () => {
  const inner = { type: 'user_message', payload: { thread_id: 't-1', text: '你好', agent_mode: 'smart' } };
  const frame = encodeUplinkFrame(inner);
  assert.equal(Buffer.from(frame).readUInt32BE(0), frame.length);
  const back = decodeUplinkFrame(Buffer.from(frame).toString('base64'), 2);
  assert.deepEqual(back, inner);
});

test('上行帧：真实抓包样本可解析出 user_message', () => {
  const frames = loadFrames('quick-turn-out.json');
  const parsed = frames.map((f) => decodeUplinkFrame(f.b64, 2)).filter(Boolean);
  const userMsg = parsed.find((x) => x.type === 'user_message');
  assert.ok(userMsg, '应能解出一条 user_message');
  assert.equal(userMsg.payload.agent_mode, 'smart');
  assert.equal(typeof userMsg.payload.text, 'string');
});

test('状态机：agentic 多段用空行分隔', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: '第一步' } });
  ex.consume({ type: 'message_complete', payload: { text: '第一步', continuation_expected: true } });
  assert.equal(ex.finished, false);
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: '第二步' } });
  assert.equal(ex.text, '第一步\n\n第二步');
  ex.consume({ type: 'message_complete', payload: { text: '第二步' } });
  assert.equal(ex.finished, true);
});

test('状态机：错误事件被记录', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'error', payload: { message: '炸了' } });
  assert.equal(ex.error, '炸了');
});

test('状态机：text_complete 全文兜底', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_complete', payload: { text: '只有全文' } });
  assert.equal(ex.text, '只有全文');
});

// ============ 会话 URL 解析（续接依赖它，回归重点） ============
const CA = '090212b4-1268-44cf-843e-2e7f6faa9857';
const CB = '6484c36d-7e7c-431d-b410-57456fb59201';
const ACCT = '261414899405';
const chatUrl = (cid) => 'https://quick.aws.com/sn/account/' + ACCT + '/start/chat' + (cid ? '?conversationId=' + cid : '');

test('URL 解析：带会话', () => {
  assert.deepEqual(parseQuickUrl(chatUrl(CA)), { accountId: ACCT, conversationId: CA });
});

test('URL 解析：不带会话', () => {
  assert.deepEqual(parseQuickUrl(chatUrl()), { accountId: ACCT, conversationId: null });
});

test('URL 解析：多查询参数', () => {
  const u = 'https://quick.aws.com/sn/account/' + ACCT + '/start/chat?foo=1&conversationId=' + CA + '&bar=2';
  assert.equal(parseQuickUrl(u).conversationId, CA);
});

test('URL 解析：非法输入不抛异常', () => {
  assert.deepEqual(parseQuickUrl(''), { accountId: null, conversationId: null });
  assert.deepEqual(parseQuickUrl('https://example.com/x'), { accountId: null, conversationId: null });
});

test('构造会话 URL 后能被解析回', () => {
  const built = buildConversationUrl(ACCT, CB);
  assert.equal(parseQuickUrl(built).conversationId, CB);
  assert.equal(parseQuickUrl(built).accountId, ACCT);
});

test('会话判定：只有 id 完全相同才算在同一会话', () => {
  assert.equal(isOnConversation(chatUrl(CA), CA), true);
  assert.equal(isOnConversation(chatUrl(CB), CA), false);
  assert.equal(isOnConversation(chatUrl(), CA), false);
  assert.equal(isOnConversation(chatUrl(CA), ''), false);
});

test('extractThreadIdFromUrl 与 parseQuickUrl 一致', () => {
  assert.equal(extractThreadIdFromUrl(chatUrl(CA)), CA);
  assert.equal(extractThreadIdFromUrl(chatUrl()), null);
});

// ============ 入口页（/sn vs /sn/start）============
test('默认 targetUrl 用 /sn/start，不是落地页 /sn', () => {
  assert.equal(DEFAULT_PROFILE_VALUES.targetUrl, 'https://quick.aws.com/sn/start');
});

test('buildChatUrl：有账号 ID 时直达聊天页', () => {
  assert.equal(buildChatUrl('261414899405'), 'https://quick.aws.com/sn/account/261414899405/start/chat');
});

test('buildChatUrl：没有账号 ID 时兜底到 /sn/start（绝不能是 /sn）', () => {
  assert.equal(buildChatUrl(null), 'https://quick.aws.com/sn/start');
  assert.equal(buildChatUrl(''), 'https://quick.aws.com/sn/start');
  assert.equal(buildChatUrl(undefined), 'https://quick.aws.com/sn/start');
});

test('/sn/start 本身解析不出账号，跳转后才有', () => {
  assert.equal(parseQuickUrl('https://quick.aws.com/sn/start').accountId, null);
  assert.equal(parseQuickUrl('https://quick.aws.com/sn/account/261414899405/start/chat').accountId, '261414899405');
});

// ============ 超长文本转附件 ============
test('阈值是 20000', () => {
  assert.equal(TEXT_TO_FILE_THRESHOLD, 20000);
});

test('不超过阈值的文本原样直发', () => {
  const r = splitOversizedTexts([{ kind: 'text', text: 'x'.repeat(20000) }]);
  assert.equal(r.files.length, 0);
  assert.equal(r.inlineTexts.length, 1);
});

test('超过阈值转成附件，并生成摘要', () => {
  const r = splitOversizedTexts([{ kind: 'text', text: 'y'.repeat(20001) }]);
  assert.equal(r.files.length, 1);
  assert.equal(r.inlineTexts.length, 0);
  assert.equal(r.summaryNotes.length, 1);
  assert.ok(r.summaryNotes[0].includes('已作为附件发送'));
  cleanupAttachments(r.files);
});

test('文件名清洗掉 Windows 非法字符', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

// ============ base64 文件项 ============
test('base64 文件项落盘且内容一致', () => {
  const content = '暗号：测试-1234';
  const r = materializeFileItems([{
    kind: 'file', filename: 'x.txt', mimeType: 'text/plain',
    data: Buffer.from(content, 'utf8').toString('base64'),
  }]);
  assert.equal(r.files.length, 1);
  assert.equal(r.errors.length, 0);
  assert.ok(r.files[0].fileName.endsWith('.txt'), '应保留扩展名');
  const back = fs.readFileSync(r.files[0].filePath, 'utf8');
  assert.equal(back, content);
  cleanupAttachments(r.files);
});

test('base64 支持 data:URL 前缀', () => {
  const b64 = Buffer.from('hello', 'utf8').toString('base64');
  const r = materializeFileItems([{ kind: 'file', filename: 'a.md', data: 'data:text/plain;base64,' + b64 }]);
  assert.equal(r.files.length, 1);
  cleanupAttachments(r.files);
});

test('空 data 与非法 base64 都要报错，不产生垃圾文件', () => {
  const r1 = materializeFileItems([{ kind: 'file', filename: 'e.txt', data: '' }]);
  assert.equal(r1.files.length, 0);
  assert.equal(r1.errors.length, 1);

  const r2 = materializeFileItems([{ kind: 'file', filename: 'b.txt', data: '!!!bad!!!' }]);
  assert.equal(r2.files.length, 0);
  assert.equal(r2.errors.length, 1);
});

test('只用 file 项、text 项不受影响', () => {
  const b64 = Buffer.from('z', 'utf8').toString('base64');
  const r = materializeFileItems([{ kind: 'text', text: 'hi' }, { kind: 'file', filename: 'z.txt', data: b64 }]);
  assert.equal(r.files.length, 1);
  cleanupAttachments(r.files);
});

// ============ 心跳 / 超时配置 ============
test('配置里有 keepAliveSec 与 idleTimeoutSec', () => {
  assert.equal(DEFAULT_PROFILE_VALUES.keepAliveSec, 20);
  assert.equal(DEFAULT_PROFILE_VALUES.idleTimeoutSec, 180);
});

test('空闲超时默认比旧硬编码 120s 更宽松', () => {
  assert.ok(DEFAULT_PROFILE_VALUES.idleTimeoutSec >= 180,
    '默认空闲超时应该 >= 180s，实际 ' + DEFAULT_PROFILE_VALUES.idleTimeoutSec);
});

test('requestTimeoutSec 仍是总兜底，且大于 idleTimeoutSec', () => {
  assert.ok(DEFAULT_PROFILE_VALUES.requestTimeoutSec > DEFAULT_PROFILE_VALUES.idleTimeoutSec);
});

test('新字段能被校验并接受合法值', () => {
  const v = validateProfile({ keepAliveSec: 10, idleTimeoutSec: 300 });
  assert.equal(v.keepAliveSec, 10);
  assert.equal(v.idleTimeoutSec, 300);
});

test('新字段拒绝负数', () => {
  let threw = false;
  try { validateProfile({ idleTimeoutSec: -1 }); } catch { threw = true; }
  assert.ok(threw, '负数应该被拒绝');
});

// ============ 启动后自动打开管理后台 ============
test('autoOpenAdmin 默认开启', () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.autoOpenAdmin, true);
});

test('openInBrowser 是函数且空 URL 直接返回 false', async () => {
  const { openInBrowser } = await import('../bridge/open-browser.js');
  assert.equal(typeof openInBrowser, 'function');
  assert.equal(await openInBrowser(''), false);
});

// ============ 版本号 ============
test('getVersion 在开发环境能读出 package.json 的版本', async () => {
  const v = getVersion();
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0, '版本号不应为空');
  assert.ok(/^\d+\.\d+\.\d+/.test(v), '版本号格式应形如 x.y.z，实际 ' + v);
});

test('getVersion 多次调用结果稳定（有缓存）', () => {
  assert.equal(getVersion(), getVersion());
});

// ============ 后续步骤未到来的兜底 ============
test('continuation_expected:true 会置 awaitingContinuation', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_complete', payload: { text: 'p1', continuation_expected: true } });
  assert.equal(ex.finished, false);
  assert.equal(ex.awaitingContinuation, true);
});

test('后续步骤正常到来时清空 awaitingContinuation', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_complete', payload: { text: 'p1', continuation_expected: true } });
  ex.consume({ type: 'message_complete', payload: { text: 'p2' } });
  assert.equal(ex.finished, true);
  assert.equal(ex.awaitingContinuation, false);
});

test('stream_ended 能终结「等待后续」状态（兜底收尾用）', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_complete', payload: { text: 'p1', continuation_expected: true } });
  assert.equal(ex.finished, false);
  ex.consume({ type: 'stream_ended', payload: { message: '后续步骤超时' } });
  assert.equal(ex.finished, true);
});

test('lastEventAt 会随事件更新', async () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', payload: {} });
  const t1 = ex.lastEventAt;
  assert.ok(t1 > 0, '应该记录时间戳');
  await new Promise((r) => setTimeout(r, 30));
  ex.consume({ type: 'text_delta', payload: { delta: 'x' } });
  assert.ok(ex.lastEventAt >= t1, '后续事件应更新时间戳');
});

// ============ 临时分支会话 branch-* ============
// 用户在页面上「编辑消息 / 重新生成」时，Quick 会分配 branch-xxx 形式的临时分支 ID。
// 它和主会话 UUID 没有包含关系，旧实现做严格相等比对会误报「会话不一致」。
const MAIN_SID = 'd486e356-3056-417c-92d0-6811a37889d3';
const BRANCH_SID = 'branch-498dd9e9';

test('主会话 ID 是 UUID，branch 不是', () => {
  assert.equal(isMainSessionId(MAIN_SID), true);
  assert.equal(isMainSessionId(BRANCH_SID), false);
});

test('能识别 branch-* 形态', () => {
  assert.equal(isBranchSessionId(BRANCH_SID), true);
  assert.equal(isBranchSessionId('branch-abc123'), true);
  assert.equal(isBranchSessionId(MAIN_SID), false);
});

test('临时分支应按同会话接受，不报「会话不一致」', () => {
  assert.equal(isThreadAcceptable(BRANCH_SID, MAIN_SID).ok, true);
  assert.equal(isThreadAcceptable(BRANCH_SID, MAIN_SID).reason, 'branch');
});

test('branch 自己续接自己也应被接受', () => {
  assert.equal(isThreadAcceptable(BRANCH_SID, BRANCH_SID).ok, true);
});

test('完全相同自然接受', () => {
  assert.equal(isThreadAcceptable(MAIN_SID, MAIN_SID).ok, true);
});

test('真正的不同会话仍然拒绝', () => {
  const other = 'aaaa1111-2222-3333-4444-555566667777';
  assert.equal(isThreadAcceptable(other, MAIN_SID).ok, false);
  assert.equal(isThreadAcceptable(other, MAIN_SID).reason, 'mismatch');
});

test('无 thread 或无期望值时放行', () => {
  assert.equal(isThreadAcceptable('', MAIN_SID).ok, true);
  assert.equal(isThreadAcceptable(MAIN_SID, '').ok, true);
});

// ============ 完成后又继续（agent 多步）============
test('message_complete 之后又来 message_start 会重新打开', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', thread_id: 't', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: '第一段' } });
  ex.consume({ type: 'message_complete', payload: { text: '第一段' } });
  assert.equal(ex.finished, true);

  // 实测会出现：第一段完成后，agent 又发 message_start 开始下一步
  ex.consume({ type: 'message_start', thread_id: 't', payload: {} });
  assert.equal(ex.finished, false, '不应停留在已完成状态');
});

test('重新打开后能继续累积正文，最终正常结束', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: 'A' } });
  ex.consume({ type: 'message_complete', payload: { text: 'A' } });
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: 'B' } });
  ex.consume({ type: 'message_complete', payload: { text: 'B' } });
  assert.equal(ex.finished, true);
  assert.ok(ex.text.includes('A') && ex.text.includes('B'), '两段内容都要保留，实际: ' + ex.text);
});

test('thinking_start 属于聊天事件（曾在白名单里缺失）', async () => {
  const { looksLikeChatEvent } = await import('../bridge/quick-transport.js');
  assert.equal(looksLikeChatEvent({ type: 'thinking_start', thread_id: 't', payload: {} }), true);
});

test('带 thread_id 的未知事件类型也放行（防止新增类型被丢）', async () => {
  const { looksLikeChatEvent } = await import('../bridge/quick-transport.js');
  assert.equal(looksLikeChatEvent({ type: 'some_future_event', thread_id: 't', payload: { x: 1 } }), true);
  // 没有 thread_id 也没有 payload 的仍然过滤
  assert.equal(looksLikeChatEvent({ type: 'random_noise' }), false);
});
