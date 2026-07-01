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
- The `context-guard` Stop hook fires one of the following → injects an instruction to invoke this skill (additionalContext attaches `tier/tokens/rate/etaTurns`):
  - **predict** — predicted to hit 218k within ≤ K (3) turns (tokens haven't reached 184k yet — plenty of buffer)
  - **tier1** — real tokens ≥ 184k (absolute safety net)
  - **tier2** — real tokens ≥ 218k (urgent)
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
   > **If `handoff` isn't installed yet** — don't let work get lost, do 3 things:
   > 1. Write a short `HANDOFF.md` **right now** (what's uncommitted / worktree-branch-env / next task+BLOCKED / gotchas · redact secrets)
   > 2. **Install handoff automatically for next time:** `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs` (fetches from github.com/mattpocock/skills → falls back to the vendored copy if offline)
   > 3. Tell the user: `handoff` has been installed — **restart the session** for it to load (skills load at session start, not usable immediately)
2. Update the repo's state file (e.g. `task.md`) to be fully current
3. Write the handoff's path to `~/.claude/.handoff-guard/last-handoff.txt` (so the new session's SessionStart hook can find it)
4. **Give the user a chip to spawn a new session** (convenient, no need to open one manually) — call `mcp__ccd_session__spawn_task`:
   - `title`: short and imperative, e.g. "Continue &lt;topic&gt; (handoff)"
   - `prompt`: self-contained — instruct the new session to read the handoff doc at that path first + summarize the next task/pending files (the new session can't see this conversation)
   - `tldr`: 1-2 sentences on what happens next
   → one click opens a new session pre-loaded with the continuation
5. Tell the user clearly: "context is ~Xk now — click the chip to open a new session (or open one yourself pointing at <handoff path>)" + a 2-3 line summary of what's pending

### 4. If the decision is to keep going
- Only finish the step that's currently pending, then loop back to the handoff decision (a marker prevents repeat warnings until the next tier is reached)
- **Do not start a new feature/refactor**

## Layer 4: Recovery (when a new session resumes the work)
The SessionStart hook injects a pointer to read the handoff doc — **read it, but don't dive straight in — run verify first:**
1. **`git status`** — do the uncommitted files match what the handoff says (do the files noted as "pending" actually exist / is what it claims was committed actually committed)
2. **branch / worktree** — is this the same one the handoff says (`git branch --show-current`, path)
3. **`npm run check`** — state isn't broken from the prior session (the leave-web project uses this as its validation gate)
4. **Does the pending work in the handoff match the actual code?** — open the files the handoff references to check they're in the state it claims → then continue

> If verify **doesn't match** (e.g. the handoff says "committed" but git still shows it pending, or the build is broken even though the handoff said it passed) → **tell the user before continuing** — the handoff might have been written as the prior session was dying, so its state may be incomplete

## Rationale (why this is more accurate than soft rules)
- **observe + predict = deterministic** — the Stop hook reads real tokens from transcript usage every turn + computes EWMA growth → ETA as pure math (`~/.claude/hooks/context-guard.mjs`), not relying on the model to "remember on its own"
- **predict before it's critical** — fires as soon as it's predicted to be full within ≤ K turns (before hitting 184k) → there's buffer to close out the step properly · the absolute tier (184k/218k) is still a fail-safe in case predict misses
- **the decision = AI** — this skill is more flexible than a hard cutoff (won't cut off in the middle of an atomic op)
- **recovery = automatic + verified** — the SessionStart hook (`session-resume.mjs`) injects the handoff pointer for the new session → the skill runs a verify checklist (L4) before continuing
- Tune via env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` / `HANDOFF_GUARD_PREDICT_TURNS` (K) / `HANDOFF_GUARD_EMA_ALPHA`

## Install / verify / tune
See [SETUP.md](SETUP.md) / [SETUP.en.md](SETUP.en.md)
