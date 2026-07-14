#!/usr/bin/env node
// scan-preload.mjs — one-shot diagnostic (read-only): "context ตอนเปิด session หายไปกับอะไร"
// F2 ของ Session Economics (spec: specs/2026-07-06-session-economics-design.md)
//
// สำคัญ: นี่คือ *attribution/breakdown* (±30%) ไม่ใช่การวัด — ของจริง hook วัดจาก usage ของ API อยู่แล้ว
// (usage ครอบ preload + dynamic + hidden ทั้งหมด) · script นี้แค่บอก "หมวดไหนกินสัดส่วนเท่าไหร่ของ preload"
//
// usage:
//   node scan-preload.mjs [--project <path>] [--json] [--max <n>]
//   --project  root ของโปรเจกต์ (default: cwd) — ใช้หา CLAUDE.md/commands/agents ระดับโปรเจกต์ + memory
//   --json     พิมพ์ JSON แทนตาราง (ให้ Claude/เครื่องมืออื่น parse)
//   --max      เพดาน context สำหรับคิด % (default: config.json max หรือ 200000)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_FILE = 1024 * 1024;   // ไฟล์ > 1MB ข้าม (กัน scan ช้า/หน่วยความจำ) + นับ skipped
const claude = join(homedir(), '.claude');

// ── args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const project = typeof args.project === 'string' ? args.project : process.cwd();

// เพดานสำหรับ % — arg > env HANDOFF_GUARD_MAX > config.json > 200000
// (arg ชัดเจนต่อครั้งชนะ env — ต่างจาก hook ที่ไม่มี arg · model auto-detect ทำไม่ได้ที่นี่
//  เพราะไม่มี transcript ให้อ่าน — ถ้าไม่ pin config แนะนำส่ง --max ตามเพดานโมเดลจริง)
function resolveMax() {
  if (typeof args.max === 'string' && Number.isFinite(Number(args.max))) return Number(args.max);
  const envMax = Number(process.env.HANDOFF_GUARD_MAX);
  if (Number.isFinite(envMax) && envMax > 0) return envMax;
  try {
    const c = JSON.parse(readFileSync(join(claude, '.handoff-guard', 'config.json'), 'utf8'));
    if (c && Number(c.max) > 0) return Number(c.max);
  } catch { /* ไม่มี config — ใช้ default */ }
  return 200000;
}
const MAX = resolveMax();

// ── helpers ─────────────────────────────────────────────────────────────────
// ประมาณ token: ascii/4 + non-ascii/1.5 ปัดขึ้น (heuristic เดียวกับ F1 handoff-stats)
function estTokens(str) {
  let ascii = 0, non = 0;
  for (const ch of str) { if (ch.codePointAt(0) < 128) ascii++; else non++; }
  return Math.ceil(ascii / 4 + non / 1.5);
}

let skipped = 0;
const topFiles = [];   // { path, est } — จัดอันดับตอนท้าย

// อ่านไฟล์ + ประมาณ token (ทั้งไฟล์) · > 1MB / อ่านไม่ได้ → นับ skipped, คืน 0
function estFile(path, transform = (s) => s) {
  try {
    if (!existsSync(path)) return 0;
    if (statSync(path).size > MAX_FILE) { skipped++; return 0; }
    // strip BOM — ไฟล์ .md จาก editor บน Windows มักมี BOM (U+FEFF) นำหน้า ทำ frontmatter regex ^--- ไม่ match
    // (precedent เดียวกับ session-resume.mjs · ใช้ charCodeAt เลี่ยงการฝัง BOM ใน source เอง)
    const raw = readFileSync(path, 'utf8');
    const est = estTokens(transform(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw));
    if (est > 0) topFiles.push({ path, est });
    return est;
  } catch { skipped++; return 0; }
}

// frontmatter block ระหว่าง --- --- (preload ของ skill/command/agent = ส่วนนี้ ไม่ใช่ body)
const frontmatter = (content) => {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : content.slice(0, 400);   // ไม่มี frontmatter → ประมาณ 400 char แรก
};

// เก็บทุกไฟล์ชื่อ `target` ใต้ dir (recursive, best-effort · ข้าม dir ที่อ่านไม่ได้)
function findFiles(dir, target, out = [], depth = 0) {
  if (depth > 8) return out;   // กันวิ่งลึกเกินใน plugins cache
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findFiles(p, target, out, depth + 1);
    else if (e.name === target) out.push(p);
  }
  return out;
}

// slug แบบ Claude Code project dir (memory): non-alphanumeric → '-', คง case (เช่น C:\Users\... → C--Users-...)
const ccSlug = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

// ── categories ───────────────────────────────────────────────────────────────
const categories = [];
const addCat = (key, label, est, files) => categories.push({ key, label, estTokens: est, files });

// 1) user CLAUDE.md
{
  const p = join(claude, 'CLAUDE.md');
  const est = estFile(p);
  addCat('user-claude-md', 'CLAUDE.md (global)', est, existsSync(p) ? 1 : 0);
}
// 2) project CLAUDE.md (root + .claude/)
{
  const ps = [join(project, 'CLAUDE.md'), join(project, '.claude', 'CLAUDE.md')].filter(existsSync);
  let est = 0; for (const p of ps) est += estFile(p);
  addCat('project-claude-md', 'CLAUDE.md (project)', est, ps.length);
}
// 3) memory index (MEMORY.md ของ project slug)
{
  const p = join(claude, 'projects', ccSlug(project), 'memory', 'MEMORY.md');
  const est = estFile(p);
  addCat('memory-index', 'memory index', est, existsSync(p) ? 1 : 0);
}
// 4) skill descriptions (frontmatter เท่านั้น — body โหลดตอน invoke)
{
  const dirs = [join(claude, 'skills'), join(claude, 'plugins', 'cache')];
  let est = 0, n = 0;
  for (const d of dirs) for (const f of findFiles(d, 'SKILL.md')) { est += estFile(f, frontmatter); n++; }
  addCat('skill-descriptions', 'skill descriptions', est, n);
}
// 5) commands (frontmatter/หัวไฟล์ — user + project)
{
  const dirs = [join(claude, 'commands'), join(project, '.claude', 'commands')];
  let est = 0, n = 0;
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith('.md') && !f.endsWith('.en.md')); } catch { /* ไม่มี dir */ }
    for (const f of files) { est += estFile(join(d, f), frontmatter); n++; }
  }
  addCat('commands', 'commands', est, n);
}
// 6) agents (frontmatter — user + project)
{
  const dirs = [join(claude, 'agents'), join(project, '.claude', 'agents')];
  let est = 0, n = 0;
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith('.md')); } catch { /* ไม่มี dir */ }
    for (const f of files) { est += estFile(join(d, f), frontmatter); n++; }
  }
  addCat('agents', 'agents', est, n);
}
// 7) settings/hooks (ทั้งไฟล์ — user + project)
{
  const ps = [join(claude, 'settings.json'), join(project, '.claude', 'settings.json')].filter(existsSync);
  let est = 0; for (const p of ps) est += estFile(p);
  addCat('settings-hooks', 'settings.json', est, ps.length);
}

const total = categories.reduce((a, c) => a + c.estTokens, 0);
topFiles.sort((a, b) => b.est - a.est);
const top = topFiles.slice(0, 10);

// ── output ───────────────────────────────────────────────────────────────────
const pct = (n) => (MAX > 0 ? (n / MAX * 100).toFixed(1) : '0.0');

if (args.json) {
  console.log(JSON.stringify({
    project, max: MAX, totalEstTokens: total, skipped,
    categories, topFiles: top,
  }, null, 2));
} else {
  console.log(`📦 preload scan — project: ${project}`);
  console.log(`   (attribution ±30% — not a measurement · the real hook measures usage directly)\n`);
  const rows = [...categories].sort((a, b) => b.estTokens - a.estTokens);
  for (const c of rows) {
    console.log(`   ${c.label.padEnd(22)} ~${String(c.estTokens).padStart(6)} tok  ${pct(c.estTokens).padStart(5)}%  (${c.files} files)`);
  }
  console.log(`\n   total preload ≈ ${total} tok (~${pct(total)}% of MAX ${MAX})` + (skipped ? ` · skipped ${skipped} files (>1MB/unreadable)` : ''));
  if (top.length) {
    console.log('\n   largest files (top ' + top.length + '):');
    for (const t of top) console.log(`   ~${String(t.est).padStart(6)} tok  ${t.path}`);
  }
}
