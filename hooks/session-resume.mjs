#!/usr/bin/env node
// SessionStart hook — auto-resume
// เมื่อเปิด/ต่อ session ถ้าเจอไฟล์ handoff ในโปรเจกต์ → ฉีดตัวชี้ให้ Claude อ่านก่อนเริ่ม
// ปิดวงจร: handoff-guard เขียน handoff ไว้ → session ใหม่อ่านเองอัตโนมัติ ไม่ต้องพึ่งความจำ
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }
const cwd = input.cwd || process.cwd();

// ไฟล์ที่ "ส่งสัญญาณ continue-me" ชัดเจน (ไม่เอา task.md เดี่ยวเพราะ common เกินไป = noise)
const signals = ['HANDOFF.md', 'docs/HANDOFF.md', '.claude/session-state.md'];
const found = signals.map((p) => join(cwd, p)).filter(existsSync);

// last-handoff ที่ handoff-guard เขียนไว้ (ข้าม session)
const lastHandoffPtr = join(homedir(), '.claude', '.handoff-guard', 'last-handoff.txt');
let lastHandoff = '';
try {
  if (existsSync(lastHandoffPtr)) lastHandoff = readFileSync(lastHandoffPtr, 'utf8').trim();
} catch { /* ignore */ }

const parts = [];
if (found.length) parts.push(`ไฟล์ handoff ในโปรเจกต์: ${found.join(', ')}`);
if (lastHandoff) parts.push(`handoff ล่าสุด (จาก handoff-guard): ${lastHandoff}`);

let out = { hookSpecificOutput: { hookEventName: 'SessionStart' } };
if (parts.length) {
  out.hookSpecificOutput.additionalContext =
    `📂 ถ้ากำลังต่องานเดิม ให้เปิดอ่านก่อนเริ่ม — ${parts.join(' · ')}`;
}
process.stdout.write(JSON.stringify(out));
