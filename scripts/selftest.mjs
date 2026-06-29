#!/usr/bin/env node
// Deterministic self-test ของ context-guard.mjs — ไม่ต้องรอ session โตจริง
// สร้าง transcript ปลอมที่มี usage ตามต้องการ แล้วยิง hook ดูว่า block ถูก tier ไหม + marker กันซ้ำ
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(homedir(), '.claude', 'hooks', 'context-guard.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'hg-'));
const markerDir = join(homedir(), '.claude', '.handoff-guard');

function makeTranscript(tokens) {
  const p = join(tmp, `t-${tokens}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user' } }),
    JSON.stringify({ type: 'assistant', message: { usage: {
      input_tokens: tokens - 100, cache_read_input_tokens: 50,
      cache_creation_input_tokens: 30, output_tokens: 20 } } }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function run(sessionId, tokens) {
  const input = JSON.stringify({
    session_id: sessionId, transcript_path: makeTranscript(tokens), hook_event_name: 'Stop',
  });
  return spawnSync('node', [HOOK], { input, encoding: 'utf8' }).stdout.trim();
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

console.log('context-guard self-test');

// 1) ต่ำกว่า threshold → ไม่ block
check('169k → no block (empty output)', run('hg-test-a', 169000) === '');

// 2) เกิน 170k → block tier1
const o2 = parse(run('hg-test-b', 171000));
check('171k → decision=block', o2 && o2.decision === 'block');
check('171k → reason mentions 170000', o2 && /170000/.test(o2.reason || ''));
check('171k → additionalContext invoke skill', o2 && /handoff-guard/.test(o2.hookSpecificOutput?.additionalContext || ''));

// 3) ยิงซ้ำ session เดิม → เงียบ (marker กัน)
check('171k same session again → silent (marker)', run('hg-test-b', 172000) === '');

// 4) เกิน 188k → tier2 (ด่วน)
const o4 = parse(run('hg-test-c', 188000));
check('188k → decision=block', o4 && o4.decision === 'block');
check('188k → tier2 urgent (ด่วน)', o4 && /ด่วน/.test(o4.reason || ''));

// 5) transcript ไม่มี → ไม่ block (เงียบ)
const noFile = spawnSync('node', [HOOK], {
  input: JSON.stringify({ session_id: 'hg-test-d', transcript_path: join(tmp, 'nope.jsonl') }),
  encoding: 'utf8',
}).stdout.trim();
check('no transcript → silent', noFile === '');

// cleanup
for (const s of ['hg-test-a', 'hg-test-b', 'hg-test-c', 'hg-test-d']) {
  for (const t of ['t1', 't2']) {
    const m = join(markerDir, `${s}.${t}`);
    if (existsSync(m)) rmSync(m);
  }
}
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
