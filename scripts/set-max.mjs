#!/usr/bin/env node
// ตั้งเพดาน context (MAX) ของ handoff-guard เอง — เขียน ~/.claude/.handoff-guard/config.json
// context-guard.mjs (Stop hook) จะอ่านไฟล์นี้ทุกเทิร์น (ไม่ต้อง restart session)
// usage: node set-max.mjs <max>      -> ตั้ง MAX ใหม่, T1=72%, T2=85% (auto)
//        node set-max.mjs <max> <t1> <t2>  -> ตั้งเองทั้ง 3 ค่า
//        node set-max.mjs reset|default     -> ลบ config, กลับไป auto-detect เพดานจากโมเดล (fable/mythos 512k · opus 256k · sonnet/haiku 200k · [1m] 1M)
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MIN_MAX = 50000;
const MAX_MAX = 2000000; // กันพิมพ์ผิด (long-context beta สูงสุดที่รู้จักตอนนี้ ~1M)

const dir = join(homedir(), '.claude', '.handoff-guard');
const configPath = join(dir, 'config.json');

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// อ่าน config เดิมมา merge — เขียนทับทั้งไฟล์จะทำลาย field อื่นเงียบๆ
// (เช่น windows map ที่ docs ให้ user เติม regex→tokens เอง หรือ field อนาคตที่เวอร์ชันนี้ยังไม่รู้จัก)
function readConfig() {
  try {
    const c = JSON.parse(readFileSync(configPath, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}

// temp+rename — hook อ่าน config.json ทุกเทิร์น ไฟล์ครึ่งเดียว (crash กลางเขียน) = JSON.parse พังเงียบทุกเทิร์น
function writeConfig(obj) {
  const tmp = configPath + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, configPath);
}

const arg0 = (process.argv[2] || '').trim().toLowerCase();

if (!arg0 || arg0 === 'reset' || arg0 === 'default') {
  if (existsSync(configPath)) unlinkSync(configPath);
  console.log('✅ Reset — removed config, back to auto-detecting the ceiling from the model each turn (fable/mythos 512k · opus 256k · sonnet/haiku 200k · [1m] 1M)');
  process.exit(0);
}

// 0 / off / disable = kill switch — เขียน {max:0} ให้ hook ปิดตัวเอง (ไม่เตือน/ไม่ block)
if (arg0 === '0' || arg0 === 'off' || arg0 === 'disable') {
  mkdirSync(dir, { recursive: true });
  writeConfig({ ...readConfig(), max: 0 });
  console.log('🔕 handoff-guard disabled (MAX=0) — no more warnings/blocks until you set a new value');
  console.log(`   Saved to ${configPath} — takes effect next turn`);
  console.log('   Turn back on: /handoff-guard-max reset (back to auto) or /handoff-guard-max <n> (set manually)');
  process.exit(0);
}

const max = Number(process.argv[2]);
if (!Number.isFinite(max) || !Number.isInteger(max)) fail(`"${process.argv[2]}" is not an integer — pass a token count like 200000`);
if (max < MIN_MAX || max > MAX_MAX) fail(`MAX must be between ${MIN_MAX} and ${MAX_MAX} (got ${max})`);

let t1 = process.argv[3] !== undefined ? Number(process.argv[3]) : Math.round(max * 0.72);
let t2 = process.argv[4] !== undefined ? Number(process.argv[4]) : Math.round(max * 0.85);

if (!Number.isFinite(t1) || !Number.isFinite(t2)) fail('custom t1/t2 must be numbers');
if (t1 <= 0 || t2 <= 0) fail('t1/t2 must be positive');
// floor กันใส่เป็น % โดยเข้าใจผิด (เช่น `200000 72 85` → T2=85 token = block ทุก session ตั้งแต่เทิร์นแรก)
const minT1 = Math.max(1000, Math.round(max * 0.01));
if (t1 < minT1) fail(`tier1 (${t1}) is abnormally low — minimum ${minT1} (1% of MAX) · if you meant to enter a %, use token counts like ${Math.round(max * 0.72)} ${Math.round(max * 0.85)}`);
if (t1 >= t2) fail(`tier1 (${t1}) must be less than tier2 (${t2})`);
if (t2 > max) fail(`tier2 (${t2}) must not exceed MAX (${max})`);

mkdirSync(dir, { recursive: true });
writeConfig({ ...readConfig(), max, t1, t2 });

console.log(`✅ New ceiling set: MAX=${max}, tier1(warn)=${t1}, tier2(urgent)=${t2}`);
console.log(`   Saved to ${configPath} — takes effect next turn · pins every model (overrides auto-detect)`);
console.log('   Back to auto-detect: node set-max.mjs reset (or /handoff-guard-max reset)');
