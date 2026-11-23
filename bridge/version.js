/**
 * 版本号解析
 *
 * [261123-version] 为什么要单独一个模块：
 * 打包成单文件 exe（Node SEA）后，process.cwd() 是「用户双击 exe 时的目录」，
 * 不一定有 package.json；而 import.meta.dirname 指向 exe 所在目录，同样没有。
 * 所以 exe 里的版本号必须在**构建时**注入，不能运行时读文件。
 *
 * 优先级：
 *   1. 开发环境：读项目根的 package.json
 *   2. exe：用构建脚本通过 esbuild define 注入的 __APP_VERSION__
 *   3. 都拿不到：'unknown'
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './app-paths.js';

/** 构建时会被 esbuild 替换成字符串字面量；开发时该标识不存在，兜底为 null */
const INJECTED = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

let cached = null;

/**
 * 取应用版本号。
 * @returns {string}
 */
export function getVersion() {
  if (cached) return cached;

  // 1) 构建时注入的（exe 走这条）
  if (INJECTED && typeof INJECTED === 'string' && INJECTED.trim()) {
    cached = INJECTED.trim();
    return cached;
  }

  // 2) 开发环境：项目根的 package.json
  try {
    const p = path.join(APP_ROOT, 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) { cached = String(v); return cached; }
  } catch (_) {}

  cached = 'unknown';
  return cached;
}
