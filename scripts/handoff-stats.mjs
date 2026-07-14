#!/usr/bin/env node
// handoff-stats.mjs — เก็บ/สรุปสถิติ handoff จริง (deterministic, best-effort)
// F1 ของ Session Economics (spec: specs/2026-07-06-session-economics-design.md)
// เป้าหมาย: สะสมข้อมูลจริงต่อ project เพื่อให้ ROI engine (F4) มีฐาน ไม่ใช่เลขเดาล้วน
//
// บันทึกเป็น append-only JSONL ที่ ~/.claude/.handoff-guard/stats.jsonl (UTF-8 ไม่มี BOM)
// ห้าม block flow หลักของ handoff — ทุก error รายงาน stderr + exit ≠0 แต่ผู้เรียก (SKILL.md)
// ถือว่า best-effort: handoff สำคัญกว่าสถิติ
//
// usage:
//   record-handoff --project <mainRepoRoot> --tokens <n> --max <n> --model <id> --doc <path> --turns <n> --rate <n>
//   record-resume  --project <mainRepoRoot> --verify pass|fail
//   summary        [--project <mainRepoRoot>]
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.claude', '.handoff-guard');
const statsPath = join(dir, 'stats.jsonl');

// slug = path เต็ม → lowercase → อักขระนอก a-z/0-9/ไทย → '-' (per-char, กติกาเดียวกับ pointer)
// key ด้วย path เต็มของ main repo root — โปรเจกต์ชื่อซ้ำจะไม่ปน
const slug = (p) => String(p).toLowerCase().replace(/[^a-z0-9฀-๿]/g, '-');

// ประมาณ token ของข้อความ (heuristic เดียวกับ scanner F2): ascii/4 + non-ascii/1.5 ปัดขึ้น
// เป็น attribution ±30% ไม่ใช่การวัด (ของจริง hook วัดจาก usage)
function estTokens(str) {
  let ascii = 0, non = 0;
  for (const ch of str) {
    if (ch.codePointAt(0) < 128) ascii++; else non++;
  }
  return Math.ceil(ascii / 4 + non / 1.5);
}

// parse --key value → object · flag ที่ไม่มีค่าตามหลัง = true
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

// number flag → Number ถ้าเป็นเลขจริง ไม่งั้น null (missing/NaN ไม่พังทั้ง record)
// flag เปล่า (parseArgs ให้ boolean true) / ค่าว่าง "" → null ด้วย — Number(true)=1, Number('')=0
// เป็นเลขปลอมที่ผ่าน filter typeof==='number' แล้วลาก p25/p75 ของ F4 เพี้ยนเงียบ
const num = (v) => {
  if (typeof v === 'boolean' || v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --project ต้องเป็น path จริง (string ไม่ว่าง) — flag เปล่าให้ boolean true ซึ่ง slug(true)='true'
// จะ mis-bucket record ใต้โปรเจกต์ผี 'true' แบบเงียบ
const projectOf = (args) => (typeof args.project === 'string' && args.project ? args.project : null);

function appendRecord(obj) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(statsPath, JSON.stringify(obj) + '\n', 'utf8');
}

// อ่าน stats.jsonl → array ของ record ที่ parse ได้ (บรรทัดเสีย/ว่างข้าม ไม่ throw)
function readRecords() {
  if (!existsSync(statsPath)) return [];
  let raw = '';
  try { raw = readFileSync(statsPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* บรรทัดเสีย — ข้าม */ }
  }
  return out;
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function cmdRecordHandoff(args) {
  const project = projectOf(args);
  if (!project) { console.error('❌ record-handoff requires --project <mainRepoRoot>'); process.exit(1); }
  let docBytes = null, docTokensEst = null, compressionRatio = null;
  if (typeof args.doc === 'string' && existsSync(args.doc)) {
    try {
      const content = readFileSync(args.doc, 'utf8');
      docBytes = Buffer.byteLength(content, 'utf8');
      docTokensEst = estTokens(content);
    } catch { /* อ่านไม่ได้ — คงเป็น null */ }
  }
  const tokens = num(args.tokens);
  if (docTokensEst && docTokensEst > 0 && tokens != null) {
    compressionRatio = Math.round((tokens / docTokensEst) * 10) / 10;
  }
  appendRecord({
    v: 1, kind: 'handoff', ts: new Date().toISOString(), project: slug(project),
    tokens, max: num(args.max), model: typeof args.model === 'string' ? args.model : null,
    turns: num(args.turns), rate: num(args.rate),
    docBytes, docTokensEst, compressionRatio,
  });
  console.log('✅ Handoff stats recorded');
}

function cmdRecordResume(args) {
  const project = projectOf(args);
  if (!project) { console.error('❌ record-resume requires --project <mainRepoRoot>'); process.exit(1); }
  const verify = args.verify === 'pass' ? 'pass' : args.verify === 'fail' ? 'fail' : null;
  appendRecord({ v: 1, kind: 'resume', ts: new Date().toISOString(), project: slug(project), verify });
  console.log('✅ Resume stats recorded');
}

function cmdSummary(args) {
  let records = readRecords();
  const scopeProject = projectOf(args);
  const scope = scopeProject ? slug(scopeProject) : null;
  if (scope) records = records.filter((r) => r && r.project === scope);
  const handoffs = records.filter((r) => r && r.kind === 'handoff');
  const resumes = records.filter((r) => r && r.kind === 'resume');
  if (!handoffs.length && !resumes.length) {
    console.log(`📊 handoff-stats — ${scope ? 'project: ' + scope : 'all projects'}`);
    console.log('   No data yet');
    return;
  }
  const tokensArr = handoffs.map((r) => r.tokens).filter((n) => typeof n === 'number');
  const ratioArr = handoffs.map((r) => r.compressionRatio).filter((n) => typeof n === 'number');
  const turnsArr = handoffs.map((r) => r.turns).filter((n) => typeof n === 'number');
  const rateArr = handoffs.map((r) => r.rate).filter((n) => typeof n === 'number');
  const pass = resumes.filter((r) => r.verify === 'pass').length;
  const total = resumes.filter((r) => r.verify === 'pass' || r.verify === 'fail').length;

  console.log(`📊 handoff-stats — ${scope ? 'project: ' + scope : 'all projects'}`);
  console.log(`   handoffs: ${handoffs.length}`);
  if (tokensArr.length) {
    console.log(`   tokens at handoff: avg ${Math.round(avg(tokensArr))} · median ${Math.round(median(tokensArr))}`);
  }
  console.log(`   compression ratio: avg ${ratioArr.length ? Math.round(avg(ratioArr) * 10) / 10 : '—'}`);
  if (turnsArr.length) console.log(`   turns/session: avg ${Math.round(avg(turnsArr))}`);
  if (rateArr.length) console.log(`   rate: avg ${Math.round(avg(rateArr))}/turn`);
  if (total) console.log(`   resume: ${pass}/${total} passed (${Math.round((pass / total) * 100)}%)`);
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));
switch (cmd) {
  case 'record-handoff': cmdRecordHandoff(args); break;
  case 'record-resume': cmdRecordResume(args); break;
  case 'summary': cmdSummary(args); break;
  default:
    console.error('usage: handoff-stats.mjs record-handoff|record-resume|summary [--flags]');
    process.exit(1);
}
