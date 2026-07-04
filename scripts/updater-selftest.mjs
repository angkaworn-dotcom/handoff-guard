#!/usr/bin/env node
// updater-selftest.mjs — hermetic tests ของ pipeline อัปเดต: install.mjs + update.mjs
// selftest.mjs เดิมยิงแค่ hooks/context-guard.mjs — updater ทั้งเส้นไม่มีเทสต์เลย จนบั๊ก Windows 2 ตัวหลุด:
//   #6 tar drive-colon — GNU tar ตีความ archive path "C:\..." เป็น remote host แล้วพัง
//   #7 CRLF false-positive — installed เป็น CRLF, tarball เป็น LF → เทียบ byte ตรงๆ ตีว่า "ต่าง" ตลอด
// ชุดนี้ปิดช่องนั้น: ยิง install.mjs/update.mjs จริง ในบ้านปลอม (fakeHome) + mock http server แทน GitHub
//   → ไม่แตะ ~/.claude จริง ไม่แตะเน็ต · deterministic ทุก run
//
// env override ที่ใช้ทำ mock (มีอยู่แล้วในโค้ดโปรดักชัน — ไว้ทดสอบโดยเฉพาะ):
//   HANDOFF_GUARD_SELF_TARBALL  → tarball ของ handoff-guard เอง (ปกติ = codeload.github.com)
//   HANDOFF_GUARD_HANDOFF_RAW   → SKILL.md ของ skill handoff (ปกติ = raw.githubusercontent.com)
//
// หมายเหตุ #6: tar บน Windows 10+ คือ bsdtar (จัดการ drive-colon ได้เอง) — เทสต์ end-to-end นี้จับ regression
//   ได้เต็มที่บนเครื่องที่ tar เป็น GNU tar (Git-Bash/บาง CI) · บน bsdtar ยังยืนยัน "extract สำเร็จบน path C:\"
//   ตามเกณฑ์ handoff ได้ (การรีเวิร์ตไปใส่ full drive-colon path จะพังทันทีบน GNU tar)
import { Worker } from 'node:worker_threads';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMap } from './update.mjs';   // mapping ตัวจริง — ตัวเดียวกับที่ production ใช้เทียบไฟล์

const HERE = dirname(fileURLToPath(import.meta.url));      // repo/scripts (ตัวจริงที่กำลังทดสอบ)
const REAL_INSTALL = join(HERE, 'install.mjs');
const REAL_UPDATE = join(HERE, 'update.mjs');
const REAL_ENSURE = join(HERE, 'ensure-handoff.mjs');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
};

// ── helpers ────────────────────────────────────────────────────────────────
const toLF = (s) => s.replace(/\r\n/g, '\n');
const toCRLF = (s) => toLF(s).replace(/\n/g, '\r\n');

// เนื้อ fixture (LF ทั้งหมด — เลียน tarball GitHub) · SKILL.md ต้องมี `name: handoff-guard`
// (update.mjs sanity-check ก่อนรัน installer) · vendor/handoff/SKILL.md ต้องมี `name: handoff`
const FIXTURE_TEXT = {
  'SKILL.md': '---\nname: handoff-guard\ndescription: fixture for updater-selftest\n---\n\n# body\nบรรทัดไทย\nline two\n',
  'SETUP.md': '# setup fixture\nalpha\nbeta\ngamma\n',
  'hooks/context-guard.mjs': '// context-guard fixture\nexport const guard = 1;\n',
  'hooks/session-resume.mjs': '// session-resume fixture\nexport const resume = 2;\n',
  'vendor/handoff/SKILL.md': '---\nname: handoff\n---\n\nvendored handoff fixture (© Matt Pocock)\n',
  'commands/handoff-guard-max.md': '# /handoff-guard-max fixture\n',
  'commands/handoff-guard-update.md': '# /handoff-guard-update fixture\n',
  'commands/handoff-guard-max.en.md': '# EN copy — ต้องถูก filter ออกจาก installMap\n',
};
// upstream ของ skill handoff (mock ตอบ ensure-handoff --check/--update) — ต้องมี `name: handoff`
const HANDOFF_UPSTREAM = '---\nname: handoff\ndescription: mock upstream\n---\n\nmock upstream body\n';

// สร้าง fixture repo (dir เดียว top-level ชื่อ handoff-guard-main เลียน tarball GitHub) แล้ว tar เป็น .tgz
// คืน { dir, tgz } · scripts/install.mjs + ensure-handoff.mjs = ตัวจริง (normalize เป็น LF) ให้ update→install รันจริงได้
function buildFixture(work) {
  const dir = join(work, 'handoff-guard-main');
  for (const [rel, txt] of Object.entries(FIXTURE_TEXT)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, toLF(txt));   // LF เสมอ ไม่ว่า disk จริงจะ CRLF
  }
  // scripts จริง — normalize LF · ต้องมี update.mjs ด้วยเพราะ install.mjs + ensure-handoff.mjs
  // ต่าง import { installMap/normEol/isMainModule } จาก './update.mjs' (side-by-side ทั้งสอง layout)
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const f of ['install.mjs', 'ensure-handoff.mjs', 'update.mjs']) {
    writeFileSync(join(dir, 'scripts', f), toLF(readFileSync(join(HERE, f), 'utf8')));
  }
  const tgz = join(work, 'repo.tgz');
  // ตั้ง cwd=work + archive เป็น basename (เลียนวิธี extract ใน update.mjs — กัน drive-colon ฝั่ง create ด้วย)
  execFileSync('tar', ['-czf', 'repo.tgz', 'handoff-guard-main'], { cwd: work });
  return { dir, tgz };
}

// mapped pairs (src fixture → dest ในบ้านปลอม) — ใช้ installMap() ตัวจริงจาก update.mjs
// (เคย mirror ด้วยมือแล้วเสี่ยง drift เงียบ: กติกาใน production เปลี่ยนแต่ test seed แบบเก่า)
function mappedPairs(fixtureDir, fakeHome) {
  return installMap(fixtureDir, join(fakeHome, '.claude'))
    .map(([srcRel, dest]) => ({ src: join(fixtureDir, srcRel), dest }));
}

// วางสำเนา "installed" ในบ้านปลอมเป็น CRLF (เลียน core.autocrlf=true บน Windows)
// mutateRel != null → เติมบรรทัดต่างจริงในไฟล์นั้น (ทดสอบ detect "เปลี่ยน")
function seedInstalled(fakeHome, fixtureDir, { mutateRel = null } = {}) {
  for (const { src, dest } of mappedPairs(fixtureDir, fakeHome)) {
    mkdirSync(dirname(dest), { recursive: true });
    let content = toCRLF(readFileSync(src, 'utf8'));
    if (mutateRel && dest.endsWith(mutateRel)) content += 'DIVERGENT REAL CHANGE\r\n';
    writeFileSync(dest, content);
  }
}

function runNode(script, args, { home, extraEnv = {} }) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv };
  // strip HANDOFF_GUARD_* ของเครื่องจริงที่อาจ leak (ยกเว้นที่ extraEnv ตั้งเอง)
  // ต้อง case-insensitive: env key บน Windows ไม่แยก case — ตัวพิมพ์ผสมหลุดเข้า child ได้
  for (const k of Object.keys(env)) {
    if (/^HANDOFF_GUARD_/i.test(k) && !(k in extraEnv)) delete env[k];
  }
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ── mock server: /repo.tgz (tarball) + /handoff-SKILL.md (upstream ของ skill handoff) ──
// สำคัญ: ต้องรันใน Worker (คนละ event loop) — spawnSync บล็อก event loop ของ main thread
// ถ้า server อยู่ main thread เดียวกัน มันจะ accept request ไม่ได้ตอน child กำลัง fetch = deadlock จน timeout
// ทุกอย่าง (fixture + บ้านปลอมทุกหลัง) อยู่ใต้ ROOT ก้อนเดียว → finally กวาดทีเดียวครบ
// แม้ section ไหน throw กลางคัน — ไม่ทิ้ง temp dir ค้างใน %TEMP% สะสมข้ามรอบ debug
const ROOT = mkdtempSync(join(tmpdir(), 'hg-upd-'));
let worker;
let shuttingDown = false;      // ตั้งก่อน terminate() ตอนจบ — exit หลังจากนี้ = คาดหมาย
let workerCrashed = false;     // error/exit ที่ไม่คาดหมาย = FAIL (mock server ล่มกลางเทสต์)

const WORKER_SRC = `
  const http = require('node:http');
  const { workerData, parentPort } = require('node:worker_threads');
  const tgz = Buffer.from(workerData.tgz);
  const upstream = workerData.upstream;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/repo.tgz')) { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(tgz); }
    else if (req.url.startsWith('/handoff-SKILL.md')) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(upstream); }
    else { res.writeHead(404); res.end('nope'); }
  });
  server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`;
console.log('updater self-test — hermetic (fakeHome + mock http, ไม่แตะ ~/.claude จริง/เน็ต)');

try {
  const fx = buildFixture(join(ROOT, 'fixture'));
  const tgzBytes = readFileSync(fx.tgz);
  worker = new Worker(WORKER_SRC, { eval: true, workerData: { tgz: tgzBytes, upstream: HANDOFF_UPSTREAM } });
  const PORT = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);   // eval/listen พัง → fail ดังๆ ไม่ค้างรอ message ที่ไม่มีวันมา
    worker.once('exit', (code) => reject(new Error('mock worker exit ก่อนพร้อม (code ' + code + ')')));
  });
  // listener ถาวรหลัง PORT พร้อม — ถ้า worker error/exit เองระหว่างเทสต์ (ไม่ใช่ terminate ตอนจบ)
  // = mock server ล่ม → บันทึกไว้เป็น FAIL แทนที่จะปล่อยเทสต์ถัดๆ ไปพังแบบงงๆ (timeout/connection refused)
  worker.on('error', (e) => { workerCrashed = true; console.error('  mock worker ERROR:', e.message); });
  worker.on('exit', (code) => {
    if (!shuttingDown) { workerCrashed = true; console.error('  mock worker EXIT ก่อนกำหนด (code ' + code + ')'); }
  });

  const TARBALL_URL = `http://127.0.0.1:${PORT}/repo.tgz`;
  const RAW_URL = `http://127.0.0.1:${PORT}/handoff-SKILL.md`;
  const netEnv = { HANDOFF_GUARD_SELF_TARBALL: TARBALL_URL, HANDOFF_GUARD_HANDOFF_RAW: RAW_URL };
  // สำหรับ section ที่ "ต้องไม่แตะเน็ตเลย" — ชี้ URL ไปปลายทาง 404 ของ mock:
  // ถ้าโค้ดแอบไป fetch (เช่น vendored พังแล้ว fallback upstream) จะ fail ดังๆ แทนที่
  // เน็ตจริงจะซ่อม regression ให้เงียบๆ (online) หรือแขวนรอ timeout (offline)
  const offlineEnv = {
    HANDOFF_GUARD_SELF_TARBALL: `http://127.0.0.1:${PORT}/offline-404`,
    HANDOFF_GUARD_HANDOFF_RAW: `http://127.0.0.1:${PORT}/offline-404`,
  };

  // ── A. install.mjs — ติดตั้งสดจาก repo layout ลงบ้านปลอม ──────────────
  // install.mjs อ่านจาก repo layout (hooks/ + commands/ เป็น sibling ของ scripts/) — รันตรงได้เฉพาะตอนอยู่ใน repo
  // ตอนไฟล์นี้ถูก cpSync ไป installed layout (~/.claude/skills/handoff-guard/scripts/ · hooks จริงอยู่ ~/.claude/hooks/)
  // จะไม่มี sibling hooks/ → install.mjs โยน ENOENT · ข้าม A แบบมีเหตุผล (ไม่ใช่ fail):
  // update-full [D] ทดสอบ install pipeline ผ่าน fixture ที่มี layout ถูกต้องอยู่แล้ว ไม่ว่าจะรันจากที่ไหน
  console.log('\n[A] install.mjs (fresh install จาก repo layout)');
  const repoLayout = existsSync(join(HERE, '..', 'hooks', 'context-guard.mjs'))
    && existsSync(join(HERE, '..', 'commands', 'handoff-guard-update.md'));
  if (!repoLayout) {
    console.log('  SKIP A — ไม่ได้อยู่ repo layout (installed copy) · install.mjs ตรงต้องรันจาก repo · [D] ครอบ install pipeline ผ่าน fixture แทน');
  } else {
    const homeA = mkdtempSync(join(ROOT, 'homeA-'));
    const rA = runNode(REAL_INSTALL, [], { home: homeA, extraEnv: offlineEnv });
    const skillA = join(homeA, '.claude', 'skills', 'handoff-guard');
    check('A exit 0', rA.status === 0);
    check('A skill SKILL.md ถูกก็อป', existsSync(join(skillA, 'SKILL.md')));
    check('A scripts/ ถูกก็อป (update.mjs)', existsSync(join(skillA, 'scripts', 'update.mjs')));
    check('A hook context-guard.mjs ถูกก็อป', existsSync(join(homeA, '.claude', 'hooks', 'context-guard.mjs')));
    check('A command handoff-guard-update.md ถูกก็อป', existsSync(join(homeA, '.claude', 'commands', 'handoff-guard-update.md')));
    const settingsA = join(homeA, '.claude', 'settings.json');
    check('A settings.json ถูกสร้าง', existsSync(settingsA));
    const sjA = existsSync(settingsA) ? readFileSync(settingsA, 'utf8') : '';
    check('A settings มี hook context-guard + session-resume', /context-guard\.mjs/.test(sjA) && /session-resume\.mjs/.test(sjA));
    check('A dependency skill handoff ถูกติดตั้ง (vendored)', existsSync(join(homeA, '.claude', 'skills', 'handoff', 'SKILL.md')));

    // idempotent — รันซ้ำไม่ error, ไม่เพิ่ม hook ซ้ำ
    const rA2 = runNode(REAL_INSTALL, [], { home: homeA, extraEnv: offlineEnv });
    check('A rerun exit 0 (idempotent)', rA2.status === 0);
    check('A rerun ไม่เพิ่ม hook ซ้ำ (settings ครบแล้ว)', /ครบแล้ว/.test(rA2.out));
    check('A rerun handoff already installed', /already installed/.test(rA2.out));
    // settings หาย/JSON พัง = install regression → ต้องนับเป็น FAIL ไม่ใช่ crash ทั้ง suite
    let hooksArr = [];
    try { hooksArr = JSON.parse(readFileSync(settingsA, 'utf8')).hooks?.Stop || []; } catch { /* guardCount=0 → FAIL ข้อถัดไป */ }
    const guardCount = JSON.stringify(hooksArr).match(/context-guard\.mjs/g)?.length || 0;
    check('A hook context-guard มีชุดเดียว (ไม่ทับซ้อน)', guardCount === 1);
  }

  // ── B. update --check: installed=CRLF vs tarball=LF, เนื้อเดียวกัน → "ตรงล่าสุด" ──
  // regression #6 (tar extract สำเร็จบน tmp path C:\...) + #7 (CRLF≡LF ไม่ใช่ false-positive)
  console.log('\n[B] update --check · CRLF installed ≡ LF tarball → ไม่มีอะไรเปลี่ยน (#6 + #7)');
  const homeB = mkdtempSync(join(ROOT, 'homeB-'));
  seedInstalled(homeB, fx.dir);   // ทุกไฟล์ CRLF, เนื้อตรงกับ fixture
  const rB = runNode(REAL_UPDATE, ['--check'], { home: homeB, extraEnv: netEnv });
  check('B exit 0 (tar extract บน C:\\ tmp สำเร็จ — #6)', rB.status === 0);
  check('B รายงาน "ตรงกับ repo ล่าสุดอยู่แล้ว" (CRLF≡LF — #7)', /ตรงกับ repo ล่าสุดอยู่แล้ว/.test(rB.out));
  check('B ไม่ false-positive ว่ามีไฟล์เปลี่ยน', !/มีไฟล์ใหม่\/เปลี่ยน/.test(rB.out));

  // ── C. update --check: ไฟล์หนึ่งต่างเนื้อจริง → detect "เปลี่ยน" ──────────────────
  console.log('\n[C] update --check · เนื้อต่างจริง 1 ไฟล์ → detect เปลี่ยน (#3)');
  const homeC = mkdtempSync(join(ROOT, 'homeC-'));
  seedInstalled(homeC, fx.dir, { mutateRel: join('handoff-guard', 'SETUP.md') });
  const rC = runNode(REAL_UPDATE, ['--check'], { home: homeC, extraEnv: netEnv });
  check('C exit 0', rC.status === 0);
  check('C รายงาน "มีไฟล์ใหม่/เปลี่ยน"', /มีไฟล์ใหม่\/เปลี่ยน/.test(rC.out));
  check('C ระบุ SETUP.md เป็นไฟล์ที่เปลี่ยน', /·\s*SETUP\.md/.test(rC.out));
  check('C --check รายงานว่ายังไม่เขียน', /ยังไม่เขียน/.test(rC.out));
  // อ่านไฟล์กลับจริง — กัน regression ที่พิมพ์ข้อความ --check ถูกแต่แอบรัน installer ทับ
  const seededC = join(homeC, '.claude', 'skills', 'handoff-guard', 'SETUP.md');
  check('C --check ไฟล์ที่ seed ไว้ยังคงเดิม (อ่านกลับ)',
    existsSync(seededC) && /DIVERGENT REAL CHANGE/.test(readFileSync(seededC, 'utf8')));

  // ── D. update (ไม่มี --check): บ้านว่าง → ดึง→extract→รัน installer→ติดตั้ง handoff จาก mock upstream ─
  console.log('\n[D] update full · บ้านว่าง → apply update end-to-end (#6 + install pipeline)');
  const homeD = mkdtempSync(join(ROOT, 'homeD-'));
  const rD = runNode(REAL_UPDATE, [], { home: homeD, extraEnv: netEnv });
  const skillD = join(homeD, '.claude', 'skills', 'handoff-guard');
  check('D exit 0', rD.status === 0);
  check('D รายงานมีไฟล์ใหม่ (บ้านว่าง)', /มีไฟล์ใหม่\/เปลี่ยน/.test(rD.out));
  check('D installer รันแล้ว: skill ถูกติดตั้ง', existsSync(join(skillD, 'SKILL.md')));
  check('D hook ถูกติดตั้งจาก update', existsSync(join(homeD, '.claude', 'hooks', 'context-guard.mjs')));
  check('D skill handoff ถูกติดตั้ง (จาก mock upstream/vendored)', existsSync(join(homeD, '.claude', 'skills', 'handoff', 'SKILL.md')));
  check('D จบด้วยข้อความ restart', /restart Claude Code session/.test(rD.out));

  // ── E. ensure-handoff --check เดี่ยว: mock upstream ต่างจาก installed → รายงาน "มีเวอร์ชันใหม่" ──
  console.log('\n[E] ensure-handoff --check เดี่ยว (mock upstream)');
  const homeE = mkdtempSync(join(ROOT, 'homeE-'));
  // ติดตั้ง handoff รุ่นเก่าไว้ก่อน (เนื้อต่างจาก mock upstream)
  const hSkill = join(homeE, '.claude', 'skills', 'handoff', 'SKILL.md');
  mkdirSync(dirname(hSkill), { recursive: true });
  writeFileSync(hSkill, '---\nname: handoff\n---\n\nOLD installed body\n');
  const rE = runNode(REAL_ENSURE, ['--check'], { home: homeE, extraEnv: netEnv });
  check('E exit 0', rE.status === 0);
  check('E รายงาน upstream มีเวอร์ชันใหม่', /upstream มีเวอร์ชันใหม่/.test(rE.out));
  check('E --check ไม่เขียนทับไฟล์เดิม', /OLD installed body/.test(readFileSync(hSkill, 'utf8')));

  // ── F. ensure-handoff --check: installed=CRLF ≡ upstream=LF → ไม่ false-positive (#7 ฝั่ง handoff) ──
  console.log('\n[F] ensure-handoff --check · CRLF installed ≡ LF upstream → ตรงกันแล้ว (#7)');
  const homeF = mkdtempSync(join(ROOT, 'homeF-'));
  const hSkillF = join(homeF, '.claude', 'skills', 'handoff', 'SKILL.md');
  mkdirSync(dirname(hSkillF), { recursive: true });
  writeFileSync(hSkillF, toCRLF(HANDOFF_UPSTREAM));   // เนื้อเดียวกับ mock upstream แต่เป็น CRLF
  const rF = runNode(REAL_ENSURE, ['--check'], { home: homeF, extraEnv: netEnv });
  check('F exit 0', rF.status === 0);
  check('F รายงาน "ตรงกับ upstream ล่าสุดอยู่แล้ว" (CRLF≡LF)', /ตรงกับ upstream ล่าสุดอยู่แล้ว/.test(rF.out));
  check('F ไม่ false-positive ว่ามีเวอร์ชันใหม่', !/upstream มีเวอร์ชันใหม่/.test(rF.out));

  // ── G. cross-check installMap เทียบ "ชุดขั้นต่ำที่ hardcode ไว้" — independent จากโค้ด production ─
  // จงใจ hardcode รายการที่คาดหวังไว้ตรงนี้ (ไม่ derive จาก installMap เอง — ถ้า derive จะเป็น tautology
  // ที่ผ่านเสมอ) · ถ้า installMap ในอนาคตเผลอตัดไฟล์สำคัญออก (เช่น hook หาย, filter .en.md หลุด)
  // ชุดนี้จะจับได้ · รายการ align กับ FIXTURE_TEXT + scripts จริงที่ buildFixture วางไว้ (install/ensure-handoff)
  console.log('\n[G] cross-check installMap ⊇ ชุดขั้นต่ำที่ hardcode (independent — กัน tautology)');
  const fakeClaude = join('X', '.claude');   // claudeRoot สมมุติ — เทียบ suffix เท่านั้น (ไม่พึ่งบ้านจริง)
  const mapG = installMap(fx.dir, fakeClaude);
  const destsG = mapG.map(([, d]) => d.replace(/\\/g, '/'));
  const expectMin = [
    'skills/handoff-guard/SKILL.md',
    'skills/handoff-guard/SETUP.md',
    'hooks/context-guard.mjs',
    'hooks/session-resume.mjs',
    'commands/handoff-guard-max.md',
    'commands/handoff-guard-update.md',
    'skills/handoff-guard/scripts/ensure-handoff.mjs',   // scripts/ walk (fixture มี install+ensure-handoff)
    'skills/handoff-guard/scripts/install.mjs',
    'skills/handoff-guard/vendor/handoff/SKILL.md',      // vendored handoff SKILL.md
  ];
  for (const suffix of expectMin) {
    check('G installMap มี dest ลงท้าย ' + suffix, destsG.some((d) => d.endsWith(suffix)));
  }
  // (5b-1) installMap ต้องไม่ map ไฟล์ .en.md เลย (filter ใน production)
  check('G installMap ไม่มี dest ใดลงท้าย .en.md', !destsG.some((d) => d.endsWith('.en.md')));

  // ── H. หลัง full update [D]: บ้านปลอมมีครบทุก pair จาก installMap + ไม่มี .en.md หลุดมา ──
  // มีความหมายจริงเพราะ install.mjs ตอนนี้ก็อปตาม installMap → dest ทุกตัวต้องโผล่ในบ้าน homeD
  console.log('\n[H] หลัง [D] full update: ทุก dest ใน installMap ต้องมีจริงในบ้านปลอม + ไม่มี .en.md');
  const claudeD = join(homeD, '.claude');
  const mapD = installMap(fx.dir, claudeD);
  let allPresent = true, missingFirst = '';
  for (const [, dest] of mapD) {
    if (!existsSync(dest)) { allPresent = false; if (!missingFirst) missingFirst = dest; }
  }
  check('H ทุก [src,dest] ใน installMap มีอยู่ในบ้านปลอมหลัง update' + (missingFirst ? ' (ขาด: ' + missingFirst + ')' : ''), allPresent);
  // (5b-2) commands/handoff-guard-max.en.md ต้องไม่ถูกก็อปเข้าบ้าน (filter ทำงานตลอดสาย install)
  check('H commands/handoff-guard-max.en.md ไม่มีในบ้านปลอม (filter .en.md)',
    !existsSync(join(claudeD, 'commands', 'handoff-guard-max.en.md')));
} finally {
  shuttingDown = true;
  if (worker) await worker.terminate();
  rmSync(ROOT, { recursive: true, force: true });
}

// worker ล่มกลางคัน (นอกเหนือ terminate ตอนจบ) = FAIL
check('worker mock server ไม่ crash ระหว่างเทสต์', !workerCrashed);

console.log(`\n${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
