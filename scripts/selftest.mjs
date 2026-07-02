#!/usr/bin/env node
// Deterministic self-test ของ context-guard.mjs (Context Manager V2) — ไม่ต้องรอ session โตจริง
// สร้าง transcript ปลอมที่มี usage ตามต้องการ แล้วยิง hook ดูว่า block ถูก tier ไหม + EWMA/predict + marker กันซ้ำ
// state.json persist ข้าม run ใน session เดียว → ทดสอบ EWMA ข้ามเทิร์นได้ตรงๆ
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = process.env.HANDOFF_GUARD_HOOK || join(homedir(), '.claude', 'hooks', 'context-guard.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'hg-'));

// hermetic: ชี้ home ปลอมให้ hook (กัน config.json / marker จริงของเครื่อง mask ผลเทสต์)
// + strip HANDOFF_GUARD_* env ที่ override threshold
const fakeHome = mkdtempSync(join(tmpdir(), 'hg-home-'));
const markerDir = join(fakeHome, '.claude', '.handoff-guard');
const cleanEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
for (const k of Object.keys(cleanEnv)) {
  if (/^HANDOFF_GUARD_(MAX|THRESHOLD|THRESHOLD2|PREDICT_TURNS|EMA_ALPHA)$/.test(k)) delete cleanEnv[k];
}

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
  return spawnSync('node', [HOOK], { input, encoding: 'utf8', env: cleanEnv }).stdout.trim();
}

function readState(sessionId) {
  const p = join(markerDir, `${sessionId}.state.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const ctxOf = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';

console.log('context-guard self-test (V2) — hermetic (fake home, ไม่แตะ config/marker จริง)');

// ── A. absolute tiers (regression — ต้องคงผ่าน · เพดาน 256k: T1=round(256k·0.72)=184320, T2=round(256k·0.85)=217600) ──
console.log('\n[A] absolute tiers (regression)');
check('183k → no block (empty output, ต่ำกว่า T1=184320)', run('hg-test-a', 183000) === '');
const o2 = parse(run('hg-test-b', 185000));
check('185k → decision=block', o2 && o2.decision === 'block');
check('185k → reason mentions 184320', o2 && /184320/.test(o2.reason || ''));
check('185k → ctx invoke skill + tier1', o2 && /handoff-guard/.test(ctxOf(o2)) && /tier=tier1/.test(ctxOf(o2)));
check('185k same session again → silent (marker)', run('hg-test-b', 186000) === '');
const o4 = parse(run('hg-test-c', 218000));
check('218k → decision=block', o4 && o4.decision === 'block');
check('218k → tier2 urgent (ด่วน)', o4 && /ด่วน/.test(o4.reason || '') && /tier=tier2/.test(ctxOf(o4)));

// ── B. predict — โตสม่ำเสมอ 11.6k/เทิร์น (เป้า T2=217600, K=3 → ยิงที่ ~183.2k < T1=184320) ──
console.log('\n[B] predict (steady growth ~11.6k/turn)');
check('B fire#1 160k → baseline, silent (turns<2)', run('hg-predict', 160000) === '');
check('B fire#2 171.6k → silent (ETA=4 > K=3)', run('hg-predict', 171600) === '');   // ETA = ceil((217600-171600)/11600) = 4
const oP = parse(run('hg-predict', 183200));            // ETA = ceil((217600-183200)/11600) = 3 ≤ K
check('B fire#3 183.2k → predict fires (block, ยังไม่ถึง T1=184320)', oP && oP.decision === 'block' && /tier=predict/.test(ctxOf(oP)));
check('B predict ctx มี etaTurns', oP && /etaTurns=3/.test(ctxOf(oP)));
const sB = readState('hg-predict');                    // อ่านก่อน perturb ด้วย run ถัดไป
check('B state.ema ≈ 11600 (EWMA นิ่ง)', sB && Math.abs(sB.ema - 11600) < 100);
check('B predict ครั้งเดียว/session → ถัดไปเงียบ', run('hg-predict', 183500) === '');

// ── C. cold-start — fire เดียวที่ rate สูงไม่ได้ ยังไม่ยิง predict (turns<2) ────
console.log('\n[C] cold-start (1 observation)');
check('C 183k fire เดียว → silent (turns<2, ema=0)', run('hg-cold', 183000) === '');
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
// Sonnet เพดาน 200k → T1=144000, T2=170000
check('G sonnet 143k → silent (< T1=144000)', run('hg-son-a', 143000, 'claude-sonnet-5') === '');
const gS = parse(run('hg-son-b', 145000, 'claude-sonnet-5'));
check('G sonnet 145k → tier1 block (≥144000)', gS && gS.decision === 'block' && /tier=tier1/.test(ctxOf(gS)));
check('G sonnet reason อ้าง 144000 (ไม่ใช่ 184320)', gS && /144000/.test(gS.reason || ''));
const gS2 = parse(run('hg-son-c', 171000, 'claude-sonnet-5'));
check('G sonnet 171k → tier2 ด่วน (≥170000)', gS2 && gS2.decision === 'block' && /tier=tier2/.test(ctxOf(gS2)));
// Opus เพดาน 256k → 183k ยังไม่ block (โมเดลต่างเพดานต่าง จาก transcript เดียวกัน)
check('G opus 183k → silent (< T1=184320)', run('hg-op-a', 183000, 'claude-opus-4-8') === '');
const gO = parse(run('hg-op-b', 185000, 'claude-opus-4-8'));
check('G opus 185k → tier1 block (≥184320)', gO && gO.decision === 'block' && /tier=tier1/.test(ctxOf(gO)));
// Fable 5 เพดาน 512k (window ใหญ่กว่า opus) → T1=round(512k·0.72)=368640: 368k เงียบ, 369k ยิง tier1
check('G fable 368k → silent (< T1=368640)', run('hg-fab-a', 368000, 'claude-fable-5') === '');
const gF = parse(run('hg-fab-b', 369000, 'claude-fable-5'));
check('G fable 369k → tier1 block (≥368640)', gF && gF.decision === 'block' && /tier=tier1/.test(ctxOf(gF)));
// long-context "[1m]" เพดาน 1M → T1=720000: 185k ยังเงียบ, 721k ยิง tier1
check('G [1m] 185k → silent (< T1=720000)', run('hg-1m-a', 185000, 'claude-sonnet-4-5[1m]') === '');
const g1 = parse(run('hg-1m-b', 721000, 'claude-sonnet-4-5[1m]'));
check('G [1m] 721k → tier1 block (≥720000)', g1 && g1.decision === 'block' && /tier=tier1/.test(ctxOf(g1)));
// โมเดลไม่รู้จัก/ว่าง → fallback 200000 → T1=144000 (ยิงเร็ว = ปลอดภัย)
const gU = parse(run('hg-unk', 145000, 'weird-model-x'));
check('G unknown model 145k → tier1 (fallback 200k)', gU && gU.decision === 'block' && /tier=tier1/.test(ctxOf(gU)));

// ── H. re-arm after compaction (regression — post-compact blind spot) ─────────
// bug: marker .t1/.t2/.p ยิงครั้งเดียว/session แล้วไม่รีเซ็ต → พอ compact แล้วโตทะลุ T1 อีก = เงียบ
console.log('\n[H] re-arm after compaction');
run('hg-rearm', 160000);                                  // baseline (< T1=184320), silent
const h1 = parse(run('hg-rearm', 185000));                // tier1 fires (marker .t1 สร้าง)
check('H 185k → tier1 fires (ครั้งแรก)', h1 && /tier=tier1/.test(ctxOf(h1)));
check('H 186k same session → silent (marker กันซ้ำ ก่อน compact)', run('hg-rearm', 186000) === '');
check('H compaction 100k → silent + re-arm', run('hg-rearm', 100000) === '');
const h2 = parse(run('hg-rearm', 185000));                // ต้องยิงซ้ำได้ หลัง re-arm
check('H 185k หลัง compact → tier1 ยิงซ้ำ (re-armed) ✅', h2 && h2.decision === 'block' && /tier=tier1/.test(ctxOf(h2)));

// ── cleanup ──────────────────────────────────────────────────────────────────
// marker/state ทั้งหมดอยู่ใน fakeHome → ลบทิ้งทั้งก้อน ไม่กระทบของจริง
rmSync(fakeHome, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
