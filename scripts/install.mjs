#!/usr/bin/env node
// One-shot installer — คัดลอกทุกส่วนไป ~/.claude/ + ensure dependency skill + merge settings.json
// ผู้ใช้สั่งรันเอง (ผ่าน install.ps1 / install.sh ที่เช็ค node ก่อน) = install-time เท่านั้น ไม่ใช่ hook อัตโนมัติ
// idempotent: รันซ้ำได้ — copy ทับด้วยของล่าสุด, settings.json เพิ่มเฉพาะ hook ที่ยังไม่มี (ไม่ทับของเดิม)
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHandoff } from './ensure-handoff.mjs';
import { installMap } from './update.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const claude = join(homedir(), '.claude');

const skillDir = join(claude, 'skills', 'handoff-guard');
const hooksDir = join(claude, 'hooks');
const cmdDir = join(claude, 'commands');
for (const d of [skillDir, hooksDir, cmdDir]) mkdirSync(d, { recursive: true });

// 1) คัดลอกทุกไฟล์ตาม installMap ตัวเดียว (single source of truth — update.mjs ใช้ list เดียวกันเทียบ diff)
//    ครอบ SKILL.md/SETUP.md + hooks/* + commands/*.md (ตัด .en.md) + scripts/ + vendor/ ทั้งหมด
//    เพิ่ม/ลบไฟล์ที่ต้องติดตั้ง = แก้ที่ installMap ที่เดียว ไม่มี hardcode ซ้ำที่นี่
for (const [src, dest] of installMap(repo, claude)) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(repo, src), dest);
}
console.log('✅ skill → ' + skillDir);
console.log('✅ hooks → ' + hooksDir);
console.log('✅ commands → ' + cmdDir);

// 4) settings.json merge — idempotent, ไม่ทับ hooks เดิมของผู้ใช้ (เพิ่มเฉพาะที่ยังไม่มี)
const settingsPath = join(claude, 'settings.json');
let settings = {};
let canMerge = true;
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch { canMerge = false; console.error('⚠️ settings.json parse ไม่ได้ — ข้าม merge, เพิ่ม hooks มือตาม settings.example.json'); }
}
if (canMerge) {
  const nodeCmd = (f) => `node "${join(hooksDir, f).replace(/\\/g, '/')}"`;
  settings.hooks ??= {};
  const ensureHook = (event, matcher, file) => {
    settings.hooks[event] ??= [];
    if (JSON.stringify(settings.hooks[event]).includes(file)) return false; // มีอยู่แล้ว
    const entry = { hooks: [{ type: 'command', command: nodeCmd(file), timeout: 15 }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
    return true;
  };
  const added = [
    ensureHook('Stop', '*', 'context-guard.mjs'),
    ensureHook('SessionStart', null, 'session-resume.mjs'),
  ].some(Boolean);
  if (added) {
    const hadFile = existsSync(settingsPath);
    if (hadFile) copyFileSync(settingsPath, settingsPath + '.bak');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('✅ settings.json ' + (hadFile ? 'merged (backup → settings.json.bak)' : 'created'));
  } else {
    console.log('✅ settings.json — hooks ครบแล้ว (ไม่แตะ)');
  }
}

// 5) dependency skill `handoff` (Matt Pocock) — ใช้ vendored ก่อน → fallback ดึง upstream
const r = await ensureHandoff();
console.log((r.installed ? '✅ ' : '⚠️ ') + r.message);

console.log('\n🎉 ติดตั้งเสร็จ — restart Claude Code session เพื่อโหลด skill/hooks');
