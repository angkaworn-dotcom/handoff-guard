# Context Manager (V2)

> [ภาษาไทย](SKILL.md) — this file is a reference translation only. The functional skill file Claude Code actually loads is `SKILL.md`; this English version is not auto-loaded.

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
   - Sequence number N = count of existing `handoffs/handoff-<project name>-*.md` files + 1 (always count real files — **never use a central counter file**: two sessions handing off concurrently would read-modify-write over each other · a duplicate N from concurrent counting is merely cosmetic)
   - `title` = `ต่อ <N>. <short focus>` (≤60 chars — the number shows which chip is newest) · `tldr` 1-2 sentences including N · `prompt` from the template (fill every `<...>` with real values — the new session cannot see this conversation):
     ```
     ต่องานจาก handoff #<N>: <focus>
     คุณคือ session จาก chip ของ handoff-guard — cwd ปัจจุบันคือ worktree ใหม่ที่ harness เพิ่งสร้าง ทำ 3 step ก่อนเริ่มงาน:
     1. ยกของ: เช็ค Test-Path ทั้งสองฝั่งก่อนเสมอ — ทำเฉพาะเมื่อ "<oldWorktree>\node_modules" มีอยู่ **และ** ".\node_modules" ยังไม่มี (ถ้าปลายทางมีอยู่ Move-Item จะย้ายไปซ้อนข้างในเงียบๆ ไม่ error!) → PowerShell: Move-Item "<oldWorktree>\node_modules" ".\node_modules" · ย้ายไม่ได้ (ถูกล็อก/ไม่มี) → ข้ามแล้ว npm install เมื่อจำเป็น — ห้าม force ห้าม kill process
     2. ฐานโค้ด: HEAD ต้องมี commit <lastCommitHash> (tip ของ <oldBranch>) — เช็ค git merge-base --is-ancestor <lastCommitHash> HEAD · ไม่มี → git merge --ff-only <oldBranch> · ff ไม่ได้ = หยุดถามผู้ใช้ อย่าเดา
     3. node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5
     จากนั้นอ่าน <handoffPath> → รัน verify ตาม Layer 4 ของ skill handoff-guard ก่อนทำงานต่อ · งานใน handoff เสร็จหรือผู้ใช้เปลี่ยนงาน → ลบ pointer <handoffPointerPath>
     ```
   - The per-worktree pointer is still written per item 3, always (the /clear path needs it · chip and pointer coexist)
   > **Do not cut the 3 steps (move node_modules / codebase check / prune) from the chip prompt** — spawn_task always creates a new worktree when the chip is pressed (no opt-out) and the real disk hog is `node_modules` → moving it from the old home = no fresh npm install · the old worktree becomes a light snapshot; keep the 5 newest · **branches are never deleted** — every point is always recoverable via `git worktree add <path> <branch>` · pin against pruning: `git worktree lock <path>` or `--keep-list name1,name2` · full rationale: `specs/2026-07-02-chip-revival-d2-design.md`
5. Tell the user clearly: "context is ~Xk — **press the chip 'ต่อ <N>. <focus>' to open the follow-up session** (the old chat stays for reference), or type `/clear` if you don't need the old chat · the handoff will load automatically → `<handoff path>`" + a 2-3 line summary of pending work

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

> If verification **doesn't match** (e.g. the handoff says "committed" but git still shows pending, or the build fails despite the handoff saying it passed) → **inform the user first; do NOT continue on top of it** — the handoff may have been written while the previous session was dying, so its state may be incomplete

## Install / verify / tune
See [SETUP.md](SETUP.md) — includes the per-model ceiling table, env tuning (`HANDOFF_GUARD_THRESHOLD` / `THRESHOLD2` / `PREDICT_TURNS` / `EMA_ALPHA`), and design principles (why observe/predict are deterministic in the hook while the decision is AI in the skill)
