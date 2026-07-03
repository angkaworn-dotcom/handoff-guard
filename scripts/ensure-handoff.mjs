#!/usr/bin/env node
// ensure skill `handoff` (Matt Pocock — github.com/mattpocock/skills) ติดตั้งแล้ว
// ถ้าไม่มี: (1) ใช้สำเนา vendored ในแพ็กเกจ (ผ่านการรีวิวแล้ว — deterministic)
//          (2) vendored หาย → ค่อยดึงจาก upstream ผ่าน fetch
// ลำดับนี้ตั้งใจ: SKILL.md ที่ติดตั้งจะถูกฉีดเข้า context ของ Claude โดยตรง —
// ดึง upstream (branch main, ไม่ pin) เป็นทางหลัก = ถ้า upstream เปลี่ยน/โดน compromise
// จะได้เนื้อหาที่ไม่เคยรีวิวมารันทันที · vendored-first ตัดความเสี่ยงนั้น
// หมายเหตุ: skill โหลดตอนเปิด session → ติดตั้งแล้วต้อง restart ถึง invoke ได้
// ใช้ได้ 2 ทาง: (a) รันตรงจาก CLI  (b) import { ensureHandoff } แล้วเรียกจาก hook อื่น (เช่น session-resume.mjs)
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md';

async function fromUpstream(targetSkill) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(RAW, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    if (!/name:\s*handoff/.test(txt)) throw new Error('unexpected content');
    writeFileSync(targetSkill, txt);
  } finally {
    clearTimeout(timer);
  }
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

// รันเฉพาะตอนเรียกตรงจาก CLI (ไม่รันตอนถูก import)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = await ensureHandoff();
  if (result.installed) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}
