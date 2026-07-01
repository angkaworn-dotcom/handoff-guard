#!/usr/bin/env node
// Stop hook — context-guard (Context Manager V2)
// L1 Observe : วัด token จริงจาก transcript (usage ของ assistant message ล่าสุด)
// L2 Predict : EWMA ของ growth/เทิร์น → ETA "อีกกี่เทิร์นถึง T2" (deterministic)
// → block ไม่ให้ Claude หยุด + ฉีด instruction ให้ invoke skill "handoff-guard"
//   เมื่อ (predict) คาดว่าใกล้เต็ม หรือ (absolute) token ทะลุ threshold เดิม (safety net)
// กัน loop ด้วย marker ต่อ session ต่อ tier (.p / .t1 / .t2)
import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// config.json เขียนโดย scripts/set-max.mjs (ผ่านสั่ง /handoff-guard-max) — persist ข้าม session
// priority ของ MAX: env (override ชั่วคราว/testing) > config.json (pin ถาวรผ่านคำสั่ง)
//                   > เพดานของโมเดลที่ detect จาก transcript > fallback 200000 (เล็กสุด = ปลอดภัย)
let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(join(homedir(), '.claude', '.handoff-guard', 'config.json'), 'utf8'));
} catch { fileConfig = {}; }

// เพดาน context ต่อโมเดล — auto-detect ต่อเทิร์นจาก message.model (transcript บันทึกให้ + เปลี่ยนกลางเซสชันได้)
// opus 256k · sonnet/haiku/ไม่รู้จัก 200k (ไม่รู้จัก = สมมติเล็กสุด → guard ยิงเร็วดีกว่าไม่ยิงเลยบนโมเดลเพดานต่ำ)
const windowForModel = (m) => /opus/.test(m) ? 256000 : 200000;

const K = Number(process.env.HANDOFF_GUARD_PREDICT_TURNS || 3);     // lead time (เทิร์น) ของ predict trigger
const ALPHA = Number(process.env.HANDOFF_GUARD_EMA_ALPHA || 0.4);   // น้ำหนัก EWMA ของ delta ล่าสุด
const FLOOR = 500;  // rate ต่ำสุดที่ยอมใช้หาร (กัน ETA ระเบิดเป็น Infinity)

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }

  const sessionId = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const transcript = input.transcript_path || '';
  if (!transcript || !existsSync(transcript)) process.exit(0);

  // L1 — token + โมเดลปัจจุบัน = usage/model ของ assistant message ล่าสุด
  // (input + cache_read + cache_creation + output = ขนาด context ที่โมเดลเห็นรอบนั้น)
  let tokens = 0;
  let model = '';
  try {
    const lines = readFileSync(transcript, 'utf8').split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch { continue; }
      const u = obj && obj.message && obj.message.usage;
      if (u) {
        tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
               + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        model = (obj.message.model || model);   // โมเดลของ message ที่ให้ token ล่าสุด
      }
    }
  } catch { process.exit(0); }

  // เพดาน/threshold — คำนวณหลังรู้โมเดล (env > config.json pin > โมเดลที่ detect > fallback)
  const MAX = Number(process.env.HANDOFF_GUARD_MAX || fileConfig.max || windowForModel(model));
  const T1 = Number(process.env.HANDOFF_GUARD_THRESHOLD || fileConfig.t1 || Math.round(MAX * 0.85));  // tier1: เตือน/ประเมิน
  const T2 = Number(process.env.HANDOFF_GUARD_THRESHOLD2 || fileConfig.t2 || Math.round(MAX * 0.94)); // tier2: ด่วน + เป้า ETA

  const dir = join(homedir(), '.claude', '.handoff-guard');
  mkdirSync(dir, { recursive: true });
  const m1 = join(dir, `${sessionId}.t1`);
  const m2 = join(dir, `${sessionId}.t2`);
  const mp = join(dir, `${sessionId}.p`);
  const statePath = join(dir, `${sessionId}.state.json`);

  // L2 — อัปเดต EWMA ของ growth rate ข้ามเทิร์น
  let state = null;
  try { if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { state = null; }

  if (!state || typeof state.lastTokens !== 'number') {
    // fire แรกของ session → baseline เท่านั้น ยังไม่มี delta
    state = { lastTokens: tokens, ema: 0, turns: 1 };
  } else {
    const delta = tokens - state.lastTokens;
    if (delta < 0) {
      // compaction/รีเซ็ตเกิดขึ้น → ไม่นับ delta ลบ, คง ema เดิม, reset baseline
      // + re-arm: ลบ marker ที่เคยยิง เพื่อให้เตือนใหม่ได้ถ้า context โตทะลุ T1/T2 อีกรอบหลัง compact
      // (session ที่ compact แล้วโตอีก = degrade แล้ว ยิ่งต้อง hand off — ไม่งั้นเงียบถาวร)
      try { rmSync(m1); rmSync(m2); rmSync(mp); } catch { /* marker อาจยังไม่เคยสร้าง */ }
    } else if (!state.ema) {
      state.ema = delta;            // delta จริงตัวแรก
    } else {
      state.ema = ALPHA * delta + (1 - ALPHA) * state.ema;   // EWMA
    }
    state.lastTokens = tokens;
    state.turns = (state.turns || 0) + 1;
  }
  try { writeFileSync(statePath, JSON.stringify(state)); } catch { /* best effort */ }

  const rate = Math.max(state.ema || 0, FLOOR);
  const etaTurns = Math.ceil((T2 - tokens) / rate);

  const emit = (reason, ctx) => {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx },
    }));
    process.exit(0);
  };

  // L3 trigger — priority สูง→ต่ำ (ยิงอันแรกที่เข้าเงื่อนไข)

  // tier2 (ด่วน) — fire ครั้งเดียวต่อ session
  if (tokens >= T2 && !existsSync(m2)) {
    writeFileSync(m2, String(tokens));
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (เกิน ${T2} — ด่วน)`,
      `🔴 ด่วน [tier=tier2 · tokens=${tokens} · rate=${Math.round(rate)}/เทิร์น]: context ~${tokens}/${MAX} ใกล้เต็มมาก. ก่อนทำงานอื่นต่อ ให้ invoke skill "handoff-guard" เดี๋ยวนี้ — ปิด step ที่ค้างให้ปลอดภัย, สร้าง handoff doc, แล้วบอกผู้ใช้เปิด session ใหม่.`
    );
  }

  // tier1 (absolute) — fire ครั้งเดียวต่อ session
  if (tokens >= T1 && !existsSync(m1)) {
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (เกิน ${T1})`,
      `⚠️ [tier=tier1 · tokens=${tokens} · rate=${Math.round(rate)}/เทิร์น]: context ~${tokens}/${MAX}. invoke skill "handoff-guard" เพื่อประเมินว่าควรขึ้น session ใหม่ไหม (ถ้าอยู่กลาง atomic op ให้ปิดให้ปลอดภัยก่อน). อย่าเริ่มงานใหญ่ใหม่จนกว่าจะประเมินเสร็จ.`
    );
  }

  // predict (L2) — fire ครั้งเดียวต่อ session, ก่อนถึง absolute tier, เมื่อ ema ตั้งตัวแล้ว
  if (tokens < T1 && state.turns >= 2 && state.ema > 0 && etaTurns <= K && !existsSync(mp)) {
    writeFileSync(mp, String(tokens));
    emit(
      `Context ~${tokens} tokens — คาดอีก ~${etaTurns} เทิร์นถึง ${T2}`,
      `🟡 คาดการณ์ [tier=predict · tokens=${tokens} · rate=${Math.round(rate)}/เทิร์น · etaTurns=${etaTurns}]: context ~${tokens}/${MAX} โตเฉลี่ย ~${Math.round(rate)}/เทิร์น → อีก ~${etaTurns} เทิร์นจะแตะ ${T2}. ปิด step ปัจจุบันให้จบ แล้ว invoke skill "handoff-guard" เพื่อเตรียม handoff. อย่าเริ่มงานใหญ่ใหม่.`
    );
  }

  process.exit(0);
}
main();
