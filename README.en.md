# handoff-guard — Context Manager (V2)

> [ภาษาไทย](README.md)

A Claude Code skill + hooks that make **handoff-when-context-is-nearly-full accurate** — instead of relying on soft rules in CLAUDE.md/memory (which the model tends to forget/ignore until context is at 256k), it uses a **Stop hook that reads real token counts every turn** as the trigger + **AI judgment** for whether to start a fresh session + a **chip/handoff doc** to make continuing easy.

> **V2 = predictive.** It adds a "time dimension" — instead of just waiting for tokens to hit 218k, it tracks the context growth rate across turns (EWMA) → **predicts how many turns until it's full** → warns ahead of time, before things get critical, while keeping the original thresholds as a safety net. The slug is still `handoff-guard` (invoke it by that name).

## 4 layers: Observe → Predict → Decide → Recover

| Layer | Responsibility | Lives in |
|-------|---------|--------|
| **L1 Observe** | Read real token counts + delta/turn | `hooks/context-guard.mjs` (deterministic) |
| **L2 Predict** | EWMA growth → ETA "how many turns until 240k" | `hooks/context-guard.mjs` (deterministic) |
| **L3 Decide** | Finish the current step vs. hand off (based on which tier fired) | `SKILL.md` (AI) |
| **L4 Recover** | Resume → **verify** → continue | `hooks/session-resume.mjs` + `SKILL.md` |

**Dependency:** Uses Matt Pocock's `handoff` skill ([mattpocock/skills](https://github.com/mattpocock/skills) → `skills/productivity/handoff`) to produce the handoff doc — this guard **requires it** (it's higher quality: saves to temp so it doesn't clutter the repo, suggested-skills, avoids duplication, redacts secrets). **If it isn't installed yet → it's installed automatically** via `scripts/ensure-handoff.mjs` (fetched from upstream → falls back to the vendored copy in `vendor/handoff/` if offline), then a restart is needed. Otherwise the only dependency is `node` on PATH.

> `vendor/handoff/` = an offline copy of the `handoff` skill (© Matt Pocock, mattpocock/skills) bundled as a fallback for the ensure step.

## Why this is more accurate than soft rules

| Part | Mechanism |
|------|-----------|
| **Observe** | The `Stop` hook (`hooks/context-guard.mjs`) reads `transcript_path` → sums the `usage` of the latest assistant message (`input + cache_read + cache_creation + output`) = the real token count the API reported |
| **Predict** | Keeps `<session>.state.json` `{lastTokens, ema, turns}` → EWMA growth (α=0.4, resilient to spikes from reading large files) → `etaTurns = ceil((240k − tokens) / max(ema, 500))` |
| **Trigger** | `decision:block` wakes Claude up to do a handoff · priority: **predict** (etaTurns ≤ K=3, not yet at 218k) → **tier1** (≥218k) → **tier2** (≥240k, urgent) · markers `.p/.t1/.t2` prevent repeat warnings · sends `tier/tokens/rate/etaTurns` to the skill |
| **Decision** | The `SKILL.md` skill — AI judgment (close out the atomic op first → hand off now vs. finish the step first) · predict = plenty of buffer, can close the step first · more flexible than a hard cutoff |
| **Recovery** | The `SessionStart` hook (`hooks/session-resume.mjs`) finds `HANDOFF.md`/last-handoff → injects a pointer for the new session to read → the skill runs **verify** (git status/branch/`npm run check`/does it match the handoff) before continuing |

> Limitations: predict needs ≥2 turns for the EWMA to settle (a session that spikes fast from the start → the absolute tier takes over instead) · if auto-compact fires before the threshold, lower the threshold (tune via env) · a chip/spawn_task is a model judgment call, it can't be made deterministic

## Install

```bash
# 1) skill (includes scripts/ + vendor/ — vendor has a copy of handoff for auto-install)
cp -r SKILL.md SETUP.md scripts vendor  ~/.claude/skills/handoff-guard/
# 1b) ensure handoff is installed (copies from vendored if missing)
node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs
# 2) hooks
cp hooks/context-guard.mjs hooks/session-resume.mjs  ~/.claude/hooks/
# 3) add the hooks to ~/.claude/settings.json (see settings.example.json — adjust paths for your machine)
# 4) (optional) slash command /handoff-guard-max — set your own MAX ceiling without touching env vars
cp commands/handoff-guard-max.md  ~/.claude/commands/
```

Requires `node` on PATH (hooks are written in Node = cross-platform, no dependency on jq/bash)

**The `command` in settings.json** must be an absolute path:
- Windows: `node "C:/Users/<you>/.claude/hooks/context-guard.mjs"`
- macOS/Linux: `node "$HOME/.claude/hooks/context-guard.mjs"`

## Verify

```bash
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # must be ALL PASS (21 cases)
```
Covers: absolute tier (regression) + predict (steady growth → fires before 218k) + cold-start + spike-dampening + compaction
Live test: temporarily set `HANDOFF_GUARD_THRESHOLD=1` → say any one sentence → Claude should get "blocked" and immediately bounce to skill `handoff-guard` → then restore to 218000 + delete stale markers in `~/.claude/.handoff-guard/` (`*.{p,t1,t2}` + `*.state.json`)

## Tuning

**Fastest way — run `/handoff-guard-max <max>`** (e.g. `/handoff-guard-max 200000`) to set your own ceiling instantly, no need to touch `settings.json`/env — it auto-computes tier1/tier2 (85%/94%), saves to `~/.claude/.handoff-guard/config.json`, and takes effect on the very next turn, no restart needed · `/handoff-guard-max reset` reverts to default

Or edit env vars directly (env vars always win over config.json — good for a one-off/testing override):

| env | default | meaning |
|-----|---------|----------|
| `HANDOFF_GUARD_THRESHOLD` | 218000 | tier1 (absolute) — warn/evaluate · = 85% of the 256k ceiling |
| `HANDOFF_GUARD_THRESHOLD2` | 240000 | tier2 (absolute) — urgent + the ETA target · = 94% of the 256k ceiling |
| `HANDOFF_GUARD_MAX` | 256000 | context ceiling (display) — beyond this, context quality starts degrading |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | K — predict fires when it's predicted to be full within ≤ K turns |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | EWMA weight (higher = reacts faster, lower = smoother) |

> Priority for MAX/T1/T2: env var > `config.json` (set via `/handoff-guard-max`) > hardcoded default (256k) · to change the ceiling yourself: T1 = MAX×0.85, T2 = MAX×0.94

See full details in [SETUP.md](SETUP.md) · V2 design in [docs/V2-design.md](docs/V2-design.md)
