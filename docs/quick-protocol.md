# Amazon Quick 网页版聊天协议（实测）

> 目标：`https://quick.aws.com/sn/account/<awsAccountId>/start/chat`
> 抓包时间：2026-11-23，实测环境：Chrome 157 + 已登录企业账号 261414899405
> 本文所有结论均来自 Chrome DevTools Protocol（`Network.webSocketFrame*Received/Sent`）的真实抓包，
> 原始帧样本见 `test/fixtures/quick-turn-in.json` / `quick-turn-out.json`。

---

## 一、结论速览

| 问题 | 实测结论 |
|---|---|
| 网页端是 WebSocket 还是 HTTP SSE？ | **WebSocket**，与桌面端同一条路径：`wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream` |
| 帧编码 | **AWS event-stream**（binary frame），payload 为 **CBOR**（`application/cbor`） |
| 输入框 | 原生 `<textarea>`，无 id/class，placeholder「提问或键入 @ 以提醒代理...」 |
| 发送按钮 | `button[aria-label="发送消息"]`，输入为空时 `disabled` |
| 会话 ID | `thread_id` / `conversationId`，形如 UUID，出现在网页 URL 的 `?conversationId=` 上 |

---

## 二、双向 WebSocket

### 2.1 连接

页面自己会在进入聊天页时建立连接，URL 形如：

```
wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
  ?surfaceType=QUICK_WORK_WEB
  &token=<id_token>
  &workingSessionId=<uuid>
  &channel=prod
```

**重要工程结论**：这条连接在 CDP 客户端连上来之前就已经建好，
因此 `Network.webSocketCreated` **不会**再触发；但 `Network.webSocketFrameReceived`
照常到达。所以不要用 `webSocketCreated` 做前置 gate，应当直接按帧内容过滤。

### 2.2 帧结构

上行、下行都是 **AWS event-stream** 消息：

```
[4B totalLen][4B headersLen][4B preludeCRC]
[headers...]
[payload...]
[4B messageCRC]
```

实测 headers：

| 方向 | headers |
|---|---|
| 下行 | `:event-type=rawOutputEvent`, `:content-type=application/cbor`, `:message-type=event` |
| 上行 | `:event-type=rawInputEvent`, `:content-type=application/cbor`, `:message-type=event` |

> 桌面端用的是 `application/json` + base64，本项目两种都兼容
> （见 `bridge/quick-protocol.js` 的 `decodeOuterPayload`）。

### 2.3 payload 是 CBOR

payload 不是 JSON 字符串，而是一个 **CBOR map**：

```
A1                      # map(1)
   67 7061796C6F6164    # "payload"
   59 0120 <bytes>      # bytes(288)  —— 内容是 inner JSON 的 UTF-8 字节
```

解出来就是 inner JSON：

```json
{
  "type": "text_delta",
  "payload": { "delta": "我是 AWS ", "kernel_thread_id": "..." },
  "message_id": "msg-...",
  "thread_id": "3e079448-101e-4a95-a95b-a3a942443ba8",
  "scope": "chat",
  "timestamp": 1795408395820
}
```

---

## 三、下行事件

一次完整对话实测到的事件（按时间顺序）：

| type | 说明 |
|---|---|
| `message_start` | 一条 assistant 消息开始，`payload.role="assistant"` |
| `runs_updated` | 运行状态噪音，可忽略 |
| `task_list_update` | 任务列表噪音，可忽略 |
| `title_generated` | 会话标题生成，`payload.conversation_id` 即 thread id |
| `keepalive` | 心跳，`{"type":"keepalive","ts":...}` |
| `text_delta` | **正文增量**，`payload.delta` |
| `thinking_delta` | 思考增量（该账号实测大多不出现） |
| `turn_usage` | 用量：`input_tokens`/`output_tokens`/`cache_read_tokens`/`total_tokens`/`served_model_id` |
| `text_complete` | 本条消息全文兜底 `payload.text` |
| `message_complete` | 消息完成；`payload.continuation_expected !== true` 表示本轮结束 |

### 3.1 一轮结束的判定

- `message_complete` 且 `payload.continuation_expected !== true` → **本轮结束**
- `stream_ended` / `turn_aborted` → 直接结束
- `error` / `guardrail_blocked` / `stream_truncated` → 失败

agentic 多步任务会连续发多轮 `message_start … message_complete`，
前几轮带 `continuation_expected: true`。

### 3.2 用量字段的坑

`turn_usage.total_tokens` 是**整个上下文**的累计（实测 70000+，含约 70000 的 prompt cache），
不是本轮增量。Cuko 的 `usage.total_tokens` 用它没问题，但不要拿它做「本轮到目前花了多少」的估算。

---

## 四、上行事件

实测页面发第一条消息时的 inner JSON 字段（`user_message`）：

```
traceId, text, send_origin, had_physical_input, appVersion, acp_first_text,
user_notification, subtask_progress, external_agent_sign_in, recents_promotion,
self_registering_connectors, message_id, thread_id, agent_mode, thinking_effort,
user_timezone, user_locale, custom_prompt, chat_agent_id, auto_routing,
web_search_enabled, direct_chat, voice_mode, voice_id, tts_speed
```

关键字段：

| 字段 | 说明 |
|---|---|
| `text` | 用户输入全文 |
| `thread_id` | 会话 ID；新建对话时由调用方生成 |
| `agent_mode` | `fast` / `balanced` / `smart` / `advanced` |
| `message_id` | 本条消息 ID |
| `custom_prompt` | 逐轮指令 |

上行还有 `federate_status`、`flows_list_submitted_drafts`、`dock_state_sync` 等非对话消息，可忽略。

---

## 五、页面 DOM（实测）

### 5.1 输入框

```
TEXTAREA                              placeholder="提问或键入 @ 以提醒代理..."
  └ SPAN
    └ DIV.mention-highlight-wrapper
      └ DIV.input-card-body
        └ DIV.input-card.qs\:shadow-md
          └ DIV.home-input-anchor       （对话页换成消息区锚点）
            └ DIV.home-layout-skeleton
              └ DIV.empty-state
```

- 原生 textarea，**没有** id / class / data-testid / aria-label，只能靠 placeholder 或「最后一个可见 textarea」定位。
- 直接赋 `value` 不会触发 React 状态更新，**发送按钮一直是 disabled**。
  必须用原生 setter + 派发 `input` 事件：

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(el, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

### 5.2 发送 / 停止 / 新对话

| 元素 | 选择器 |
|---|---|
| 发送 | `button[aria-label="发送消息"]`（空输入时 `disabled=true`） |
| 停止 | 生成中出现，`aria-label` 含「停止」/「Stop」 |
| 新对话 | `button`，文本「新对话」 |
| 模式 | `button[title="智能 模式"]`（fast/balanced/smart/advanced） |

---

## 六、本项目采用的技术路线

```
Cuko 客户端 --HTTP/SSE--> bridge/index.js --CDP--> 独立 Chrome --user-data-dir--> quick.aws.com
```

1. **发送**：填 textarea（原生 setter + input 事件）→ 等发送按钮可用 → 点按钮（失败回退 CDP 回车）→ 用「输入框清空 / 出现停止按钮」确认已发。
2. **接收**：CDP `Network.webSocketFrameReceived` → 拆 event-stream → 解 CBOR → 按事件类型归并成 Cuko 的 `output` / `think` / `usage`。
3. **会话续接**：把 `thread_id` 作为 `providerSessionId` 回传给客户端；续接时导航到 `?conversationId=<id>`。

### 6.1 为什么不让 Node 自己连 WebSocket

- `token` 是 1 小时轮换的 id_token，`ws_host` 按租户不同，还涉及 `surfaceType`/`workingSessionId` 等握手字段；
- 页面本来就维护着一条可用连接，凭据刷新、重连都由它负责。
- 直接复用页面的会话，既不复制登录态，也不承担 token 生命周期。

---

## 七、文件附件（实测）

页面里有一个**隐藏的** `input[type=file]`（`accept=*`、`multiple=true`）。
用 CDP 的 `DOM.setFileInputFiles` 把本地绝对路径写进去，页面会自动走完整上传：

```
POST /sn/account/<id>/qbsproxy/qs-file-proxy/accounts/<id>/attachments/presigned-url   ← 200
POST /sn/account/<id>/qbsproxy/quicksight/dlp/internal/<id>/data-loss-prevention/job/describe-user-aware  ← 200
POST /sn/account/<id>/qbsproxy/quicksight/accounts/<id>/invocations/files/upload/<threadId>  ← 200
```

上传成功后输入区上方出现附件卡片，发送时模型能读到文件内容。

**验证方法**：往文件里写一串独有暗号（如 `紫水晶-7788`），问模型暗号是什么。
实测模型准确答出，说明内容确实被完整读取（而不是只挂了个空卡片）。

**注意**：
- 必须在 `DOM.enable()` 之后才能用 `setFileInputFiles`
- 上传是异步的，要等 `files/upload` 返回或附件卡片出现，再点发送
- 纯附件消息的 textarea 本来就是空的，不能因为「输入框为空」判定发送失败

## 八、心跳与长静默

Quick 的下行帧里有 `keepalive` 事件（`{"type":"keepalive","ts":...}`），
但**不能依赖它判断任务是否还活着**：实测长任务中间可能出现
**连续 39 秒没有任何帧**（思考阶段），而页面其实在正常生成。

因此本项目的超时判定不只看「有没有帧」，还会在超时到点时
探测页面上的**停止生成按钮**：按钮还在 = 仍在生成 = 继续等。

## 十、临时分支会话

在页面上对消息点「编辑」或「重新生成」时，Quick 会给这次操作分配**临时分支 ID**，
形如 `branch-498dd9e9`（对应 localStorage 里的 `quickwork-draft-branch-<id>`）。

特征：
- 不是 UUID，和主会话 ID **没有包含关系**
- 下行事件的 `thread_id` 会变成这个分支 ID
- 页面 URL 里的 `conversationId` 仍然是主会话 UUID

**实测（2026-11-23）：分支可以当会话句柄用。**
把 `?conversationId=branch-498dd9e9` 直接导航，服务端返回的是**完整的同一会话内容**
（能看到主会话全部历史）；在该 URL 下发消息能正常完成，事件的 `thread_id`
仍然是 `branch-498dd9e9`，且可连续续接。

因此实现里：
- `thread_id` 校验对 `branch-*` 放行（视为同会话）
- `branch-*` 可回传作为 `providerSessionId`，支持后续续接

## 九、已知限制

- **单账号单并发**：同一账号同时只允许一轮对话（页面上只有一份输入区）。
- **无文件/图片输入**：当前版本只做文本；Quick 的附件走独立的 `upload-attachment` + `files/upload` 流程，未实现。
- **`webSocketCreated` 不可依赖**：见 2.1。
- **页面必须停在聊天页**：浏览器被用户导航到别的页面后，请求会失败并给出明确错误。
