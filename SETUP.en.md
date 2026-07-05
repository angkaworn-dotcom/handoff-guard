# Context Manager (V2) — Setup / Verify / Tune

> [ภาษาไทย](SETUP.md)

> Slug is still `handoff-guard` · full design in [docs/V2-design.md](docs/V2-design.md)

## Components (3 files + 1 state store)

| File | Role |
|------|------|
| `~/.claude/hooks/context-guard.mjs` | **Stop hook** — L1 measures real tokens + the real model every turn + L2 EWMA growth → ETA · ceiling **auto-detects per model** (fable/mythos 512k · opus 256k · sonnet/haiku 200k · `[1m]` 1M) · triggers (predict / ≥T1 / ≥T2) → blocks and injects an instruction to invoke skill `handoff-guard` |
| `~/.claude/hooks/session-resume.mjs` | **SessionStart hook** — finds a handoff file in the project/per-project pointer (`pointers/*.json`, 7-day expiry) → injects a pointer for the new session to read |
| `~/.claude/skills/handoff-guard/SKILL.md` | **AI eval (L3+L4)** — decides whether to start a new session + does the handoff + verifies on resume |
| `~/.claude/.handoff-guard/<session>.state.json` | **L2 state** — `{lastTokens, ema, turns, lastDelta}` per session (the hook reads/writes this itself, computing EWMA across turns) · markers/state untouched for over 14 days are swept automatically |
| `~/.claude/.handoff-guard/config.json` | **Your own MAX/T1/T2** — written by `scripts/set-max.mjs` (via the `/handoff-guard-max` command), read by the hook every turn · **pins every model (overrides auto-detect)** · no file = auto-detect per model |
| `~/.claude/commands/handoff-guard-max.md` | **slash command** — `/handoff-guard-max <max>` set your own ceiling without touching `settings.json` |
| `~/.claude/commands/handoff-guard-update.md` | **slash command** — `/handoff-guard-update` updates handoff-guard + the `handoff` skill to the latest (checks first, updates after confirmation) |
| `~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs` | **Chip worktree cleanup** — the chip-spawned session runs this itself (step 3) · keeps the 5 most recent as snapshots, unregisters the rest (skips dirty / locked / in-use ones · pin permanently with `git worktree lock` or `--keep-list`) · **never deletes branches** |
| `~/.claude/.handoff-guard/pointers/<slug>.json` + `handoffs/` | **Per-worktree pointer** (keyed by full path, 7-day expiry) + permanent handoff doc storage (not OS temp — Disk Cleanup can sweep that) |

## settings.json (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"C:/Users/<you>/.claude/hooks/context-guard.mjs\"", "timeout": 15 }
      ]}
    ],
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/Users/<you>/.claude/hooks/session-resume.mjs\"", "timeout": 15 }
      ]}
    ]
  }
}
```

> Adjust the path for your machine · on Windows you can use forward slashes in the node path.

## How tokens are measured (why it's accurate)

The Stop hook receives `transcript_path` via stdin → reads the JSONL **from the tail of the file** (never loads the whole file — transcripts grow to many MB right when context is nearly full) → finds `message.usage` on the **latest main-conversation** assistant message →
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` = the real context size the API reported
(not a guess based on line count/character count) · subagent entries (`isSidechain`) are skipped — a subagent's context is a separate pool; counting it would corrupt the delta/EWMA.

## How predict works (L2)

Every turn the hook computes `delta = tokens - lastTokens` → updates the **EWMA**: `ema = α·delta + (1-α)·ema` (α=0.4, weighted toward recent, resilient to spikes from reading large files) → `etaTurns = ceil((T2 - tokens) / max(ema, 500))`
**predict** fires when `etaTurns ≤ K(3)` & there are ≥2 observations & tokens haven't reached T1 yet → warns before things get critical (a negative `delta` = compaction → not counted, baseline reset + markers re-armed)
**Overshoot guard**: if the latest delta alone could blow past T2 next turn (`tokens + lastDelta ≥ T2`) → predict fires immediately without waiting for the EWMA to adjust (covers the "giant turn" case that jumps from below T1 straight past T2).

## Verify

**1. Deterministic script tests** (no need to wait for a session to grow) — there are **two suites; both must pass**:
```
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs    # ALL PASS (47 cases)
node <repo>/scripts/updater-selftest.mjs                    # ALL PASS (51 cases) — run from a repo checkout only
```
- `selftest.mjs` covers the hook: absolute (183k doesn't block · 185k tier1 · 218k tier2 · repeat fires stay silent) + **predict** (steady growth → fires at ETA≤K before 184k · cold-start turns<2 doesn't fire · a single spike doesn't make the ETA jump · compaction with a negative delta doesn't break) + subagent **sidechain** entries are skipped (EWMA stays intact) + **re-arm** removes every marker after compaction + **overshoot guard** fires predict immediately on a giant turn + **sweep** clears markers/state older than 14 days + per-model ceilings + kill switch
- `updater-selftest.mjs` covers the install/update pipeline (hermetic — fakeHome + mock GitHub; never touches the real `~/.claude` or the network): fresh install + idempotency · `update --check` doesn't false-positive on CRLF≡LF (#7) · tar extract on a `C:\` path (#6) · detects a real content change and `--check` doesn't overwrite (verified by reading the file back) · full end-to-end update · `ensure-handoff --check` for both the new-version and the CRLF≡LF cases · **G** installMap destinations (full-equality, incl. a negative control that a mis-placed dest is rejected) · **H** every installMap dest is actually present after a full update (+ no `.en.md` leaks through) · **I** installMap ordering (scripts provider-before-importer: `update.mjs` → `ensure-handoff.mjs` → `install.mjs`, so an interrupted copy never leaves a new importer beside an old provider) · **J** real-repo drift guard (every real hook + every non-`.en.md` command in the actual checkout appears in installMap) · a worker-liveness check (the mock HTTP server didn't die mid-suite). **Run it from a repo checkout** (clone/worktree) — it tests installing from the real repo layout; the installed copy under `~/.claude` lacks `hooks/` and `commands/`.

**2. Live test** (proves that `decision:block` actually wakes Claude up in this version):
- Temporarily set `HANDOFF_GUARD_THRESHOLD=1` (env, or edit the default) → say any one sentence → Claude should get "blocked" and immediately bounce to invoking `handoff-guard`
- Once verified, restore to 184320 + delete the old markers: delete `~/.claude/.handoff-guard/*.{p,t1,t2}` + `*.state.json`

## Tune

| Want | Do |
|--------|----|
| Change the context ceiling (MAX) quickly, without touching settings.json | Run `/handoff-guard-max <max>` (e.g. `/handoff-guard-max 200000`) — auto-computes T1/T2 (72%/85%), writes `~/.claude/.handoff-guard/config.json`, takes effect next turn · **pins every model** · `/handoff-guard-max reset` reverts to auto-detect per model · install this command once: `cp commands/handoff-guard-max.md ~/.claude/commands/` |
| Warn (absolute) earlier/later (manual/override) | env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` (default = `round(MAX×0.72)` / `round(MAX×0.85)`) — env always wins over config.json |
| Change the context ceiling (display) (manual/override) | env `HANDOFF_GUARD_MAX` (default = auto-detect per model) — beyond this, context quality starts degrading · if you change the ceiling, adjust T1/T2 to match (72%/85%) |
| More/less predict lead time | env `HANDOFF_GUARD_PREDICT_TURNS` (K, default 3) — higher = warns earlier/softer, lower = waits until closer before warning |
| More/less predict sensitivity to spikes | env `HANDOFF_GUARD_EMA_ALPHA` (default 0.4) — higher = reacts faster but jumpier with spikes, lower = smoother but laggier |
| Auto-compact fires before 184k (warning doesn't arrive in time) | Lower the threshold (e.g. 200000) — observe from live use at what token count compaction actually happens |
| Reset a session's warning state | Delete markers `~/.claude/.handoff-guard/<session_id>.{p,t1,t2}` + `.state.json` (resets the EWMA) |
| Update everything to the latest (handoff-guard + the `handoff` skill) | `/handoff-guard-update` in chat, or `node ~/.claude/skills/handoff-guard/scripts/update.mjs --check` (read-only) → run without `--check` (update + `.bak` backups · restart session) · Matt's part only: `ensure-handoff.mjs --check`/`--update` |
| A new model isn't auto-detected (falls back to 200k → warns too often) | Add your own mapping in `~/.claude/.handoff-guard/config.json`: `{"windows": {"<regex>": <tokens>}}` — checked before the built-in patterns, no code edit needed |

## Limitations (honest ones)

- The Stop hook fires **after** Claude finishes its turn — if a single turn blows through multiple tiers, only the highest tier that was reached fires
- **predict needs at least 2 turns** for the EWMA to settle — a session that spikes very fast in its first 2 turns may skip predict and hit the absolute tier instead (intentional — the fail-safe still covers it)
- EWMA predicts from past growth — if behavior changes suddenly (e.g. starts reading large files rapidly), the ETA will lag 1-2 turns before adjusting (α controls the react-fast vs. stay-smooth trade-off)
- If Claude Code's auto-compact fires **before** the threshold is reached → you need to lower the threshold (tune based on what you actually observe)
- The handoff decision (whether/when to hand off) **cannot be made deterministic** (it's a model judgment call) — this guard only handles handoff/context concerns · continue in a new session via `/clear`, not a chip (a chip spawns a fresh git worktree every handoff)
