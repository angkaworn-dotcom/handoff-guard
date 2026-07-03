#!/usr/bin/env node
// Stop hook — context-guard (Context Manager V2)
// L1 Observe : วัด token จริงจาก transcript (usage ของ assistant message ล่าสุด)
// L2 Predict : EWMA ของ growth/เทิร์น → ETA "อีกกี่เทิร์นถึง T2" (deterministic)
// → block ไม่ให้ Claude หยุด + ฉีด instruction ให้ invoke skill "handoff-guard"
//   เมื่อ (predict) คาดว่าใกล้เต็ม หรือ (absolute) token ทะลุ threshold เดิม (safety net)
// กัน loop ด้วย marker ต่อ session ต่อ tier (.p / .t1 / .t2)
import {
  readFileSync, mkdirSync, existsSync, writeFileSync, rmSync,
  openSync, readSync, closeSync, fstatSync, readdirSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// config.json เขียนโดย scripts/set-max.mjs (ผ่านสั่ง /handoff-guard-max) — persist ข้าม session
// priority ของ MAX: env (override ชั่วคราว/testing) > config.json (pin ถาวรผ่านคำสั่ง)
//                   > เพดานของโมเดลที่ detect จาก transcript > fallback 200000 (เล็กสุด = ปลอดภัย)
let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(join(homedir(), '.claude', '.handoff-guard', 'config.json'), 'utf8'));
} catch { fileConfig = {}; }

// kill switch: MAX=0 = ปิด guard ทั้งตัว (ไม่อ่าน transcript ไม่เตือน ไม่ block)
// ตั้งด้วย `/handoff-guard-max 0` (เขียน config.json {max:0}) หรือ env HANDOFF_GUARD_MAX=0 (ชั่วคราว)
// เปิดคืน: /handoff-guard-max reset (auto) หรือ /handoff-guard-max <n> (pin ค่าใหม่)
{
  const pinned = process.env.HANDOFF_GUARD_MAX ?? fileConfig.max;   // undefined = ไม่ได้ตั้ง → ไม่ใช่ kill switch
  if (pinned !== undefined && pinned !== '' && Number(pinned) === 0) process.exit(0);
}

// เพดาน context ต่อโมเดล — auto-detect ต่อเทิร์นจาก message.model (transcript บันทึกให้ + เปลี่ยนกลางเซสชันได้)
// "[1m]" (long-context 1M) > fable/mythos 512k > opus 256k > sonnet/haiku/ไม่รู้จัก 200k
// fable/mythos: window จริงใหญ่มาก (spec 1M — สังเกตจริงโตทะลุ 400k โดยยังไม่ auto-compact) →
//   ตั้ง 512k เป็นกันชนครึ่งทาง: สูงพอไม่เตือนเร็วเกิน แต่ยังเผื่อไว้เผื่อ CC compact ก่อน 1M (อยากดันสุด: pin 1000000)
// (ไม่รู้จัก = สมมติเล็กสุด → guard ยิงเร็วดีกว่าไม่ยิงเลยบนโมเดลเพดานต่ำ)
// pattern ข้างล่างผูกกับ format ของ message.model ที่ Anthropic เปลี่ยนได้ — ถ้าโมเดลใหม่ไม่ match
// จะ fallback 200k (ปลอดภัยแต่เตือนถี่บนโมเดลเพดานสูง) → override ได้เองไม่ต้องแก้โค้ด:
// config.json {"windows": {"<regex>": <tokens>, ...}} เช็คก่อน built-in ตามลำดับที่เขียน
const windowForModel = (m) => {
  if (fileConfig.windows && typeof fileConfig.windows === 'object') {
    for (const [pat, tok] of Object.entries(fileConfig.windows)) {
      try { if (new RegExp(pat, 'i').test(m) && Number(tok) > 0) return Number(tok); }
      catch { /* pattern เสีย — ข้ามไปตัวถัดไป */ }
    }
  }
  return /\[1m\]/.test(m) ? 1000000 :
    /fable|mythos/.test(m) ? 512000 :
    /opus/.test(m) ? 256000 : 200000;
};

const K = Number(process.env.HANDOFF_GUARD_PREDICT_TURNS || 3);     // lead time (เทิร์น) ของ predict trigger
const ALPHA = Number(process.env.HANDOFF_GUARD_EMA_ALPHA || 0.4);   // น้ำหนัก EWMA ของ delta ล่าสุด
const FLOOR = 500;  // rate ต่ำสุดที่ยอมใช้หาร (กัน ETA ระเบิดเป็น Infinity)
const SWEEP_DAYS = 14;  // marker/state ของ session ที่ไม่ถูกแตะเกินนี้ → ลบทิ้ง (กันสะสมไม่จำกัด)

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// หา usage/model ของ assistant message "ล่าสุดของ main conversation" จาก transcript JSONL
// - อ่านจากท้ายไฟล์เป็น chunk (ขยายทีละ 4 เท่าจนเจอ) — ไม่อ่านทั้งไฟล์: transcript โตหลายสิบ MB
//   ตอน context ใกล้เต็ม ซึ่งเป็นจังหวะที่ hook นี้ต้องเร็วที่สุด
// - ข้าม entry ของ subagent (isSidechain) — context ของ subagent เล็กกว่า main มาก ถ้านับปน
//   delta จะติดลบปลอม (โดนตีความเป็น compaction → re-arm marker ทิ้ง) แล้วเทิร์นถัดไป
//   delta โตผิดจริง → EWMA พัง → predict ยิงมั่ว
function lastMainUsage(transcript) {
  let fd;
  try { fd = openSync(transcript, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    let chunk = 256 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();   // บรรทัดแรกของ chunk อาจโดนตัดกลางบรรทัด — ทิ้ง
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        let obj;
        try { obj = JSON.parse(s); } catch { continue; }
        if (obj.isSidechain) continue;
        const u = obj && obj.message && obj.message.usage;
        if (!u) continue;
        return {
          tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
                + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
          model: obj.message.model || '',
        };
      }
      if (start === 0) return null;   // อ่านถึงหัวไฟล์แล้วยังไม่เจอ usage เลย
      chunk *= 4;
    }
  } catch { return null; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }

  const sessionId = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const transcript = input.transcript_path || '';
  if (!transcript || !existsSync(transcript)) process.exit(0);

  // L1 — token + โมเดลปัจจุบัน = usage/model ของ assistant message ล่าสุด (main only)
  // (input + cache_read + cache_creation + output = ขนาด context ที่โมเดลเห็นรอบนั้น)
  const last = lastMainUsage(transcript);
  if (!last) process.exit(0);
  const tokens = last.tokens;
  const model = last.model;

  // เพดาน/threshold — คำนวณหลังรู้โมเดล (env > config.json pin > โมเดลที่ detect > fallback)
  const MAX = Number(process.env.HANDOFF_GUARD_MAX || fileConfig.max || windowForModel(model));
  const T1 = Number(process.env.HANDOFF_GUARD_THRESHOLD || fileConfig.t1 || Math.round(MAX * 0.72));  // tier1: เตือน/ประเมิน (72% → ยิงก่อน CC auto-compact ~85%)
  const T2 = Number(process.env.HANDOFF_GUARD_THRESHOLD2 || fileConfig.t2 || Math.round(MAX * 0.85)); // tier2: ด่วน + เป้า ETA

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
    state = { lastTokens: tokens, ema: 0, turns: 1, lastDelta: 0 };
    // จังหวะเดียวกันนี้ (ครั้งเดียวต่อ session — ไม่เปลือง I/O ทุกเทิร์น) เก็บกวาด marker/state
    // ของ session เก่าที่ไม่มีวันถูกลบเอง — ไม่งั้นสะสมไม่จำกัดใน .handoff-guard/
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (!d.isFile() || !/\.(t1|t2|p|state\.json)$/.test(d.name)) continue;
        const fp = join(dir, d.name);
        try {
          if (Date.now() - statSync(fp).mtimeMs > SWEEP_DAYS * 864e5) rmSync(fp, { force: true });
        } catch { /* ไฟล์หาย/ล็อก — ข้าม */ }
      }
    } catch { /* dir อ่านไม่ได้ — ข้าม */ }
  } else {
    const delta = tokens - state.lastTokens;
    if (delta < 0) {
      // compaction/รีเซ็ตเกิดขึ้น → ไม่นับ delta ลบ, คง ema เดิม, reset baseline
      // + re-arm: ลบ marker ที่เคยยิง เพื่อให้เตือนใหม่ได้ถ้า context โตทะลุ T1/T2 อีกรอบหลัง compact
      // (session ที่ compact แล้วโตอีก = degrade แล้ว ยิ่งต้อง hand off — ไม่งั้นเงียบถาวร)
      // force: true = ไฟล์ไหนไม่มีก็ข้าม — ห้าม throw กลางคัน ไม่งั้นตัวถัดไปไม่ถูกลบ
      rmSync(m1, { force: true });
      rmSync(m2, { force: true });
      rmSync(mp, { force: true });
      state.lastDelta = 0;
    } else {
      if (!state.ema) state.ema = delta;                        // delta จริงตัวแรก
      else state.ema = ALPHA * delta + (1 - ALPHA) * state.ema; // EWMA
      state.lastDelta = delta;
    }
    state.lastTokens = tokens;
    state.turns = (state.turns || 0) + 1;
  }
  try { writeFileSync(statePath, JSON.stringify(state)); } catch { /* best effort */ }

  const rate = Math.max(state.ema || 0, FLOOR);
  let etaTurns = Math.ceil((T2 - tokens) / rate);
  // overshoot guard: EWMA ถ่วง spike โดยตั้งใจ (กัน ETA กระตุก) แต่ทำให้มองไม่เห็น "เทิร์นยักษ์" —
  // ถ้า delta ล่าสุดตัวเดียวก็พาทะลุ T2 ได้ในเทิร์นหน้า ให้ถือว่า ETA=1 ไม่ต้องรอ EWMA ปรับตัว
  const overshootNext = (state.lastDelta || 0) > 0 && tokens + state.lastDelta >= T2;
  if (overshootNext) etaTurns = Math.min(etaTurns, 1);

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

  // predict (L2) — fire ครั้งเดียวต่อรอบ (marker re-arm หลัง compaction), ก่อนถึง absolute tier,
  // เมื่อ ema ตั้งตัวแล้ว หรือ delta ล่าสุดตัวเดียวจะพาทะลุ T2 (overshoot guard)
  if (tokens < T1 && state.turns >= 2 && ((state.ema > 0 && etaTurns <= K) || overshootNext) && !existsSync(mp)) {
    writeFileSync(mp, String(tokens));
    emit(
      `Context ~${tokens} tokens — คาดอีก ~${etaTurns} เทิร์นถึง ${T2}`,
      `🟡 คาดการณ์ [tier=predict · tokens=${tokens} · rate=${Math.round(rate)}/เทิร์น · etaTurns=${etaTurns}]: context ~${tokens}/${MAX} โตเฉลี่ย ~${Math.round(rate)}/เทิร์น → อีก ~${etaTurns} เทิร์นจะแตะ ${T2}. ปิด step ปัจจุบันให้จบ แล้ว invoke skill "handoff-guard" เพื่อเตรียม handoff. อย่าเริ่มงานใหญ่ใหม่.`
    );
  }

  process.exit(0);
}
main();
