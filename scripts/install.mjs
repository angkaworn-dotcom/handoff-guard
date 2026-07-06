#!/usr/bin/env node
// One-shot installer — คัดลอกทุกส่วนไป ~/.claude/ + ensure dependency skill + merge settings.json
// ผู้ใช้สั่งรันเอง (ผ่าน install.ps1 / install.sh ที่เช็ค node ก่อน) = install-time เท่านั้น ไม่ใช่ hook อัตโนมัติ
// idempotent: รันซ้ำได้ — copy ทับด้วยของล่าสุด, settings.json เพิ่มเฉพาะ hook ที่ยังไม่มี (ไม่ทับของเดิม)
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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

// 2) settings.json merge — idempotent, ไม่ทับ hooks เดิมของผู้ใช้ (เพิ่มเฉพาะที่ยังไม่มี)
const settingsPath = join(claude, 'settings.json');
let settings = {};
let canMerge = true;
if (existsSync(settingsPath)) {
  // ต้องเป็น JSON *object* เท่านั้น — null/array/string ผ่าน JSON.parse ได้แต่พังตอน merge:
  // null → TypeError ล้มทั้ง install · array → รับ property ได้แต่ JSON.stringify ทิ้ง = hooks หายเงียบ
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a JSON object');
  } catch {
    settings = {};
    canMerge = false;
    console.error('⚠️ settings.json ไม่ใช่ JSON object ที่ parse ได้ — ข้าม merge, เพิ่ม hooks มือตาม settings.example.json');
  }
}
if (canMerge) {
  const nodeCmd = (f) => `node "${join(hooksDir, f).replace(/\\/g, '/')}"`;
  settings.hooks ??= {};
  const ensureHook = (event, matcher, file) => {
    settings.hooks[event] ??= [];
    // เช็ค "มีแล้ว" จาก command จริงเท่านั้น — substring ทั้ง array จะโดนชื่อไฟล์ที่โผล่ใน field อื่น
    // (เช่น matcher/comment) หลอกว่าติดตั้งแล้วทั้งที่ hook ไม่มีจริง
    const installed = settings.hooks[event].some((e) => Array.isArray(e?.hooks)
      && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(file)));
    if (installed) return false; // มีอยู่แล้ว
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
    // temp+rename — settings.json ครึ่งไฟล์ (crash/ENOSPC กลางเขียน) ทำ Claude Code ทั้งตัวอ่าน config ไม่ได้
    const tmpS = settingsPath + '.tmp-' + process.pid;
    writeFileSync(tmpS, JSON.stringify(settings, null, 2) + '\n');
    renameSync(tmpS, settingsPath);
    console.log('✅ settings.json ' + (hadFile ? 'merged (backup → settings.json.bak)' : 'created'));
  } else {
    console.log('✅ settings.json — hooks ครบแล้ว (ไม่แตะ)');
  }
}

// 3) dependency skill `handoff` (Matt Pocock) — ใช้ vendored ก่อน → fallback ดึง upstream
const r = await ensureHandoff();
console.log((r.installed ? '✅ ' : '⚠️ ') + r.message);

console.log('\n🎉 ติดตั้งเสร็จ — restart Claude Code session เพื่อโหลด skill/hooks');
