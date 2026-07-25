# Context Manager (V2) — Setup / Verify / Tune

> [ภาษาไทย](SETUP.th.md)

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
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs    # should print ALL PASS
node <repo>/scripts/updater-selftest.mjs                    # should print ALL PASS — run from a repo checkout only
```
- `selftest.mjs` covers the hook: absolute (183k doesn't block · 185k tier1 · 218k tier2 · repeat fires stay silent) + **predict** (steady growth → fires at ETA≤K before 184k · "once per session" is decided by the real marker (α=0 keeps the arithmetic from silencing it) · cold-start turns<2 doesn't fire · a single spike doesn't make the ETA jump · compaction with a negative delta doesn't break) + subagent **sidechain** entries are skipped (EWMA stays intact) + **re-arm** removes every marker after compaction + **overshoot guard** fires predict immediately on a giant turn + **sweep** clears markers/state older than 14 days + per-model ceilings + **env MAX override skips file-pinned t1/t2** (recomputed as % of the env MAX · explicit env T1/T2 still always win) + kill switch (incl. an empty env `""` not masking a config `{max:0}` · a non-numeric config max falls back to the model ceiling instead of NaN silently disabling the guard) + **F3 cost warnings** (every tier carries a cost phrase "~N tokens left before the ceiling" + `etaTurns` in the bracket · tier2 adds the auto-compact/degrade rationale + `etaTurns=0`) + **F4 ROI engine** (with ≥5 stats → ROI range + label per the table (tier2→Critical, tier1 ROI≥20→Recommended) · no stats → default range + "not enough stats yet" · `HANDOFF_GUARD_ROI=0` → no ROI line · corrupt stats → no crash · env override prompts) · every silent check also asserts exit 0 (a hook that crashes silently no longer counts as passing)
- `updater-selftest.mjs` covers the install/update pipeline (hermetic — fakeHome + mock GitHub; never touches the real `~/.claude` or the network): fresh install + idempotency · `update --check` doesn't false-positive on CRLF≡LF (#7) · tar extract on a `C:\` path (#6) · detects a real content change and `--check` doesn't overwrite (verified by reading the file back) · full end-to-end update · `ensure-handoff --check` for both the new-version and the CRLF≡LF cases · **G** installMap destinations (full-equality, incl. a negative control that a mis-placed dest is rejected) · **H** every installMap dest is actually present after a full update (+ no `.th.md` leaks through) · **I** installMap ordering (scripts provider-before-importer: `update.mjs` → `ensure-handoff.mjs` → `install.mjs`, so an interrupted copy never leaves a new importer beside an old provider) · **J** real-repo drift guard (every real hook + every non-`.th.md` command in the actual checkout appears in installMap) · **K** `prune-worktrees.mjs` against a fixture git repo with real worktrees (`--dry` touches nothing · removes only clean worktrees older than the keep window and truly unregisters them · dirty / locked / keep-list (incl. case-insensitive) / recent / self / worktrees outside `.claude/worktrees` all survive · `--keep 0` isn't swallowed into the default · a negative `--keep` errors instead of clamping to 0 · a rename whose source is under ignore-dirt but whose target is a real file counts as dirty · leftover dirs git doesn't know about only get a warning, never deleted) · **L** `set-max.mjs` writes config as a merge (unknown fields such as `windows` survive, both for normal set and the kill switch) + a t1/t2 floor (values mistakenly given as % are rejected without writing the file) · **M** a full update whose handoff step fails → exit 1 with no misleading "🎉 done" banner · **N** `ensure-handoff` finding a torn SKILL.md (empty/half-written) self-heals from the vendored copy instead of reporting "already installed" (an intact file still reports already) · **O** `install.mjs` with malformed settings.json (`null`/`[]` → warn + skip merge without crashing or silently clobbering · a hook filename appearing in some other field doesn't fake "already installed") · **P** anchored `name: handoff` sanity checks (the wrong skill, e.g. `handoff-guard`, doesn't pass · corrupted vendored content fails loudly instead of installing garbage) · **Q** `session-resume` (the "next" summary doesn't grab bullets from a later section · path matching stays case-insensitive on win32) · **R** `handoff-stats.mjs` (F1 — Session Economics): `record-handoff` writes well-formed JSONL + doc metrics via the heuristic (est/bytes/compression ratio) · an unreadable doc → `null` metrics without breaking · `record-resume` pass/fail · `summary` computes avg/median tokens · turns · rate · compression · resume-rate correctly · corrupt JSON lines are skipped without crashing · no data → exit 0 · installMap includes `handoff-stats.mjs` · **S** `scan-preload.mjs` (F2 — Session Economics): `--json` parses + `max` defaults to 200000 · per-category est matches the heuristic (global CLAUDE.md 400 ascii → 100, project 40 → 10) · `totalEstTokens` = sum of all categories · files >1MB are skipped and counted in `skipped` · skill est comes from frontmatter · text mode has "total preload" + % · `--max` override · installMap includes `scan-preload.mjs` + `handoff-guard-scan.md` (not `.th.md`) · a worker-liveness check (the mock HTTP server didn't die mid-suite). **Run it from a repo checkout** (clone/worktree) — it tests installing from the real repo layout; the installed copy under `~/.claude` lacks `hooks/` and `commands/`.

**2. Live test** (proves that `decision:block` actually wakes Claude up in this version):
- Temporarily set `HANDOFF_GUARD_THRESHOLD=1` (env, or edit the default) → say any one sentence → Claude should get "blocked" and immediately bounce to invoking `handoff-guard`
- Once verified, restore to 184320 + delete the old markers: delete `~/.claude/.handoff-guard/*.{p,t1,t2}` + `*.state.json`

## Where the MAX ceiling comes from (priority)

The hook picks the MAX for each turn in this order, **stopping at the first one that has a value**:

1. **env** `HANDOFF_GUARD_MAX` — temporary/testing override (wins over everything)
2. **config.json** (`fileConfig.max`) — pinned permanently via `/handoff-guard-max <n>` · **overrides auto-detect for every model**
3. **auto-detect from the model** — reads `message.model` from the latest assistant message in the transcript → `[1m]` (long-context) 1M · `fable`/`mythos` 512k (a very large real window — spec says 1M; 512k is set as a buffer so the guard doesn't warn too early) · `opus` 256k (**every Opus generation, `claude-opus-5` included** — 256k is an assumption inherited from the earlier Opus models, not a measured window: if auto-compact lands before any tier1 warning, the real window is smaller → `/handoff-guard-max 200000`; if context sails well past 256k without compacting, pin higher) · `sonnet`/`haiku`/unknown 200k (unknown = assume the smallest, better to warn too soon than not at all)
   > These patterns are tied to model-name formats that can change — if a new model isn't detected (falls back to 200k, warning too often), add your own mapping in `config.json`: `{"windows": {"<regex>": <tokens>}}`, checked before the built-ins, no code edit needed

T1/T2 follow the same priority (env → config → `round(MAX×0.72)` / `round(MAX×0.85)`) **except**: if env `HANDOFF_GUARD_MAX` is set, any t1/t2 pinned in config.json are ignored (recomputed as % of the new env MAX — the file's t1/t2 were derived from the old max, and reusing them against a new MAX can drift so far that T1 > MAX = permanently silent) unless you also set env `HANDOFF_GUARD_THRESHOLD`/`THRESHOLD2` yourself, which always win · the model can change mid-session, and the ceiling adjusts automatically as long as it isn't pinned

> **Switching between Opus/Sonnet often → don't pin** (let it auto-detect) · **Tuning auto-compact for one model → pin it with `/handoff-guard-max`** · **Want the guard fully off → `/handoff-guard-max 0`** (writes `{max:0}` → the hook exits immediately, no warnings · turn back on with `reset`)

> **What `{max:0}` covers**: the Stop hook goes silent (no measuring, no warning, no blocking) **and the skill stops volunteering** — `SKILL.md` instructs Claude not to self-invoke or suggest a handoff while the guard is disabled, since the hook isn't the only path that can raise one. An explicit `/handoff-guard` still works (you asked for it), and the SessionStart hook still surfaces an *existing* handoff doc so a resumed session doesn't lose its thread — that's recovery, not a warning. If you want that quiet too, delete the pointer for the project (its path is in the injected message).

## Tune

| Want | Do |
|--------|----|
| Change the context ceiling (MAX) quickly, without touching settings.json | Run `/handoff-guard-max <max>` (e.g. `/handoff-guard-max 200000`) — auto-computes T1/T2 (72%/85%), writes config.json, takes effect next turn · **pins every model** · `/handoff-guard-max reset` reverts to auto-detect per model · install this command once: `cp commands/handoff-guard-max.md ~/.claude/commands/` |
| Warn (absolute) earlier/later (manual/override) | env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` (default = `round(MAX×0.72)` / `round(MAX×0.85)`) — env always wins over config.json |
| Force the ceiling (display) (manual/override) | env `HANDOFF_GUARD_MAX` (default = auto-detect per model) — beyond this, context quality starts degrading · T1/T2 are automatically recomputed as % of this value (file-pinned t1/t2 are skipped) |
| More/less predict lead time | env `HANDOFF_GUARD_PREDICT_TURNS` (K, default 3) — higher = warns earlier/softer, lower = waits until closer before warning |
| More/less predict sensitivity to spikes | env `HANDOFF_GUARD_EMA_ALPHA` (default 0.4) — higher = reacts faster but jumpier with spikes, lower = smoother but laggier |
| Disable the ROI line (F4) in warnings | env `HANDOFF_GUARD_ROI=0` or config.json `{"roi": 0}` — behavior reverts to exactly pre-F4 (tier blocking still applies) · strict comparison only: `{"roi": null}` or any other value does NOT disable (an invalid config value must never silently change behavior) |
| Set the ROI "remaining turns" range yourself (instead of stats/default) | env `HANDOFF_GUARD_ROI_PROMPTS=lo,hi` (e.g. `2,4`) or config.json `{"roiPrompts": [lo, hi]}` — env wins over config · unset = p25–p75 from stats (needs ≥5 sessions), otherwise default `[5,15]` |
| Auto-compact fires before T1 (warning doesn't arrive in time) | Pin a lower ceiling `/handoff-guard-max <below where compaction actually happens>` — observe from live use at what token count compaction actually happens |
| Reset a session's warning state | Delete markers `~/.claude/.handoff-guard/<session_id>.{p,t1,t2}` + `.state.json` (resets the EWMA) |
| Update everything to the latest (handoff-guard + the `handoff` skill) | `/handoff-guard-update` in chat, or `node ~/.claude/skills/handoff-guard/scripts/update.mjs --check` (read-only) → run without `--check` (update + `.bak` backups · restart session) · Matt's part only: `ensure-handoff.mjs --check`/`--update` |

## Limitations (honest ones)
- The Stop hook fires **after** Claude finishes its turn — if a single turn blows through multiple tiers, only the highest tier that was reached fires
- **predict needs at least 2 turns** for the EWMA to settle — a session that spikes very fast in its first 2 turns may skip predict and hit the absolute tier instead (intentional — the fail-safe still covers it)
- EWMA predicts from past growth — if behavior changes suddenly (e.g. starts reading large files rapidly), the ETA will lag 1-2 turns before adjusting (α controls the react-fast vs. stay-smooth trade-off)
- If Claude Code's auto-compact fires **before** the threshold is reached → you need to lower the threshold (tune based on what you actually observe)
- The handoff decision (whether/when to hand off) **cannot be made deterministic** (it's a model judgment call) — this guard only handles handoff/context concerns · continue in a new session via `/clear`, not a chip (a chip spawns a fresh git worktree every handoff)
