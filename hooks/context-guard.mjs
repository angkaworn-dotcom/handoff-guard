#!/usr/bin/env node
// Stop hook — context-guard
// วัด token จริงจาก transcript (usage ของ assistant message ล่าสุด) ถ้าเกิน threshold
// → block ไม่ให้ Claude หยุด + ฉีด instruction ให้ invoke skill "handoff-guard"
// trigger แม่น (อ่านตัวเลขจริงที่ API รายงาน ไม่ใช่เดา) · กัน loop ด้วย marker ต่อ session ต่อ tier
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const T1 = Number(process.env.HANDOFF_GUARD_THRESHOLD || 170000);   // tier1: เตือน/ประเมิน
const T2 = Number(process.env.HANDOFF_GUARD_THRESHOLD2 || 188000);  // tier2: ด่วน

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }

  const sessionId = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const transcript = input.transcript_path || '';
  if (!transcript || !existsSync(transcript)) process.exit(0);

  // token ปัจจุบัน = usage ของ assistant message ล่าสุด
  // (input + cache_read + cache_creation + output = ขนาด context ที่โมเดลเห็นรอบนั้น)
  let tokens = 0;
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
      }
    }
  } catch { process.exit(0); }

  const dir = join(homedir(), '.claude', '.handoff-guard');
  mkdirSync(dir, { recursive: true });
  const m1 = join(dir, `${sessionId}.t1`);
  const m2 = join(dir, `${sessionId}.t2`);

  const emit = (reason, ctx) => {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx },
    }));
    process.exit(0);
  };

  // tier2 (ด่วน) — fire ครั้งเดียวต่อ session
  if (tokens >= T2 && !existsSync(m2)) {
    writeFileSync(m2, String(tokens));
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (เกิน ${T2} — ด่วน)`,
      `🔴 ด่วน: context ~${tokens}/200000 ใกล้เต็มมาก. ก่อนทำงานอื่นต่อ ให้ invoke skill "handoff-guard" เดี๋ยวนี้ — ปิด step ที่ค้างให้ปลอดภัย, สร้าง handoff doc, แล้วบอกผู้ใช้เปิด session ใหม่.`
    );
  }

  // tier1 — fire ครั้งเดียวต่อ session
  if (tokens >= T1 && !existsSync(m1)) {
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (เกิน ${T1})`,
      `⚠️ context ~${tokens}/200000. invoke skill "handoff-guard" เพื่อประเมินว่าควรขึ้น session ใหม่ไหม (ถ้าอยู่กลาง atomic op ให้ปิดให้ปลอดภัยก่อน). อย่าเริ่มงานใหญ่ใหม่จนกว่าจะประเมินเสร็จ.`
    );
  }

  process.exit(0);
}
main();
