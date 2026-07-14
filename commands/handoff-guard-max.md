---
description: Set handoff-guard's own context ceiling (MAX) — recomputes tier1/tier2 automatically, takes effect immediately, no restart needed
argument-hint: <max_tokens>|reset|0
allowed-tools: ["Bash"]
---

# /handoff-guard-max

> [ภาษาไทย](handoff-guard-max.th.md) — reference translation only; this file is the one Claude Code actually loads as the command.

Sets the context ceiling (`MAX`) that handoff-guard uses to warn/predict, instead of hand-editing an env var in `settings.json`.

## Argument

`$ARGUMENTS` = the maximum token count of the context window, **set it to match how you actually work**, e.g.:
- `200000` — Sonnet/Haiku (200k)
- `256000` — Opus (256k)
- `512000` — Fable/Mythos (large window, set high so it doesn't warn too early)
- `1000000` — long-context beta / push Fable all the way to spec (1M)
- `0` — **turn handoff-guard off** (never warns/blocks until you set it again)
- `reset` or `default` — delete the config, revert to per-model auto-detect (recommended if you switch models a lot)

## Steps

1. If `$ARGUMENTS` is empty → ask the user with AskUserQuestion what they want to set (offer 256000 / 512000 / 1000000 / reset / 0 as options) before running the script
2. If `$ARGUMENTS` is not a number and not `reset`/`default`/`0`/`off`/`disable` → tell the user the format is wrong, show a correct example, and stop (don't guess a value)
3. Run the setter script (first confirm the real path with `ls ~/.claude/skills/handoff-guard/scripts/set-max.mjs` in case the user installed it elsewhere):
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/set-max.mjs $ARGUMENTS
   ```
4. Read the script's stdout (it reports the new MAX/tier1/tier2, or an error if the values are invalid — e.g. tier1 ≥ tier2, out of range) and summarize it for the user in plain terms — don't paraphrase the numbers, quote them directly
5. If the script can't find the path (handoff-guard isn't installed yet, or the path differs from expected) → tell the user plainly which path wasn't found, and to check `~/.claude/skills/handoff-guard/scripts/` or wherever they actually installed it — do not create a new script to paper over it

## Notes

- Once set, it takes effect **immediately on the next turn** — the hook (`context-guard.mjs`) reads `~/.claude/.handoff-guard/config.json` fresh every time it runs; no session restart needed
- If env vars `HANDOFF_GUARD_MAX`/`HANDOFF_GUARD_THRESHOLD`/`HANDOFF_GUARD_THRESHOLD2` were ever set in `settings.json` — the env var **always wins** over what this command sets (it's meant for a temporary/testing override). If setting via `/handoff-guard-max` seems to have no effect, check whether a leftover env var is in the way
- tier1/tier2 are auto-computed at 72%/85% of MAX unless all three values are specified explicitly (`node set-max.mjs <max> <t1> <t2>`)
