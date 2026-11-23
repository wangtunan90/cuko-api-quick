/**
 * 默认配置方案（不可修改）
 *
 * 时间单位统一为「秒」，支持小数（如 1.12 表示 1.12 秒）。
 * 等待类字段为区间，实际使用时在 [min, max] 内随机，模拟真人节奏。
 */

/** 默认方案字段值（不可变） */
export const DEFAULT_PROFILE_VALUES = Object.freeze({
  // ===== Chrome 组 =====
  /** Chrome 可执行文件路径；空字符串 = 自动探测 Program Files 下的两个默认路径 */
  chromePath: '',
  /** 追加的 Chrome 启动参数，如 --proxy-server=http://127.0.0.1:8080 */
  extraArgs: '',
  /**
   * 首次启动 Chrome 时打开的页面。
   *
   * [261123-entry-fix] 用 /sn/start 而不是 /sn：
   *   /sn       → 产品落地页（Features / Pricing / Sign in），永远没有输入框
   *   /sn/start → 会自动路由到 /sn/account/<账号ID>/start/chat（实测约 10s）
   * 这样不需要知道用户的账号 ID，也能进到真正的聊天页。
   */
  targetUrl: 'https://quick.aws.com/sn/start',

  // ===== 时序组（秒，支持小数） =====
  /** 等待 CDP 调试端口就绪的最长秒数 */
  connectPollMaxSec: 25,
  /** 等待页面输入框出现的最长秒数 */
  pageReadyPollMaxSec: 25,
  /**
   * 点「新对话」后，最长等多久算超时（秒）。
   *
   * [261123-newchat-ready] 注意这和 pageReadyPollMaxSec 不是一回事：
   * 输入框在页面上一直存在，光看它无法判断「新对话是否真的重置好了」。
   * 这里等的是「URL 里的 conversationId 清掉 + 输入框清空 + 不在生成中」。
   */
  newChatWaitSec: 30,
  /**
   * 判定新对话就绪后，再额外静置多久（秒）。
   *
   * 给 React 留时间把状态彻底重置。第一次对话（尤其带系统提示词的长消息）
   * 如果发得太早容易失败 —— 调大这个值可以缓解。
   */
  newChatSettleSec: 3,
  /**
   * 单次请求流式接收的最长秒数，超时强制结束。
   * Quick 的 agent 首轮要跑 30~90s，长任务更久，因此默认给到 900s；
   * 真正的卡死判定由 index.js 的空闲超时负责，这里只兜「永不结束」。
   */
  requestTimeoutSec: 900,
  /**
   * SSE 心跳间隔（秒）。
   * 长任务期间每隔这么久发一个 SSE 注释帧保活，
   * 避免客户端或中间代理因「长时间无数据」掐断连接。
   */
  keepAliveSec: 20,
  /**
   * 空闲超时（秒）：连续这么久「没有收到任何聊天事件」才判定卡死。
   *
   * [261123-idle-fix] 注意是「没有任何事件」——只要页面还在输出
   * （思考 / 正文 / 工具进度 / keepalive），计时器就会被重置，不会误判。
   * 旧实现只在首帧重置一次，导致 120s 后无条件超时，长回复必定撞上。
   */
  idleTimeoutSec: 180,
  /** 连接聊天 WebSocket 的最长等待秒数 */
  wsConnectTimeoutSec: 30,
  /** WebSocket 握手后等待 session_established/connected 的最长秒数 */
  wsAckTimeoutSec: 40,

  // ===== 等待区间（秒，实际使用时在 [min, max] 内随机） =====
  textPasteWaitMinSec: 1.0,
  textPasteWaitMaxSec: 3.0,
  preEnterWaitMinSec: 0.8,
  preEnterWaitMaxSec: 2.5,

  // ===== 开关组 =====
  /** 是否给 Chrome 加防后台节流参数（--disable-background-timer-throttling 等） */
  disableBackgroundThrottling: true,
  /** 是否把发送内容同时走「剪贴板粘贴」以让页面 UI 与真实链路保持一致 */
  uiPasteToInput: true,
});

/** 字段中文标签（UI 展示用） */
export const FIELD_LABELS = Object.freeze({
  chromePath: 'Chrome 路径（留空自动探测：注册表 → 用户级 → 系统级 → Edge）',
  extraArgs: '额外启动参数',
  targetUrl: '启动页面 URL（/sn/start 会自动跳到聊天页）',
  connectPollMaxSec: 'CDP 端口就绪超时（秒）',
  pageReadyPollMaxSec: '页面就绪超时（秒）',
  newChatWaitSec: '新对话等待超时（秒）',
  newChatSettleSec: '新对话就绪后静置（秒）',
  keepAliveSec: 'SSE 心跳间隔（秒）',
  idleTimeoutSec: '空闲超时（秒，无任何事件才算卡死）',
  requestTimeoutSec: '请求总超时（秒）',
  wsConnectTimeoutSec: 'WebSocket 连接超时（秒）',
  wsAckTimeoutSec: '会话握手超时（秒）',
  textPasteWaitMinSec: '文本粘贴等待下限（秒）',
  textPasteWaitMaxSec: '文本粘贴等待上限（秒）',
  preEnterWaitMinSec: '回车前等待下限（秒）',
  preEnterWaitMaxSec: '回车前等待上限（秒）',
  disableBackgroundThrottling: '防后台节流',
  uiPasteToInput: '同步到输入框（视觉一致）',
});

/** 数值型字段列表（校验用） */
const NUMBER_FIELDS = [
  'connectPollMaxSec', 'pageReadyPollMaxSec', 'requestTimeoutSec',
  'newChatWaitSec', 'newChatSettleSec',
  'keepAliveSec', 'idleTimeoutSec',
  'wsConnectTimeoutSec', 'wsAckTimeoutSec',
  'textPasteWaitMinSec', 'textPasteWaitMaxSec',
  'preEnterWaitMinSec', 'preEnterWaitMaxSec',
];

/** 区间字段对：[min, max, 描述] */
const RANGE_PAIRS = [
  ['textPasteWaitMinSec', 'textPasteWaitMaxSec', '文本粘贴等待'],
  ['preEnterWaitMinSec', 'preEnterWaitMaxSec', '回车前等待'],
];

/** 布尔字段 */
const BOOL_FIELDS = ['disableBackgroundThrottling', 'uiPasteToInput'];

/**
 * 校验方案 values，不合法抛异常。
 * 缺失字段用默认值补齐（向前兼容老方案）。
 * @param {object} values 待校验的 values
 * @returns {object} 规范化后的新对象（含全部字段）
 */
export function validateProfile(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('配置内容必须是对象');
  }
  const out = { ...DEFAULT_PROFILE_VALUES };
  for (const k of Object.keys(DEFAULT_PROFILE_VALUES)) {
    if (values[k] !== undefined) out[k] = values[k];
  }

  for (const k of ['chromePath', 'extraArgs', 'targetUrl']) {
    if (typeof out[k] !== 'string') throw new Error('字段 ' + k + ' 必须是字符串');
  }
  if (!out.targetUrl.trim()) throw new Error('目标页面 URL 不能为空');

  for (const k of NUMBER_FIELDS) {
    const n = Number(out[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error('字段 ' + k + ' 必须是非负数字');
    out[k] = n;
  }

  for (const k of BOOL_FIELDS) {
    if (typeof out[k] !== 'boolean') throw new Error('字段 ' + k + ' 必须是布尔值');
  }

  for (const [minK, maxK, label] of RANGE_PAIRS) {
    if (out[minK] > out[maxK]) throw new Error(label + '的下限不能大于上限');
  }

  return out;
}

/**
 * 在 [min, max] 区间内取随机数（秒 → 毫秒）。
 * @param {number} minSec 下限秒
 * @param {number} maxSec 上限秒
 * @returns {number} 毫秒整数
 */
export function randomInRange(minSec, maxSec) {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  return Math.round(lo * 1000 + Math.random() * (hi - lo) * 1000);
}
