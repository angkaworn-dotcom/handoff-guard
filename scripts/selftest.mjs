#!/usr/bin/env node
// Deterministic self-test ของ context-guard.mjs (Context Manager V2) — ไม่ต้องรอ session โตจริง
// สร้าง transcript ปลอมที่มี usage ตามต้องการ แล้วยิง hook ดูว่า block ถูก tier ไหม + EWMA/predict + marker กันซ้ำ
// state.json persist ข้าม run ใน session เดียว → ทดสอบ EWMA ข้ามเทิร์นได้ตรงๆ
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(homedir(), '.claude', 'hooks', 'context-guard.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'hg-'));
const markerDir = join(homedir(), '.claude', '.handoff-guard');

function makeTranscript(tokens, model = 'claude-opus-4-8') {
  const p = join(tmp, `t-${tokens}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user' } }),
    JSON.stringify({ type: 'assistant', message: { model, usage: {
      input_tokens: tokens - 100, cache_read_input_tokens: 50,
      cache_creation_input_tokens: 30, output_tokens: 20 } } }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function run(sessionId, tokens, model) {
  const input = JSON.stringify({
    session_id: sessionId, transcript_path: makeTranscript(tokens, model), hook_event_name: 'Stop',
  });
  return spawnSync('node', [HOOK], { input, encoding: 'utf8' }).stdout.trim();
}

function readState(sessionId) {
  const p = join(markerDir, `${sessionId}.state.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const ctxOf = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';

console.log('context-guard self-test (V2)');

// config.json หรือ env override จะ mask การ detect โมเดล → เตือนกัน [A][B][G] เพี้ยนโดยไม่รู้ตัว
if (existsSync(join(markerDir, 'config.json')) || process.env.HANDOFF_GUARD_MAX
    || process.env.HANDOFF_GUARD_THRESHOLD || process.env.HANDOFF_GUARD_THRESHOLD2) {
  console.log('⚠️  พบ config.json หรือ HANDOFF_GUARD_* env — override auto-detect: เทสต์ [A][B][G] อาจไม่ตรง');
}

// ── A. absolute tiers (regression — ต้องคงผ่าน · เพดาน 256k: T1=round(256k·0.85)=217600, T2=round(256k·0.94)=240640) ──
console.log('\n[A] absolute tiers (regression)');
check('217k → no block (empty output, ต่ำกว่า T1=217600)', run('hg-test-a', 217000) === '');
const o2 = parse(run('hg-test-b', 219000));
check('219k → decision=block', o2 && o2.decision === 'block');
check('219k → reason mentions 217600', o2 && /217600/.test(o2.reason || ''));
check('219k → ctx invoke skill + tier1', o2 && /handoff-guard/.test(ctxOf(o2)) && /tier=tier1/.test(ctxOf(o2)));
check('219k same session again → silent (marker)', run('hg-test-b', 220000) === '');
const o4 = parse(run('hg-test-c', 241000));
check('241k → decision=block', o4 && o4.decision === 'block');
check('241k → tier2 urgent (ด่วน)', o4 && /ด่วน/.test(o4.reason || '') && /tier=tier2/.test(ctxOf(o4)));

// ── B. predict — โตสม่ำเสมอ 8k/เทิร์น (เป้า T2=240640, K=3 → ยิงช่วง [216640,217600)) ──
console.log('\n[B] predict (steady growth ~8k/turn)');
check('B fire#1 201k → baseline, silent (turns<2)', run('hg-predict', 201000) === '');
check('B fire#2 209k → silent (ETA=4 > K=3)', run('hg-predict', 209000) === '');   // ETA = ceil((240640-209000)/8000) = 4
const oP = parse(run('hg-predict', 217000));            // ETA = ceil((240640-217000)/8000) = 3 ≤ K
check('B fire#3 217k → predict fires (block, ยังไม่ถึง T1=217600)', oP && oP.decision === 'block' && /tier=predict/.test(ctxOf(oP)));
check('B predict ctx มี etaTurns', oP && /etaTurns=3/.test(ctxOf(oP)));
const sB = readState('hg-predict');                    // อ่านก่อน perturb ด้วย run ถัดไป
check('B state.ema ≈ 8000 (EWMA นิ่ง)', sB && Math.abs(sB.ema - 8000) < 100);
check('B predict ครั้งเดียว/session → ถัดไปเงียบ', run('hg-predict', 217500) === '');

// ── C. cold-start — fire เดียวที่ rate สูงไม่ได้ ยังไม่ยิง predict (turns<2) ────
console.log('\n[C] cold-start (1 observation)');
check('C 215k fire เดียว → silent (turns<2, ema=0)', run('hg-cold', 215000) === '');
const sC = readState('hg-cold');
check('C state turns=1 ema=0', sC && sC.turns === 1 && sC.ema === 0);

// ── D. spike — delta กระโดดครั้งเดียวถูก EWMA ถ่วง (ema << raw spike) ──────────
console.log('\n[D] spike dampening');
run('hg-spike', 100000);                 // baseline
run('hg-spike', 105000);                 // d=5k → ema=5000
run('hg-spike', 110000);                 // d=5k → ema=5000
run('hg-spike', 150000);                 // d=40k spike → ema=0.4*40000+0.6*5000=19000
const sD = readState('hg-spike');
check('D ema ดึงลงจาก spike 40k → ~19k (ถ่วงสำเร็จ)', sD && sD.ema > 15000 && sD.ema < 23000);
check('D ema น้อยกว่าครึ่งของ raw spike (40k)', sD && sD.ema < 20000);

// ── E. compaction — delta ติดลบ ไม่นับ, ไม่ crash, reset baseline ─────────────
console.log('\n[E] compaction (token ลดฮวบ)');
check('E 160k baseline → silent', run('hg-comp', 160000) === '');
check('E 90k (compaction) → silent, ไม่ crash', run('hg-comp', 90000) === '');
const sE = readState('hg-comp');
check('E baseline reset เป็น 90000, ema คงเดิม (0)', sE && sE.lastTokens === 90000 && sE.ema === 0);

// ── F. no transcript → silent ────────────────────────────────────────────────
console.log('\n[F] edge');
const noFile = spawnSync('node', [HOOK], {
  input: JSON.stringify({ session_id: 'hg-test-d', transcript_path: join(tmp, 'nope.jsonl') }),
  encoding: 'utf8',
}).stdout.trim();
check('F no transcript → silent', noFile === '');

// ── G. model-adaptive ceiling (auto-detect จาก message.model) ────────────────
console.log('\n[G] model-adaptive ceiling');
// Sonnet เพดาน 200k → T1=170000, T2=188000
check('G sonnet 169k → silent (< T1=170000)', run('hg-son-a', 169000, 'claude-sonnet-5') === '');
const gS = parse(run('hg-son-b', 171000, 'claude-sonnet-5'));
check('G sonnet 171k → tier1 block (≥170000)', gS && gS.decision === 'block' && /tier=tier1/.test(ctxOf(gS)));
check('G sonnet reason อ้าง 170000 (ไม่ใช่ 217600)', gS && /170000/.test(gS.reason || ''));
const gS2 = parse(run('hg-son-c', 189000, 'claude-sonnet-5'));
check('G sonnet 189k → tier2 ด่วน (≥188000)', gS2 && gS2.decision === 'block' && /tier=tier2/.test(ctxOf(gS2)));
// Opus เพดาน 256k → 217k ยังไม่ block (โมเดลต่างเพดานต่าง จาก transcript เดียวกัน)
check('G opus 217k → silent (< T1=217600)', run('hg-op-a', 217000, 'claude-opus-4-8') === '');
const gO = parse(run('hg-op-b', 219000, 'claude-opus-4-8'));
check('G opus 219k → tier1 block (≥217600)', gO && gO.decision === 'block' && /tier=tier1/.test(ctxOf(gO)));
// โมเดลไม่รู้จัก/ว่าง → fallback 200000 → T1=170000 (ยิงเร็ว = ปลอดภัย)
const gU = parse(run('hg-unk', 171000, 'weird-model-x'));
check('G unknown model 171k → tier1 (fallback 200k)', gU && gU.decision === 'block' && /tier=tier1/.test(ctxOf(gU)));

// ── H. re-arm after compaction (regression — post-compact blind spot) ─────────
// bug: marker .t1/.t2/.p ยิงครั้งเดียว/session แล้วไม่รีเซ็ต → พอ compact แล้วโตทะลุ T1 อีก = เงียบ
console.log('\n[H] re-arm after compaction');
run('hg-rearm', 160000);                                  // baseline (< T1), silent
const h1 = parse(run('hg-rearm', 219000));                // tier1 fires (marker .t1 สร้าง)
check('H 219k → tier1 fires (ครั้งแรก)', h1 && /tier=tier1/.test(ctxOf(h1)));
check('H 220k same session → silent (marker กันซ้ำ ก่อน compact)', run('hg-rearm', 220000) === '');
check('H compaction 100k → silent + re-arm', run('hg-rearm', 100000) === '');
const h2 = parse(run('hg-rearm', 219000));                // ต้องยิงซ้ำได้ หลัง re-arm
check('H 219k หลัง compact → tier1 ยิงซ้ำ (re-armed) ✅', h2 && h2.decision === 'block' && /tier=tier1/.test(ctxOf(h2)));

// ── cleanup ──────────────────────────────────────────────────────────────────
const sessions = ['hg-test-a', 'hg-test-b', 'hg-test-c', 'hg-test-d',
                  'hg-predict', 'hg-cold', 'hg-spike', 'hg-comp',
                  'hg-son-a', 'hg-son-b', 'hg-son-c', 'hg-op-a', 'hg-op-b', 'hg-unk',
                  'hg-rearm'];
for (const s of sessions) {
  for (const ext of ['t1', 't2', 'p', 'state.json']) {
    const m = join(markerDir, `${s}.${ext}`);
    if (existsSync(m)) rmSync(m);
  }
}
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
