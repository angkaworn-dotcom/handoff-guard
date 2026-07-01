# handoff-guard

> [ภาษาไทย](README.md)

When a Claude Code session runs long, the context fills up and Claude Code will **auto-compact** — it compresses the conversation by throwing away older parts, which often loses or garbles whatever you were in the middle of. The usual workaround is a soft rule in CLAUDE.md/memory like "when it's nearly full, summarize and hand off," but the model tends to forget, or lets it fill up first.

**handoff-guard fixes that.** It's a Claude Code skill + hooks that measure the real token count every turn. When the context is nearly full it **stops Claude and forces it to write a hand-off document first**. Then a new session reads that document and picks up right where you left off — no reliance on the model's memory.

## How it works

Every time Claude finishes a reply, the hook does four things:

1. **Observe** — read the real token count from the transcript
2. **Predict** — remember the context growth rate and estimate "how many turns until it's full"
3. **Warn** — if it's nearly full (or predicted to fill up soon), stop Claude and tell it to hand off
4. **Recover** — when a new session starts, a second hook points Claude at the hand-off doc before it begins

There are three warning levels:

- 🟡 **Ahead of time** — predicted to fill up in a few turns (still time to wrap up cleanly)
- ⚠️ **Nearly full** — reached 85% of the ceiling
- 🔴 **Urgent** — reached 94% of the ceiling

It figures out each model's ceiling on its own (Opus 256k, Sonnet/Haiku 200k), and if a session gets compacted and then grows back toward full again, it will warn a second time.

## Requirements

- **Node.js** on PATH (the hooks are written in Node, so they run on any OS — no jq/bash needed)
- Matt Pocock's `handoff` skill (the thing that actually writes the hand-off doc) — **installed automatically if you don't have it**

## Install

One command — copies the files, wires up `settings.json`, and installs the dependency:

```bash
# Windows (PowerShell)
pwsh -File install.ps1
# macOS / Linux
sh install.sh
```

It's safe to re-run (overwrites with the latest, only adds hooks that aren't already there without clobbering yours, and keeps a `.bak` backup). When it's done, **restart Claude Code** to load the new skill/hooks.

<details><summary>Manual install (if you'd rather not use the installer)</summary>

```bash
# 1) skill (includes scripts/ and vendor/ — vendor has a copy of handoff for auto-install)
cp -r SKILL.md SETUP.md scripts vendor  ~/.claude/skills/handoff-guard/
# 2) make sure the handoff skill is installed (copies from the vendored copy if missing)
node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs
# 3) hooks
cp hooks/context-guard.mjs hooks/session-resume.mjs  ~/.claude/hooks/
# 4) add the hooks to ~/.claude/settings.json (see settings.example.json — adjust paths for your machine)
# 5) (optional) the /handoff-guard-max command for setting your own ceiling
cp commands/handoff-guard-max.md  ~/.claude/commands/
```

Paths in `settings.json` must be absolute:
- Windows: `node "C:/Users/<you>/.claude/hooks/context-guard.mjs"`
- macOS/Linux: `node "$HOME/.claude/hooks/context-guard.mjs"`
</details>

## Verify

```bash
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # should print ALL PASS (32 cases)
```

To try the real thing: temporarily set `HANDOFF_GUARD_THRESHOLD=1` and type any sentence — Claude should get stopped and bounce straight to the hand-off flow. When you're done, `unset HANDOFF_GUARD_THRESHOLD` (back to auto) and delete the marker files in `~/.claude/.handoff-guard/` (`*.p`, `*.t1`, `*.t2`, `*.state.json`).

## Tuning

You normally don't need to set anything — it adjusts the ceiling per model automatically. But if you want to override it:

**Easiest:** type `/handoff-guard-max 200000` in chat — sets the ceiling immediately, effective next turn, no restart (`/handoff-guard-max reset` goes back to auto).

Or use env vars (env always wins — good for a one-off/testing override):

| env | default | meaning |
|-----|---------|---------|
| `HANDOFF_GUARD_MAX` | auto per model | context ceiling — Opus 256k, Sonnet/Haiku/unknown 200k |
| `HANDOFF_GUARD_THRESHOLD` | 85% of the ceiling | the "nearly full" level |
| `HANDOFF_GUARD_THRESHOLD2` | 94% of the ceiling | the "urgent" level |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | warn ahead when predicted to be full within ≤ this many turns |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | how fast it reacts to the growth rate (higher = faster, lower = smoother) |

Ceiling priority: **env > the value pinned with `/handoff-guard-max` > auto-detect per model > 200k (the safe fallback)**

## Good to know / limitations

- **If Claude Code auto-compacts before handoff-guard gets to warn you**, the guard stays silent (this can happen on lower-ceiling models like Sonnet) — fix it by lowering the ceiling, e.g. `/handoff-guard-max 150000`, so it warns earlier.
- It's a **personal tool** tied to Claude Code's internal transcript format — if Claude Code changes that format down the road, this may need updating.
- The ahead-of-time warning needs at least 2 turns to learn the growth rate first (if it spikes hard from the very start, the percentage levels take over instead).

Full details in [SETUP.md](SETUP.md) · V2 design in [docs/V2-design.md](docs/V2-design.md)

---

The hand-off doc is produced by Matt Pocock's `handoff` skill ([mattpocock/skills](https://github.com/mattpocock/skills)) · `vendor/handoff/` is an offline copy bundled for installs without a network connection (© Matt Pocock).
