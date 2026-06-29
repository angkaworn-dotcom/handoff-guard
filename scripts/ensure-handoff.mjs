#!/usr/bin/env node
// ensure skill `handoff` (Matt Pocock — github.com/mattpocock/skills) ติดตั้งแล้ว
// ถ้าไม่มี: (1) ดึงจาก source จริงผ่าน fetch  (2) ถ้าดึงไม่ได้ → fallback สำเนา vendored
// หมายเหตุ: skill โหลดตอนเปิด session → ติดตั้งแล้วต้อง restart ถึง invoke ได้
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md';
const target = join(homedir(), '.claude', 'skills', 'handoff');
const targetSkill = join(target, 'SKILL.md');

if (existsSync(targetSkill)) {
  console.log('handoff: already installed ✅');
  process.exit(0);
}
mkdirSync(target, { recursive: true });

async function fromUpstream() {
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

function fromVendored() {
  const here = dirname(fileURLToPath(import.meta.url));
  const v = join(here, '..', 'vendor', 'handoff', 'SKILL.md');
  if (!existsSync(v)) throw new Error('ไม่พบ vendored ที่ ' + v);
  copyFileSync(v, targetSkill);
}

try {
  await fromUpstream();
  console.log('handoff: ติดตั้งจาก upstream (mattpocock/skills) → ' + target + ' · restart session เพื่อโหลด');
} catch (e) {
  try {
    fromVendored();
    console.log('handoff: upstream ไม่ได้ (' + e.message + ') → ใช้ vendored → ' + target + ' · restart session');
  } catch (e2) {
    console.error('handoff: ติดตั้งไม่สำเร็จ — ' + e2.message);
    process.exit(1);
  }
}
