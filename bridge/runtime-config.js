/**
 * 运行时配置（端口等）
 *
 * 为什么需要它：环境变量 CUKO_HTTP_PORT 只对「命令行启动」有效，
 * 双击 exe 的用户没法设环境变量。所以再加一层配置文件 data/config.json，
 * 让用户改完重启就能生效。
 *
 * 优先级（后者覆盖前者）：
 *   内置默认值  <  data/config.json  <  环境变量 CUKO_HTTP_PORT
 *
 * 环境变量优先级最高，方便临时改端口、也方便在 CI/脚本里覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';

export const RUNTIME_CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 内置默认值 */
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  /** HTTP 监听端口 */
  port: 3000,
  /** 监听地址；默认只本机可访问，改成 0.0.0.0 可让局域网访问（不推荐，无鉴权） */
  host: '127.0.0.1',
  /** 启动后是否自动用默认浏览器打开管理后台 */
  autoOpenAdmin: true,
  /**
   * 用户手填的 Chrome 可执行文件路径。
   * [261123-chrome-ui] 自动探测失败时，用户在管理台填一次，写进 data/config.json，
   * 对所有账号生效（包括只读的默认方案）。
   */
  chromePath: '',
});

/**
 * 读取 data/config.json。
 * 文件不存在返回空对象；JSON 坏了也返回空对象并告警（不能因为配置坏了起不来）。
 */
export function readRuntimeConfig() {
  if (!fs.existsSync(RUNTIME_CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    console.warn('[config] data/config.json 解析失败，忽略该文件:', e.message);
    return {};
  }
}

/** 首次运行时把默认配置写出来，用户能看到有哪些可改项 */
export function ensureRuntimeConfigFile() {
  if (fs.existsSync(RUNTIME_CONFIG_FILE)) return false;
  try {
    const body = {
      _说明: [
        '改完这个文件后重启程序才生效。',
        'port：HTTP 监听端口，默认 3000。客户端里的「API 地址」要填成一样的端口。',
        'host：监听地址，默认 127.0.0.1（只有本机能访问）。',
        '      改成 0.0.0.0 可以让局域网访问，但本项目没有鉴权，请自行评估风险。',
        'autoOpenAdmin：启动后是否自动打开管理后台页面，默认 true。',
        'chromePath：Chrome 可执行文件的完整路径。自动探测失败时在管理台填写即可，不用手改这里。',
        '      如果你把服务跑在服务器上、或者不想每次弹浏览器，改成 false。',
        '环境变量 CUKO_HTTP_PORT 优先级高于本文件。',
      ],
      port: DEFAULT_RUNTIME_CONFIG.port,
      host: DEFAULT_RUNTIME_CONFIG.host,
      autoOpenAdmin: DEFAULT_RUNTIME_CONFIG.autoOpenAdmin,
      chromePath: DEFAULT_RUNTIME_CONFIG.chromePath,
    };
    fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(body, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[config] 写入默认配置失败:', e.message);
    return false;
  }
}

/**
 * 解析最终生效的运行时配置。
 * @returns {{ port:number, host:string, portSource:string }}
 *   portSource 用于启动日志里告诉用户「这个端口是从哪来的」
 */
export function resolveRuntimeConfig() {
  const file = readRuntimeConfig();
  let port = DEFAULT_RUNTIME_CONFIG.port;
  let host = DEFAULT_RUNTIME_CONFIG.host;
  let autoOpenAdmin = DEFAULT_RUNTIME_CONFIG.autoOpenAdmin;
  let chromePath = DEFAULT_RUNTIME_CONFIG.chromePath;
  let portSource = '默认值';

  // 1) 配置文件
  if (file.port !== undefined) {
    const n = Number(file.port);
    if (Number.isInteger(n) && n > 0 && n < 65536) { port = n; portSource = 'data/config.json'; }
    else console.warn('[config] data/config.json 里的 port 不合法（' + JSON.stringify(file.port) + '），已忽略');
  }
  if (typeof file.host === 'string' && file.host.trim()) host = file.host.trim();

  // 2) 环境变量优先
  const envPort = process.env.CUKO_HTTP_PORT;
  if (envPort !== undefined && envPort !== '') {
    const n = Number(envPort);
    if (Number.isInteger(n) && n > 0 && n < 65536) { port = n; portSource = '环境变量 CUKO_HTTP_PORT'; }
    else console.warn('[config] 环境变量 CUKO_HTTP_PORT 不合法（' + JSON.stringify(envPort) + '），已忽略');
  }

  // 布尔开关：字符串 'false' 也当 false 处理（方便手工编辑 json）
  if (file.autoOpenAdmin !== undefined) {
    const v = file.autoOpenAdmin;
    autoOpenAdmin = !(v === false || v === 'false' || v === 0 || v === '0');
  }

  if (typeof file.chromePath === 'string' && file.chromePath.trim()) {
    chromePath = file.chromePath.trim();
  }

  return { port, host, portSource, autoOpenAdmin, chromePath };
}

/** 端口被占用时给用户的建议（写进错误信息里） */
export function portInUseHint(port) {
  return [
    '端口 ' + port + ' 已被占用。可以：',
    '  1) 关掉占用该端口的程序（Windows 下用 netstat -ano | findstr :' + port + ' 查 PID）',
    '  2) 换个端口：编辑 ' + RUNTIME_CONFIG_FILE + '，把 port 改成别的值，然后重启',
    '  3) 或临时用环境变量：set CUKO_HTTP_PORT=3002 && npm start',
  ].join('\n');
}
