#!/usr/bin/env node
// update.mjs — อัปเดตรวมจุดเดียว: (1) handoff-guard เอง จาก repo main  (2) skill `handoff` ของ Matt จาก upstream
// usage:
//   node update.mjs --check   เช็คว่ามีอะไรใหม่ทั้งสองส่วน (ไม่เขียนอะไรเลย)
//   node update.mjs           อัปเดตทั้งสองส่วน: ดึง repo ล่าสุด → รัน installer ของเวอร์ชันใหม่ → ดึง handoff ล่าสุด
// การอัปเดตเป็นคำสั่งที่ผู้ใช้สั่งเองเสมอ (ผ่าน CLI หรือ /handoff-guard-update) — ไม่มี auto-pull เงียบๆ
// หมายเหตุ: ไฟล์นี้จะถูกเขียนทับระหว่างอัปเดตตัวเอง — ปลอดภัยเพราะ Node โหลดทั้งไฟล์เข้า memory ก่อนรัน
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// env override มีไว้ให้ test ชี้ mock server เท่านั้น — ใช้งานจริงคง URL ตายตัว
const TARBALL = process.env.HANDOFF_GUARD_SELF_TARBALL
  || 'https://codeload.github.com/angkaworn-dotcom/handoff-guard/tar.gz/refs/heads/main';

const checkOnly = process.argv.includes('--check');
const claude = join(homedir(), '.claude');
const skillDir = join(claude, 'skills', 'handoff-guard');
const hooksDir = join(claude, 'hooks');
const cmdDir = join(claude, 'commands');

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
function walk(dir, base = dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

// เทียบเนื้อหาแบบ line-ending-agnostic (\r\n → \n) — บน Windows ที่ core.autocrlf=true
// installed copy เป็น CRLF (install.mjs ก็อปจาก working tree) แต่ tarball จาก GitHub เป็น LF
// ถ้าเทียบ byte ตรงๆ จะตีว่า "ต่าง" ทุกไฟล์ที่มีขึ้นบรรทัด = false positive ว่ามีอัปเดตตลอด
// (ไฟล์ใน installMap เป็น text ล้วน — .md/.mjs — normalize ปลอดภัย)
const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
const sameFile = (a, b) => {
  try { return norm(readFileSync(a)) === norm(readFileSync(b)); } catch { return false; }
};

// รายการ (ไฟล์ใน repo → ที่ติดตั้งจริง) — ล้อโครงของ scripts/install.mjs
function installMap(repoDir) {
  const map = [
    ['SKILL.md', join(skillDir, 'SKILL.md')],
    ['SETUP.md', join(skillDir, 'SETUP.md')],
    [join('hooks', 'context-guard.mjs'), join(hooksDir, 'context-guard.mjs')],
    [join('hooks', 'session-resume.mjs'), join(hooksDir, 'session-resume.mjs')],
  ];
  for (const sub of ['scripts', 'vendor']) {
    const d = join(repoDir, sub);
    if (existsSync(d)) for (const f of walk(d)) map.push([join(sub, f), join(skillDir, sub, f)]);
  }
  const cd = join(repoDir, 'commands');
  if (existsSync(cd)) {
    for (const f of readdirSync(cd)) {
      if (f.endsWith('.md') && !f.endsWith('.en.md')) map.push([join('commands', f), join(cmdDir, f)]);
    }
  }
  return map;
}

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
  // ใช้ตัวที่เพิ่งติดตั้ง (เวอร์ชันล่าสุด) ถ้ามี — ตกมาใช้ตัวข้างๆ ไฟล์นี้ตอนยังไม่ได้ติดตั้ง
  const eh = [join(skillDir, 'scripts', 'ensure-handoff.mjs'), join(repoDir, 'scripts', 'ensure-handoff.mjs')]
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
