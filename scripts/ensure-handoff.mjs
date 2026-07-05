#!/usr/bin/env node
// ensure skill `handoff` (Matt Pocock — github.com/mattpocock/skills) ติดตั้งแล้ว
// ถ้าไม่มี: (1) ใช้สำเนา vendored ในแพ็กเกจ (ผ่านการรีวิวแล้ว — deterministic)
//          (2) vendored หาย → ค่อยดึงจาก upstream ผ่าน fetch
// ลำดับนี้ตั้งใจ: SKILL.md ที่ติดตั้งจะถูกฉีดเข้า context ของ Claude โดยตรง —
// ดึง upstream (branch main, ไม่ pin) เป็นทางหลัก = ถ้า upstream เปลี่ยน/โดน compromise
// จะได้เนื้อหาที่ไม่เคยรีวิวมารันทันที · vendored-first ตัดความเสี่ยงนั้น
// อยากได้เวอร์ชันล่าสุด → สั่งเองแบบตั้งใจ (อัปเดต = การตัดสินใจของผู้ใช้ ไม่ใช่ automation เงียบๆ):
//   --check    เทียบตัวที่ติดตั้งกับ upstream ล่าสุด + โชว์ diff (ไม่เขียนอะไร)
//   --update   ดึง upstream ล่าสุด โชว์ diff แล้วเขียนทับ (สำรองตัวเก่าเป็น SKILL.md.bak)
// หมายเหตุ: skill โหลดตอนเปิด session → ติดตั้ง/อัปเดตแล้วต้อง restart ถึงได้ตัวใหม่
// ใช้ได้ 2 ทาง: (a) รันตรงจาก CLI  (b) import { ensureHandoff, updateHandoff } แล้วเรียกจาก hook/script อื่น
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// normEol (strip BOM + \r\n→\n) + isMainModule import จาก update.mjs (ตัวเดียวกับที่ sameFile ใช้ #7):
// installed copy อาจเป็น CRLF (checkout ด้วย core.autocrlf=true ก่อนยุค .gitattributes) แต่ upstream
// raw.githubusercontent.com เป็น LF เสมอ — เทียบ byte ตรงๆ จะรายงาน "มีเวอร์ชันใหม่" ปลอมทุก --check ทั้งที่เนื้อเดียวกัน
import { normEol, isMainModule } from './update.mjs';

// env override มีไว้ให้ test ชี้ mock server เท่านั้น — ใช้งานจริงคง URL upstream ตายตัว
const RAW = process.env.HANDOFF_GUARD_HANDOFF_RAW
  || 'https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md';

async function fetchUpstream() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(RAW, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    if (!/name:\s*handoff/.test(txt)) throw new Error('unexpected content');
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

async function fromUpstream(targetSkill) {
  writeFileSync(targetSkill, await fetchUpstream());
}

// unified diff ระหว่างเนื้อหาเก่า/ใหม่ — ยืม git diff --no-index (มี git ทุกเครื่องที่ใช้ skill นี้อยู่แล้ว)
function diffText(oldTxt, newTxt) {
  const dir = mkdtempSync(join(tmpdir(), 'hg-handoff-'));
  try {
    const a = join(dir, 'installed-SKILL.md');
    const b = join(dir, 'upstream-SKILL.md');
    writeFileSync(a, oldTxt);
    writeFileSync(b, newTxt);
    try {
      execFileSync('git', ['diff', '--no-index', '--', a, b], { encoding: 'utf8' });
      return '';   // exit 0 = ไม่ต่าง (ไม่ควรมาถึงตรงนี้ — caller เช็คก่อนแล้ว)
    } catch (e) {
      // git diff --no-index exit 1 เมื่อไฟล์ต่าง = เคสปกติ · ไม่มี git → stdout ว่าง
      const out = (e.stdout || '').toString();
      return out || `(แสดง diff ไม่ได้ — ไม่มี git) ขนาดเดิม ${oldTxt.length} → ใหม่ ${newTxt.length} ตัวอักษร`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// คืนค่า { changed: boolean, diff: string, message: string } · write=false = --check (ไม่เขียนอะไร)
export async function updateHandoff({ write } = { write: false }) {
  const target = join(homedir(), '.claude', 'skills', 'handoff');
  const targetSkill = join(target, 'SKILL.md');
  const latest = await fetchUpstream();
  const current = existsSync(targetSkill) ? readFileSync(targetSkill, 'utf8') : null;

  if (current !== null && normEol(current) === normEol(latest)) {
    return { changed: false, diff: '', message: 'handoff: ตรงกับ upstream ล่าสุดอยู่แล้ว ✅' };
  }
  const diff = diffText(current ?? '', latest);
  if (!write) {
    return {
      changed: true, diff,
      message: current === null
        ? 'handoff: ยังไม่ได้ติดตั้ง — upstream ล่าสุดอยู่ด้านบน · ติดตั้ง: รันโดยไม่ใส่ flag (vendored) หรือ --update (upstream)'
        : 'handoff: upstream มีเวอร์ชันใหม่ (diff ด้านบน) · รับมา: --update',
    };
  }
  mkdirSync(target, { recursive: true });
  if (current !== null) writeFileSync(targetSkill + '.bak', current);   // ตัวเก่าไว้ย้อน/เทียบ
  writeFileSync(targetSkill, latest);
  return {
    changed: true, diff,
    message: 'handoff: อัปเดตเป็น upstream ล่าสุดแล้ว ✅'
      + (current !== null ? ' · ตัวเก่าสำรองไว้ที่ SKILL.md.bak' : '')
      + ' · restart session เพื่อโหลดตัวใหม่',
  };
}

function fromVendored(targetSkill) {
  const here = dirname(fileURLToPath(import.meta.url));
  const v = join(here, '..', 'vendor', 'handoff', 'SKILL.md');
  if (!existsSync(v)) throw new Error('ไม่พบ vendored ที่ ' + v);
  copyFileSync(v, targetSkill);
}

// คืนค่า { installed: boolean, source: 'already'|'vendored'|'upstream'|null, message: string }
export async function ensureHandoff() {
  const target = join(homedir(), '.claude', 'skills', 'handoff');
  const targetSkill = join(target, 'SKILL.md');

  if (existsSync(targetSkill)) {
    return { installed: true, source: 'already', message: 'handoff: already installed ✅' };
  }
  mkdirSync(target, { recursive: true });

  try {
    fromVendored(targetSkill);
    return {
      installed: true,
      source: 'vendored',
      message: 'handoff: ติดตั้งจากสำเนา vendored (© Matt Pocock) → ' + target + ' · restart session เพื่อโหลด',
    };
  } catch (e) {
    try {
      await fromUpstream(targetSkill);
      return {
        installed: true,
        source: 'upstream',
        message: 'handoff: vendored ไม่ได้ (' + e.message + ') → ดึงจาก upstream (mattpocock/skills) → ' + target + ' · restart session',
      };
    } catch (e2) {
      return { installed: false, source: null, message: 'handoff: ติดตั้งไม่สำเร็จ — ' + e2.message };
    }
  }
}

// รันเฉพาะตอนเรียกตรงจาก CLI (ไม่รันตอนถูก import) — isMainModule เทียบ realpath สองฝั่ง
// กันเคส junction/symlink ที่ทำให้ guard เดิม false → เงียบ exit 0 (ดู update.mjs)
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--update') || args.includes('--check')) {
    try {
      const r = await updateHandoff({ write: args.includes('--update') });
      if (r.diff) console.log(r.diff);
      console.log(r.message);
    } catch (e) {
      console.error('handoff: เช็ค/อัปเดต upstream ไม่สำเร็จ — ' + e.message);
      process.exit(1);
    }
  } else {
    const result = await ensureHandoff();
    if (result.installed) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  }
}
