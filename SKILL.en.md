# Context Manager (V2)

> [ภาษาไทย](SKILL.md) — this file is a reference translation only. The functional skill file Claude Code actually loads is `SKILL.md`; this English version is not auto-loaded.

Protects work from being lost when context is nearly full — **predicts ahead of time** how many turns until it's full → uses judgment to decide "should this hand off to a new session?" and, if so, produces a clean handoff.

> Formerly named **Handoff Guard** (reactive — waited until 184k to act) · V2 adds a time dimension (predictive), but the slug is still `handoff-guard` (invoke it by this name)

## 4 layers (Observe → Predict → Decide → Recover)
| Layer | Responsibility | Lives in |
|---|---|---|
| **L1 Observe** | Read real tokens + delta/turn | `hooks/context-guard.mjs` (deterministic) |
| **L2 Predict** | EWMA growth → ETA "how many turns until 218k" | `hooks/context-guard.mjs` (deterministic) |
| **L3 Decide** | Finish step vs. hand off (based on which tier fired) | **this skill** (AI) |
| **L4 Recover** | resume → verify → continue | `session-resume.mjs` + this skill (verify checklist) |

## When this gets invoked
> T1/T2 = `round(MAX×0.72)` / `round(MAX×0.85)` · MAX **auto-detects per model** (fable/mythos 512k → T1≈369k/T2≈435k · opus 256k → T1≈184k/T2≈218k · sonnet/haiku 200k → T1=144k/T2=170k · `[1m]` 1M) or pin it yourself with `/handoff-guard-max` (`0` = disable the guard entirely)

- The `context-guard` Stop hook fires one of the following → injects an instruction to invoke this skill (additionalContext attaches `tier/tokens/rate/etaTurns`):
  - **predict** — predicted to hit T2 within ≤ K (3) turns (tokens haven't reached T1 yet — plenty of buffer)
  - **tier1** — real tokens ≥ T1 (absolute safety net)
  - **tier2** — real tokens ≥ T2 (urgent)
- The user types `/handoff-guard` themselves

## Steps (follow in order)

### 1. Make atomic state safe first (most important — never abandon work mid-way)
- Multiple files edited but not committed + pass validation → commit if the user allows it · otherwise **note it clearly in the handoff** that "file X is left uncommitted"
- A migration / `db.batch` left mid-way → close it out, or note that it's unfinished + the impact
- A subagent/background task still running → wait for the result, or note its status + how to check on it later

### 2. Evaluate: hand off now vs. keep going a bit more
> Read `tier/etaTurns` from additionalContext first — it tells you how urgent this is (predict = plenty of buffer · tier2 = least buffer)

| Signal | Decision |
|--------|--------|
| **predict** (tokens < 184k, predicted to be full in ~etaTurns turns) | There's buffer — **it's fine to close out the current step properly** before handing off · **do not start a new feature/refactor** · if remaining work exceeds etaTurns → hand off after closing this step |
| tier2 (≥218k) | **Hand off immediately** — little buffer left, at risk of compaction eating the work |
| tier1 (≥184k) + in the middle of a large task with many steps left | Close out the current step safely → **hand off** |
| tier1 + close to finishing in 1-2 short steps | Finish that step → **hand off immediately** (don't start anything new) |

### 3. If the decision is to hand off
1. Produce a **handoff doc** using the `handoff` skill (superpowers/Matt) — **required (a dependency of this guard)**
   invoke skill `handoff` · pass the next session's focus as an argument + require it to cover **atomic/uncommitted state, worktree/branch/env, BLOCKED items**
   **Doc location: `~/.claude/.handoff-guard/handoffs/` (create the folder if missing) — override the `handoff` skill's default of saving to the OS temp dir** (Temp gets swept by Disk Cleanup/Storage Sense → the doc vanishes while the pointer still points at it)
   > **If `handoff` isn't installed yet** — don't let work get lost, do 3 things:
   > 1. Write a short `HANDOFF.md` **right now** (what's uncommitted / worktree-branch-env / next task+BLOCKED / gotchas · redact secrets)
   > 2. **Install handoff automatically for next time:** `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs` (fetches from github.com/mattpocock/skills → falls back to the vendored copy if offline)
   > 3. Tell the user: `handoff` has been installed — **restart the session** for it to load (skills load at session start, not usable immediately)
2. Update the repo's state file (e.g. `task.md`) to be fully current
3. Write a **per-worktree** pointer using the **Write tool ONLY**: `~/.claude/.handoff-guard/pointers/<slug of full cwd>.json` containing `{"cwd":"<full current cwd path>","handoff":"<full handoff doc path>"}`
   - **slug = full cwd path → lowercase → replace every char that is not a-z, 0-9, or Thai with `-`** (e.g. `c--users-dell-documents-ระบบ-ลง-วันลา-leave-web-svelte.json`) — key by **full path**, not folder name: main / each worktree / same-named projects in different locations each get their own file, no overwrites (keying by project name caused real overwrites — `/clear` resumed the wrong handoff) · the filename itself doesn't affect matching — the hook reads the `cwd` field inside
   - **Never write the pointer via PowerShell (`Set-Content`/`Out-File`) or bash `echo`** — BOM/UTF-16/mangled Thai paths make the hook's JSON.parse fail silently and fall back to someone else's handoff (Write tool = UTF-8 without BOM · the hook also strips BOM as a second layer, but don't rely on it)
   - Hook matching: **exact cwd first**, then prefix fallback (main ↔ worktrees under `.claude/worktrees/` count as the same project) · **do NOT write the old `last-handoff.txt`** (single slot = cross-project pollution) · pointers self-expire after 7 days
4. **Create a chip for one-click continuation (`mcp__ccd_session__spawn_task`)** — /clear remains the fallback
   - Sequence number N: read `~/.claude/.handoff-guard/counters.json` (`{"<slug of the main repo root path — same rule as pointers>": N}`) → new N = old value + 1 · file/key missing → N = count of `handoffs/handoff-<project name>-*.md` files + 1 · write back with the **Write tool ONLY**
   - `title` = `ต่อ <N>. <short focus>` (≤60 chars — the number shows which chip is newest) · `tldr` 1-2 sentences including N · `prompt` per the template (fill in every `<...>` with real values — the new session cannot see this conversation):
     ```
     ต่องานจาก handoff #<N>: <focus>
     You are a session spawned from a handoff-guard chip — your current cwd is a fresh worktree the harness just created. Do these 3 steps before starting work:
     1. Carry-over: always Test-Path both sides first — proceed only when "<oldWorktree>\node_modules" exists **and** ".\node_modules" does not (if the destination exists, Move-Item silently nests the folder inside it instead of erroring!) → PowerShell: Move-Item "<oldWorktree>\node_modules" ".\node_modules" · if the move fails (locked/missing) → skip and npm install when needed — never force, never kill processes
     2. Code base: HEAD must contain commit <lastCommitHash> (tip of <oldBranch>) — check with git merge-base --is-ancestor <lastCommitHash> HEAD · if not → git merge --ff-only <oldBranch> · if ff fails = stop and ask the user, don't guess
     3. node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5
     Then read <handoffPath> → run the Layer 4 verify checklist of the handoff-guard skill before continuing · when the handoff's work is done or the user moves on → delete the pointer <handoffPointerPath>
     ```
   - Still write the per-worktree pointer per step 3 (the /clear path needs it · chip and pointer coexist)
   > **Why carry-over + prune (do not drop the 3 steps from the prompt):** spawn_task always creates a fresh worktree on chip click (no way to disable) and the real disk eater is node_modules ~206MB each (this project once piled up 60 worktrees ≈10GB) → carrying over = no reinstall · the old worktree becomes a light rollback snapshot, keep the 5 newest · **never delete branches** = every rollback point stays recoverable via `git worktree add <path> <branch>` · details: `specs/2026-07-02-chip-revival-d2-design.md`
5. Tell the user clearly: "context is ~Xk now — **click the chip 'ต่อ <N>. <focus>' to continue in a new session** (the old chat stays around to scroll back through), or type `/clear` if you don't need the old chat · the handoff loads automatically → `<handoff path>`" + a 2-3 line summary of what's pending

### 4. If the decision is to keep going
- Only finish the step that's currently pending, then loop back to the handoff decision (a marker prevents repeat warnings until the next tier is reached)
- **Do not start a new feature/refactor**

## Layer 4: Recovery (when a new session resumes the work)
The SessionStart hook injects a pointer to read the handoff doc · shows the user a handoff summary (title/status/next task) via `systemMessage` (rendered in terminal CLI only — the desktop app/extension don't display it as of 2026-07, see issue #15344; in the app the user must type a first message before Claude starts reading — hooks cannot trigger a turn) — **read it, but don't dive straight in — run verify first:**
0. **(chip-spawned sessions only)** complete the 3 steps from the chip prompt first (carry-over / code base / prune) — skip this item when resuming via /clear
1. **`git status`** — do the uncommitted files match what the handoff says (do the files noted as "pending" actually exist / is what it claims was committed actually committed)
2. **branch / worktree** — is this the same one the handoff says (`git branch --show-current`, path)
3. **`npm run check`** — state isn't broken from the prior session (the leave-web project uses this as its validation gate)
4. **Does the pending work in the handoff match the actual code?** — open the files the handoff references to check they're in the state it claims → then continue
5. **Close the loop: when the handoff's work is done (or the user moved on to something else) → delete the pointer file** (its path is included in the hook's injected message) — an unconsumed pointer re-announces stale work on every `/clear` until it expires after 7 days · keep the doc in `handoffs/` as-is

> If verify **doesn't match** (e.g. the handoff says "committed" but git still shows it pending, or the build is broken even though the handoff said it passed) → **tell the user before continuing** — the handoff might have been written as the prior session was dying, so its state may be incomplete

## Rationale (why this is more accurate than soft rules)
- **observe + predict = deterministic** — the Stop hook reads real tokens from transcript usage every turn + computes EWMA growth → ETA as pure math (`~/.claude/hooks/context-guard.mjs`), not relying on the model to "remember on its own"
- **predict before it's critical** — fires as soon as it's predicted to be full within ≤ K turns (before hitting 218k) → there's buffer to close out the step properly · the absolute tier (218k/240k) is still a fail-safe in case predict misses
- **the decision = AI** — this skill is more flexible than a hard cutoff (won't cut off in the middle of an atomic op)
- **recovery = automatic + verified** — the SessionStart hook (`session-resume.mjs`) injects the handoff pointer for the new session → the skill runs a verify checklist (L4) before continuing
- Tune via env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` / `HANDOFF_GUARD_PREDICT_TURNS` (K) / `HANDOFF_GUARD_EMA_ALPHA`

## Install / verify / tune
See [SETUP.md](SETUP.md) / [SETUP.en.md](SETUP.en.md)
