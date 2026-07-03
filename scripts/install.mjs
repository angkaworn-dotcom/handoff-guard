#!/usr/bin/env node
// One-shot installer — คัดลอกทุกส่วนไป ~/.claude/ + ensure dependency skill + merge settings.json
// ผู้ใช้สั่งรันเอง (ผ่าน install.ps1 / install.sh ที่เช็ค node ก่อน) = install-time เท่านั้น ไม่ใช่ hook อัตโนมัติ
// idempotent: รันซ้ำได้ — copy ทับด้วยของล่าสุด, settings.json เพิ่มเฉพาะ hook ที่ยังไม่มี (ไม่ทับของเดิม)
import { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHandoff } from './ensure-handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const claude = join(homedir(), '.claude');

const skillDir = join(claude, 'skills', 'handoff-guard');
const hooksDir = join(claude, 'hooks');
const cmdDir = join(claude, 'commands');
for (const d of [skillDir, hooksDir, cmdDir]) mkdirSync(d, { recursive: true });

// 1) skill (SKILL.md + SETUP.md + scripts/ + vendor/ — vendor มีสำเนา handoff ไว้ auto-install)
copyFileSync(join(repo, 'SKILL.md'), join(skillDir, 'SKILL.md'));
copyFileSync(join(repo, 'SETUP.md'), join(skillDir, 'SETUP.md'));
cpSync(join(repo, 'scripts'), join(skillDir, 'scripts'), { recursive: true });
cpSync(join(repo, 'vendor'), join(skillDir, 'vendor'), { recursive: true });
console.log('✅ skill → ' + skillDir);

// 2) hooks
copyFileSync(join(repo, 'hooks', 'context-guard.mjs'), join(hooksDir, 'context-guard.mjs'));
copyFileSync(join(repo, 'hooks', 'session-resume.mjs'), join(hooksDir, 'session-resume.mjs'));
console.log('✅ hooks → ' + hooksDir);

// 3) slash commands
copyFileSync(join(repo, 'commands', 'handoff-guard-max.md'), join(cmdDir, 'handoff-guard-max.md'));
copyFileSync(join(repo, 'commands', 'handoff-guard-update.md'), join(cmdDir, 'handoff-guard-update.md'));
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
