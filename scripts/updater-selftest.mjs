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
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMap } from './update.mjs';   // mapping ตัวจริง — ตัวเดียวกับที่ production ใช้เทียบไฟล์

const HERE = dirname(fileURLToPath(import.meta.url));      // repo/scripts (ตัวจริงที่กำลังทดสอบ)
const REAL_INSTALL = join(HERE, 'install.mjs');
const REAL_UPDATE = join(HERE, 'update.mjs');
const REAL_ENSURE = join(HERE, 'ensure-handoff.mjs');
const REAL_PRUNE = join(HERE, 'prune-worktrees.mjs');
const REAL_SETMAX = join(HERE, 'set-max.mjs');

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

function runNode(script, args, { home, extraEnv = {}, cwd } = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv };
  // strip HANDOFF_GUARD_* ของเครื่องจริงที่อาจ leak (ยกเว้นที่ extraEnv ตั้งเอง)
  // ต้อง case-insensitive: env key บน Windows ไม่แยก case — ตัวพิมพ์ผสมหลุดเข้า child ได้
  for (const k of Object.keys(env)) {
    if (/^HANDOFF_GUARD_/i.test(k) && !(k in extraEnv)) delete env[k];
  }
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, cwd });
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
    // ผูก listener แบบตั้งชื่อไว้เพื่อถอดทั้งหมดเมื่อ settle — กัน listener ค้าง (teardown 'exit' reject ตอนนี้ no-op
    // แต่ latent: ถ้าไม่ถอด พอ terminate() ตอนจบจะยิง onExit เก่าที่ reject promise ที่ settle ไปแล้ว)
    const onMessage = (port) => { cleanup(); resolve(port); };
    const onError = (e) => { cleanup(); reject(e); };   // eval/listen พัง → fail ดังๆ ไม่ค้างรอ message ที่ไม่มีวันมา
    const onExit = (code) => { cleanup(); reject(new Error('mock worker exit ก่อนพร้อม (code ' + code + ')')); };
    const cleanup = () => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
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
  // ตอนไฟล์นี้ถูกติดตั้งตาม installMap ไป installed layout (~/.claude/skills/handoff-guard/scripts/ · hooks จริงอยู่ ~/.claude/hooks/)
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
  // ชุดนี้จะจับได้ · รายการ align กับ FIXTURE_TEXT + scripts จริงที่ buildFixture วางไว้ (install/ensure-handoff/update)
  // ใช้ claudeD (บ้าน homeD จาก [D]) เป็น claudeRoot map เดียวกันทั้ง G+H — ไม่มี synthetic root แยก
  console.log('\n[G] cross-check installMap ⊇ ชุดขั้นต่ำที่ hardcode (independent — กัน tautology)');
  const claudeD = join(homeD, '.claude');
  const mapG = installMap(fx.dir, claudeD);
  const destsG = mapG.map(([, d]) => d);
  // เทียบ full equality (dest === join(claudeD, suffix)) ไม่ใช่ endsWith — endsWith ปล่อยผ่าน dest ผิดที่
  // เช่น <claudeD>/skills/handoff-guard/hooks/context-guard.mjs ก็ยัง endsWith 'hooks/context-guard.mjs'
  const expectMin = [
    'skills/handoff-guard/SKILL.md',
    'skills/handoff-guard/SETUP.md',
    'hooks/context-guard.mjs',
    'hooks/session-resume.mjs',
    'commands/handoff-guard-max.md',
    'commands/handoff-guard-update.md',
    'skills/handoff-guard/scripts/update.mjs',           // ไฟล์ที่ script อื่นทุกตัว import จากมัน
    'skills/handoff-guard/scripts/ensure-handoff.mjs',   // scripts/ walk (fixture มี install+ensure-handoff+update)
    'skills/handoff-guard/scripts/install.mjs',
    'skills/handoff-guard/vendor/handoff/SKILL.md',      // vendored handoff SKILL.md
  ];
  for (const suffix of expectMin) {
    const want = join(claudeD, ...suffix.split('/'));
    check('G installMap มี dest = ' + suffix, destsG.some((d) => d === want));
  }
  // negative control: dest ผิดที่ (hook ไปโผล่ใต้ skillDir) ต้องไม่ match checker — ยืนยัน full-equality ไม่ใช่ endsWith
  const wrongDest = join(claudeD, 'skills', 'handoff-guard', 'hooks', 'context-guard.mjs');
  check('G (neg-ctrl) dest ผิดที่ใต้ skillDir ไม่ match แบบ full-equality',
    !destsG.some((d) => d === wrongDest) && wrongDest.replace(/\\/g, '/').endsWith('hooks/context-guard.mjs'));
  // (5b-1) installMap ต้องไม่ map ไฟล์ .en.md เลย (filter ใน production)
  check('G installMap ไม่มี dest ใดลงท้าย .en.md', !destsG.some((d) => d.replace(/\\/g, '/').endsWith('.en.md')));

  // ── H. หลัง full update [D]: บ้านปลอมมีครบทุก pair จาก installMap + ไม่มี .en.md หลุดมา ──
  // มีความหมายจริงเพราะ install.mjs ตอนนี้ก็อปตาม installMap → dest ทุกตัวต้องโผล่ในบ้าน homeD
  // ใช้ mapG ก้อนเดียวกับ G (claudeRoot=claudeD) — ไม่เรียก installMap ซ้ำ
  console.log('\n[H] หลัง [D] full update: ทุก dest ใน installMap ต้องมีจริงในบ้านปลอม + ไม่มี .en.md');
  let allPresent = true, missingFirst = '';
  for (const [, dest] of mapG) {
    if (!existsSync(dest)) { allPresent = false; if (!missingFirst) missingFirst = dest; }
  }
  check('H ทุก [src,dest] ใน installMap มีอยู่ในบ้านปลอมหลัง update' + (missingFirst ? ' (ขาด: ' + missingFirst + ')' : ''), allPresent);
  // (5b-2) commands/handoff-guard-max.en.md ต้องไม่ถูกก็อปเข้าบ้าน (filter ทำงานตลอดสาย install)
  check('H commands/handoff-guard-max.en.md ไม่มีในบ้านปลอม (filter .en.md)',
    !existsSync(join(claudeD, 'commands', 'handoff-guard-max.en.md')));

  // ── I. installMap ordering: provider ก่อน importer ใน scripts/ (invariant กัน mixed-version window #1) ──
  // ถ้า copy loop ถูกขัดกลางคัน dir ที่ติดตั้งต้องไม่เหลือ new-importer + old-provider (importer พังทันที)
  // chain: update.mjs (no local import) ← ensure-handoff.mjs ← install.mjs → index ต้องเรียงตามนี้
  console.log('\n[I] installMap ordering — scripts provider-before-importer (#1)');
  const idxOf = (base) => mapG.findIndex(([, d]) =>
    d === join(claudeD, 'skills', 'handoff-guard', 'scripts', base));
  const iUpd = idxOf('update.mjs'), iEns = idxOf('ensure-handoff.mjs'), iIns = idxOf('install.mjs');
  check('I update.mjs มาก่อน ensure-handoff.mjs', iUpd >= 0 && iEns >= 0 && iUpd < iEns);
  check('I ensure-handoff.mjs มาก่อน install.mjs', iEns >= 0 && iIns >= 0 && iEns < iIns);

  // ── J. real-repo drift guard: installMap เทียบ checkout จริง (ไม่ใช่ fixture) ──
  // fixture อาจ lag repo จริง — ข้อนี้จับ hook/command ที่เพิ่มใน repo จริงแต่ตกจาก installMap
  // (เช่น เพิ่ม hook ใหม่แต่ลืม walk / เพิ่ม command แต่ filter พลาด) · REPO_ROOT = parent ของ HERE (scripts/)
  console.log('\n[J] real-repo drift: installMap ⊇ ทุก hook จริง + ทุก command .md (ไม่ใช่ .en.md)');
  const REPO_ROOT = join(HERE, '..');
  const repoLayoutJ = existsSync(join(REPO_ROOT, 'hooks')) && existsSync(join(REPO_ROOT, 'commands'));
  if (!repoLayoutJ) {
    console.log('  SKIP J — ไม่ได้อยู่ repo layout (installed copy ไม่มี hooks/ commands/ sibling)');
  } else {
    const fakeJ = join(ROOT, 'fakeJ', '.claude');
    const srcsJ = installMap(REPO_ROOT, fakeJ).map(([src]) => src.replace(/\\/g, '/'));
    // ทุกไฟล์จริงใต้ hooks/ (recursive) ต้องอยู่ใน map
    const walkRel = (dir, base = dir) => {
      const out = [];
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) out.push(...walkRel(p, base));
        else out.push(join('hooks', p.slice(base.length + 1)).replace(/\\/g, '/'));
      }
      return out;
    };
    let hooksOk = true, hookMiss = '';
    for (const rel of walkRel(join(REPO_ROOT, 'hooks'))) {
      if (!srcsJ.includes(rel)) { hooksOk = false; if (!hookMiss) hookMiss = rel; }
    }
    check('J ทุก hook จริงใน repo อยู่ใน installMap' + (hookMiss ? ' (ขาด: ' + hookMiss + ')' : ''), hooksOk);
    // ทุก command .md จริง (ไม่ใช่ .en.md) ต้องอยู่ใน map
    let cmdsOk = true, cmdMiss = '';
    for (const f of readdirSync(join(REPO_ROOT, 'commands'))) {
      if (f.endsWith('.md') && !f.endsWith('.en.md')) {
        const rel = 'commands/' + f;
        if (!srcsJ.includes(rel)) { cmdsOk = false; if (!cmdMiss) cmdMiss = rel; }
      }
    }
    check('J ทุก command .md จริงใน repo อยู่ใน installMap' + (cmdMiss ? ' (ขาด: ' + cmdMiss + ')' : ''), cmdsOk);
  }
  // ── K. prune-worktrees.mjs — destructive op: ทุกชั้นกันลบต้องกันจริง + ลบเฉพาะตัวที่ควรลบ ──
  // fixture = git repo จริง + worktree จริง (script ยิง git จริง — mock ไม่ได้อะไร)
  // อายุ worktree ปลอมผ่าน GIT_COMMITTER_DATE (recency ของ script = commit time ของ HEAD ไม่ใช่ mtime)
  console.log('\n[K] prune-worktrees.mjs — fixture repo + worktrees (guards ครบทุกชั้น)');
  const kRoot = join(ROOT, 'pruneK');
  const kHome = join(kRoot, 'home');
  const kRepo = join(kRoot, 'main-repo');
  mkdirSync(kRepo, { recursive: true });
  mkdirSync(kHome, { recursive: true });
  // git แบบ hermetic: ไม่อ่าน config เครื่องจริง (gpgsign/autocrlf/hooks ของผู้ใช้ทำ fixture เพี้ยนได้)
  const kGitEnv = { GIT_CONFIG_GLOBAL: join(kRoot, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  writeFileSync(kGitEnv.GIT_CONFIG_GLOBAL,
    '[user]\n\tname = hg-selftest\n\temail = selftest@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
  const gitK = (cwd, args, dateIso) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...kGitEnv, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

  gitK(kRepo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(kRepo, 'base.txt'), 'base\n');
  gitK(kRepo, ['add', '.']);
  gitK(kRepo, ['commit', '-q', '-m', 'base'], daysAgo(12));   // ทุก worktree เริ่มที่อายุ 12 วัน (พ้น RECENT_DAYS=2)

  const wtRootK = join(kRepo, '.claude', 'worktrees');
  const addWt = (name) => { gitK(kRepo, ['worktree', 'add', '-q', join(wtRootK, name), '-b', name]); return join(wtRootK, name); };
  const commitIn = (wt, dateIso) => {
    writeFileSync(join(wt, 'w.txt'), dateIso + '\n');
    gitK(wt, ['add', '.']);
    gitK(wt, ['commit', '-q', '-m', 'work'], dateIso);
  };
  // ผู้รอด (ต้องไม่ถูกลบไม่ว่ารันกี่รอบ):
  const wtDirty = addWt('wt-dirty'); writeFileSync(join(wtDirty, 'uncommitted.txt'), 'งานค้างจริง\n');
  const wtLocked = addWt('wt-locked'); gitK(kRepo, ['worktree', 'lock', join(wtRootK, 'wt-locked')]);
  const wtKeepL = addWt('wt-keeplist');
  const wtRecent = addWt('wt-recent'); commitIn(wtRecent, new Date().toISOString());
  // เหยื่อ (clean + เก่า — เรียงอายุ: nm-dirty 12d > old-a 10d > old-b 9d > old-c 8d ใหม่สุด):
  const wtNmDirty = addWt('wt-nm-dirty');
  mkdirSync(join(wtNmDirty, 'node_modules'), { recursive: true });
  writeFileSync(join(wtNmDirty, 'node_modules', 'x.js'), 'module\n');   // dirt ใต้ ignore-dirt default → นับ clean
  const wtOldA = addWt('wt-old-a'); commitIn(wtOldA, daysAgo(10));
  const wtOldB = addWt('wt-old-b'); commitIn(wtOldB, daysAgo(9));
  const wtOldC = addWt('wt-old-c'); commitIn(wtOldC, daysAgo(8));
  // worktree นอก .claude/worktrees — ต้องอยู่นอกสายตา script เด็ดขาด (แม้เก่า+clean)
  const wtOutside = join(kRoot, 'outside-wt');
  gitK(kRepo, ['worktree', 'add', '-q', wtOutside, '-b', 'wt-outside']);
  // dir ตกค้างที่ git ไม่รู้จัก — ต้องได้แค่คำเตือน ห้าม rm เอง
  const leftoverK = join(wtRootK, 'leftover-dir');
  mkdirSync(leftoverK, { recursive: true });
  writeFileSync(join(leftoverK, 'junk.txt'), 'ของใครไม่รู้\n');

  const survivorsK = [wtDirty, wtLocked, wtKeepL, wtRecent, wtOutside, leftoverK];
  const registeredK = (p) => gitK(kRepo, ['worktree', 'list', '--porcelain']).split(/\r?\n/)
    .some((l) => l.startsWith('worktree ') && l.slice(9).replace(/\//g, '\\').toLowerCase() === p.replace(/\//g, '\\').toLowerCase());
  const pruneArgs = ['--repo', kRepo, '--keep', '1', '--keep-list', 'wt-keeplist'];
  // ส่ง kGitEnv เข้า child ด้วย — git ที่ prune ยิงเองต้อง hermetic เท่ากับ fixture
  const kRun = (args, cwd) => runNode(REAL_PRUNE, args, { home: kHome, extraEnv: kGitEnv, cwd });

  // K0: ไม่มี --repo → usage error ไม่ใช่ลบมั่ว
  const rK0 = kRun([]);
  check('K0 ไม่มี --repo → exit 1 + usage', rK0.status === 1 && /usage:/.test(rK0.out));

  // K1: --dry ห้ามแตะอะไรเลย แต่รายงาน would-remove ถูกตัว
  const rK1 = kRun([...pruneArgs, '--dry']);
  check('K1 --dry exit 0', rK1.status === 0);
  check('K1 --dry would-remove=3 (nm-dirty, old-a, old-b — keep 1 เก็บ old-c)', /would-remove=3/.test(rK1.out));
  check('K1 --dry ไม่ลบจริง (ทุก dir ยังอยู่ครบ)',
    [...survivorsK, wtNmDirty, wtOldA, wtOldB, wtOldC].every((p) => existsSync(p)));

  // K2: รันจาก cwd ในตัว worktree เอง → ต้อง skip (self) — กัน script ลบพื้นที่ที่ตัวเองยืนอยู่
  const rK2 = kRun([...pruneArgs, '--dry'], wtOldC);
  check('K2 cwd ใน worktree → skip (self)', /skip \(self\)/.test(rK2.out));

  // K2b: keep-list ต้อง match แบบ case-insensitive — norm() lowercase path เสมอ
  // ถ้า keepList ไม่ lowercase ตาม `--keep-list WT-KEEPLIST` จะไม่ match แล้ว worktree ที่สั่งห้ามลบถูกลบ
  const rK2b = kRun(['--repo', kRepo, '--keep', '0', '--keep-list', 'WT-KEEPLIST', '--dry']);
  check('K2b keep-list ตัวพิมพ์ใหญ่ → ยัง skip (keep-list) (case-insensitive)', /skip \(keep-list\)/.test(rK2b.out));

  // K3: รันจริง --keep 1 — ลบเฉพาะ 3 ตัวเก่าสุดที่ clean, เก็บ old-c (ใหม่สุด), ผู้รอดครบ
  const rK3 = kRun(pruneArgs);
  check('K3 exit 0', rK3.status === 0);
  check('K3 removed=3', /removed=3/.test(rK3.out));
  check('K3 เหยื่อถูกลบจริง (dir หาย)', [wtNmDirty, wtOldA, wtOldB].every((p) => !existsSync(p)));
  check('K3 เหยื่อถูกถอนทะเบียนจาก git', [wtNmDirty, wtOldA, wtOldB].every((p) => !registeredK(p)));
  check('K3 old-c (ใหม่สุดใน candidates) ถูกเก็บ', existsSync(wtOldC) && registeredK(wtOldC));
  check('K3 dirty รอด (งานค้างจริงห้ามหาย)', existsSync(join(wtDirty, 'uncommitted.txt')) && registeredK(wtDirty));
  check('K3 locked รอด', existsSync(wtLocked) && registeredK(wtLocked));
  check('K3 keep-list รอด', existsSync(wtKeepL) && registeredK(wtKeepL));
  check('K3 recent (< 2 วัน) รอด', existsSync(wtRecent) && registeredK(wtRecent));
  check('K3 worktree นอก .claude/worktrees ไม่ถูกแตะ', existsSync(wtOutside) && registeredK(wtOutside));
  check('K3 log ระบุเหตุ skip ครบ (dirty/locked/keep-list/recent)',
    ['skip (dirty)', 'skip (locked)', 'skip (keep-list)', 'skip (recent)'].every((s) => rK3.out.includes(s)));
  check('K3 dir ตกค้างได้แค่ warn ไม่ถูกลบ',
    /unregistered leftover dirs/.test(rK3.out) && rK3.out.includes('leftover-dir') && existsSync(join(leftoverK, 'junk.txt')));

  // K4: --keep 0 กวาด candidates ที่เหลือ (old-c) — แต่ผู้รอดทุกชั้นยังต้องรอดเหมือนเดิม
  const rK4 = kRun(['--repo', kRepo, '--keep', '0', '--keep-list', 'wt-keeplist']);
  check('K4 --keep 0 exit 0 (regression: parser ห้ามกลืน 0 เป็น default 5)', rK4.status === 0);
  check('K4 old-c ถูกลบ (keep 0 = ไม่เก็บ candidate เลย)', !existsSync(wtOldC) && !registeredK(wtOldC));
  check('K4 ผู้รอดทุกชั้นยังครบหลังกวาดรอบสอง',
    survivorsK.every((p) => existsSync(p)) && [wtDirty, wtLocked, wtKeepL, wtRecent, wtOutside].every((p) => registeredK(p)));

  // ── L. set-max.mjs — เขียน config ต้อง merge (ไม่ทำลาย field อื่น) + floor t1 กันใส่ % ──
  console.log('\n[L] set-max.mjs — merge config field ที่ไม่รู้จัก + floor t1/t2');
  const homeL = mkdtempSync(join(ROOT, 'homeL-'));
  const cfgL = join(homeL, '.claude', '.handoff-guard', 'config.json');
  mkdirSync(dirname(cfgL), { recursive: true });
  // windows = feature ที่ docs โฆษณาให้ user เติม regex→tokens เอง · custom = field อนาคตที่ยังไม่รู้จัก
  writeFileSync(cfgL, JSON.stringify({ max: 100000, windows: { 'my-model': 123456 }, custom: 'keep-me' }));
  const rL1 = runNode(REAL_SETMAX, ['200000'], { home: homeL });
  let cfg1 = {};
  try { cfg1 = JSON.parse(readFileSync(cfgL, 'utf8')); } catch { /* cfg1 ว่าง → FAIL ข้างล่าง */ }
  check('L1 set-max 200000 exit 0 + max/t1/t2 auto ถูกต้อง',
    rL1.status === 0 && cfg1.max === 200000 && cfg1.t1 === 144000 && cfg1.t2 === 170000);
  check('L1 windows/custom field ไม่หาย (merge ไม่ใช่เขียนทับทั้งไฟล์)',
    cfg1.windows && cfg1.windows['my-model'] === 123456 && cfg1.custom === 'keep-me');
  const rL2 = runNode(REAL_SETMAX, ['0'], { home: homeL });
  let cfg2 = {};
  try { cfg2 = JSON.parse(readFileSync(cfgL, 'utf8')); } catch { /* FAIL ข้างล่าง */ }
  check('L2 kill switch (0) → max=0 แต่ windows/custom ยังอยู่',
    rL2.status === 0 && cfg2.max === 0 && cfg2.windows && cfg2.windows['my-model'] === 123456 && cfg2.custom === 'keep-me');
  // t1/t2 ใส่เป็น % (เข้าใจผิด) — 85 token = block ทุก session ตั้งแต่เทิร์นแรก ต้องปฏิเสธ
  const rL3 = runNode(REAL_SETMAX, ['200000', '72', '85'], { home: homeL });
  let cfg3 = {};
  try { cfg3 = JSON.parse(readFileSync(cfgL, 'utf8')); } catch { /* FAIL ข้างล่าง */ }
  check('L3 t1/t2 ต่ำผิดปกติ (พิมพ์ % มา) → exit 1 + config เดิมไม่ถูกแตะ',
    rL3.status === 1 && cfg3.max === 0 && cfg3.custom === 'keep-me');

  // ── M. update full ที่ส่วน handoff fail — ห้ามพิมพ์ 🎉 banner ให้ model อ่านแล้วรายงานผิด ──
  // tarball ปกติ (ส่วน 1 สำเร็จ) แต่ upstream ของ skill handoff = 404 → r2.status ≠ 0 → fail=true
  console.log('\n[M] update full · ส่วน handoff ล้มเหลว → exit 1 + ไม่มี banner ฉลอง');
  const homeM = mkdtempSync(join(ROOT, 'homeM-'));
  const rM = runNode(REAL_UPDATE, [], {
    home: homeM,
    extraEnv: { HANDOFF_GUARD_SELF_TARBALL: TARBALL_URL, HANDOFF_GUARD_HANDOFF_RAW: `http://127.0.0.1:${PORT}/offline-404` },
  });
  check('M exit 1 (ส่วน handoff fail)', rM.status === 1);
  // เจาะจง banner สรุปท้ายของ update.mjs — 🎉 ของ install.mjs (ส่วน 1 ที่สำเร็จจริง) ไม่นับ
  check('M ไม่มี banner "🎉 อัปเดตเสร็จ" ทั้งที่ fail', !rM.out.includes('🎉 อัปเดตเสร็จ'));
  check('M รายงานว่าส่วน handoff ล้มเหลวชัดเจน', /handoff ล้มเหลว/.test(rM.out));

  // ── N. ensure-handoff — SKILL.md torn (ว่าง/เขียนค้าง) ต้อง self-heal ไม่ใช่ "already installed" ──
  console.log('\n[N] ensure-handoff · SKILL.md torn → reinstall จาก vendored (ไม่แตะเน็ต)');
  const homeN = mkdtempSync(join(ROOT, 'homeN-'));
  const tornN = join(homeN, '.claude', 'skills', 'handoff', 'SKILL.md');
  mkdirSync(dirname(tornN), { recursive: true });
  writeFileSync(tornN, '');   // ไฟล์ว่าง = เขียนค้างตอน crash/ENOSPC
  const rN = runNode(REAL_ENSURE, [], { home: homeN, extraEnv: offlineEnv });
  check('N exit 0', rN.status === 0);
  check('N ไม่รายงาน already installed ทั้งที่ไฟล์ torn', !/already installed/.test(rN.out));
  check('N เนื้อถูก heal จาก vendored (มี name: handoff)',
    /name:\s*handoff/.test(readFileSync(tornN, 'utf8')));
  // ไฟล์สมบูรณ์อยู่แล้ว → ยังต้อง already installed (ไม่เขียนทับซ้ำทุกรอบ)
  const rN2 = runNode(REAL_ENSURE, [], { home: homeN, extraEnv: offlineEnv });
  check('N2 รันซ้ำหลัง heal → already installed', rN2.status === 0 && /already installed/.test(rN2.out));

} finally {
  // ชุดนี้ synchronous ทั้งหมด (spawnSync บล็อก event loop) → event 'exit'/'error' ของ worker
  // ไม่มีโอกาส tick ระหว่างเทสต์ workerCrashed จึงเป็น false เสมอถ้าพึ่งแต่ event handler
  // เช็ค liveness ตรงๆ: worker ที่ยัง run อยู่ threadId >= 0 · ถ้าตายกลางคัน (ยังไม่ terminate) threadId = -1
  // (ใช้ threadId ไม่ใช่ exitCode — บน Node 22 exitCode ค้าง undefined แม้ worker exit ไปแล้ว)
  if (worker && worker.threadId === -1) workerCrashed = true;
  shuttingDown = true;
  if (worker) await worker.terminate();
  rmSync(ROOT, { recursive: true, force: true });
}

// mock server ตายกลางคัน (threadId = -1 ก่อน terminate ตอนจบ) หรือยิง event 'error' = FAIL
check('worker mock server ไม่ crash ระหว่างเทสต์', !workerCrashed);

console.log(`\n${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
