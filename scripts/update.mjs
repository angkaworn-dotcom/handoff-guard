#!/usr/bin/env node
// update.mjs — อัปเดตรวมจุดเดียว: (1) handoff-guard เอง จาก repo main  (2) skill `handoff` ของ Matt จาก upstream
// usage:
//   node update.mjs --check   เช็คว่ามีอะไรใหม่ทั้งสองส่วน (ไม่เขียนอะไรเลย)
//   node update.mjs           อัปเดตทั้งสองส่วน: ดึง repo ล่าสุด → รัน installer ของเวอร์ชันใหม่ → ดึง handoff ล่าสุด
// การอัปเดตเป็นคำสั่งที่ผู้ใช้สั่งเองเสมอ (ผ่าน CLI หรือ /handoff-guard-update) — ไม่มี auto-pull เงียบๆ
// หมายเหตุ: ไฟล์นี้จะถูกเขียนทับระหว่างอัปเดตตัวเอง — ปลอดภัยเพราะ Node โหลดทั้งไฟล์เข้า memory ก่อนรัน
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// env override มีไว้ให้ test ชี้ mock server เท่านั้น — ใช้งานจริงคง URL ตายตัว
const TARBALL = process.env.HANDOFF_GUARD_SELF_TARBALL
  || 'https://codeload.github.com/angkaworn-dotcom/handoff-guard/tar.gz/refs/heads/main';

const claude = join(homedir(), '.claude');
const skillDir = join(claude, 'skills', 'handoff-guard');

async function downloadTarball(dest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(TARBALL, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

// เดินไฟล์ทุกตัวใต้ dir (recursive) — คืน path แบบ relative
// ใช้ภายในไฟล์นี้เท่านั้น (installMap เรียก) — ตัวนอกอย่าง install.mjs/selftest import installMap ไม่ใช่ walk
function walk(dir, base = dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

// normalize ข้อความให้เทียบแบบ line-ending-agnostic + ตัด BOM หัวไฟล์ทิ้ง:
//  - strip leading UTF-8 BOM (U+FEFF) — บางเครื่องมือ/editor ใส่ BOM ให้ .md แต่ tarball GitHub ไม่มี
//  - \r\n → \n — บน Windows ที่ core.autocrlf=true installed copy เป็น CRLF แต่ tarball เป็น LF
// ถ้าเทียบ byte ตรงๆ จะตีว่า "ต่าง" ทุกไฟล์ที่มี BOM/ขึ้นบรรทัด = false positive ว่ามีอัปเดตตลอด
// ตัวเดียวใช้ร่วมทั้ง repo: sameFile ที่นี่ + ensure-handoff.mjs import ไปใช้ (ไฟล์ text ล้วน — normalize ปลอดภัย)
export const normEol = (s) => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const sameFile = (a, b) => {
  try { return normEol(readFileSync(a, 'utf8')) === normEol(readFileSync(b, 'utf8')); } catch { return false; }
};

// รายการ (ไฟล์ใน repo → ที่ติดตั้งจริง) — ล้อโครงของ scripts/install.mjs
// claudeRoot เป็น param เพื่อให้ updater-selftest.mjs ชี้บ้านปลอมได้โดยใช้ mapping ตัวจริง (ไม่ mirror)
export function installMap(repoDir, claudeRoot = claude) {
  const sDir = join(claudeRoot, 'skills', 'handoff-guard');
  const hDir = join(claudeRoot, 'hooks');
  const cDir = join(claudeRoot, 'commands');
  const map = [
    ['SKILL.md', join(sDir, 'SKILL.md')],
    ['SETUP.md', join(sDir, 'SETUP.md')],
    [join('hooks', 'context-guard.mjs'), join(hDir, 'context-guard.mjs')],
    [join('hooks', 'session-resume.mjs'), join(hDir, 'session-resume.mjs')],
  ];
  for (const sub of ['scripts', 'vendor']) {
    const d = join(repoDir, sub);
    if (existsSync(d)) for (const f of walk(d)) map.push([join(sub, f), join(sDir, sub, f)]);
  }
  const cd = join(repoDir, 'commands');
  if (existsSync(cd)) {
    for (const f of readdirSync(cd)) {
      if (f.endsWith('.md') && !f.endsWith('.en.md')) map.push([join('commands', f), join(cDir, f)]);
    }
  }
  return map;
}

// เทียบว่าไฟล์นี้ถูกเรียกตรงจาก CLI หรือไม่ — ด้วย realpath ทั้งสองฝั่ง:
// Node realpath ทาง ESM entry ให้อยู่แล้ว ถ้าเทียบ metaUrl กับ argv[1] ดิบๆ (ผ่าน pathToFileURL)
// การรันผ่าน junction/symlink จะได้ false → CLI เงียบ exit 0 (สังเกตจริงบน Windows junction)
// realpathSync สองฝั่งให้ตรงกันจึงทำงานถูกไม่ว่าจะเรียกผ่าน link ใด · argv[1] undefined/error → false
export function isMainModule(metaUrl) {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

// รันเฉพาะตอนเรียกตรงจาก CLI — ตอนถูก import (โดย updater-selftest.mjs) ต้องไม่ยิงเน็ต/ไม่ exit
if (isMainModule(import.meta.url)) {
const checkOnly = process.argv.includes('--check');
let fail = false;
const tmp = mkdtempSync(join(tmpdir(), 'hg-update-'));
try {
  // ── ส่วนที่ 1: handoff-guard เอง ─────────────────────────────────────────────
  console.log('── handoff-guard (repo main) ──');
  const tgz = join(tmp, 'repo.tgz');
  await downloadTarball(tgz);
  // รัน tar โดยตั้ง cwd=tmp + ส่ง archive เป็น basename (ไม่มี drive colon) — กัน GNU tar
  // ตีความ path แบบ "C:\..." เป็น remote host (host:path ของ rsh) แล้วพัง "Cannot connect to C:"
  // แบบนี้ทนทั้ง GNU tar และ bsdtar โดยไม่ต้องพึ่ง --force-local · Windows 10+/macOS/Linux มี tar ในตัว
  execFileSync('tar', ['-xzf', 'repo.tgz'], { cwd: tmp });
  const inner = readdirSync(tmp, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!inner) throw new Error('tarball ว่าง');
  const repoDir = join(tmp, inner.name);
  // sanity: ต้องเป็น repo handoff-guard จริง ก่อนเอา installer ของมันมารัน
  const skillHead = readFileSync(join(repoDir, 'SKILL.md'), 'utf8').slice(0, 400);
  if (!/name:\s*handoff-guard/.test(skillHead)) throw new Error('เนื้อหา tarball ไม่ใช่ handoff-guard');

  const changed = installMap(repoDir)
    .filter(([src, dest]) => !sameFile(join(repoDir, src), dest))
    .map(([src]) => src);
  if (!changed.length) {
    console.log('handoff-guard: ตรงกับ repo ล่าสุดอยู่แล้ว ✅');
  } else {
    console.log(`handoff-guard: มีไฟล์ใหม่/เปลี่ยน ${changed.length} ไฟล์:`);
    for (const f of changed) console.log('  · ' + f);
    if (checkOnly) {
      console.log('handoff-guard: (--check) ยังไม่เขียนอะไร · รับมา: รันโดยไม่ใส่ --check');
    } else {
      // รัน installer "ของเวอร์ชันใหม่" — copy ครบทุกส่วน + merge settings แบบ idempotent
      const r = spawnSync(process.execPath, [join(repoDir, 'scripts', 'install.mjs')], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('installer ล้มเหลว (exit ' + r.status + ')');
    }
  }

  // ── ส่วนที่ 2: skill `handoff` ของ Matt ─────────────────────────────────────
  console.log('\n── skill handoff (Matt Pocock upstream) ──');
  // ใช้ตัวจาก repoDir ก่อน (= ตัวที่เพิ่งดาวน์โหลดล่าสุด ทั้งโหมด --check และ full-update) —
  // ตกมาใช้ตัวที่ติดตั้งไว้เดิมเฉพาะกรณี tarball ไม่มี (ไม่ควรเกิด) · repoDir คือของใหม่เสมอ ไม่ใช่ตัว stale
  const eh = [join(repoDir, 'scripts', 'ensure-handoff.mjs'), join(skillDir, 'scripts', 'ensure-handoff.mjs')]
    .find(existsSync);
  const r2 = spawnSync(process.execPath, [eh, checkOnly ? '--check' : '--update'], { stdio: 'inherit' });
  if (r2.status !== 0) fail = true;   // upstream ล่ม/เนื้อหาผิด — รายงานแล้วโดย ensure-handoff เอง

  console.log(checkOnly
    ? '\nเช็คเสร็จ — ยังไม่แตะไฟล์ใดๆ'
    : '\n🎉 อัปเดตเสร็จ — restart Claude Code session เพื่อโหลดของใหม่');
} catch (e) {
  console.error('update: ไม่สำเร็จ — ' + e.message);
  fail = true;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
}
