/**
 * 单轮对话主流程：接收 Cuko 请求 → 驱动页面发送 → 观测聊天帧 → 转成 Cuko SSE
 *
 * 传输策略见 quick-transport.js：
 *   - 默认 observe：页面自己发上行帧，我们只解析下行。
 *   - 页面未就绪/无连接时可切 inject（在页面上下文自建 WS，自己收发）。
 *
 * 结束判定（docs/quick-protocol.md §4.4）：
 *   message_complete 且 continuation_expected !== true  → 本轮结束
 *   stream_ended / turn_aborted                          → 直接结束
 *   error / guardrail_blocked / stream_truncated         → 失败
 */
import { QuickTurnExtractor } from './quick-protocol.js';
import { QuickChannel } from './quick-transport.js';
import { sendUserMessage, waitForComposer, startNewChat, gotoConversation, attachFiles, isGenerating, currentUrl } from './quick-sender.js';
import { cleanupAttachments } from './attachments.js';
import { extractThreadIdFromUrl, parseQuickUrl } from './page.js';

const KEEPALIVE_MS = 20000;

/**
 * 处理一次 Cuko /v1/responses 请求（普通增量对话）。
 * @param {object} ctx
 * @param {import('node:http').ServerResponse} ctx.res
 * @param {object} ctx.payload Cuko 请求体
 * @param {object} ctx.account 账号
 * @param {object} ctx.conn CDP 常驻连接
 * @param {object} ctx.cfg 生效配置方案 values
 * @param {object} ctx.profile 生效配置方案
 * @param {(modelId:string)=>void} ctx.release 释放并发锁
 */
export async function handleChat({ res, payload, account, conn, cfg, profile, release }) {
  const isNewChat = !payload.providerSessionId;
  const log = (...a) => console.log('[Chat]', ...a);

  const extractor = new QuickTurnExtractor();
  let channel = null;
  let dispatched = false;
  let isStreaming = false;
  let sentTextLen = 0;
  let sentThinkLen = 0;
  let sessionIdSent = false;
  let realSessionId = payload.providerSessionId || null;
  let timedOut = false;
  let aborted = false;
  let idleTimer = null;
  let totalTimer = null;
  let keepAliveTimer = null;
  let firstEventSeen = false;

  const clearAllTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  };

  /** 推首帧 / 推增量 */
  const flush = (force) => {
    if (!isStreaming) {
      if (!realSessionId && !payload.providerSessionId && !force) return;
      isStreaming = true;
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify({ output: [], providerSessionId: realSessionId }) + '\n\n');
      if (realSessionId) sessionIdSent = true;
    }
    const data = {};
    let has = false;
    if (extractor.text.length > sentTextLen) {
      data.output = [extractor.text.slice(sentTextLen)];
      sentTextLen = extractor.text.length;
      has = true;
    }
    if (extractor.think.length > sentThinkLen) {
      data.think = extractor.think.slice(sentThinkLen);
      sentThinkLen = extractor.think.length;
      has = true;
    }
    if (has) {
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    }
  };

  /** 拿到真实 thread id 后补推 providerSessionId */
  const pushSessionIdIfNeeded = () => {
    if (sessionIdSent || !realSessionId) return;
    if (!isStreaming) { flush(); return; }
    sessionIdSent = true;
    log('补推 providerSessionId:', realSessionId);
    res.write('event: message\n');
    res.write('data: ' + JSON.stringify({ output: [], providerSessionId: realSessionId }) + '\n\n');
  };

  // [261123-idle-fix] 空闲超时改为可配置（默认 180s）。
  // 语义是「连续这么久没有任何聊天事件」——每个事件都会重置它，
  // 所以只要页面还在输出，这条超时永远不会触发。
  const idleTimeoutMs = Math.max(30000, Math.round(((cfg && cfg.idleTimeoutSec) || 180) * 1000));
  // [261123-idle-fix] 空闲超时不再一刀切：
  // 到点后先问一次页面「还在生成吗」，仍在生成就再给一轮时间。
  // 原因：Quick 思考阶段可能长时间不下发任何事件（实测有超过 2 分钟的静默），
  // 单靠「无事件」判定会误杀正在正常工作的任务。
  let idleStrikes = 0;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleStrikes = 0;   // 收到新事件就把确认计数清零
    idleTimer = setTimeout(async () => {
      if (dispatched || aborted) return;
      const elapsed = Math.round(idleTimeoutMs / 1000);
      const generating = await isGenerating(conn).catch(() => false);
      idleStrikes++;
      // [261123-idle-fix] 只要页面还在生成就不判超时（不设次数上限）。
      // 原因：Quick 的思考阶段可能长时间不下发事件，实测有超过 2 分钟的静默；
      // 用固定次数上限会在「事件稀疏但任务正常」时误杀。
      // 真正的兜底交给「请求总超时」（requestTimeoutSec，默认 900s），
      // 以及页面停止生成后这一轮立刻判超时。
      if (generating) {
        log('已 ' + elapsed + 's 无事件，但页面仍在生成中（第 ' + idleStrikes + ' 次确认），继续等待…');
        resetIdleKeepStrikes();
        return;
      }
      log('空闲超时（' + elapsed + 's 无事件，页面已不在生成），强制结束');
      timedOut = true;
      finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
    }, idleTimeoutMs);
  };

  /** 二次确认时不把 idleStrikes 清零，便于日志统计确认了几次 */
  const resetIdleKeepStrikes = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const keep = idleStrikes;
    idleTimer = setTimeout(async () => {
      if (dispatched || aborted) return;
      const elapsed = Math.round(idleTimeoutMs / 1000);
      const generating = await isGenerating(conn).catch(() => false);
      idleStrikes = keep + 1;
      if (generating) {
        log('已 ' + elapsed + 's 无事件，但页面仍在生成中（第 ' + idleStrikes + ' 次确认），继续等待…');
        resetIdleKeepStrikes();
        return;
      }
      log('空闲超时（' + elapsed + 's 无事件，页面已不在生成），强制结束');
      timedOut = true;
      finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
    }, idleTimeoutMs);
  };

  /** 收尾：推 done 并释放资源 */
  const finish = async () => {
    if (dispatched) return;
    dispatched = true;
    clearAllTimers();
    if (channel) channel.close();

    // 页面 URL 里通常能拿到 thread id，作为续接句柄兜底
    if (!realSessionId) {
      const url = await currentUrl(conn).catch(() => '');
      const tid = extractThreadIdFromUrl(url);
      if (tid) {
        realSessionId = tid;
        log('从页面 URL 提取到 thread id:', tid);
        pushSessionIdIfNeeded();
      }
    }

    try { flush(true); } catch (_) {}

    if (extractor.error && !timedOut) {
      try {
        res.write('event: error\n');
        res.write('data: ' + JSON.stringify({ code: 'provider_unavailable', message: extractor.error }) + '\n\n');
      } catch (_) {}
    } else if (timedOut) {
      try {
        res.write('event: error\n');
        res.write('data: ' + JSON.stringify({ code: 'request_timeout', message: '响应超时，内容可能不完整' }) + '\n\n');
      } catch (_) {}
    }

    const usage = extractor.usage || { total_tokens: 0 };
    try {
      res.write('event: done\n');
      res.write('data: ' + JSON.stringify({
        finishReason: timedOut ? 'timeout' : 'stop',
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
        providerSessionId: realSessionId || undefined,
      }) + '\n\n');
      res.end();
    } catch (_) {}

    log('本轮结束：正文 ' + extractor.text.length + ' 字，思考 ' + extractor.think.length + ' 字，事件 ' + JSON.stringify(extractor.eventCounts));
    // [261123-attach] 清理本轮生成的临时附件，避免磁盘堆积
    if (Array.isArray(payload._attachMeta) && payload._attachMeta.length) {
      cleanupAttachments(payload._attachMeta);
    }
    release();
  };

  // 客户端断开（用户点停止）→ 清理并释放锁
  res.on('close', () => {
    if (!dispatched) {
      log('客户端断开，中止本轮');
      aborted = true;
      clearAllTimers();
      if (channel) channel.close();
      dispatched = true;
      release();
    }
  });

  try {
    // ---------- 1. 页面就绪 ----------
    let st = await waitForComposer(conn, cfg.pageReadyPollMaxSec);
    if (!st) {
      // [261123-autolaunch] Chrome 刚被自动拉起时，页面可能还停在落地页/登录页，
      // 或者根本没加载完。这里自动导航一次到聊天页再等，而不是直接失败。
      const url = await currentUrl(conn);
      log('输入区未就绪（当前 URL=' + url + '），尝试自动导航到聊天页…');
      const navOk = await startNewChat(conn, cfg).catch(() => false);
      if (navOk) {
        st = await waitForComposer(conn, cfg.pageReadyPollMaxSec);
      }
      if (!st) {
        const url2 = await currentUrl(conn);
        throw new Error(
          '页面输入区未就绪（当前 URL: ' + url2 + '）。' +
          '请确认那个 Chrome 窗口里已经登录 quick.aws.com，' +
          '并且能看到聊天输入框。',
        );
      }
    }
    log('页面就绪，输入区选择器=' + st.sel + '，当前 URL=' + (await currentUrl(conn)));

    if (isNewChat) {
      log('新对话请求，先回到新对话页');
      await startNewChat(conn, cfg);
      st = await waitForComposer(conn, cfg.pageReadyPollMaxSec);
      if (!st) throw new Error('新建对话后输入区未就绪');
    } else {
      // [261123-continue-fix] 续接必须真的切到目标会话。
      // 旧实现只在「新建」时动页面，续接时直接用页面当前停留的会话发消息，
      // 导致客户端传了 A 的 providerSessionId、消息却发进了 B，上下文串台。
      const wantId = String(payload.providerSessionId);
      const nav = await gotoConversation(conn, wantId, cfg);
      if (!nav.ok) {
        throw new Error('续接失败：' + nav.error + '。如果你切换过 Quick 账号或清空过登录态，请新建对话。');
      }
      if (nav.navigated) log('已切到目标会话:', wantId);
    }

    // ---------- 2. 挂下行帧监听 ----------
    const scope = conn.createScope();
    channel = new QuickChannel(scope, {
      log,
      onEvent: (evt) => {
        if (aborted || dispatched) return;
        // [261123-idle-fix] 关键修复：每收到一个事件就重置空闲计时器。
        // 旧实现只在「首次收到事件」时 reset 一次，之后再不重置，
        // 结果从首帧算起 120s 一到就无条件判超时 —— 哪怕页面一直在正常输出。
        // 长思考、长回复、agent 多步任务、附件解析慢，全都会撞上这个误报。
        firstEventSeen = true;
        resetIdle();
        // [261123-continue-fix] 续接时如果收到的帧属于别的会话，说明页面根本没切过去。
        // 旧实现静默 return，结果所有事件被丢弃 → 客户端表现成「超时且无输出」，很难排查。
        // 现在直接判失败并说明原因。
        const evtThread = evt.thread_id || (evt.payload && evt.payload.thread_id) || '';
        if (payload.providerSessionId && evtThread && evtThread !== String(payload.providerSessionId)) {
          log('收到其它会话的事件（期望 ' + payload.providerSessionId + '，实际 ' + evtThread + '），判定会话不一致');
          extractor.consume({
            type: 'error',
            payload: { message: '会话不一致：页面在 ' + evtThread + '，期望 ' + payload.providerSessionId },
          });
          finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
          return;
        }
        extractor.consume(evt);
        if (!realSessionId && extractor.threadId) {
          realSessionId = extractor.threadId;
          log('从事件中拿到 thread id:', realSessionId);
          pushSessionIdIfNeeded();
        }
        flush();
        if (extractor.finished || extractor.error) {
          finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
        }
      },
      onError: (err) => {
        if (aborted || dispatched) return;
        log('通道错误:', err.code, err.message);
        if (err.code === 'ws_closed') {
          extractor.consume({ type: 'stream_truncated', payload: { message: err.message } });
          finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
        }
      },
    }).attach();

    // 总超时 + 心跳（覆盖粘贴/等待阶段）
    totalTimer = setTimeout(() => {
      log('请求总超时（' + cfg.requestTimeoutSec + 's），强制结束');
      timedOut = true;
      finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
    }, Math.round((cfg.requestTimeoutSec || 900) * 1000));
    // [261123-idle-fix] 心跳加厚：SSE 注释帧保持连接不被中间层掐断，
    // 同时把已用时长写进注释，方便排查「到底卡了多久」。
    const keepAliveMs = Math.max(5000, Math.round((cfg.keepAliveSec || 20) * 1000));
    const startedAt = Date.now();
    // [261123-finish-fix] 兜底：收到 continuation_expected:true 后，
    // 若后续步骤迟迟不来（约 20s 无任何事件），主动收尾。
    // 否则会永远停在 finished=false，客户端表现成「回复完了但一直等待」。
    const CONTINUATION_GRACE_MS = 20000;
    let continuationCheckedAt = 0;

    keepAliveTimer = setInterval(async () => {
      try {
        if (!res.writableEnded) {
          const el = Math.round((Date.now() - startedAt) / 1000);
          res.write(': keepalive ' + el + 's\n\n');
        }
      } catch (_) {}

      // 只在「等待后续步骤」状态下检查，且每 5 秒最多判一次，避免频繁 query DOM
      if (dispatched || aborted) return;
      if (!extractor.awaitingContinuation) return;
      const now = Date.now();
      if (now - continuationCheckedAt < 5000) return;
      continuationCheckedAt = now;

      const since = now - (extractor.lastEventAt || startedAt);
      if (since < CONTINUATION_GRACE_MS) return;

      // 超过宽限期仍无新事件：先看页面是否还在生成
      const generating = await isGenerating(conn).catch(() => false);
      if (generating) return;   // 还在生成，交给正常的空闲超时机制

      log('后续步骤未到来（' + Math.round(since / 1000) + 's 无事件，页面已停止生成），主动收尾');
      extractor.consume({ type: 'stream_ended', payload: { message: '后续步骤超时' } });
      flush();
      finish().catch((e) => console.warn('[Chat] finish 异常:', e.message));
    }, keepAliveMs);

    // ---------- 3. 发送 ----------
    // 客户端断开后不要再往页面里打字，避免污染会话
    if (aborted) throw new Error('客户端已断开，中止发送');

    // [261123-attach] 先挂附件再填正文：页面在上传完成前不接受发送按钮点击
    const attachPaths = Array.isArray(payload._attachFiles) ? payload._attachFiles : [];
    if (attachPaths.length) {
      log('挂载 ' + attachPaths.length + ' 个附件…');
      const at = await attachFiles(conn, attachPaths, cfg);
      if (!at.ok) throw new Error('附件上传失败: ' + at.error);
      log('附件已就绪');
    }

    const r = await sendUserMessage(conn, payload._text, cfg, {
      skipPreEnterWait: payload.type === 'user',
      hasAttachments: attachPaths.length > 0,
    });
    if (!r.ok) throw new Error(r.error || '发送失败');
    log('消息已发出，等待 Quick 响应…');

    // 发送完成后再开始空闲计时（粘贴/等待阶段不算卡死）
    resetIdle();

    // 若短时间内没有任何事件，可能是页面没有真的发出，给出提示但不立即失败
    setTimeout(async () => {
      if (dispatched || aborted || firstEventSeen) return;
      const gen = await isGenerating(conn).catch(() => false);
      log('尚未收到任何聊天事件（页面生成中=' + gen + '），继续等待…');
    }, 15000);
  } catch (err) {
    console.error('[Chat] 失败:', err.message);
    if (!res.writableEnded) {
      try {
        res.write('event: error\n');
        res.write('data: ' + JSON.stringify({ code: 'internal_error', message: err.message }) + '\n\n');
        res.end();
      } catch (_) {}
    }
    clearAllTimers();
    if (channel) channel.close();
    if (!dispatched) { dispatched = true; release(); }
  }
}
