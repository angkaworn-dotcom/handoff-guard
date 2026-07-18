---
name: handoff-guard
description: Context Manager (V2) — observe→predict→decide→recover. Decide whether to hand off to a fresh session when context is near (or predicted to reach) the token limit, and produce a clean handoff if so. Use when the context-guard Stop hook injects a near-limit OR predictive warning (tier=predict/tier1/tier2), when the user invokes /handoff-guard, or when context usage is high or rising fast relative to the current model's context window and you must decide whether to keep working or start a new session.
---

# Context Manager (V2)

> [ภาษาไทย](SKILL.th.md) — reference translation only; this `SKILL.md` is the functional file Claude Code loads.

Protects work from being lost when context is nearly full — the `context-guard.mjs` hook measures real tokens + predicts ETA deterministically (L1 Observe / L2 Predict) → **this skill is the decision layer (L3 Decide) + the resume-verify layer (L4 Recover)** · Full 4-layer architecture + design principles: [SETUP.md](SETUP.md) · `docs/V2-design.md`

## When this gets invoked
> **T1 (warn) = `round(MAX×0.72)` · T2 (urgent) = `round(MAX×0.85)`** — MAX auto-detects per model, or pin it with `/handoff-guard-max` (`0` = disable the guard entirely) · **The actual values for the current turn arrive in the hook's additionalContext (`tier/tokens/rate/etaTurns`) — always decide from those attached values, never from memorized fixed numbers**, because MAX differs per model / per pin (per-model ceiling table: SETUP.md)

- The `context-guard` Stop hook fires one of the following → injects an instruction to invoke this skill:
  - **predict** — predicted to hit T2 within ≤ K (3) turns (tokens haven't reached T1 yet — plenty of buffer)
  - **tier1** — real tokens ≥ T1 (absolute safety net)
  - **tier2** — real tokens ≥ T2 (urgent)
- The user types `/handoff-guard` themselves

## Steps (follow in order)

### 1. Make atomic state safe first (most important — never abandon work mid-way)
- Multiple files edited but not committed + pass validation → commit if the user allows it · otherwise **note it clearly in the handoff** that "file X is left uncommitted"
- A migration / `db.batch` left mid-way → close it out, or note that it's unfinished + the impact
- A subagent/background task still running → wait for the result, or note its status + how to check on it

### 2. Assess: hand off now vs. keep going a bit
> Read `tier/tokens/etaTurns` from additionalContext first — it tells you how urgent things are (predict = plenty of buffer · tier2 = the least)

| Signal | Decision |
|--------|----------|
| **predict** (tokens < T1, expected to reach T2 in ~etaTurns turns) | Buffer available — **you may close out the current step cleanly** then hand off · **do NOT start a new feature/refactor** · if remaining work is longer than etaTurns → hand off after closing this step |
| **tier2** (tokens ≥ T2) | **Hand off immediately** — little buffer left; compaction may eat your work |
| **tier1** (tokens ≥ T1) + mid-way through a large task with many steps left | Close the current step safely → **hand off** |
| **tier1** + work nearly done in 1-2 short steps | Finish that step → **hand off immediately** (do not start anything big) |

> **ROI (if present in the hook message — F4)**: the `💰 ROI(est): … · <label>` line is *supplementary* to the decision, not a command — a high ROI / a `Recommended`/`Critical` label = lean toward handing off sooner · but **tier still sets the primary urgency** (tier2/`Critical` = always immediate) · the numbers are an *estimated range from stats* (the "remaining turns" input is a guess) — don't treat them as precise; the final call is the AI's per the V2 principle · the more stats (F1) accumulate, the narrower the range (adaptive by nature — no separate per-project threshold).

### 3. If the decision is to hand off
1. Write the **handoff doc yourself** following the `handoff` skill's format (Matt Pocock) — **do NOT invoke it via the Skill tool**: that skill sets `disable-model-invocation: true` on purpose (the model cannot invoke it) · **what matters is the doc, not who writes it**
   - Source format: `Read ~/.claude/skills/handoff/SKILL.md` and follow all of it (has a suggested-skills section · reference existing artifacts by path/URL, don't duplicate · redact secrets · tailor to the next session's focus) + **always add (guard): atomic/uncommitted, worktree/branch/env, BLOCKED**
   - **Write with the Write tool** (UTF-8 no BOM — Thai content/paths stay intact) to `~/.claude/.handoff-guard/handoffs/` (create the folder if missing) — **name the file `handoff-<project name>-<date/short focus>.md`** so it matches the `handoff-<project name>-*.md` pattern step 4 uses to count the sequence number (a name outside the pattern isn't counted → duplicate chip numbers) — **override** Matt's default of saving to OS temp (Temp can be swept by Disk Cleanup/Storage Sense → the doc disappears while the pointer still points at it)
   > **If `~/.claude/skills/handoff/SKILL.md` is missing** (not installed) — write the doc now using the format above (what's pending / worktree-branch-env / next steps + BLOCKED / gotchas / suggested-skills · redact secrets), then install for next time: `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs` (serves as the format reference — `Read` works immediately after install · the `/handoff` command itself only becomes available **next session**, since skills load at session start — don't tell the user it's usable right away)
2. Update the repo's state file (e.g. `task.md`) so it's fresh
3. Write the **per-worktree** pointer with the **Write tool only**: `~/.claude/.handoff-guard/pointers/<slug of full cwd>.json` containing `{"cwd":"<full current cwd path>","handoff":"<full handoff doc path>"}`
   - **slug = full cwd path → lowercase → replace every character that isn't a-z, 0-9, or Thai letters with `-`** — keyed by the **full path**, not the folder name, so main / each worktree / same-named projects in different places each get their own file and never overwrite each other (which would make /clear pop the wrong handoff) · the filename itself doesn't affect matching — the hook reads the `cwd` field inside
   - **Never write the pointer via PowerShell (`Set-Content`/`Out-File`) or bash `echo`** — BOM/UTF-16/Thai-path corruption makes the hook fail to parse silently (Write tool = UTF-8 without BOM)
   - Hook matching: **exact cwd first**, then prefix fallback (main↔worktree under `.claude/worktrees/` count as the same project) · **never write the old `last-handoff.txt`** (single slot = cross-project mixing) · pointers expire on their own after 7 days
4. **Create a one-click continue chip (`mcp__ccd_session__spawn_task`)** — only when the session has this tool (Claude Code desktop app) · **no tool → skip this entire step**; the /clear + pointer path (item 3) is fully equivalent
   - Sequence number N = count of existing `~/.claude/.handoff-guard/handoffs/handoff-<project name>-*.md` files + 1, where `<project name>` = basename of mainRepoRoot (same name used in the step-1 filename — never the worktree folder name) · **count with this exact glob — never a bare `handoff-*.md`**: the handoffs folder is shared across every project, and every file in it starts with `handoff-`, so a loose glob counts other projects' files and the number jumps wildly (observed: 11 → 46 → 13) · sanity check: if N jumps by more than a couple from the last chip you saw, re-count with the full pattern (always count real files — **never use a central counter file**: two sessions handing off concurrently would read-modify-write over each other · a duplicate N from concurrent counting is merely cosmetic)
   - `title` = `Continue <N>. <short focus>` (≤60 chars — the number shows which chip is newest) · `tldr` 1-2 sentences including N · `prompt` from the template (fill every `<...>` with real values — the new session cannot see this conversation):
     ```
     Continue from handoff #<N>: <focus>
     You are a session spawned from a handoff-guard chip — the current cwd is a new worktree the harness just created. Do these 3 steps before starting work:
     1. Move the goods: always check Test-Path on both sides first — only act when "<oldWorktree>\node_modules" exists **and** ".\node_modules" doesn't yet (if the destination already exists, Move-Item silently nests it inside — no error!) → PowerShell: Move-Item "<oldWorktree>\node_modules" ".\node_modules" · can't move (locked/missing) → skip, then npm install if needed — no force, no killing processes
     2. Codebase check: HEAD must contain commit <lastCommitHash> (the tip of <oldBranch>) — check with git merge-base --is-ancestor <lastCommitHash> HEAD · missing → git merge --ff-only <oldBranch> · ff fails = stop and ask the user, don't guess
     3. node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5
     Then read <handoffPath> → run verify per Layer 4 of the handoff-guard skill before continuing · once the handoff's work is done or the user switches tasks → delete pointer <handoffPointerPath>
     ```
   - The per-worktree pointer is still written per item 3, always (the /clear path needs it · chip and pointer coexist)
   > **Do not cut the 3 steps (move node_modules / codebase check / prune) from the chip prompt** — spawn_task always creates a new worktree when the chip is pressed (no opt-out) and the real disk hog is `node_modules` → moving it from the old home = no fresh npm install · the old worktree becomes a light snapshot; keep the 5 newest · **branches are never deleted** — every point is always recoverable via `git worktree add <path> <branch>` · pin against pruning: `git worktree lock <path>` or `--keep-list name1,name2` · full rationale: `specs/2026-07-02-chip-revival-d2-design.md`
5. Tell the user clearly: "context is ~Xk — **press the chip 'Continue <N>. <focus>' to open the follow-up session** (the old chat stays for reference), or type `/clear` if you don't need the old chat · the handoff will load automatically → `<handoff path>`" + a 2-3 line summary of pending work
6. **Record handoff stats (best-effort — F1)**: `node ~/.claude/skills/handoff-guard/scripts/handoff-stats.mjs record-handoff --project "<mainRepoRoot>" --tokens <tokens> --max <MAX> --model <model> --doc "<handoff path>" --turns <turns> --rate <rate>` — read every value (`tokens`/`max`/`model`/`rate`/`turns`) straight from the bracket in the additionalContext the hook attached — every field is a bare value with no unit glued on, copy as-is (skip a field only if it's genuinely absent) · **on failure just skip it, no impact on the flow** (stats matter less than the handoff) · this data feeds the ROI engine (F4) — see `specs/2026-07-06-session-economics-design.md`

### 4. If the decision is to keep going
- Finish only the pending step, then come back and hand off (the marker suppresses repeat warnings until the next tier)
- **Do NOT start a new feature/refactor**

## Layer 4: Recovery (when a new session resumes the work)
The SessionStart hook injects a pointer to the handoff doc · shows a summary (title/status/next task) via `systemMessage` (rendered only in the terminal CLI as of 2026-07 — see issue #15344; in the app the user must type the first message before Claude starts reading) — **after reading, don't charge ahead; run verify before continuing:**
0. **(Chip-spawned sessions only)** complete the 3 steps in the chip prompt first (move node_modules / codebase check / prune) — sessions opened via /clear skip this
1. **`git status`** — do the uncommitted files match what the handoff says? (does what it noted as "pending" really exist / is what it claims committed actually still pending?)
2. **branch / worktree** — are you on the same one the handoff says? (`git branch --show-current`, path)
3. **The project's validation gate** — state isn't broken from the previous session (use whatever the project has, e.g. `npm run check` / `npm test` / lint · no gate → skip this item)
4. **Does the pending work in the handoff match the actual code?** — open the files the handoff references and confirm they're in the stated condition → then continue
5. **Close the loop: when the work in the handoff is done (or the user switches to something else) → delete the pointer file** (its path is in the hook's injected message) — an undeleted pointer = the old task pops up on every `/clear` until it expires in 7 days · the doc in `handoffs/` stays; no need to delete it
6. **Record the resume result (best-effort — F1)**: after verify items 1-4, run `node ~/.claude/skills/handoff-guard/scripts/handoff-stats.mjs record-resume --project "<mainRepoRoot>" --verify pass|fail` per the real outcome (all items passed = `pass` · state mismatch/broken = `fail`) — on failure just skip it, no impact on the flow

> If verification **doesn't match** (e.g. the handoff says "committed" but git still shows pending, or the build fails despite the handoff saying it passed) → **inform the user first; do NOT continue on top of it** — the handoff may have been written while the previous session was dying, so its state may be incomplete

## Install / verify / tune
See [SETUP.md](SETUP.md) — includes the per-model ceiling table, env tuning (`HANDOFF_GUARD_THRESHOLD` / `THRESHOLD2` / `PREDICT_TURNS` / `EMA_ALPHA`), and design principles (why observe/predict are deterministic in the hook while the decision is AI in the skill)
