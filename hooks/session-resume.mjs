#!/usr/bin/env node
// SessionStart hook — auto-resume
// When a session opens/resumes, if a handoff "for this project" is found → inject a pointer for Claude to read before starting
// Closes the loop: handoff-guard wrote a handoff → the new session reads it automatically, no reliance on memory
//
// v2: the pointer is per-project (~/.claude/.handoff-guard/pointers/*.json) instead of a single last-handoff.txt slot
//   - prevents handoffs from cross-contaminating between projects + prevents overwrites when working on several projects in parallel
//   - the pointer expires after MAX_AGE_DAYS days (once the work is done, it doesn't keep popping up as stale noise)
//   - a pointer whose target doc has disappeared (e.g. swept by Disk Cleanup) is skipped
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_AGE_DAYS = 7;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }
const cwd = input.cwd || process.cwd();

// normalize the path for comparison — lowercase only on case-insensitive filesystems (win32/darwin):
// on Linux, paths that differ only in case are genuinely different folders — lowercasing them would
// wrongly match pointers belonging to different projects
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return CASE_INSENSITIVE_FS ? s.toLowerCase() : s;
};
const here = norm(cwd);

// files that "signal continue-me" within a project (naturally per-project — unchanged)
const signals = ['HANDOFF.md', 'docs/HANDOFF.md', '.claude/session-state.md'];
const found = signals.map((p) => join(cwd, p)).filter(existsSync);

// per-project pointer written by handoff-guard: pointers/*.json = {"cwd": "...", "handoff": "..."}
// match: exact · the session is under the pointer's path · the pointer is under the session's .claude/worktrees/
// (main repo ↔ worktree count as the same project — but a generic parent-folder match is not allowed)
const pointersDir = join(homedir(), '.claude', '.handoff-guard', 'pointers');
let lastHandoff = '';
let lastPointer = '';
try {
  const candidates = [];
  for (const f of readdirSync(pointersDir)) {
    if (!f.endsWith('.json')) continue;
    const fp = join(pointersDir, f);
    try {
      const st = statSync(fp);
      if (Date.now() - st.mtimeMs > MAX_AGE_DAYS * 864e5) continue; // too old — skip
      // strip BOM — a pointer accidentally written via PowerShell -Encoding utf8 gets a leading U+FEFF → JSON.parse throws silently
      const { cwd: pc, handoff } = JSON.parse(readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
      const pcn = norm(pc);
      if (!pcn || !handoff) continue;
      // session-deeper direction (here under pcn) is allowed generically: opening a subdir/worktree of the
      // pointer's project = the same thing. pointer-deeper direction is restricted to only a worktree under
      // here's .claude/worktrees/ — allowing a generic prefix match here would mean opening a session at a
      // parent folder (e.g. ~/projects) matches every project's pointer underneath and surfaces unrelated handoffs
      const sameProject = here === pcn
        || here.startsWith(pcn + '/')
        || pcn.startsWith(here + '/.claude/worktrees/');
      if (!sameProject) continue;
      if (!existsSync(handoff)) continue; // target doc is gone — skip
      candidates.push({ handoff, mtime: st.mtimeMs, exact: here === pcn, fp });
    } catch { /* corrupt pointer — skip */ }
  }
  // exact cwd match comes first — main and each worktree have their own pointer = never picks up another
  // worktree's pointer that happened to write to the same slot · if there's no exact match, fall back to
  // the newest prefix match (main↔worktree)
  candidates.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (b.mtime - a.mtime));
  if (candidates.length) { lastHandoff = candidates[0].handoff; lastPointer = candidates[0].fp; }
} catch { /* no pointers dir yet — silent */ }

// short handoff summary shown to the user immediately (systemMessage) — title + status + first pending item
function summarizeHandoff(path) {
  try {
    const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const clip = (s) => { s = s.replace(/\*\*|`/g, ''); return s.length > 140 ? s.slice(0, 137) + '…' : s; };
    const title = (lines.find((l) => l.startsWith('# ')) || '').replace(/^#\s*(Handoff\s*[—-]\s*)?/i, '').trim();
    const status = (lines.find((l) => /^##\s*(สถานะ|Status)/i.test(l)) || '').replace(/^##\s*/, '').trim();
    const i = lines.findIndex((l) => /^##\s*(งานที่รอ|งานถัดไป|Next)/i.test(l));
    // only look for a bullet within this section (stop at the next heading) — otherwise an empty section
    // would grab a bullet from a different section (e.g. Gotchas) and wrongly show it as "next"
    let next = '';
    if (i >= 0) {
      const rest = lines.slice(i + 1);
      const end = rest.findIndex((l) => /^##\s/.test(l));
      const sect = end >= 0 ? rest.slice(0, end) : rest;
      next = (sect.find((l) => l.trim().startsWith('- ')) || '').trim().replace(/^-\s*/, '');
    }
    return [title, status, next && `Next: ${next}`].filter(Boolean).map(clip).join('\n');
  } catch { return ''; }
}

const parts = [];
if (found.length) parts.push(`Handoff files in this project: ${found.join(', ')}`);
if (lastHandoff) parts.push(`Latest handoff: ${lastHandoff}`);

let out = { hookSpecificOutput: { hookEventName: 'SessionStart' } };
if (parts.length) {
  // compact/resume = the existing conversation is still around (mid-task) → just a light reference, don't
  // trigger a redundant resume announcement
  // startup/clear = fresh context → tell Claude to read + announce the handoff itself so the user sees it resumed
  const midTask = ['compact', 'resume'].includes(input.source || '');
  const consumeHint = lastPointer
    ? ` Once the work in this handoff is done, or the user isn't continuing it → delete the pointer file to prevent it popping up again: ${lastPointer}.`
    : '';
  out.hookSpecificOutput.additionalContext = midTask
    ? `📂 (reference) Handoff for this project: ${parts.join(' · ')}`
    : `📂 Found pending work for this project (from handoff-guard). Before replying to the user's first message, Read the handoff below ` +
      `and give the user a short 2-3 line summary (what's pending / which branch·worktree / next step) to confirm it resumed ` +
      `before continuing — unless the user is clearly starting new work unrelated to this handoff.${consumeHint} ${parts.join(' · ')}`;
  if (!midTask && lastHandoff) {
    // show the summary to the user right when the session starts (documented field — renders on the terminal CLI;
    // the app/IDE extension don't render it yet as of 2026-07: github.com/anthropics/claude-code/issues/15344)
    const sum = summarizeHandoff(lastHandoff);
    if (sum) out.systemMessage = `📂 Pending work from handoff:\n${sum}`;
  }
}
process.stdout.write(JSON.stringify(out));
