#!/usr/bin/env node
// ตั้งเพดาน context (MAX) ของ handoff-guard เอง — เขียน ~/.claude/.handoff-guard/config.json
// context-guard.mjs (Stop hook) จะอ่านไฟล์นี้ทุกเทิร์น (ไม่ต้อง restart session)
// usage: node set-max.mjs <max>      -> ตั้ง MAX ใหม่, T1=72%, T2=85% (auto)
//        node set-max.mjs <max> <t1> <t2>  -> ตั้งเองทั้ง 3 ค่า
//        node set-max.mjs reset|default     -> ลบ config, กลับไปใช้ hardcoded default (256000)
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
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

const arg0 = (process.argv[2] || '').trim().toLowerCase();

if (!arg0 || arg0 === 'reset' || arg0 === 'default') {
  if (existsSync(configPath)) unlinkSync(configPath);
  console.log('✅ รีเซ็ตแล้ว — ลบ config, กลับไป auto-detect เพดานจากโมเดลต่อเทิร์น (opus 256k · sonnet/haiku 200k)');
  process.exit(0);
}

const max = Number(process.argv[2]);
if (!Number.isFinite(max) || !Number.isInteger(max)) fail(`"${process.argv[2]}" ไม่ใช่จำนวนเต็ม — ใส่ token count เช่น 200000`);
if (max < MIN_MAX || max > MAX_MAX) fail(`MAX ต้องอยู่ระหว่าง ${MIN_MAX} ถึง ${MAX_MAX} (ได้ ${max})`);

let t1 = process.argv[3] !== undefined ? Number(process.argv[3]) : Math.round(max * 0.72);
let t2 = process.argv[4] !== undefined ? Number(process.argv[4]) : Math.round(max * 0.85);

if (!Number.isFinite(t1) || !Number.isFinite(t2)) fail('t1/t2 ที่ใส่เองต้องเป็นตัวเลข');
if (t1 <= 0 || t2 <= 0) fail('t1/t2 ต้องเป็นค่าบวก');
if (t1 >= t2) fail(`tier1 (${t1}) ต้องน้อยกว่า tier2 (${t2})`);
if (t2 > max) fail(`tier2 (${t2}) ต้องไม่เกิน MAX (${max})`);

mkdirSync(dir, { recursive: true });
writeFileSync(configPath, JSON.stringify({ max, t1, t2 }, null, 2));

console.log(`✅ ตั้งเพดานใหม่: MAX=${max}, tier1(เตือน)=${t1}, tier2(ด่วน)=${t2}`);
console.log(`   บันทึกที่ ${configPath} — มีผลเทิร์นถัดไป · pin ทุกโมเดล (override auto-detect)`);
console.log('   กลับไป auto-detect: node set-max.mjs reset (หรือ /handoff-guard-max reset)');
