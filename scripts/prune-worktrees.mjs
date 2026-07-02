#!/usr/bin/env node
// prune-worktrees.mjs — เก็บ snapshot worktree เบา N อันล่าสุด ลบ clean ที่เก่ากว่า (ไม่แตะ branch)
// ใช้โดย chip session ของ handoff-guard — spec: ../specs/2026-07-02-chip-revival-d2-design.md
// usage: node prune-worktrees.mjs --repo "<mainRepoRoot>" [--keep 5] [--dry]
import { execFileSync } from 'node:child_process';
import { statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const KEEP_LIST = ['leave-db-redesign-feat']; // worktree งาน dev จริง — ห้ามลบเด็ดขาด
const RECENT_DAYS = 2;

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const repo = argVal('--repo', '');
const keep = Math.max(0, parseInt(argVal('--keep', '5'), 10) || 5);
const dry = args.includes('--dry');
if (!repo || !existsSync(repo)) {
  console.error('usage: prune-worktrees.mjs --repo <mainRepoRoot> [--keep N] [--dry]');
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
  const base = np.slice(wtRoot.length + 1).split(sep)[0];
  if (KEEP_LIST.includes(base)) { skip('keep-list', path); continue; }
  if (!existsSync(path)) { skip('missing', path); continue; }
  let dirtyOut = '';
  try { dirtyOut = git(path, 'status', '--porcelain'); } catch { skip('status-error', path); continue; }
  // dirt ใน node_modules/ ไม่นับเป็นงานค้าง — repo นี้ track node_modules ไว้ (git มีเนื้อไฟล์ครบ)
  // เคสจริง: clean-worktree-node-modules.sh ลบ node_modules → status ขึ้น " D node_modules/..." ทั้งแผง
  const realDirt = dirtyOut.split(/\r?\n/).filter(Boolean)
    .filter((l) => !l.slice(3).replace(/^"/, '').startsWith('node_modules/'));
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
