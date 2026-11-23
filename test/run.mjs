/**
 * 测试运行器（自带，避免 node --test 在本机被吞输出）
 * 用法：npm test
 */
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TESTS = [];
globalThis.__test = (name, fn) => TESTS.push({ name, fn });

const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
assert.equal = (a, b, msg) => { if (a !== b) throw new Error((msg || '断言失败') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };
assert.ok = (v, msg) => { if (!v) throw new Error(msg || '断言失败'); };
assert.match = (s, re, msg) => { if (!re.test(String(s))) throw new Error((msg || '断言失败') + ': 不匹配 ' + re); };
assert.deepEqual = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '断言失败') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };
assert.notEqual = (a, b, msg) => { if (a === b) throw new Error((msg || '断言失败') + ': 两值不应相等，实际都是 ' + JSON.stringify(a)); };
assert.isNull = (a, msg) => { if (a !== null) throw new Error((msg || '断言失败') + ': 应为 null，实际 ' + JSON.stringify(a)); };
assert.throws = async (fn, msg) => { let threw = false; try { await fn(); } catch { threw = true; } if (!threw) throw new Error(msg || '断言失败：应抛异常'); };
globalThis.__assert = assert;

const dir = import.meta.dirname;
const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
for (const f of files) await import(pathToFileURL(path.join(dir, f)).href);

let pass = 0, fail = 0;
const failures = [];
for (const t of TESTS) {
  try { await t.fn(); console.log('  PASS  ' + t.name); pass++; }
  catch (e) { console.log('  FAIL  ' + t.name + '\n        ' + e.message); fail++; failures.push(t.name); }
}
const summary = pass + ' 通过 / ' + fail + ' 失败';
console.log('\n' + summary + (fail ? '\n失败项: ' + failures.join('; ') : ''));
writeFileSync(path.join(dir, 'last-run.txt'), summary + '\n' + (fail ? failures.join('\n') : ''), 'utf8');
process.exitCode = fail ? 1 : 0;
