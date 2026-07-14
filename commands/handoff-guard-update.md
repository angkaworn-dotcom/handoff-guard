---
description: Update handoff-guard + the handoff skill (Matt Pocock) to the latest version in one command — checks first, updates after confirmation
argument-hint: (no arguments)
allowed-tools: ["Bash", "AskUserQuestion"]
---

# /handoff-guard-update

> [ภาษาไทย](handoff-guard-update.th.md) — reference translation only; this file is the one Claude Code actually loads as the command.

Updates two things in one command: **handoff-guard itself** (pulled from the repo's main) and **Matt Pocock's `handoff` skill** (pulled from upstream). Updating is always an explicit user command — never a silent auto-pull.

## Steps

1. Check first (writes nothing):
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/update.mjs --check
   ```
2. Read stdout and summarize for the user: which parts have updates (handoff-guard's changed-file list / the handoff skill's diff) — quote from stdout directly, don't paraphrase file names or numbers.
3. **Both already up to date** → tell the user, done.
4. **Updates available** → confirm with AskUserQuestion (show a summary of what will change), then run:
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/update.mjs
   ```
5. Summarize what was updated + remind the user to **restart the Claude Code session** to load the new hooks/skill (the old ones keep running until restart).
6. If the script fails (no network / bad tarball / upstream content fails validation) → surface the error from stdout/stderr verbatim; don't guess, don't hand-edit files in place of the script.

## Notes

- `--check` is always safe (read-only) — the real update backs things up: settings.json → `.bak`, the previous handoff skill → `SKILL.md.bak`
- Matt's part is validated before writing — content that isn't the real `handoff` skill is rejected without touching the existing file
- To update only Matt's part: `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs --update`
