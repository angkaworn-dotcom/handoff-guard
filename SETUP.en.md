# Context Manager (V2) — Setup / Verify / Tune

> [ภาษาไทย](SETUP.md)

> Slug is still `handoff-guard` · full design in [docs/V2-design.md](docs/V2-design.md)

## Components (3 files + 1 state store)

| File | Role |
|------|------|
| `~/.claude/hooks/context-guard.mjs` | **Stop hook** — L1 measures real tokens every turn + L2 EWMA growth → ETA · triggers (predict / ≥184k / ≥218k) → blocks and injects an instruction to invoke skill `handoff-guard` |
| `~/.claude/hooks/session-resume.mjs` | **SessionStart hook** — finds a handoff file in the project/last-handoff → injects a pointer for the new session to read |
| `~/.claude/skills/handoff-guard/SKILL.md` | **AI eval (L3+L4)** — decides whether to start a new session + does the handoff + verifies on resume |
| `~/.claude/.handoff-guard/<session>.state.json` | **L2 state** — `{lastTokens, ema, turns}` per session (the hook reads/writes this itself, computing EWMA across turns) |
| `~/.claude/.handoff-guard/config.json` | **Your own MAX/T1/T2** — written by `scripts/set-max.mjs` (via the `/handoff-guard-max` command), read by the hook every turn (no file = use default 256000) |
| `~/.claude/commands/handoff-guard-max.md` | **slash command** — `/handoff-guard-max <max>` set your own ceiling without touching `settings.json` |

## settings.json (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"C:/Users/Dell/.claude/hooks/context-guard.mjs\"", "timeout": 15 }
      ]}
    ],
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/Users/Dell/.claude/hooks/session-resume.mjs\"", "timeout": 15 }
      ]}
    ]
  }
}
```

> Adjust the path for your machine · on Windows you can use forward slashes in the node path.

## How tokens are measured (why it's accurate)

The Stop hook receives `transcript_path` via stdin → reads the JSONL → finds `message.usage` on the **latest** assistant message →
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` = the real context size the API reported
(not a guess based on line count/character count).

## How predict works (L2)

Every turn the hook computes `delta = tokens - lastTokens` → updates the **EWMA**: `ema = α·delta + (1-α)·ema` (α=0.4, weighted toward recent, resilient to spikes from reading large files) → `etaTurns = ceil((218k - tokens) / max(ema, 500))`
**predict** fires when `etaTurns ≤ K(3)` & there are ≥2 observations & tokens haven't reached 184k yet → warns before things get critical (a negative `delta` = compaction → not counted, baseline reset)

## Verify

**1. Deterministic script test** (no need to wait for a session to grow) — see `scripts/selftest.mjs`:
```
node "C:/Users/Dell/.claude/skills/handoff-guard/scripts/selftest.mjs"
```
Covers: absolute (183k doesn't block · 185k tier1 · 218k tier2 · repeat fires stay silent) + **predict** (steady growth → fires at ETA≤K before 184k · cold-start turns<2 doesn't fire · a single spike doesn't make the ETA jump · compaction with a negative delta doesn't break)

**2. Live test** (proves that `decision:block` actually wakes Claude up in this version):
- Temporarily set `HANDOFF_GUARD_THRESHOLD=1` (env, or edit the default) → say any one sentence → Claude should get "blocked" and immediately bounce to invoking `handoff-guard`
- Once verified, restore to 184320 + delete the old markers: delete `~/.claude/.handoff-guard/*.{p,t1,t2}` + `*.state.json`

## Tune

| Want | Do |
|--------|----|
| Change the context ceiling (MAX) quickly, without touching settings.json | Run `/handoff-guard-max <max>` (e.g. `/handoff-guard-max 200000`) — auto-computes T1/T2 (72%/85%), writes `~/.claude/.handoff-guard/config.json`, takes effect next turn · `/handoff-guard-max reset` reverts to 256000 · install this command once: `cp commands/handoff-guard-max.md ~/.claude/commands/` |
| Warn (absolute) earlier/later (manual/override) | env `HANDOFF_GUARD_THRESHOLD` (default 184320 = 72%×256k), `HANDOFF_GUARD_THRESHOLD2` (217600 = 85%×256k) — env always wins over config.json |
| Change the context ceiling (display) (manual/override) | env `HANDOFF_GUARD_MAX` (default 256000) — beyond this, context quality starts degrading · if you change the ceiling, adjust T1/T2 to match (72%/85%) |
| More/less predict lead time | env `HANDOFF_GUARD_PREDICT_TURNS` (K, default 3) — higher = warns earlier/softer, lower = waits until closer before warning |
| More/less predict sensitivity to spikes | env `HANDOFF_GUARD_EMA_ALPHA` (default 0.4) — higher = reacts faster but jumpier with spikes, lower = smoother but laggier |
| Auto-compact fires before 184k (warning doesn't arrive in time) | Lower the threshold (e.g. 200000) — observe from live use at what token count compaction actually happens |
| Reset a session's warning state | Delete markers `~/.claude/.handoff-guard/<session_id>.{p,t1,t2}` + `.state.json` (resets the EWMA) |

## Limitations (honest ones)

- The Stop hook fires **after** Claude finishes its turn — if a single turn blows through multiple tiers, only the highest tier that was reached fires
- **predict needs at least 2 turns** for the EWMA to settle — a session that spikes very fast in its first 2 turns may skip predict and hit the absolute tier instead (intentional — the fail-safe still covers it)
- EWMA predicts from past growth — if behavior changes suddenly (e.g. starts reading large files rapidly), the ETA will lag 1-2 turns before adjusting (α controls the react-fast vs. stay-smooth trade-off)
- If Claude Code's auto-compact fires **before** the threshold is reached → you need to lower the threshold (tune based on what you actually observe)
- A chip / spawn_task **cannot be made deterministic** (it's a model judgment call) — this guard only handles handoff/context concerns
