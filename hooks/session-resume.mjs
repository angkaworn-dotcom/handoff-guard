#!/usr/bin/env node
// SessionStart hook — auto-resume
// เมื่อเปิด/ต่อ session ถ้าเจอ handoff "ของโปรเจกต์นี้" → ฉีดตัวชี้ให้ Claude อ่านก่อนเริ่ม
// ปิดวงจร: handoff-guard เขียน handoff ไว้ → session ใหม่อ่านเองอัตโนมัติ ไม่ต้องพึ่งความจำ
//
// v2: pointer เป็น per-project (~/.claude/.handoff-guard/pointers/*.json) แทน last-handoff.txt slot เดียว
//   - กัน handoff ข้ามโปรเจกต์ปนกัน + กันเขียนทับกันเมื่อทำหลายโปรเจกต์คู่กัน
//   - pointer หมดอายุ MAX_AGE_DAYS วัน (งานจบแล้วไม่เด้ง noise ค้าง)
//   - ข้าม pointer ที่ doc ปลายทางหายแล้ว (เช่นโดน Disk Cleanup)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_AGE_DAYS = 7;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }
const cwd = input.cwd || process.cwd();

// normalize path สำหรับเทียบบน Windows (backslash/case-insensitive)
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const here = norm(cwd);

// ไฟล์ที่ "ส่งสัญญาณ continue-me" ในโปรเจกต์ (per-project โดยธรรมชาติ — คงเดิม)
const signals = ['HANDOFF.md', 'docs/HANDOFF.md', '.claude/session-state.md'];
const found = signals.map((p) => join(cwd, p)).filter(existsSync);

// pointer per-project ที่ handoff-guard เขียนไว้: pointers/*.json = {"cwd": "...", "handoff": "..."}
// match: exact · session อยู่ใต้ path ของ pointer · pointer อยู่ใน .claude/worktrees/ ของ session
// (main repo ↔ worktree ถือเป็นโปรเจกต์เดียวกัน — แต่ไม่ยอม parent-folder match ทั่วไป)
const pointersDir = join(homedir(), '.claude', '.handoff-guard', 'pointers');
let lastHandoff = '';
let lastPointer = '';
try {
  const candidates = [];
  for (const f of readdirSync(pointersDir)) {
    if (!f.endsWith('.json')) continue;
    const fp = join(pointersDir, f);
    try {
      const st = statSync(fp);
      if (Date.now() - st.mtimeMs > MAX_AGE_DAYS * 864e5) continue; // งานเก่าเกิน — ข้าม
      // strip BOM — pointer ที่เผลอเขียนด้วย PowerShell -Encoding utf8 จะมี U+FEFF นำหน้า → JSON.parse throw แบบเงียบ
      const { cwd: pc, handoff } = JSON.parse(readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
      const pcn = norm(pc);
      if (!pcn || !handoff) continue;
      // ทิศ session-ลึกกว่า (here ใต้ pcn) ยอมทั่วไป: เปิดที่ subdir/worktree ของโปรเจกต์ pointer = เรื่องเดียวกัน
      // ทิศ pointer-ลึกกว่า จำกัดเฉพาะ worktree ใต้ .claude/worktrees/ ของ here เท่านั้น —
      // ถ้ายอม prefix ทั่วไป การเปิด session ที่โฟลเดอร์แม่ (เช่น ~/projects) จะ match pointer
      // ของทุกโปรเจกต์ข้างใต้แล้วเด้ง handoff ที่ไม่เกี่ยวขึ้นมา
      const sameProject = here === pcn
        || here.startsWith(pcn + '/')
        || pcn.startsWith(here + '/.claude/worktrees/');
      if (!sameProject) continue;
      if (!existsSync(handoff)) continue; // doc ปลายทางหายแล้ว — ข้าม
      candidates.push({ handoff, mtime: st.mtimeMs, exact: here === pcn, fp });
    } catch { /* pointer เสีย — ข้าม */ }
  }
  // exact cwd match มาก่อน — main/แต่ละ worktree มี pointer ของตัวเอง = ไม่หยิบของ worktree อื่น
  // ที่บังเอิญเขียนทับช่องเดิม · ถ้าไม่มี exact ค่อย fallback prefix-match ที่ใหม่สุด (main↔worktree)
  candidates.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (b.mtime - a.mtime));
  if (candidates.length) { lastHandoff = candidates[0].handoff; lastPointer = candidates[0].fp; }
} catch { /* ยังไม่มี pointers dir — เงียบ */ }

// สรุป handoff สั้นๆ สำหรับโชว์ผู้ใช้ทันที (systemMessage) — title + สถานะ + งานถัดไปข้อแรก
function summarizeHandoff(path) {
  try {
    const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const clip = (s) => { s = s.replace(/\*\*|`/g, ''); return s.length > 140 ? s.slice(0, 137) + '…' : s; };
    const title = (lines.find((l) => l.startsWith('# ')) || '').replace(/^#\s*(Handoff\s*[—-]\s*)?/i, '').trim();
    const status = (lines.find((l) => /^##\s*(สถานะ|Status)/i.test(l)) || '').replace(/^##\s*/, '').trim();
    const i = lines.findIndex((l) => /^##\s*(งานที่รอ|งานถัดไป|Next)/i.test(l));
    const next = i >= 0 ? (lines.slice(i + 1).find((l) => l.trim().startsWith('- ')) || '').trim().replace(/^-\s*/, '') : '';
    return [title, status, next && `ถัดไป: ${next}`].filter(Boolean).map(clip).join('\n');
  } catch { return ''; }
}

const parts = [];
if (found.length) parts.push(`ไฟล์ handoff ในโปรเจกต์: ${found.join(', ')}`);
if (lastHandoff) parts.push(`handoff ล่าสุด: ${lastHandoff}`);

let out = { hookSpecificOutput: { hookEventName: 'SessionStart' } };
if (parts.length) {
  // compact/resume = บทสนทนาเดิมยังอยู่ (กลางงาน) → แค่อ้างอิงเบาๆ ไม่สั่ง resume ซ้อนให้เด้ง
  // startup/clear = context สด → สั่ง Claude อ่าน+ประกาศ handoff เองให้ผู้ใช้เห็นว่า resume แล้ว
  const midTask = ['compact', 'resume'].includes(input.source || '');
  const consumeHint = lastPointer
    ? ` เมื่องานใน handoff นี้เสร็จ หรือผู้ใช้ไม่ต่องานนี้แล้ว → ลบไฟล์ pointer กันเด้งซ้ำ: ${lastPointer}.`
    : '';
  out.hookSpecificOutput.additionalContext = midTask
    ? `📂 (อ้างอิง) handoff ของโปรเจกต์นี้: ${parts.join(' · ')}`
    : `📂 พบงานค้างของโปรเจกต์นี้ (จาก handoff-guard). ก่อนตอบข้อความแรกของผู้ใช้ ให้เปิดอ่าน handoff ด้านล่างด้วย Read ` +
      `แล้วบอกผู้ใช้สั้นๆ 2-3 บรรทัด (ค้างอะไร / อยู่ branch·worktree ไหน / งานถัดไป) เพื่อยืนยันว่า resume แล้ว ` +
      `ก่อนทำงานต่อ — ยกเว้นผู้ใช้เริ่มงานใหม่ที่ไม่เกี่ยวกับ handoff นี้ชัดเจน.${consumeHint} ${parts.join(' · ')}`;
  if (!midTask && lastHandoff) {
    // โชว์สรุปให้ผู้ใช้เห็นทันทีตอน session เริ่ม (documented field — terminal CLI render;
    // แอป/extension ยังไม่ render ณ 2026-07: github.com/anthropics/claude-code/issues/15344)
    const sum = summarizeHandoff(lastHandoff);
    if (sum) out.systemMessage = `📂 งานค้างจาก handoff:\n${sum}`;
  }
}
process.stdout.write(JSON.stringify(out));
