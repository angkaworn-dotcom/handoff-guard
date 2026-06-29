#!/usr/bin/env node
// ensure skill `handoff` (superpowers/Matt) ติดตั้งแล้ว — ถ้าไม่มี copy จาก vendored ใน handoff-guard
// หมายเหตุ: skill โหลดตอนเปิด session → ติดตั้งแล้วต้อง restart ถึงจะ invoke ได้
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = join(homedir(), '.claude', 'skills', 'handoff');
if (existsSync(join(target, 'SKILL.md'))) {
  console.log('handoff: already installed ✅');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));        // .../handoff-guard/scripts
const vendor = join(here, '..', 'vendor', 'handoff');
if (!existsSync(join(vendor, 'SKILL.md'))) {
  console.error('handoff: ไม่พบ vendored copy ที่ ' + vendor + ' — ติดตั้ง handoff เองจาก superpowers');
  process.exit(1);
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    const s = join(src, e), d = join(dst, e);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}
copyDir(vendor, target);
console.log('handoff: ติดตั้งแล้วที่ ' + target + ' → restart session เพื่อให้โหลด');
