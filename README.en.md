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

## Two ways to continue in a new session

- **Click the chip** (Claude Code apps with `spawn_task`) — after finishing the handoff, Claude creates a one-click "ต่อ N. &lt;task&gt;" button (the running number N tells you which chip is newest). The new session runs 3 steps on its own before starting work: **move the goods** (relocate `node_modules` from the old worktree so there's no fresh `npm install`) → **verify the code base** (HEAD must contain the old branch's tip commit; ff-merge if not) → **prune** (keep the 5 most recent old worktrees as snapshots, unregister the rest — **branches are never deleted**, every point stays recoverable via `git worktree add`)
- **Type `/clear`** (works everywhere including the terminal CLI) — the per-project pointer routes the new session to the handoff doc, and it runs the verify checklist (git status / branch / validation gate) before continuing.

Pointers are one file per worktree (keyed by the full path) — you can have several projects/worktrees open at once without handoffs cross-contaminating · pointers expire after 7 days, and Claude deletes them once the handoff's work is done.

There are three warning levels:

- 🟡 **Ahead of time** — predicted to fill up in a few turns (still time to wrap up cleanly)
- ⚠️ **Nearly full** — reached 72% of the ceiling
- 🔴 **Urgent** — reached 85% of the ceiling

It figures out each model's ceiling on its own (Fable/Mythos 512k, Opus 256k, Sonnet/Haiku 200k, long-context `[1m]` mode 1M), and if a session gets compacted and then grows back toward full again, it will warn a second time.

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
# 2) make sure the handoff skill is installed (vendored copy first; upstream fetch only as fallback)
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
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # should print ALL PASS (47 cases)
```

To try the real thing: temporarily set `HANDOFF_GUARD_THRESHOLD=1` and type any sentence — Claude should get stopped and bounce straight to the hand-off flow. When you're done, `unset HANDOFF_GUARD_THRESHOLD` (back to auto) and delete the marker files in `~/.claude/.handoff-guard/` (`*.p`, `*.t1`, `*.t2`, `*.state.json`).

## Tuning

You normally don't need to set anything — it adjusts the ceiling per model automatically. But if you want to override it:

**Easiest:** type `/handoff-guard-max <number>` in chat — sets the ceiling immediately, effective next turn, no restart. **Set it to match how you actually work:**

| How you work | What to set |
|---|---|
| Switch between models / don't want to think about it | `/handoff-guard-max reset` → let it auto-detect per model **(recommended)** |
| Mostly stay on one model | pin it to that model's window — Opus `256000` · Fable/Mythos `512000` · Sonnet/Haiku `200000` |
| Want earlier/more frequent warnings | pin lower, e.g. `/handoff-guard-max 150000` |
| Want to silence it (let Claude Code auto-compact on its own) | `/handoff-guard-max 0` — fully off, never warns/blocks · turn back on with `/handoff-guard-max reset` |

Or use env vars (env always wins — good for a one-off/testing override):

| env | default | meaning |
|-----|---------|---------|
| `HANDOFF_GUARD_MAX` | auto per model | context ceiling — Fable/Mythos 512k, Opus 256k, Sonnet/Haiku/unknown 200k, `[1m]` 1M · **`0` = turn guard off** |
| `HANDOFF_GUARD_THRESHOLD` | 72% of the ceiling | the "nearly full" level |
| `HANDOFF_GUARD_THRESHOLD2` | 85% of the ceiling | the "urgent" level |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | warn ahead when predicted to be full within ≤ this many turns |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | how fast it reacts to the growth rate (higher = faster, lower = smoother) |

Ceiling priority: **env > the value pinned with `/handoff-guard-max` > auto-detect per model > 200k (the safe fallback)**

## Good to know / limitations

- **If Claude Code auto-compacts before handoff-guard gets to warn you**, the guard stays silent (this can happen on lower-ceiling models like Sonnet) — fix it by lowering the ceiling, e.g. `/handoff-guard-max 150000`, so it warns earlier.
- **Fable/Mythos are set to a 512k ceiling** (higher than the others) because their real context window is very large — the spec says 1M, and in practice a session was observed growing past 400k without Claude Code auto-compacting. Setting them to Opus's 256k would make the guard warn far too early while there's still a huge buffer left · to push it all the way to spec, use `/handoff-guard-max 1000000` (though it's not yet confirmed where Claude Code actually auto-compacts on a 1M window).
- It's tied to Claude Code's internal transcript format — if Claude Code changes that format down the road, this may need updating · a new model the auto-detect doesn't recognize falls back to 200k (warns too often on big-window models) — override it yourself in `config.json` with `{"windows": {"<regex>": <tokens>}}`, no code edit needed.
- The ahead-of-time warning needs at least 2 turns to learn the growth rate first (if it spikes hard from the very start, the percentage levels take over instead).
- **Chips only work on clients that have `spawn_task`** (the Claude Code desktop app) — on the terminal CLI use the `/clear` + pointer path instead; same functionality, just no button. Also note a chip **always creates a new git worktree** (there's no way to turn that off), which is why the move-the-goods + prune steps exist at all.
- **The `node_modules` move never fires in repos that commit `node_modules` to git** — a fresh worktree materializes `node_modules` at checkout, so the "destination is empty" condition is never true (deliberately safe: `Move-Item` into an existing destination silently *nests* the folder inside) → the old worktree keeps its full `node_modules` until pruned/deleted manually.
- **To protect a worktree from pruning → `git worktree lock <path>`** (the script always skips locked ones) or pass its name via `--keep-list` · **Prune can't delete a worktree that's still in use** — an old session that's still open (or a dev server still running) holds the cwd, so the file deletion fails (EBUSY). The script unregisters it from git and reports it as an "orphan folder" to delete manually after closing the session — it never forces or kills processes for you.
- **The handoff summary shown at session start (`systemMessage`) renders only on the terminal CLI** — the desktop app/IDE extensions don't render it yet (as of 2026-07), and a hook can't trigger a turn by itself: the user has to send the first message before Claude starts reading the handoff.

Full details in [SETUP.md](SETUP.md) · V2 design in [docs/V2-design.md](docs/V2-design.md)

---

The hand-off doc is produced by Matt Pocock's `handoff` skill ([mattpocock/skills](https://github.com/mattpocock/skills)) · `vendor/handoff/` is a pinned copy used as the primary install source (upstream is fetched only if the copy is missing — content injected into Claude's context should be a reviewed version, not a live main branch) (© Matt Pocock).

Update to the latest version (both handoff-guard itself and Matt's `handoff`) in one command: type `/handoff-guard-update` in chat, or run `node ~/.claude/skills/handoff-guard/scripts/update.mjs --check` to see what's new, then run it without `--check` to take it (previous versions are backed up as `.bak` · restart the session afterwards) — updating is always an explicit command, never an automatic pull · to update only Matt's part: `ensure-handoff.mjs --update`.
