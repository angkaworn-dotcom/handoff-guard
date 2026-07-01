# Context Manager (V2) — Design Spec

> [ภาษาไทย](V2-design.md)

> Upgrades `handoff-guard` from **reactive** (wait until 184k, then act) to **predictive** (predict that it'll hit the danger zone in ~N turns → prepare the handoff starting now), while keeping the entire original mechanism as a **safety net**
>
> The slug is still `handoff-guard` (do not touch `/handoff-guard`, the hook injection text, settings.json, or the marker dir) — only the title + description are retitled to "Context Manager (V2)"

## 1. Philosophy / Goal

The original system decided based only on the **current token level** → if a single turn blows through multiple tiers, the warning arrives late/cuts off work mid-way.
V2 adds a **time dimension**: track the context growth rate across turns → predict "how many turns until it's full" → warn ahead of time, while context still isn't critical, so the current step can be closed out cleanly before the handoff.

**Success criteria:**
- The hook computes EWMA growth + ETA deterministically, resilient to spikes (reading a large file at once) without false positives
- Fires a "predict" trigger when it's predicted to reach T2 within ≤ K turns — **before** tokens reach T1
- The original absolute tiers (T1/T2) still work fully as a fail-safe (in case predict misses)
- A new session on resume runs the verify checklist before continuing
- `node selftest.mjs` covers all the new logic and passes

## 2. 4-layer architecture (mapped to real files)

| Layer | Responsibility | Location | Mechanism |
|---|---|---|---|
| **L1 Observe** | Read real tokens from the latest `message.usage` + compute delta/turn | `hooks/context-guard.mjs` | deterministic |
| **L2 Predict** | EWMA of growth → ETA "how many turns until T2" | `hooks/context-guard.mjs` | deterministic (math) |
| **L3 Decision** | Finish step vs. hand off (aware of whether predictive/absolute trigger fired) | `skills/handoff-guard/SKILL.md` | AI |
| **L4 Recovery** | resume → **verify** → continue | `hooks/session-resume.mjs` (pointer) + `SKILL.md` (verify checklist) | AI |

## 3. L1+L2 — Changes in `context-guard.mjs`

### 3.1 New state file (per session)
`~/.claude/.handoff-guard/<session>.state.json`
```jsonc
{
  "lastTokens": 216340,  // tokens from the previous round (used to compute delta)
  "ema": 8200,           // EWMA of the growth rate (tokens/turn)
  "turns": 18            // number of times the hook has fired in this session (used to check whether ema has settled)
}
```
> The original `.t1/.t2` markers still exist (to prevent repeat fires) — state.json is a new, separate file that doesn't overwrite the old ones

### 3.2 Update the EWMA on every Stop hook
```
const ALPHA = 0.4;        // weight given to the latest delta: 40%
const FLOOR = 500;        // minimum rate allowed as a divisor (prevents ETA from exploding to Infinity)

If there's no state.json (the session's first fire):
    → create { lastTokens: tokens, ema: 0, turns: 1 }  // baseline only, no delta yet
    → done (don't fire predict — turns < 2)

If state already exists:
    delta = tokens - state.lastTokens
    if (delta < 0)            → compaction/reset → don't count the negative delta, keep the existing ema
    else if (state.ema === 0) → ema = delta                          // the first real delta
    else                      → ema = ALPHA*delta + (1-ALPHA)*ema     // EWMA

    state.lastTokens = tokens
    state.turns += 1
    write state.json back
```
> Result: fire#1 = baseline (turns 1, ema 0) · fire#2 = the first real delta (turns 2, ema settled) → predict can first be considered as early as fire#2 (consistent with the `turns ≥ 2` condition in 3.4)

### 3.3 Compute ETA
```
rate = max(ema, FLOOR)
turnsToT2 = Math.ceil((T2 - tokens) / rate)   // how many turns until T2 is reached
```

### 3.4 Trigger — priority high→low (fires the first condition that matches)
```
1. tokens ≥ T2 (218k) & !marker.t2   → fire "tier2"   (urgent — original)
2. tokens ≥ T1 (184k) & !marker.t1   → fire "tier1"   (original)
3. turnsToT2 ≤ K (3) & state.turns ≥ 2 & tokens < T1 & !marker.p
                                     → fire "predict"  (new)
```
- `K = 3` (env `HANDOFF_GUARD_PREDICT_TURNS`) — a moderate lead time
- The `state.turns ≥ 2` condition = requires at least 2 observations before trusting the ema (prevents cold-start false fires)
- The `tokens < T1` condition = once past T1, let the absolute tier handle it instead (avoid double-firing)
- The new `.p` marker prevents predict from firing repeatedly within a session

### 3.5 additionalContext sent to the skill (every tier)
Sends the actual numbers for the AI to decide with — including new fields:
```
tier: 'predict' | 'tier1' | 'tier2'
tokens: <current>
rate: <ema, tokens/turn>
etaTurns: <turnsToT2>
```
Example predict message:
> 🟡 Forecast: context ~183k, growing ~11.6k/turn on average → will reach 218k in ~3 turns. Close out the current step, then invoke skill "handoff-guard" to prepare a handoff. Don't start anything new.

## 4. L3 — Changes in `SKILL.md` (decision table)

Adds a row to the "evaluate: hand off now vs. keep going" table:

| Signal | Decision |
|---|---|
| **predict tier (tokens haven't reached 184k yet, plenty of buffer)** | **It's fine to close out the current step properly** before handing off · don't start a new feature/refactor |
| tier1 (≥184k) ... | (unchanged) |
| tier2 (≥218k) ... | (unchanged) |

Added principle: predict = more buffer than the absolute tiers → decide without urgency, but still don't start anything big · read `tier/etaTurns` from additionalContext to gauge urgency

## 5. L4 — Recovery verify checklist (new section in `SKILL.md`)

Adds a "### Layer 4: Recovery (when a new session resumes)" section:
The new session reads the handoff doc, then **runs verify before continuing:**
1. `git status` — do the uncommitted items match what the handoff says (do the files noted as "pending" actually exist)
2. Correct branch/worktree (compare against the handoff)
3. Does `npm run check` pass — state isn't broken from the previous session
4. Does the pending work in the handoff match reality in the code → then continue
If verify doesn't match (e.g. the handoff says it was committed but git still shows it pending) → tell the user before continuing

> `session-resume.mjs` stays unchanged (still just injects a pointer) — verify is the AI's job, done within the skill

## 6. Tunables (env)

| env | default | meaning |
|---|---|---|
| `HANDOFF_GUARD_THRESHOLD` | 184320 | T1 (absolute tier1) = 72% of the 256k ceiling |
| `HANDOFF_GUARD_THRESHOLD2` | 217600 | T2 (absolute tier2 + the ETA target) = 85% of the 256k ceiling |
| `HANDOFF_GUARD_MAX` | 256000 | context ceiling (display only) — beyond this, context quality starts degrading |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | K — lead time (turns) for the predict trigger |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | EWMA weight |

> **256k ceiling** — T1/T2 are set at 72%/85% of the ceiling (previously based on 200k = 144k/170k) · if the ceiling changes in the future, compute T1=ceil(MAX×0.72), T2=ceil(MAX×0.85)

## 7. Affected files

| File | Change |
|---|---|
| `hooks/context-guard.mjs` | + state.json read/write, EWMA, ETA, predict trigger, `.p` marker, additionalContext fields |
| `skills/handoff-guard/SKILL.md` | retitle "Context Manager (V2)", + decision row (predict), + L4 verify section, + explanation of the 4 layers |
| `skills/handoff-guard/SETUP.md` | + new env vars (K, alpha), + explanation of state.json, + predict tier in verify |
| `skills/handoff-guard/scripts/selftest.mjs` | + cases: EWMA growth, predict fires at ETA≤K, compaction (negative delta) doesn't break, cold-start (turns<2) doesn't fire |
| `session-resume.mjs` | **untouched** |
| `settings.json` | **untouched** |

## 8. Test plan

`node selftest.mjs` adds these cases (deterministic, no need to wait for a session to grow):
1. Steady growth of ~11.6k/turn → predict fires at ETA ≤ 3 (≈183k), before reaching T1=184320
2. cold-start (turns=1) → predict doesn't fire (ema hasn't settled yet)
3. A single-turn spike of +40k, then it settles back down → the EWMA doesn't cause the ETA to jump into a false fire
4. Compaction (tokens drop from 180k → 90k) → the negative delta isn't counted, no crash, baseline resets
5. Original absolute tiers: 183k doesn't fire / 185k fires tier1 / 218k fires tier2 (regression — must still pass)
6. Marker prevents repeat fires: once predict fires, the same session stays silent afterward
