#!/usr/bin/env node
// Stop hook — context-guard (Context Manager V2)
// L1 Observe : measure real tokens from the transcript (usage of the latest assistant message)
// L2 Predict : EWMA of growth/turn → ETA "how many turns until T2" (deterministic)
// → blocks Claude from stopping + injects an instruction to invoke skill "handoff-guard"
//   when (predict) it looks close to full, or (absolute) tokens blow past the original threshold (safety net)
// Loop prevention via a marker per session per tier (.p / .t1 / .t2)
import {
  readFileSync, mkdirSync, existsSync, writeFileSync, rmSync,
  openSync, readSync, closeSync, fstatSync, readdirSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// config.json is written by scripts/set-max.mjs (via the /handoff-guard-max command) — persists across sessions
// MAX priority: env (temporary/testing override) > config.json (permanently pinned via the command)
//               > the ceiling auto-detected from the transcript's model > fallback 200000 (smallest = safest)
let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(join(homedir(), '.claude', '.handoff-guard', 'config.json'), 'utf8'));
} catch { fileConfig = {}; }

// kill switch: MAX=0 = disable the guard entirely (no transcript reads, no warnings, no blocking)
// set with `/handoff-guard-max 0` (writes config.json {max:0}) or env HANDOFF_GUARD_MAX=0 (temporary)
// turn back on: /handoff-guard-max reset (auto) or /handoff-guard-max <n> (pin a new value)
{
  // an empty env ("") = not set — must fall through to config, otherwise an empty env would mask config's {max:0} kill switch
  const envMax = process.env.HANDOFF_GUARD_MAX;
  const pinned = (envMax !== undefined && envMax !== '') ? envMax : fileConfig.max;   // undefined = not set → not a kill switch
  if (pinned !== undefined && pinned !== '' && Number(pinned) === 0) process.exit(0);
}

// context ceiling per model — auto-detected per turn from message.model (the transcript records it + it can change mid-session)
// "[1m]" (long-context 1M) > fable/mythos 512k > opus 256k > sonnet/haiku/unknown 200k
// fable/mythos: the real window is very large (spec says 1M — observed in practice growing past 400k without auto-compact yet) →
//   512k is set as a middle-ground buffer: high enough not to warn too early, but still leaves room in case CC compacts before 1M (to push all the way: pin 1000000)
// (unknown = assume the smallest → the guard firing too soon beats not firing at all on a low-ceiling model)
// the patterns below are tied to the message.model format, which Anthropic can change — if a new model doesn't match,
// it falls back to 200k (safe but warns too often on a high-ceiling model) → override it yourself, no code change needed:
// config.json {"windows": {"<regex>": <tokens>, ...}}, checked before the built-ins in the order written
const windowForModel = (m) => {
  if (fileConfig.windows && typeof fileConfig.windows === 'object') {
    for (const [pat, tok] of Object.entries(fileConfig.windows)) {
      try { if (new RegExp(pat, 'i').test(m) && Number(tok) > 0) return Number(tok); }
      catch { /* bad pattern — skip to the next one */ }
    }
  }
  return /\[1m\]/.test(m) ? 1000000 :
    /fable|mythos/.test(m) ? 512000 :
    /opus/.test(m) ? 256000 : 200000;
};

const K = Number(process.env.HANDOFF_GUARD_PREDICT_TURNS || 3);     // lead time (turns) for the predict trigger
const ALPHA = Number(process.env.HANDOFF_GUARD_EMA_ALPHA || 0.4);   // EWMA weight given to the latest delta
const FLOOR = 500;  // minimum rate allowed as a divisor (prevents ETA from exploding to Infinity)
const SWEEP_DAYS = 14;  // markers/state untouched by a session for longer than this → deleted (prevents unbounded accumulation)

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// Find the usage/model of the "latest main-conversation" assistant message from the transcript JSONL
// - Reads from the tail of the file in chunks (quadrupling until found) — never reads the whole file: transcripts
//   grow to tens of MB right when context is nearly full, which is exactly when this hook most needs to be fast
// - Subagent entries (isSidechain) are skipped — a subagent's context is much smaller than main's, and counting it
//   would produce a false negative delta (misread as compaction → markers re-armed for nothing), then next turn
//   the delta would spuriously jump → the EWMA breaks → predict fires erratically
function lastMainUsage(transcript) {
  let fd;
  try { fd = openSync(transcript, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    let chunk = 256 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      // use the actual number of bytes read — a short read (file truncated mid-read) would otherwise leave stale \0s at the buffer's tail
      const n = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8', 0, n).split('\n');
      if (start > 0) lines.shift();   // the chunk's first line may be cut mid-line — discard it
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        let obj;
        try { obj = JSON.parse(s); } catch { continue; }
        if (obj.isSidechain) continue;
        const u = obj && obj.message && obj.message.usage;
        if (!u) continue;
        return {
          tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
                + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
          model: obj.message.model || '',
        };
      }
      if (start === 0) return null;   // reached the head of the file and still found no usage
      chunk *= 4;
    }
  } catch { return null; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }

  const sessionId = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const transcript = input.transcript_path || '';
  if (!transcript || !existsSync(transcript)) process.exit(0);

  // L1 — current tokens + model = usage/model of the latest assistant message (main only)
  // (input + cache_read + cache_creation + output = the context size the model saw that round)
  const last = lastMainUsage(transcript);
  if (!last) process.exit(0);
  const tokens = last.tokens;
  const model = last.model;

  // ceiling/threshold — computed after the model is known (env > config.json pin > detected model > fallback)
  let MAX = Number(process.env.HANDOFF_GUARD_MAX || fileConfig.max || windowForModel(model));
  // config.max isn't a number (e.g. "abc") → NaN makes every comparison false = the guard silently turns off → fall back to the model ceiling
  if (!Number.isFinite(MAX) || MAX <= 0) MAX = windowForModel(model);
  // if env MAX is set → any t1/t2 pinned in the file were derived from the old max, so they can't be reused
  // (config {max:500k,t1:360k} + env MAX=200k → T1 > MAX = the guard stays silent forever) — recompute as % of
  // the new MAX unless env T1/T2 are set explicitly
  const envMaxSet = (process.env.HANDOFF_GUARD_MAX ?? '') !== '';
  const T1 = Number(process.env.HANDOFF_GUARD_THRESHOLD || (!envMaxSet && fileConfig.t1) || Math.round(MAX * 0.72));  // tier1: warn/assess (72% → fires before CC auto-compact ~85%)
  const T2 = Number(process.env.HANDOFF_GUARD_THRESHOLD2 || (!envMaxSet && fileConfig.t2) || Math.round(MAX * 0.85)); // tier2: urgent + the ETA target

  const dir = join(homedir(), '.claude', '.handoff-guard');
  mkdirSync(dir, { recursive: true });
  const m1 = join(dir, `${sessionId}.t1`);
  const m2 = join(dir, `${sessionId}.t2`);
  const mp = join(dir, `${sessionId}.p`);
  const statePath = join(dir, `${sessionId}.state.json`);

  // L2 — update the EWMA of the growth rate across turns
  let state = null;
  try { if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { state = null; }

  if (!state || typeof state.lastTokens !== 'number') {
    // the session's first fire → baseline only, no delta yet
    state = { lastTokens: tokens, ema: 0, turns: 1, lastDelta: 0 };
    // at this same moment (once per session — not every turn's worth of I/O), sweep marker/state files
    // from old sessions that would otherwise never get deleted on their own — else they pile up
    // without bound under .handoff-guard/
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (!d.isFile() || !/\.(t1|t2|p|state\.json)$/.test(d.name)) continue;
        const fp = join(dir, d.name);
        try {
          if (Date.now() - statSync(fp).mtimeMs > SWEEP_DAYS * 864e5) rmSync(fp, { force: true });
        } catch { /* file missing/locked — skip */ }
      }
    } catch { /* dir unreadable — skip */ }
  } else {
    const delta = tokens - state.lastTokens;
    if (delta < 0) {
      // compaction/reset happened → don't count the negative delta, keep the existing ema, reset the baseline
      // + re-arm: delete any markers that already fired, so warnings can fire again if context grows
      // past T1/T2 a second time after compaction (a session that compacted and grew again has
      // already degraded — all the more reason to hand off, not stay silent forever)
      // force: true = skip any file that's missing — must not throw partway through, or the next one never gets deleted
      rmSync(m1, { force: true });
      rmSync(m2, { force: true });
      rmSync(mp, { force: true });
      state.lastDelta = 0;
    } else {
      if (!state.ema) state.ema = delta;                        // the first real delta
      else state.ema = ALPHA * delta + (1 - ALPHA) * state.ema; // EWMA
      state.lastDelta = delta;
    }
    state.lastTokens = tokens;
    state.turns = (state.turns || 0) + 1;
  }
  try { writeFileSync(statePath, JSON.stringify(state)); } catch { /* best effort */ }

  const rate = Math.max(state.ema || 0, FLOOR);
  let etaTurns = Math.ceil((T2 - tokens) / rate);
  // overshoot guard: the EWMA deliberately dampens spikes (to keep the ETA from jerking around), but that
  // hides a "giant turn" — if the latest delta alone would blow past T2 next turn, treat ETA as 1
  // without waiting for the EWMA to catch up
  const overshootNext = (state.lastDelta || 0) > 0 && tokens + state.lastDelta >= T2;
  if (overshootNext) etaTurns = Math.min(etaTurns, 1);

  const emit = (reason, ctx) => {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx },
    }));
    process.exit(0);
  };

  // F3 — a cost rationale built only from "measured" values (tokens/rate/MAX/T2), no guessed numbers
  // remaining = left until the ceiling · turnsToMax = turns until the ceiling at the current rate · etaToT2 = until T2
  // cold start (ema hasn't settled yet, e.g. the session's first fire): rate = FLOOR, which is a fallback, not a measurement
  // → must not claim "~N turns" from the floor value (this once claimed "~20 turns" when a real turn could burn 10k+ tokens)
  const remaining = Math.max(0, MAX - tokens);
  const rateSettled = (state.ema || 0) > 0;
  const turnsToMax = Math.ceil(remaining / rate);
  const etaToT2 = Math.max(0, etaTurns);   // same formula as predict — also gets the overshoot clamp (a giant turn → ETA 1)
  const costPhrase = rateSettled
    ? `~${remaining} tok left before the MAX ceiling ≈ ~${turnsToMax} turns at this rate`
    : `~${remaining} tok left before the MAX ceiling (rate hasn't settled yet — can't estimate turns yet)`;

  // F4 — ROI engine (deterministic): always shows "how much more expensive is staying vs. handing off" as a *range*
  // the input is a guess (expected remaining prompts) → clearly labeled as an estimate, not a measurement (avoids pseudo-precision)
  // reads stats.jsonl only at emit time (emit fires then process.exit — not I/O on every turn)
  // can be disabled: env HANDOFF_GUARD_ROI=0 or config {roi:0} → behavior reverts to exactly pre-F4 in every respect
  const roiSlug = (p) => String(p).toLowerCase().replace(/[^a-z0-9฀-๿]/g, '-');
  const roiMedian = (arr) => {
    if (!arr.length) return 0;   // avoid NaN — the original F1 returns null but this caller does arithmetic on the result
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const roiSuffix = (tier) => {
    // kill switch: strict comparison only — Number() would turn {roi:null}/false/"" into 0 = silently off
    // even though the user never set it (same convention as MAX: an invalid config value must never silently change behavior)
    if (process.env.HANDOFF_GUARD_ROI === '0' || fileConfig.roi === 0 || fileConfig.roi === '0') return '';
    try {
      let recs = [];
      try {
        const raw = readFileSync(join(dir, 'stats.jsonl'), 'utf8');
        for (const ln of raw.split('\n')) {
          const s = ln.trim(); if (!s) continue;
          try { recs.push(JSON.parse(s)); } catch { /* corrupt line — skip */ }
        }
      } catch { /* no file — fall through to the default range */ }
      const handoffs = recs.filter((r) => r && r.kind === 'handoff');
      // try per-project first (if cwd gives ≥5) → otherwise fall back to the pool across all projects
      // records are keyed by slug(mainRepoRoot) (SKILL step 6), but a chip-spawned session runs inside a worktree
      // → strip /.claude/worktrees/<name>... before slugging (main↔worktree = the same project,
      // same rule as the pointer in session-resume) or the per-project pool would never match
      let pool = handoffs;
      if (input.cwd) {
        const cwdMain = String(input.cwd).replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '');
        const cs = roiSlug(cwdMain);
        const pj = handoffs.filter((r) => r.project === cs);
        if (pj.length >= 5) pool = pj;
      }
      const turnsArr = pool.map((r) => r.turns).filter((n) => typeof n === 'number');
      const docArr = pool.map((r) => r.docTokensEst).filter((n) => typeof n === 'number');

      // remaining-prompts range: env/config override > stats p25–p75 (≥5) > default [5,15]
      let lo, hi, source;
      const envOv = String(process.env.HANDOFF_GUARD_ROI_PROMPTS || '').split(',').map(Number);
      const cfgOv = Array.isArray(fileConfig.roiPrompts) ? fileConfig.roiPrompts.map(Number) : null;
      if (envOv.length === 2 && envOv.every(Number.isFinite)) { [lo, hi] = envOv; source = 'override'; }
      else if (cfgOv && cfgOv.length === 2 && cfgOv.every(Number.isFinite)) { [lo, hi] = cfgOv; source = 'override'; }
      else if (turnsArr.length >= 5) {
        const cur = state.turns || 1;
        const sorted = [...turnsArr].sort((a, b) => a - b);   // sort once, reuse for both percentiles
        const pct = (p) => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))];
        lo = Math.max(1, pct(0.25) - cur);
        hi = Math.max(1, pct(0.75) - cur);
        source = 'stats';
      } else { lo = 5; hi = 15; source = 'default'; }
      if (lo > hi) { const t = lo; lo = hi; hi = t; }

      const handoffCost = docArr.length ? Math.round(roiMedian(docArr)) + 3000 : 10000;
      const replayLo = tokens * lo, replayHi = tokens * hi;
      const roiLo = Math.floor(replayLo / handoffCost), roiHi = Math.floor(replayHi / handoffCost);
      if (roiHi <= 0) return '';

      const label = tier === 'tier2' ? 'Critical'
        : tier === 'tier1' ? (roiLo >= 20 ? 'Recommended' : 'Soon')
          : (roiLo >= 20 ? 'Soon' : 'Continue');
      const note = source === 'stats' ? `range from ${turnsArr.length} sessions of stats — an estimate, not a measurement`
        : source === 'override' ? 'range set manually via config/env'
          : 'default range — not enough stats yet';
      return ` 💰 ROI(est): replay ~${replayLo}–${replayHi} vs handoff ~${handoffCost} → ~${roiLo}x–${roiHi}x · ${label} (${note})`;
    } catch { return ''; }
  };

  // L3 trigger — priority high→low (fires the first condition that matches)

  // tier2 (urgent) — fires once per session
  if (tokens >= T2 && !existsSync(m2)) {
    writeFileSync(m2, String(tokens));
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (over ${T2} — urgent)`,
      `🔴 Urgent [tier=tier2 · tokens=${tokens} · max=${MAX} · model=${model || 'unknown'} · rate=${Math.round(rate)} · turns=${state.turns} · etaTurns=0]: context ~${tokens}/${MAX} is very close to full (${costPhrase}). Continuing until you hit the ceiling means getting auto-compacted and losing context quality — that's the real cost of not handing off. Before doing anything else, invoke skill "handoff-guard" right now — safely close out any pending step, write the handoff doc, then tell the user to open a new session.` + roiSuffix('tier2')
    );
  }

  // tier1 (absolute) — fires once per session
  if (tokens >= T1 && !existsSync(m1)) {
    writeFileSync(m1, String(tokens));
    emit(
      `Context ~${tokens} tokens (over ${T1})`,
      `⚠️ [tier=tier1 · tokens=${tokens} · max=${MAX} · model=${model || 'unknown'} · rate=${Math.round(rate)} · turns=${state.turns} · etaTurns=${etaToT2}]: context ~${tokens}/${MAX} (${costPhrase}${rateSettled ? ` · ~${etaToT2} more turns until T2 ${T2}` : ''}). Invoke skill "handoff-guard" to assess whether to start a new session (if you're in the middle of an atomic op, close it out safely first). Don't start anything new until that assessment is done.` + roiSuffix('tier1')
    );
  }

  // predict (L2) — fires once per round (markers re-arm after compaction), before the absolute tier,
  // once the ema has settled or the latest delta alone would blow past T2 (overshoot guard)
  if (tokens < T1 && state.turns >= 2 && ((state.ema > 0 && etaTurns <= K) || overshootNext) && !existsSync(mp)) {
    writeFileSync(mp, String(tokens));
    emit(
      `Context ~${tokens} tokens — predicted ~${etaTurns} more turns until ${T2}`,
      `🟡 Forecast [tier=predict · tokens=${tokens} · max=${MAX} · model=${model || 'unknown'} · rate=${Math.round(rate)} · turns=${state.turns} · etaTurns=${etaTurns}]: context ~${tokens}/${MAX}, growing ~${Math.round(rate)}/turn on average → will reach ${T2} in ~${etaTurns} more turns (${costPhrase}). Close out the current step, then invoke skill "handoff-guard" to prepare a handoff. Don't start anything new.` + roiSuffix('predict')
    );
  }

  process.exit(0);
}
main();
