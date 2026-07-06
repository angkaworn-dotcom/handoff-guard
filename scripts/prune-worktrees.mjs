#!/usr/bin/env node
// prune-worktrees.mjs — เก็บ snapshot worktree เบา N อันล่าสุด ลบ clean ที่เก่ากว่า (ไม่แตะ branch)
// ใช้โดย chip session ของ handoff-guard — spec: ../specs/2026-07-02-chip-revival-d2-design.md
// usage: node prune-worktrees.mjs --repo "<mainRepoRoot>" [--keep 5] [--keep-list a,b] [--dry]
// worktree ที่ห้ามลบถาวร: git worktree lock <path> (วิธีมาตรฐาน — script ข้ามตัว locked เสมอ)
// หรือส่งชื่อผ่าน --keep-list / env HANDOFF_GUARD_KEEP_LIST (คั่น comma)
import { execFileSync } from 'node:child_process';
import { statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const RECENT_DAYS = 2;

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const repo = argVal('--repo', '');
const keepRaw = parseInt(argVal('--keep', '5'), 10);
// ติดลบ = error ดังๆ — clamp เป็น 0 เงียบๆ คือ "ลบ aggressive สุด" ซึ่งตรงข้ามกับที่ผู้ใช้น่าจะตั้งใจ
if (!Number.isNaN(keepRaw) && keepRaw < 0) {
  console.error(`--keep ต้องเป็นจำนวนเต็ม ≥ 0 (ได้ ${keepRaw})`);
  process.exit(1);
}
const keep = Number.isNaN(keepRaw) ? 5 : keepRaw;   // ห้ามใช้ `|| 5` — จะกลืน --keep 0
const dry = args.includes('--dry');
// lowercase ให้ตรงกับ base ที่มาจาก norm() (lowercase เสมอ) — ไม่งั้นชื่อมีตัวพิมพ์ใหญ่ไม่มีวัน match
const keepList = argVal('--keep-list', process.env.HANDOFF_GUARD_KEEP_LIST || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// dirt ใต้ prefix พวกนี้ไม่นับเป็นงานค้าง — default node_modules/ ปลอดภัยทุก repo:
// repo ปกติ ignore node_modules อยู่แล้ว (ไม่โผล่ใน status) · repo ที่ track node_modules
// (git มีเนื้อไฟล์ครบ กู้ได้จาก checkout) การลบมันไม่ใช่งานที่ต้องรักษา
const ignoreDirt = argVal('--ignore-dirt', 'node_modules/')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!repo || !existsSync(repo)) {
  console.error('usage: prune-worktrees.mjs --repo <mainRepoRoot> [--keep N] [--keep-list a,b] [--ignore-dirt p1,p2] [--dry]');
  process.exit(1);
}

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

const wtRoot = norm(join(repo, '.claude', 'worktrees'));
const self = norm(process.cwd());
const skipped = [];
const skip = (why, path) => { skipped.push(why); console.log(`skip (${why}): ${path}`); };

// enumerate จาก git = source of truth (readdir อาจเจอ dir ที่ไม่ใช่ worktree จริง)
const blocks = git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
const candidates = [];
for (const b of blocks) {
  const m = b.match(/^worktree (.+)$/m);
  if (!m) continue;
  const path = m[1].trim();
  const np = norm(path);
  if (!np.startsWith(wtRoot + sep)) continue; // เฉพาะใต้ .claude/worktrees
  if (np === self || self.startsWith(np + sep)) { skip('self', path); continue; }
  // git worktree lock = สัญญาณมาตรฐานว่า "ห้ามแตะ" (session อื่นใช้อยู่ / ผู้ใช้ pin ไว้)
  if (/^locked/m.test(b)) { skip('locked', path); continue; }
  const base = np.slice(wtRoot.length + 1).split(sep)[0];
  if (keepList.includes(base)) { skip('keep-list', path); continue; }
  if (!existsSync(path)) { skip('missing', path); continue; }
  let dirtyOut = '';
  try { dirtyOut = git(path, 'status', '--porcelain'); } catch { skip('status-error', path); continue; }
  // กรอง dirt ใต้ prefix ที่ระบุ (--ignore-dirt, default node_modules/) ออกก่อนตัดสิน dirty
  // เคสจริง: script ลบ node_modules ใน repo ที่ track มัน → status ขึ้น " D node_modules/..." ทั้งแผง
  // rename/copy ("R  old -> new"): ทั้งสองฝั่งต้องอยู่ใต้ prefix ที่ ignore ถึงจะไม่นับ —
  // ดูแค่ต้นบรรทัด (ฝั่ง old) จะกลืน rename ที่ปลายทางเป็นไฟล์งานจริง (= งานค้าง) แล้วลบ worktree ทิ้ง
  const realDirt = dirtyOut.split(/\r?\n/).filter(Boolean)
    .filter((l) => {
      const rest = l.slice(3);
      const paths = /^[RC]/.test(l) && rest.includes(' -> ') ? rest.split(' -> ') : [rest];
      return !paths.every((p) => {
        const f = p.trim().replace(/^"|"$/g, '');
        return ignoreDirt.some((x) => f.startsWith(x));
      });
    });
  if (realDirt.length) { skip('dirty', path); continue; }
  // recency = เวลา commit ล่าสุดของ HEAD (การทำงานจริง) — dir mtime เชื่อไม่ได้
  // (clean-worktree-node-modules.sh ไปแตะ mtime ทุกโฟลเดอร์ทั้งที่ไม่มีใครทำงาน)
  let lastWork = 0;
  try { lastWork = (parseInt(git(path, 'log', '-1', '--format=%ct'), 10) || 0) * 1000; } catch { /* fallthrough */ }
  if (!lastWork) { try { lastWork = statSync(path).mtimeMs; } catch { skip('stat-error', path); continue; } }
  if (Date.now() - lastWork < RECENT_DAYS * 864e5) { skip('recent', path); continue; }
  candidates.push({ path, mtime: lastWork });
}

candidates.sort((a, b) => b.mtime - a.mtime);
const removals = candidates.slice(keep);
let removed = 0;
for (const r of removals) {
  if (dry) { console.log(`[dry] would remove: ${r.path}`); continue; }
  try {
    // --force จำเป็น: git นับ node_modules ที่หาย/ไฟล์ ignored เป็น dirty แล้วปฏิเสธ —
    // ปลอดภัยเพราะ candidate ทุกตัวผ่านเช็ค realDirt ว่าง (ไม่มีงานจริงค้าง) มาแล้วข้างบน
    git(repo, 'worktree', 'remove', '--force', r.path);
    console.log(`removed: ${r.path}`);
    removed++;
  } catch (e) {
    // Windows: git อาจ unregister สำเร็จแต่ลบโฟลเดอร์ไม่ได้ (ไฟล์ readonly/ล็อก) → เก็บกวาดเอง
    let stillRegistered = true;
    try {
      stillRegistered = git(repo, 'worktree', 'list', '--porcelain')
        .split(/\r?\n/).some((l) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(r.path));
    } catch { /* ถือว่ายังอยู่ — ไม่เสี่ยง rm */ }
    if (!stillRegistered && existsSync(r.path)) {
      try { rmSync(r.path, { recursive: true, force: true }); console.log(`removed (fs-fallback): ${r.path}`); removed++; continue; }
      catch (e2) { console.log(`skip (fs-fallback-failed): ${r.path} — ${String(e2.message || e2).split('\n')[0]}`); continue; }
    }
    console.log(`skip (remove-failed): ${r.path} — ${String(e.message || e).split('\n')[0]}`);
  }
}
// โฟลเดอร์ตกค้างที่ git ไม่รู้จักแล้ว (เคยลบไม่สำเร็จเพราะไฟล์/cwd ถูกล็อก) — เตือนเฉยๆ ไม่ลบเอง
// (ลบเองอันตราย: dir ที่ไม่ใช่ worktree อาจเป็นของอย่างอื่น) → ผู้ใช้ปิด session เก่า/restart แล้วลบมือ
try {
  const { readdirSync } = await import('node:fs');
  const registered = new Set(
    git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/)
      .filter((l) => l.startsWith('worktree ')).map((l) => norm(l.slice(9)))
  );
  const leftovers = readdirSync(join(repo, '.claude', 'worktrees'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !registered.has(norm(join(repo, '.claude', 'worktrees', d.name))))
    .map((d) => d.name);
  if (leftovers.length) console.log(`warn: unregistered leftover dirs (ปิด session เก่า/restart แล้วลบมือ): ${leftovers.join(', ')}`);
} catch { /* ไม่มี dir — ข้าม */ }
console.log(`done: kept=${Math.min(keep, candidates.length)} removed=${dry ? 0 : removed}${dry ? ` would-remove=${removals.length}` : ''} skipped=${skipped.length}`);
