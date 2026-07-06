---
description: Scan what the session's preloaded context is spent on (CLAUDE.md/skills/commands/settings, etc.) — attribution ±30%, not a measurement
argument-hint: [--json]
allowed-tools: ["Bash"]
---

# /handoff-guard-scan

> [ภาษาไทย](handoff-guard-scan.md) — this file is a reference translation only. The functional command Claude Code loads is `handoff-guard-scan.md`.

Runs a one-shot diagnostic that estimates how the **preloaded** context (loaded when a session opens) is distributed — global/project CLAUDE.md, skill descriptions, commands, agents, settings/hooks, memory index.

**This is attribution/breakdown (±30%), not a measurement** — the hook already measures the real size from the API `usage` (covering preload + dynamic + hidden). This tool only gives a rough per-category share so the user can decide what preload to trim.

## Steps

1. Resolve the real script path first (`ls ~/.claude/skills/handoff-guard/scripts/scan-preload.mjs`) in case it differs — if missing, tell the user plainly and point them at `~/.claude/skills/handoff-guard/scripts/`; never recreate the script.
2. Run it against the current project (cwd):
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/scan-preload.mjs --project "$(pwd)" $ARGUMENTS
   ```
3. Read stdout and summarize for the user: which category costs the most tokens (quote the numbers/% straight from the output, don't paraphrase) + the top 2-3 largest files.
4. Only advise at the **attribution** level, e.g. "global CLAUDE.md ~8k = 4% of MAX" — **never delete/edit files automatically**; the user decides what to trim.

## Notes

- Fully read-only — the script edits nothing.
- The `MAX` used for the % comes from `~/.claude/.handoff-guard/config.json` (if pinned via `/handoff-guard-max`) or defaults to 200000 · override per-run with `--max <n>`.
- `--json` emits JSON output (for piping/parsing).
- Files > 1MB or unreadable are skipped and counted under "skipped" — they never crash the script.
