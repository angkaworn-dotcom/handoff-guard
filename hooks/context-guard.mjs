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
  // env ว่าง ("") = ไม่ได้ตั้ง — ต้อง fall through ไป config ไม่งั้น env ว่างจะ mask kill switch ของ config {max:0}
  const envMax = process.env.HANDOFF_GUARD_MAX;
  const pinned = (envMax !== undefined && envMax !== '') ? envMax : fileConfig.max;   // undefined = ไม่ได้ตั้ง → ไม่ใช่ kill switch
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
      // ใช้จำนวน byte ที่อ่านได้จริง — read สั้น (ไฟล์โดน truncate ระหว่างอ่าน) จะทิ้ง \0 ค้างท้าย buffer
      const n = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8', 0, n).split('\n');
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
  let MAX = Number(process.env.HANDOFF_GUARD_MAX || fileConfig.max || windowForModel(model));
  // config.max ไม่ใช่ตัวเลข (เช่น "abc") → NaN ทำทุก comparison เป็น false = guard ปิดเงียบ → fallback เพดานโมเดล
  if (!Number.isFinite(MAX) || MAX <= 0) MAX = windowForModel(model);
  // env MAX ตั้ง → t1/t2 ที่ pin ในไฟล์คิดจาก max ตัวเก่า ห้ามเอามาใช้ (config {max:500k,t1:360k}
  // + env MAX=200k → T1 > MAX = guard เงียบตลอด) — คิด % ใหม่จาก MAX เว้นแต่ env T1/T2 ตั้งเอง
  const envMaxSet = (process.env.HANDOFF_GUARD_MAX ?? '') !== '';
  const T1 = Number(process.env.HANDOFF_GUARD_THRESHOLD || (!envMaxSet && fileConfig.t1) || Math.round(MAX * 0.72));  // tier1: เตือน/ประเมิน (72% → ยิงก่อน CC auto-compact ~85%)
  const T2 = Number(process.env.HANDOFF_GUARD_THRESHOLD2 || (!envMaxSet && fileConfig.t2) || Math.round(MAX * 0.85)); // tier2: ด่วน + เป้า ETA

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

  // F3 — เหตุผลเชิงต้นทุนจากค่าที่ "วัดจริง" เท่านั้น (tokens/rate/MAX/T2) ไม่มีเลขเดา
  // remaining = ที่เหลือถึงเพดาน · turnsToMax = อีกกี่เทิร์นชนเพดานที่ rate ปัจจุบัน · etaToT2 = ถึง T2
  // cold start (ema ยังไม่ตั้งตัว เช่น fire แรกของ session): rate = FLOOR ซึ่งเป็น fallback ไม่ใช่การวัด
  // → ห้าม claim "~N เทิร์น" จากค่า floor (เคย claim "~20 เทิร์น" ทั้งที่เทิร์นจริงกิน 10k+ ได้)
  const remaining = Math.max(0, MAX - tokens);
  const rateSettled = (state.ema || 0) > 0;
  const turnsToMax = Math.ceil(remaining / rate);
  const etaToT2 = Math.max(0, etaTurns);   // สูตรเดียวกับ predict — ได้ overshoot clamp ด้วย (เทิร์นยักษ์ → ETA 1)
  const costPhrase = rateSettled
    ? `เหลือ ~${remaining} tok ก่อนเพดาน MAX ≈ ~${turnsToMax} เทิร์นที่ rate นี้`
    : `เหลือ ~${remaining} tok ก่อนเพดาน MAX (rate ยังไม่ settle — ยังประมาณจำนวนเทิร์นไม่ได้)`;

  // F4 — ROI engine (deterministic): แสดง "อยู่ต่อแพงกว่า handoff กี่เท่า" เป็น *ช่วง* เสมอ
  // input เป็นค่าเดา (expected remaining prompts) → ระบุชัดว่าเป็นการประมาณ ไม่ใช่การวัด (กัน pseudo-precision)
  // อ่าน stats.jsonl เฉพาะจังหวะ emit (emit ยิงแล้ว process.exit — ไม่ใช่ I/O ทุกเทิร์น)
  // ปิดได้: env HANDOFF_GUARD_ROI=0 หรือ config {roi:0} → พฤติกรรมกลับไปเท่าก่อน F4 ทุกประการ
  const roiSlug = (p) => String(p).toLowerCase().replace(/[^a-z0-9฀-๿]/g, '-');
  const roiMedian = (arr) => {
    if (!arr.length) return 0;   // กัน NaN — ต้นฉบับ F1 คืน null แต่ฝั่งนี้ผู้เรียกใช้เลขต่อ
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const roiSuffix = (tier) => {
    // kill switch: เทียบ strict เท่านั้น — Number() จะทำ {roi:null}/false/"" กลายเป็น 0 = ปิดเงียบ
    // ทั้งที่ผู้ใช้ไม่ได้ตั้ง (convention เดียวกับ MAX: ค่า config ไม่ valid ห้ามเปลี่ยนพฤติกรรมเงียบ)
    if (process.env.HANDOFF_GUARD_ROI === '0' || fileConfig.roi === 0 || fileConfig.roi === '0') return '';
    try {
      let recs = [];
      try {
        const raw = readFileSync(join(dir, 'stats.jsonl'), 'utf8');
        for (const ln of raw.split('\n')) {
          const s = ln.trim(); if (!s) continue;
          try { recs.push(JSON.parse(s)); } catch { /* บรรทัดเสีย — ข้าม */ }
        }
      } catch { /* ไม่มีไฟล์ — ตกไป default range */ }
      const handoffs = recs.filter((r) => r && r.kind === 'handoff');
      // per-project ก่อน (ถ้า cwd ให้ ≥5) → ไม่ถึงก็ pool รวมทุกโปรเจกต์
      // record key ด้วย slug(mainRepoRoot) (SKILL step 6) แต่ session จาก chip รันใน worktree
      // → ตัด /.claude/worktrees/<name>... ทิ้งก่อน slug (main↔worktree = โปรเจกต์เดียวกัน
      // กติกาเดียวกับ pointer ใน session-resume) ไม่งั้น per-project pool ไม่มีวัน match
      let pool = handoffs;
      if (input.cwd) {
        const cwdMain = String(input.cwd).replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '');
        const cs = roiSlug(cwdMain);
        const pj = handoffs.filter((r) => r.project === cs);
        if (pj.length >= 5) pool = pj;
      }
      const turnsArr = pool.map((r) => r.turns).filter((n) => typeof n === 'number');
      const docArr = pool.map((r) => r.docTokensEst).filter((n) => typeof n === 'number');

      // remaining prompts (ช่วง): override env/config > สถิติ p25–p75 (≥5) > default [5,15]
      let lo, hi, source;
      const envOv = String(process.env.HANDOFF_GUARD_ROI_PROMPTS || '').split(',').map(Number);
      const cfgOv = Array.isArray(fileConfig.roiPrompts) ? fileConfig.roiPrompts.map(Number) : null;
      if (envOv.length === 2 && envOv.every(Number.isFinite)) { [lo, hi] = envOv; source = 'override'; }
      else if (cfgOv && cfgOv.length === 2 && cfgOv.every(Number.isFinite)) { [lo, hi] = cfgOv; source = 'override'; }
      else if (turnsArr.length >= 5) {
        const cur = state.turns || 1;
        const sorted = [...turnsArr].sort((a, b) => a - b);   // sort ครั้งเดียว ใช้สอง percentile
        const pct = (p) => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))];
        lo = Math.max(1, pct(0.25) - cur);
        hi = Math.max(1, pct(0.75) - cur);
        source = 'stats';
      } else { lo = 5; hi = 15; source = 'default'; }
      if (lo > hi) { const t = lo; lo = hi; hi = t; }

      const handoffCost = docArr.length ? Math.round(roiMedian(docArr)) + 3000 : 10000;
      const replayLo = tokens * lo, replayHi = tokens * hi;
      const roiLo = Math.floor(replayLo / handoffCost), roiHi = Math.floor(replayHi / handoffCost);
      if (roiHi <= 0) return '';

      const label = tier === 'tier2' ? 'Critical'
        : tier === 'tier1' ? (roiLo >= 20 ? 'Recommended' : 'Soon')
          : (roiLo >= 20 ? 'Soon' : 'Continue');
      const note = source === 'stats' ? `ช่วงจากสถิติ ${turnsArr.length} session — ประมาณ ไม่ใช่การวัด`
        : source === 'override' ? 'ช่วงกำหนดเองจาก config/env'
          : 'default range — ยังไม่มีสถิติ';
      return ` 💰 ROI(est): replay ~${replayLo}–${replayHi} vs handoff ~${handoffCost} → ~${roiLo}x–${roiHi}x · ${label} (${note})`;
    } catch { return ''; }
  };

  // L3 trigger — priority สูง→ต่ำ (ยิงอันแรกที่เข้าเงื่อนไข)

  // tier2 (ด่วน) — fire ครั้งเดียวต่อ session
  if (tokens >= T2 && !existsSync(m2)) {
    writeFileSync(m2, String(tokens));
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (เกิน ${T2} — ด่วน)`,
      `🔴 ด่วน [tier=tier2 · tokens=${tokens} · max=${MAX} · model=${model || 'unknown'} · rate=${Math.round(rate)} · turns=${state.turns} · etaTurns=0]: context ~${tokens}/${MAX} ใกล้เต็มมาก (${costPhrase}). ทำต่อจนชนเพดาน = โดน auto-compact แล้ว context degrade — นั่นคือต้นทุนจริงของการไม่ handoff. ก่อนทำงานอื่นต่อ ให้ invoke skill "handoff-guard" เดี๋ยวนี้ — ปิด step ที่ค้างให้ปลอดภัย, สร้าง handoff doc, แล้วบอกผู้ใช้เปิด session ใหม่.` + roiSuffix('tier2')
    );
  }

  // tier1 (absolute) — fire ครั้งเดียวต่อ session
  if (tokens >= T1 && !existsSync(m1)) {
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (เกิน ${T1})`,
      `⚠️ [tier=tier1 · tokens=${tokens} · max=${MAX} · model=${model || 'unknown'} · rate=${Math.round(rate)} · turns=${state.turns} · etaTurns=${etaToT2}]: context ~${tokens}/${MAX} (${costPhrase}${rateSettled ? ` · อีก ~${etaToT2} เทิร์นถึง T2 ${T2}` : ''}). invoke skill "handoff-guard" เพื่อประเมินว่าควรขึ้น session ใหม่ไหม (ถ้าอยู่กลาง atomic op ให้ปิดให้ปลอดภัยก่อน). อย่าเริ่มงานใหญ่ใหม่จนกว่าจะประเมินเสร็จ.` + roiSuffix('tier1')
    );
  }

  // predict (L2) — fire ครั้งเดียวต่อรอบ (marker re-arm หลัง compaction), ก่อนถึง absolute tier,
  // เมื่อ ema ตั้งตัวแล้ว หรือ delta ล่าสุดตัวเดียวจะพาทะลุ T2 (overshoot guard)
  if (tokens < T1 && state.turns >= 2 && ((state.ema > 0 && etaTurns <= K) || overshootNext) && !existsSync(mp)) {
    writeFileSync(mp, String(tokens));
    emit(
      `Context ~${tokens} tokens — คาดอีก ~${etaTurns} เทิร์นถึง ${T2}`,
      `🟡 คาดการณ์ [tier=predict · tokens=${tokens} · max=${MAX} · model=${model || 'unknown'} · rate=${Math.round(rate)} · turns=${state.turns} · etaTurns=${etaTurns}]: context ~${tokens}/${MAX} โตเฉลี่ย ~${Math.round(rate)}/เทิร์น → อีก ~${etaTurns} เทิร์นจะแตะ ${T2} (${costPhrase}). ปิด step ปัจจุบันให้จบ แล้ว invoke skill "handoff-guard" เพื่อเตรียม handoff. อย่าเริ่มงานใหญ่ใหม่.` + roiSuffix('predict')
    );
  }

  process.exit(0);
}
main();
