/**
 * 超长文本转附件
 *
 * 背景：Cuko 客户端会把工具调用结果当成普通文本项发过来，动辄几万字符。
 * 直接塞进 Quick 的输入框有两个问题：
 *   1. 输入框是 React 受控的 textarea，超长文本填进去很慢，还可能被截断
 *   2. 页面自己也会把超长文本转成卡片，行为和我们的预期不一致
 *
 * 实测确认（见 docs/quick-protocol.md「附件」一节）：把内容写成文件挂成附件后，
 * 模型能完整读到文件内容（用暗号验证过）。
 *
 * 因此策略是：
 *   - 单个文本项 <= 阈值 → 正常走输入框
 *   - 单个文本项 >  阈值 → 写成 .txt 附件，正文里留一句说明 + 首尾摘要
 *
 * 阈值默认 20000 字符，可由调用方传入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';

/** 超过这个字符数的单个文本项会被转成附件 */
export const TEXT_TO_FILE_THRESHOLD = 20000;

/** 超长文本转成附件时，正文里保留的首尾摘要长度 */
const PREVIEW_HEAD = 400;
const PREVIEW_TAIL = 200;

/** 临时附件目录（每次进程启动清空） */
export const ATTACH_DIR = path.join(DATA_DIR, 'tmp-attachments');

/** 确保临时目录存在并清空上次残留 */
export function ensureAttachDir() {
  try { fs.rmSync(ATTACH_DIR, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
}

/**
 * 清洗文件名：去掉 Windows 非法字符和路径分隔符。
 * （和剪贴板方案里的 sanitize 不同，这里的文件名要真的落盘。）
 */
export function safeFileName(name, fallback = 'content') {
  let out = String(name || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!out) out = fallback;
  if (out.length > 80) out = out.slice(0, 80);
  return out;
}

/**
 * 把超长文本写成附件文件。
 * @param {string} text 文本内容
 * @param {number} index 序号（用于生成不重名的文件名）
 * @returns {{ filePath: string, fileName: string, chars: number }}
 */
export function writeTextAttachment(text, index = 0) {
  ensureAttachDirOnce();
  const firstLine = String(text).split(/\r?\n/)[0] || '';
  const base = safeFileName(firstLine.slice(0, 24), 'tool-result');
  const stamp = Date.now().toString(36) + '_' + index;
  const fileName = base + '_' + stamp + '.txt';
  const filePath = path.join(ATTACH_DIR, fileName);
  fs.writeFileSync(filePath, text, 'utf8');
  return { filePath, fileName, chars: String(text).length };
}

let _dirReady = false;
function ensureAttachDirOnce() {
  if (_dirReady) return;
  ensureAttachDir();
  _dirReady = true;
}

/**
 * 把传入的文本项按阈值分流成「直接发送」和「转附件」。
 *
 * @param {Array<{kind:string, text?:string}>} items normalizeInputItems 的结果
 * @param {number} [threshold] 阈值，默认 TEXT_TO_FILE_THRESHOLD
 * @returns {{ inlineTexts: string[], files: Array<{filePath:string, fileName:string, chars:number}>, summaryNotes: string[] }}
 */
export function splitOversizedTexts(items, threshold = TEXT_TO_FILE_THRESHOLD, opts = {}) {
  // [261123-attach-total] 除了「单项超阈值」，还要考虑「多项总和超阈值」。
  // 场景：Cuko 把工具结果拆成很多小段发来（每段 800 字 × 30 段 = 24000 字），
  // 单看每段都没超，但拼起来照样超 —— 旧实现完全不转，直接塞进输入框。
  const totalThreshold = opts.totalThreshold || TEXT_TO_FILE_THRESHOLD;
  const inlineTexts = [];
  const files = [];
  const summaryNotes = [];
  let idx = 0;

  for (const item of items || []) {
    if (item.kind !== 'text' || typeof item.text !== 'string') continue;
    const text = item.text;
    if (text.length <= threshold) {
      inlineTexts.push(text);
      continue;
    }
    // 超长 → 落成文件
    const file = writeTextAttachment(text, idx++);
    files.push(file);
    const head = text.slice(0, PREVIEW_HEAD);
    const tail = text.slice(-PREVIEW_TAIL);
    summaryNotes.push([
      '【附件 ' + file.fileName + '】内容过长（' + text.length + ' 字符），已作为附件发送，请读取附件内容。',
      '以下是开头片段：',
      head,
      '……（中间省略 ' + Math.max(0, text.length - PREVIEW_HEAD - PREVIEW_TAIL) + ' 字符）……',
      '结尾片段：',
      tail,
    ].join('\n'));
    console.log('[attach] 文本超长转为附件: ' + file.fileName + '（' + text.length + ' 字符）');
  }

  // 「总量超阈值」兜底：如果前面没产生任何附件，但所有直发文本加起来
  // 仍然超过阈值，就把它们合并成一个附件（保留首尾摘要）。
  if (files.length === 0 && inlineTexts.length > 1) {
    const joined = inlineTexts.join('\n\n');
    if (joined.length > totalThreshold) {
      const file = writeTextAttachment(joined, idx++);
      files.push(file);
      const head = joined.slice(0, PREVIEW_HEAD);
      const tail = joined.slice(-PREVIEW_TAIL);
      summaryNotes.length = 0;
      summaryNotes.push([
        '【附件 ' + file.fileName + '】内容过长（' + joined.length + ' 字符，由 ' +
        inlineTexts.length + ' 段合并），已作为附件发送，请读取附件内容。',
        '以下是开头片段：',
        head,
        '……（中间省略 ' + Math.max(0, joined.length - PREVIEW_HEAD - PREVIEW_TAIL) + ' 字符）……',
        '结尾片段：',
        tail,
      ].join('\n'));
      inlineTexts.length = 0;
      console.log('[attach] 多段文本合计超长，合并为附件: ' + file.fileName + '（' + joined.length + ' 字符）');
    }
  }

  return { inlineTexts, files, summaryNotes };
}

/**
 * 清理已发送的临时附件（发送完成后调用，避免磁盘堆积）。
 * @param {Array<{filePath:string}>} files
 */
export function cleanupAttachments(files) {
  for (const f of files || []) {
    try { fs.unlinkSync(f.filePath); } catch (_) {}
  }
}

/**
 * 把 Cuko 的 file 项（base64）落地成临时文件，供 attachFiles 注入。
 *
 * Cuko 协议里的文件项格式（docs/cuko-api-v1.md §3.2）：
 *   { "type": "file", "filename": "a.pdf", "mimeType": "application/pdf", "data": "base64..." }
 *
 * 有些客户端会把 data:URL 前缀一起带上，这里要剥掉再解码。
 *
 * @param {{filename?:string, mimeType?:string, data:string}} item
 * @param {number} index 序号，避免重名
 * @returns {{ok:true, filePath:string, fileName:string, bytes:number} | {ok:false, error:string}}
 */
export function writeBase64Attachment(item, index = 0) {
  ensureAttachDirOnce();
  try {
    let b64 = String(item.data || '');
    // 剥掉 data:xxx;base64, 前缀
    const m = b64.match(/^data:[^;]*;base64,(.*)$/s);
    if (m) b64 = m[1];
    // 去掉 base64 里可能夹带的空白/换行
    b64 = b64.replace(/\s+/g, '');
    if (!b64) return { ok: false, error: '文件内容为空' };

    // [261123-attach] 校验 base64 合法性：Buffer.from 对非法输入很宽容，
    // 会把 "!!!" 解成 0 字节或垃圾。这里先做字符集检查 + 回编码比对，
    // 避免把垃圾文件挂上去让模型读。
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      return { ok: false, error: 'data 含非法 base64 字符' };
    }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { ok: false, error: '文件内容解码后为空（data 不是合法 base64？）' };
    // 回编码比对（去掉 padding 差异），确认没有静默丢数据
    const reencoded = buf.toString('base64').replace(/=+$/, '');
    if (reencoded !== b64.replace(/=+$/, '')) {
      return { ok: false, error: 'base64 解码结果与原数据不一致' };
    }

    const original = safeFileName(item.filename || 'file', 'file');
    // 保留扩展名（模型靠扩展名判断类型），名字过长时截断主干
    const dot = original.lastIndexOf('.');
    let stem = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : '';
    if (stem.length > 60) stem = stem.slice(0, 60);
    const fileName = stem + '_' + Date.now().toString(36) + '_' + index + ext;
    const filePath = path.join(ATTACH_DIR, fileName);
    fs.writeFileSync(filePath, buf);

    console.log('[attach] 文件项落盘: ' + fileName + '（' + buf.length + ' 字节，' + (item.mimeType || '未知类型') + '）');
    return { ok: true, filePath, fileName, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: '写文件失败: ' + e.message };
  }
}

/**
 * 把所有 file 项一次性落盘。
 * @param {Array<{kind:string, data?:string, filename?:string, mimeType?:string}>} items
 * @returns {{ files: Array<{filePath:string,fileName:string,bytes:number}>, errors: string[] }}
 */
export function materializeFileItems(items) {
  const files = [];
  const errors = [];
  let idx = 0;
  for (const it of items || []) {
    if (it.kind !== 'file') continue;
    if (!it.data) {
      errors.push((it.filename || 'file') + ': 文件内容为空（data 字段缺失）');
      continue;
    }
    const r = writeBase64Attachment(it, idx++);
    if (r.ok) files.push({ filePath: r.filePath, fileName: r.fileName, bytes: r.bytes });
    else errors.push((it.filename || 'file') + ': ' + r.error);
  }
  return { files, errors };
}
