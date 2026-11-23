---
id: 261123-quick-web-provider
type: feature
title: Amazon Quick 网页版接入 Cuko API
status: doing
branch: feat/261123-quick-web-provider
created: 2026-11-23
updated: 2026-11-23
---

## 背景

已有 `one-chrome-ex`（DeepSeek）和 `cuko-api-gpt`（ChatGPT）两个 Cuko Provider，
都通过 CDP 控制独立 Chrome 驱动网页版聊天。现在需要把 **Amazon Quick 网页版**
（`https://quick.aws.com/sn/account/<awsAccountId>/start/chat`）也接进来。

与两个姊妹项目最大的不同：**Quick 网页端聊天走 WebSocket，不是 HTTP SSE**。
Cuko 的 `POST /v1/responses` 却是 SSE 契约，中间需要一个桥。

## 目标

1. `GET /v1/models`、`POST /v1/responses` 按 `docs/cuko-api-v1.md` 工作。
2. 新建对话、会话续接、历史压缩三种请求都能跑通。
3. 多账号（独立 Chrome profile + 独立调试端口）。
4. 管理台能加账号、看健康、配参数。

## 方案

### 传输选型

不自己从 Node 连 `wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`，理由：

- URL 里的 `token` 是 1 小时轮换的 id_token，`ws_host` 按租户不同；
- 还有 `surfaceType`/`outpostId`/`workingSessionId`/`channel` 等握手字段；
- 页面本来就维护着一条可用连接，凭据刷新、重连都由它负责。

改为：**驱动页面 UI 发送 + 经 CDP 观测下行帧**。
发送时点页面自己的发送按钮，页面自己发上行帧；我们只在
`Network.webSocketFrameReceived` 上做解析。

### 协议解析

下行帧是 **AWS event-stream**（12B prelude + headers + payload + 4B CRC），
payload 是 **CBOR**（`application/cbor`）的 `{payload: <bytes>}`，里面才是 inner JSON。

`bridge/quick-protocol.js` 实现：

- `esDrain()`：字节流拆帧，支持半包/粘包；
- `cborDecode()`：手写 CBOR 子集解码（map/text/bytes/array/整数）；
- `decodeOuterPayload()`：同时兼容 CBOR 与桌面端的 JSON+base64；
- `QuickTurnExtractor`：把事件流归并成 `{text, think, usage, finished, error, threadId}`。

### 发送

页面输入框是原生 `<textarea>`（React 受控）。直接改 `value` 不更新状态，
发送按钮一直是 `disabled`。必须：

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(el, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

发送优先点 `button[aria-label="发送消息"]`，回车作兜底。
判定「已发出」：输入框清空，或页面出现停止按钮。

### 会话续接

Quick 的 `thread_id` 就是会话句柄。第一轮从下行事件
（`message_start.thread_id` / `title_generated.payload.conversation_id`）里拿，
作为 `providerSessionId` 回给客户端；客户端下次带上它就续接。

## 验收标准

- [x] `GET /v1/models` 返回账号列表
- [x] `POST /v1/responses` 新建对话，SSE 流式返回正文
- [x] 首帧带 `providerSessionId`
- [x] 续接对话保持上下文（实测：问「刚才让你记的数字」答对）
- [x] `type: "compress"` 返回新 session
- [x] 并发锁（同模型第二轮 429）
- [x] 客户端断开后清理并释放锁
- [x] 账号健康检查
- [x] 协议层单测 9/9（真实抓包样本）
- [x] 管理台可加账号 / 看状态 / 配参数
- [ ] 文件/图片输入
- [ ] 账号组转移对话

## 修订记录

### 261123-continue-fix：续接没有真正切换会话

**问题**：客户端传了 `providerSessionId`，消息仍发到页面当前停留的会话里。
实测「建 A（记 111）→ 建 B（记 222）→ 续接 A 问数字」，Quick 答 **222**。

**根因**：`chat.js` 只在 `isNewChat` 时动页面，续接分支没有任何导航逻辑，
全仓库搜不到 `conversationId` 的使用。

**修法**：
- `page.js` 新增 `parseQuickUrl` / `buildConversationUrl` / `isOnConversation`
- `quick-sender.js` 新增 `gotoConversation`：解析账号 ID → 导航 → 等 URL 切换 → 等输入区
- `waitForComposer` 改为 250ms 细轮询并容忍导航过渡期的 evaluate 异常
  （导航后 1~2 秒内会给页面上下文重建，旧实现会在这段耗掉预算后误判失败）
- 续接时若收到别的 thread 的事件，从「静默丢弃」改为「明确报错」，
  避免表现成无输出的超时

**验收**：A→B→A 来回切换，分别答出 111 / 222 / 111；新增 7 项 URL 单测。

### 261123-entry-fix：入口页用错，永远进不了聊天页

**问题**：`targetUrl` 默认值 `https://quick.aws.com/sn` 是**产品落地页**
（Features / Pricing / Sign in），实测等 18 秒也只有 7441 字符的介绍内容、
`textarea` 恒为 0，服务必然报「输入区未就绪」。

**根因**：真正的聊天页是 `/sn/account/<账号ID>/start/chat`，
而账号 ID 我们并不知道，旧代码的兜底又直接导航到落地页。

**修法**：
- `targetUrl` 默认值改为 `https://quick.aws.com/sn/start` —— 实测会自动
  路由到带账号 ID 的聊天页（约 10s 出输入框）
- 新增 `detectAccountId()`：按「当前 URL → cookie `qs-directory-alias` →
  cookie `aws-directoryUserInfo` → localStorage ARN」四级探测账号 ID
- `startNewChat()` 改为三段式：点「新对话」按钮 → 有账号 ID 就直达聊天页
  → 都没有则退回 `/sn/start`
- `chrome.js` 与 `buildChatUrl()` 的兜底全部从 `/sn` 改成 `/sn/start`

**验收**：单测覆盖 `buildChatUrl` 三种入参 + 默认值 + 路由后解析，共 20 项全过；
已确认代码中不再有裸 `/sn` 字面量。

### 261123-autolaunch：Chrome 被关掉后不会自动拉起

**现象**：关闭 Chrome 后再发对话，客户端报
「Provider 内部错误，请稍后重试。（connect ECONNREFUSED 127.0.0.1:9222）」。

**根因**：`/v1/responses` 直接调用 `getConnection()`，它只连「已经存在的」
调试端口，连不上就抛错。`ensureChrome()` 早就有（健康检查在用），
但请求路径从来没调过它。

**修法**：
- `chrome.js` 新增 `ensureConnection()`：端口活着直接连；不通则
  `ensureChrome()` 拉起 → 等端口就绪 → 再连。失败时抛出可操作的错误
  （列出没装 Chrome / 端口被占 / 需要登录三种排查方向），而不是原始 ECONNREFUSED。
- `index.js` 的请求路径改用 `ensureConnection`。
- `chat.js` 在「输入区未就绪」时不再直接失败，先自动导航一次到聊天页再等，
  覆盖「Chrome 刚拉起、页面还停在入口」的情况。

**验收**（真机，Chrome 完全关闭状态发请求）：
```
[Chrome] 账号 quick-main 调试端口 9222 不通，自动启动 Chrome…
[Chrome] 账号 quick-main 已启动，端口就绪
[CDP-conn] connected: quick-main port 9222
[Chat] 页面就绪 … 本轮结束：正文 2 字
```
全程 17.5s，客户端无报错。

### 261123-attach：超长文本转附件 + 支持 Cuko 文件项

**背景**：Cuko 客户端会把工具调用结果当普通文本发来，动辄几万字符。
直接塞输入框又慢又容易被页面截断。

**可行性验证（先做再写代码）**：
发现页面里有隐藏的 `input[type=file]`，用 CDP `DOM.setFileInputFiles` 注入后，
页面自己走完 presigned-url → DLP → files/upload。然后往文件里埋暗号问模型，
模型准确答出 —— 确认附件内容能被读到，方案成立。

**实现**：
- 新增 `bridge/attachments.js`：超长文本落盘（阈值 20000 字符）、
  base64 文件项落盘、文件名清洗、临时文件清理
- `quick-sender.js` 新增 `attachFiles()`：注入文件 → 等上传完成 → 等附件卡片
- `cdp-connection.js` 暴露 DOM 域（原本只有 Runtime/Input/Network/Page）
- `chat.js` 发送前挂附件，结束后清理临时文件
- `index.js` 接分流逻辑，不再丢弃 file 项

**边界处理**：
- base64 做字符集校验 + 回编码比对，非法数据报错而不是写垃圾文件
- 空 data、data:URL 前缀、无扩展名、300KB 大文件都覆盖到

**验收**（真机 E2E，四种输入）：
① 普通短文本 ✅  ② 续接上下文 ✅
③ 24014 字符转附件，模型答出暗号 ✅  ④ base64 文件项，模型答出暗号 ✅

测试：28 项单测全过（新增 8 项覆盖分流与 base64）。

### 261123-idle-fix：长任务误报「响应超时」

**现象**：用户反馈长任务会报
「⚠️ 请求超时，请重试。（响应超时，内容可能不完整）」。

**根因**（两层）：
1. 空闲计时器**只在首帧重置一次**，之后再不重置。
   从首帧算起 120 秒一到就无条件判超时，哪怕页面一直在正常输出。
2. 即使改成「每个事件都重置」，如果事件间隔超过阈值（Quick 思考阶段
   可能静默很久），仍然会误报。用模拟台验证过：阈值 1s、事件间隔 1.5s 时，
   「仅每事件重置」会误报 20 次。

**修法**（三层保障）：
- 每收到一个事件就 `resetIdle()`
- 到点后**二次确认**：探测页面停止按钮，仍在生成就继续等，**不设次数上限**
- 真正的兜底交给 `requestTimeoutSec`（默认 900s）

**新增配置项**：
- `keepAliveSec`（默认 20）：SSE 心跳间隔
- `idleTimeoutSec`（默认 180）：空闲超时阈值

心跳帧同时带上已用时长（`: keepalive 40s`），便于排查。

**验收**：
- 模拟台三层对比（旧实现 / 仅每事件重置 / 无限确认），
  最终语义为「生成中零误报，停止后正常超时」
- 真机长任务：80.3 秒、中间连续 39 秒无事件，正常完成 4386 字，
  心跳在 20/40/60 秒准时发出

### 261123-open-admin：启动后自动打开管理后台

**背景**：exe 双击启动后只弹一个命令行窗口，用户不知道该去浏览器敲地址。

**实现**：
- 新增 `bridge/open-browser.js`：三级兜底打开默认浏览器
  1. `cmd /c start "" "<url>"`（最轻量）
  2. `rundll32 url.dll,FileProtocolHandler`
  3. PowerShell `Start-Process`
  任一成功即可，全部失败只打日志、不影响服务
- `runtime-config.js` 增加 `autoOpenAdmin` 开关（默认 true），
  支持 true/false/"false"/0/1 多种写法归一化
- `index.js` 在 listen 回调里触发

**验证**：
- 启动日志出现「已尝试打开管理台」，Chrome 窗口标题确认为
  `cuko-api-quick 管理台` —— 浏览器确实被打开了
- `autoOpenAdmin: false` 时不打开，日志提示手动访问
- 值归一化 7 种输入全部正确（含缺省、空配置、文件不存在时回退默认 true）

### 261123-finish-fix：回复完了但一直等待

**现象**：AI 回复内容已经生成完，但 SSE 不结束，客户端一直转圈。

**根因（两条）**：

1. **重复发送**：点击发送后页面反应慢（>6s 才进入生成中），`waitSent` 判失败，
   于是回退到物理回车 —— 同一条消息发了两次，产生两个 thread 和两条响应流。
   客户端只消费第一条流的 done，第二条流没人读。

2. **后续步骤未兑现**：收到 `message_complete` 且 `continuation_expected: true`
   （表示后面还有步骤）后，如果下一步因为丢帧或服务端提前收尾没来，
   extractor 永远停在 `finished=false`。

用状态机模拟验证过：只有 `continuation_expected:true` 单独出现时，
旧实现确实永不结束。

**修法**：
- 回退回车**之前先二次确认**（等 3s 观察是否已进入生成中 / 输入框是否已清空），
  确认「真的没发出去」才重试。日志里出现「二次确认：点击其实已生效，跳过回退」
- extractor 记录 `awaitingContinuation` 和 `lastEventAt`
- 心跳定时器顺带检查：等待后续步骤超过 **20s** 且页面已停止生成 → 主动收尾

**验收**：同一会话连发 3 轮，全部正常收到 done（22s / 42s / 43s），
日志中每个请求只有一次「已确认发送」，零次回退回车。
新增 4 项状态机单测，合计 41 项全过。

### 261123-branch-fix：编辑消息后报「会话不一致」

**现象**：在 Quick 页面上修改/重新生成对话后，再发请求报
「Provider 不可用（会话不一致：页面在 branch-498dd9e9，期望 d486e356-...）」。

**根因**：`branch-498dd9e9` 是 Quick 给「编辑/重新生成」分配的**临时分支 ID**，
不是主会话 UUID，两者也没有包含关系。旧实现用严格相等比对 `thread_id`，
把分支误判成「另一个会话」直接报错。

**修法**：
- `page.js` 新增 `isMainSessionId` / `isBranchSessionId` / `isThreadAcceptable`
- `chat.js` 的会话校验改用 `isThreadAcceptable`：`branch-*` 视为同会话放行，
  真正的不同会话仍然拒绝
- 不把 `branch-*` 当作 `providerSessionId` 回传（否则下次续接会失效）
- 客户端若真拿 `branch-*` 来续接，给出可操作提示（请新建对话）

**验收**：同一会话连续 3 轮续接全部正常（6.1s / 7.1s / 7.2s）；
新增 6 项分支判定单测，合计 47 项全过。

### 261123-branch-resume：支持用 branch-* 续接对话

此前为了保守，把 `branch-*` 当成「不可续接的临时状态」，续接时直接报错。
用户要求「就想用分支继续对话」，于是实测确认可行性：

1. 导航 `?conversationId=branch-498dd9e9` → 服务端加载出**完整主会话内容**
   （页面里能看到主会话的全部历史消息）
2. 在该 URL 下发消息 → 正常完成，事件 `thread_id` 仍是 `branch-498dd9e9`
3. 连续两次用它续接 → 都成功，服务端如实回传该 ID

结论：分支是**同一会话的可寻址视图**，可以当会话句柄长期使用。

改动：
- 解除 `chat.js` 里「branch 无法续接」的硬性报错
- 恢复把 `branch-*` 作为 `providerSessionId` 回传
- `finish` 里从 URL 兜底取会话 ID 时也不再排除 branch

**验收**：分支续接 2 轮成功（9.0s / 11.4s），session 均正确回传
`branch-498dd9e9`。单测增至 48 项全过。

### 261123-finish-v2：网页结束了但客户端收不到结束

上一版修了「重复发送」和「continuation 未兑现」，但用户反馈仍有卡住。

抓完整事件流后发现两个真问题：

1. **`message_complete` 不代表本轮结束**。实测序列是
   `message_complete → message_start → ... → message_complete`，
   第一段完成时 `continuation_expected` 甚至是 undefined。
   按「收到 message_complete 就结束」会过早收尾；而只认 continuation_expected 又判断不了。

2. **事件白名单漏了 `thinking_start`**，这类事件被静默丢弃。
   白名单是硬编码的，Quick 新增类型时必然再漏。

修法：
- `QuickTurnExtractor`：收到 `message_start` 时若之前已 finished，撤销该标记（重新打开本轮）
- `chat.js`：结束改为**延迟确认** —— `message_complete` 后挂 3s 定时器，
  期间又来 `message_start` 就取消收尾
- `CHAT_EVENT_HINTS` 补 `thinking_start`、`message_sources`、`runs_updated` 等
- 增加兜底：带 `thread_id` 且 payload 是对象的未知事件一律放行

**验收**：之前必卡的多步任务（branch 会话）跑 202 秒、输出 47581 字，
正常收到 done；日志出现「已确认本轮结束」。单测增至 52 项全过。

### 261123-chrome-detect：扩大 Chrome 路径自动探测

**问题**：用户报「未找到 chrome.exe，请在配置方案里指定 chromePath」。
原实现只探测 Program Files 和 Program Files (x86) 两个写死路径，
而 Chrome 支持**免管理员安装**（装到 `%LOCALAPPDATA%`），这类用户必然探测失败。

**修法**（探测顺序）：
1. 配置里指定的 `chromePath`（存在才用，不存在会告警并继续往下找）
2. 注册表 `App Paths\chrome.exe`（HKLM + HKCU，能覆盖自定义目录）
3. `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`
4. `%ProgramFiles%\...` / `%ProgramFiles(x86)%\...`
5. 写死的两个兜底路径
6. `msedge.exe` 作为最后兜底（同为 Chromium，CDP 参数通用）

失败时会把**试过的所有路径**打进日志，方便用户直接看出该填什么。

顺带修了 `chrome.js` 里在 ESM 模块内用 `require` 的问题。

**验收**：4 项路径解析单测全过（自动探测 / 坏路径回退 / 空串 / 指定有效路径），
合计 56 项；启动日志不再出现「未找到 chrome.exe」。

### 261123-chrome-ui：管理台引导用户填写 Chrome 路径

**背景**：即使扩大自动探测，仍可能有人的 Chrome 装在探测不到的位置
（绿色版、自定义目录、多版本共存）。此前的表现是「添加账号后控制台打一行
警告」，用户完全不知道该干什么。

**方案**（用户提出）：管理台检测到没有 Chrome 时，直接让用户填路径。

**实现**：
- `GET /api/chrome/detect`：返回 `found` / `path` / `candidates`（含每个是否存在的标记）
- `POST /api/chrome/path`：保存用户手填路径到 `data/config.json`，
  校验三项：非空、文件存在、必须以 `.exe` 结尾
- `/api/info` 附带 `chrome` 字段，管理台启动即可知道要不要提示
- 管理台顶部提示条：显示输入框 + 「保存并检测」+ 可展开的候选路径列表
- `resolveChromePath` 把「用户配置」放在最高优先级，
  且不受自动探测结果影响（对所有账号生效，包括只读的默认方案）

**验收**（后端接口全测）：
| 场景 | 结果 |
|---|---|
| 空路径 | ✅ 400「请填写完整路径」 |
| 不存在的文件 | ✅ 400「文件不存在」 |
| 填了文件夹 | ✅ 400「请填到 .exe 文件」 |
| 有效路径 | ✅ 200，写入 config.json，detect 立即反映 |
| 本机已装 Chrome | ✅ 提示条隐藏 |

UI 在真实浏览器验证：提示条显示/隐藏正常、保存错误路径时 toast 正确提示、无 JS 错误。
单测增至 57 项全过。

### 261123-account-edit：已有账号可修改配置

**问题**：账号建好后只能「改名」，没法切换配置方案。
而后端 `PUT /api/accounts/:id` 其实早就支持 `modelName` 和 `profileId`，
只是管理台没暴露入口。

**实现**：
- 账号行新增「配置」按钮，打开编辑弹窗
- 弹窗内可改：显示名称、配置方案
- 只读展示：调试端口（创建时分配，避免冲突）
- 显示「当前生效：xx 方案」，方便判断

**验收**（真实浏览器）：
- 点「配置」→ 弹窗打开，字段正确回填（名称 / 端口 / 方案选中态）
- 改成「Quick 主账号-已改」+ 切到「低延迟方案」→ 保存成功
- 服务端返回 `profileId=p_demo1, profileName=低延迟方案` ✅
- 表格立即刷新显示新名称与新方案
- **方案真的生效**：低延迟方案的回车前等待是 0.3~0.8s，
  实测「填入 → 点击发送」间隔 0.0s（默认方案是 0.8~2.5s）
- 无 JS 错误

单测增至 58 项全过。

### 261123-newchat-ready：第一次对话（系统提示词）经常发失败

**现象**：用户反馈每次新对话的第一条消息发不出去，尤其是带系统提示词的长消息。

**根因**：`startNewChat` 点完「新对话」按钮后，用
`waitForComposer()`（等输入框出现）判断就绪。但实测点击前后：

```
点击前: ta=true  (textarea 一直在)
t+0.3s: ta=true  bodyLen=626  msgCount=1   ← 已切空对话
t+1.8s: ta=true  bodyLen=726              ← 页面才真正重渲染完
```

**输入框从头到尾都存在**，所以这个判据永远立即返回 true ——
页面还在重渲染就发消息，React 状态没重置完，第一条容易失败。

**修法**：
- 新增 `NEW_CHAT_READY_EXPR`：同时检查「URL 无 conversationId +
  输入框为空 + 未在生成」三项
- 新增 `waitForNewChatReady()`：轮询该判定，**连续两次就绪**再算稳定，
  并额外静置 `newChatSettleSec` 秒
- 新增 `isAlreadyFreshChat()`：本来就在干净新对话里时**跳过重建**，避免白等
- 新增配置项 `newChatWaitSec`（默认 30）、`newChatSettleSec`（默认 3）

**验收**：连续 3 次新对话全部成功（7.8s / 13.1s / 14.7s）。
日志可见两条路径都正常：
`[Send] 已经在新对话里，跳过重建` 与 `[Send] 新对话已就绪（等待 3.1s）`。
单测增至 61 项全过。

### 261123-keepalive-fix：长回复永远不结束（keepalive 续命）

**现象**：回复内容已经完整输出（以 `</sources>` 结尾），但之后只有
`: keepalive 260s / 280s / ... / 400s`，永远收不到 `event: done`。

**根因**：Quick 自己每 20~30 秒下发 `keepalive` 帧保活。
上一版为了让长任务不被误判，改成了「每收到一个事件就 resetIdle()」——
结果 keepalive 把空闲计时器无限续命。一旦 `message_complete` 丢失，
就永远等不到超时。这条路径与用户日志完全吻合。

**修法**：
- `chat.js`：只有「实质内容」事件才 `resetIdle()`；
  keepalive / status / runs_updated / task_list_update / title_generated 等不算
- `quick-protocol.js`：extractor 新增 `lastContentAt`，
  与 `lastEventAt`（任意事件）区分开
- 新增卡死兜底：**已有内容 + 90s 无实质进展 + 页面已停止生成** → 主动收尾

**验收**：
- 模拟用户场景（t=0 有内容、之后只有 keepalive、页面 5s 后停止生成）：
  旧逻辑永不收尾，新逻辑 **100s 收尾**
- 真机：同一 branch 会话跑长回复，124.6s / 14698 字，正常收到 done
- 单测增至 64 项全过

### 261123-stall-cap：上游卡死导致永远不结束

**复现过程**：用 branch 会话连发 5 次长回复请求，第 3 次复现：

```
第 3 轮: 240s done=false 字数=12747 心跳=11 ❌
```

**现场日志**（关键）：

```
00:18:45 [Chat] 消息已发出，等待 Quick 响应…
        ↓ 3 分 56 秒，一个事件都没有
00:22:41 [Chat] 客户端断开，中止本轮
```

**页面状态**：显示「正在处理」、停止按钮存在、正文尾部就是那条用户消息。

**结论**：不是我们判定错了，是 **Quick 服务端卡死** ——
一个事件都不推，但页面仍声称在生成。旧逻辑看到 `isGenerating=true`
就无条件放行，于是无限等待。

**修法**：加硬上限 `STALL_HARD_CAP_MS = 6 分钟`。
即使页面说还在生成，只要「距上次实质内容」超过 6 分钟就判卡死收尾。

为什么 6 分钟：实测正常长任务最长静默约 2 分钟，6 分钟留足余量。

**顺带修的**：`startedAt` 原来声明在 try 块内，而兜底逻辑在块外使用，
会触发 ReferenceError。已提到函数顶部。

**验收**：
- 判定表 6 种组合全部符合预期（60s/120s/300s 继续，360s/420s 收尾，停止生成立即收尾）
- 正常请求不受影响（15.3s 完成）
- 单测增至 66 项全过

## 遗留

- **文件/图片输入**：Quick 的附件走独立的 `upload-attachment` → DLP 扫描 → `files/upload` 流程，
  需要额外的 REST 调用，当前版本只做文本。
- **账号组转移对话**：可从 `one-chrome-ex` 移植，但 Quick 的历史在服务端按 thread 存，
  转移语义要重新设计。
- **打包 exe**：可参考 `one-chrome-ex` 的 Node SEA 方案。
- **`webSocketCreated` 不可依赖**：页面在 CDP 连上之前就建好连接，该事件不再触发。
  当前实现靠帧内容过滤，若将来需要「主动注入帧」得换方案。
