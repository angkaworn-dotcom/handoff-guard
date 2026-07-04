# SKILL.md Slim + Symbolic Tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (งานนี้ไฟล์เดียวต่อ task — inline execution เหมาะกว่า subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ลดน้ำหนัก `SKILL.md` ของ handoff-guard (~20-25% tokens) + เปลี่ยนเลข threshold ที่ hardcode (184k/218k/144k/170k/256k ฯลฯ) เป็นการอ้าง `T1`/`T2`/`MAX` เชิงสัญลักษณ์ เพื่อ (1) skill โหลดเบาลงตอน context วิกฤต (2) guidance ไม่ผิดเมื่อผู้ใช้ pin MAX เอง (ตอนนี้ pin 300k → T1/T2 จริง = 216k/255k แต่ skill ยังสอนว่า tier1=184k)

**Architecture:** แก้ 2 ไฟล์ docs เท่านั้น (`SKILL.md` functional + `SKILL.en.md` mirror) — **ไม่แตะโค้ด hook/script ใดๆ** เนื้อหาใหม่ทั้งไฟล์ให้ไว้ในแผนนี้แล้ว executor แค่ Write ทับ ตรวจ แล้ว commit. หลักการ trim: ตัดเฉพาะส่วน non-instruction (ตาราง 4 ชั้นที่ซ้ำ SETUP.md, section "หลักการ" ท้ายไฟล์, ประวัติ/เกร็ดยาว) — **กฎเชิงพฤติกรรมทุกข้อ + เหตุผลสั้นกำกับกฎ (กัน Claude ฝ่าฝืน) คงไว้ครบ**

**Tech Stack:** Markdown เท่านั้น · repo: `github.com/angkaworn-dotcom/handoff-guard` · local clone: `C:/Users/George.AK/Documents/ClaudeCode/handoff-guard`

---

## ⚠️ กฎเหล็กสำหรับ executor (อ่านก่อนเริ่ม)

1. **ใช้ Write tool เขียนทับทั้งไฟล์** — ห้าม Edit ทีละจุดบนไฟล์ไทย (บทเรียนจริง: piecemeal Edit บนไฟล์ multi-byte เคยทำ UTF-8 พังเงียบ) เนื้อหาเต็มอยู่ในแผนนี้แล้ว
2. **ห้ามแตะไฟล์อื่น** — `README.md`, `README.en.md`, `SETUP.md`, `hooks/*`, `scripts/*` ไม่อยู่ในขอบเขต (เลขต่อโมเดลในนั้นเป็นตัวอย่าง auto-detect ที่ถูกต้องอยู่แล้ว)
3. **ห้ามเปลี่ยนความหมายกฎ** — งานนี้คือ slim + symbolic เท่านั้น ถ้าอยากปรับกฎไหนให้บันทึกเป็นข้อเสนอแยก อย่าแก้ในรอบนี้
4. เนื้อหาในแผนใช้ fence 4 backticks ครอบ เพราะข้างในมี ``` ซ้อน — ตอน Write ให้เอาเฉพาะเนื้อใน fence

---

### Task 1: Preflight + branch

**Files:** ไม่แก้ไฟล์ — เตรียม workspace

- [ ] **Step 1: ยืนยัน repo สด**

Run:
```bash
cd /c/Users/George.AK/Documents/ClaudeCode/handoff-guard && git checkout main && git pull && git status
```
Expected: `Already up to date.` (หรือ pull มาใหม่) + working tree clean · ถ้า dirty → หยุด ถามผู้ใช้

- [ ] **Step 2: เก็บ baseline — เลข hardcode ที่ต้องหายไป**

Run:
```bash
grep -cE "184k|218k|144k|170k|369k|435k" SKILL.md SKILL.en.md
```
Expected: ทั้งสองไฟล์มี match (SKILL.md ~4 บรรทัด, SKILL.en.md ~4 บรรทัด) — นี่คือสิ่งที่จะลบ

- [ ] **Step 3: สร้าง branch**

Run:
```bash
git checkout -b claude/skill-slim-symbolic-tiers
```
Expected: `Switched to a new branch`

---

### Task 2: เขียน SKILL.md ใหม่ (ไฟล์ functional)

**Files:**
- Modify (เขียนทับทั้งไฟล์): `C:/Users/George.AK/Documents/ClaudeCode/handoff-guard/SKILL.md`

- [ ] **Step 1: Write ทับด้วยเนื้อหานี้ทั้งไฟล์ (ตรงตัวอักษร)**

````markdown
---
name: handoff-guard
description: Context Manager (V2) — observe→predict→decide→recover. Decide whether to hand off to a fresh session when context is near (or predicted to reach) the token limit, and produce a clean handoff if so. Use when the context-guard Stop hook injects a near-limit OR predictive warning (tier=predict/tier1/tier2), when the user invokes /handoff-guard, or when context usage is high or rising fast relative to the current model's context window and you must decide whether to keep working or start a new session.
---

# Context Manager (V2)

> [English reference translation](SKILL.en.md) (this `SKILL.md` is the functional file Claude Code loads — the English copy is documentation only)

ปกป้องงานไม่ให้เสียตอน context ใกล้เต็ม — hook `context-guard.mjs` วัด token จริง + ทำนาย ETA แบบ deterministic (L1 Observe / L2 Predict) → **skill นี้คือชั้นตัดสิน (L3 Decide) + ชั้น verify ตอน resume (L4 Recover)** · สถาปัตยกรรม 4 ชั้น + หลักการออกแบบฉบับเต็ม: [SETUP.md](SETUP.md) · `docs/V2-design.md`

## เมื่อไหร่ถูกเรียก
> **T1 (เตือน) = `round(MAX×0.72)` · T2 (ด่วน) = `round(MAX×0.85)`** — MAX auto-detect ตามโมเดล หรือ pin ด้วย `/handoff-guard-max` (`0` = ปิด guard สนิท) · **ค่าจริง ณ เทิร์นนั้นมากับ additionalContext ของ hook (`tier/tokens/rate/etaTurns`) — ตัดสินจากค่าที่แนบมาเสมอ ห้ามใช้เลขจำตายตัว** เพราะ MAX ต่างกันตามโมเดล/การ pin (ตารางเพดานต่อโมเดล: SETUP.md)

- Stop hook `context-guard` ทริกอย่างใดอย่างหนึ่ง → ฉีด instruction มาให้ invoke skill นี้:
  - **predict** — คาดว่าอีก ≤ K (3) เทิร์นจะแตะ T2 (token ยังไม่ถึง T1 — buffer เยอะ)
  - **tier1** — token จริง ≥ T1 (absolute safety net)
  - **tier2** — token จริง ≥ T2 (ด่วน)
- ผู้ใช้พิมพ์ `/handoff-guard` เอง

## ขั้นตอน (ทำตามลำดับ)

### 1. ทำ atomic state ให้ปลอดภัยก่อน (สำคัญสุด — ห้ามทิ้งงานครึ่งทาง)
- แก้หลายไฟล์ยังไม่ commit + ผ่าน validation → commit ถ้าผู้ใช้อนุญาต · ไม่งั้น **note ชัดใน handoff** ว่า "ค้าง uncommitted ที่ไฟล์ X"
- migration / `db.batch` ค้างกลางทาง → ปิดให้จบ หรือ note ว่ายังไม่จบ + ผลกระทบ
- subagent/background task รันอยู่ → รอผลหรือ note สถานะ + วิธีเช็คต่อ

### 2. ประเมิน: handoff เลย vs ทำต่อได้อีกนิด
> อ่าน `tier/tokens/etaTurns` จาก additionalContext ก่อน — บอกว่าเร่งแค่ไหน (predict = buffer เยอะ · tier2 = น้อยสุด)

| สัญญาณ | ตัดสิน |
|--------|--------|
| **predict** (token < T1, คาดอีก ~etaTurns เทิร์นแตะ T2) | มี buffer — **ปิด step ปัจจุบันให้จบสวยๆ ได้** แล้วค่อย handoff · **ห้ามเริ่ม feature/refactor ใหม่** · ถ้างานเหลือยาวเกิน etaTurns → handoff หลังปิด step นี้ |
| **tier2** (token ≥ T2) | **handoff ทันที** — buffer น้อย เสี่ยง compaction กินงาน |
| **tier1** (token ≥ T1) + อยู่กลาง task ใหญ่ ยังเหลือหลาย step | ปิด step ปัจจุบันให้ปลอดภัย → **handoff** |
| **tier1** + งานใกล้จบใน 1-2 step สั้น | ทำต่อให้จบ step นั้น → **handoff ทันที** (อย่าเริ่มงานใหญ่ใหม่) |

### 3. ถ้าตัดสินว่า handoff
1. สร้าง **handoff doc** ด้วย skill `handoff` (superpowers/Matt) — **บังคับใช้ (dependency ของ guard นี้)**
   invoke skill `handoff` · ส่ง focus ของ session ถัดไปเป็น argument + บังคับให้ครอบ **atomic/uncommitted, worktree/branch/env, BLOCKED**
   **ที่เก็บ doc: `~/.claude/.handoff-guard/handoffs/` (สร้างโฟลเดอร์ถ้ายังไม่มี) — override default ของ skill `handoff` ที่เซฟลง OS temp** (Temp โดน Disk Cleanup/Storage Sense กวาดได้ → doc หายทั้งที่ pointer ยังชี้)
   > **ถ้า `handoff` ยังไม่ติดตั้ง** — อย่าปล่อยงานหาย ทำ 3 อย่าง:
   > 1. เขียน `HANDOFF.md` สั้นๆ **ตอนนี้** (ค้างทันที / worktree-branch-env / งานถัดไป+BLOCKED / gotchas · redact secret)
   > 2. **ติดตั้ง handoff ให้รอบหน้าอัตโนมัติ:** `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs`
   > 3. บอกผู้ใช้: ติดตั้ง `handoff` แล้ว — **restart session** เพื่อให้โหลด (skill โหลดตอนเปิด session ใช้ทันทีไม่ได้)
2. อัปเดต state file ของ repo (เช่น `task.md`) ให้สดล่าสุด
3. เขียน pointer **per-worktree** ด้วย **Write tool เท่านั้น**: `~/.claude/.handoff-guard/pointers/<slug ของ cwd เต็ม>.json` เนื้อหา `{"cwd":"<path cwd ปัจจุบันเต็ม>","handoff":"<path handoff doc เต็ม>"}`
   - **slug = path cwd เต็ม → lowercase → แทนอักขระที่ไม่ใช่ a-z, 0-9, อักษรไทย ด้วย `-`** — key ด้วย **path เต็ม** ไม่ใช่ชื่อโฟลเดอร์ กัน main/แต่ละ worktree/โปรเจกต์ชื่อซ้ำเขียนทับกันแล้ว /clear เด้ง handoff ผิดตัว · ชื่อไฟล์ไม่มีผลกับ matching — hook อ่าน field `cwd` ข้างใน
   - **ห้ามเขียน pointer ผ่าน PowerShell (`Set-Content`/`Out-File`) หรือ bash `echo`** — BOM/UTF-16/path ไทยเพี้ยน ทำให้ hook parse ไม่ผ่านแบบเงียบ (Write tool = UTF-8 ไม่มี BOM)
   - hook match: **exact cwd ก่อน** แล้ว fallback prefix (main↔worktree ใต้ `.claude/worktrees/` ถือเป็นโปรเจกต์เดียวกัน) · **ห้ามเขียน `last-handoff.txt` แบบเก่า** (slot เดียว = ข้ามโปรเจกต์ปน) · pointer หมดอายุเอง 7 วัน
4. **สร้าง chip ให้กดต่อคลิกเดียว (`mcp__ccd_session__spawn_task`)** — เฉพาะเมื่อ session มี tool นี้ (แอป Claude Code desktop) · **ไม่มี tool นี้ → ข้าม step นี้ทั้งข้อ** เส้น /clear + pointer (ข้อ 3) ครบเทียบเท่าอยู่แล้ว
   - เลขลำดับ N = จำนวนไฟล์ `handoffs/handoff-<ชื่อโปรเจกต์>-*.md` ที่มีอยู่ + 1 (นับจากไฟล์จริงเสมอ — **ห้ามใช้ไฟล์ counter กลาง**: สอง session handoff พร้อมกันจะ read-modify-write ทับกัน · เลขซ้ำจากการนับพร้อมกันเป็นแค่ cosmetic ไม่พังอะไร)
   - `title` = `ต่อ <N>. <focus สั้น>` (≤60 ตัว — เลขทำให้รู้ว่า chip ไหนล่าสุด) · `tldr` 1-2 ประโยคมีเลข N · `prompt` ตาม template (เติมค่าจริงทุก `<...>` — session ใหม่ไม่เห็นบทสนทนานี้):
     ```
     ต่องานจาก handoff #<N>: <focus>
     คุณคือ session จาก chip ของ handoff-guard — cwd ปัจจุบันคือ worktree ใหม่ที่ harness เพิ่งสร้าง ทำ 3 step ก่อนเริ่มงาน:
     1. ยกของ: เช็ค Test-Path ทั้งสองฝั่งก่อนเสมอ — ทำเฉพาะเมื่อ "<oldWorktree>\node_modules" มีอยู่ **และ** ".\node_modules" ยังไม่มี (ถ้าปลายทางมีอยู่ Move-Item จะย้ายไปซ้อนข้างในเงียบๆ ไม่ error!) → PowerShell: Move-Item "<oldWorktree>\node_modules" ".\node_modules" · ย้ายไม่ได้ (ถูกล็อก/ไม่มี) → ข้ามแล้ว npm install เมื่อจำเป็น — ห้าม force ห้าม kill process
     2. ฐานโค้ด: HEAD ต้องมี commit <lastCommitHash> (tip ของ <oldBranch>) — เช็ค git merge-base --is-ancestor <lastCommitHash> HEAD · ไม่มี → git merge --ff-only <oldBranch> · ff ไม่ได้ = หยุดถามผู้ใช้ อย่าเดา
     3. node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5
     จากนั้นอ่าน <handoffPath> → รัน verify ตาม Layer 4 ของ skill handoff-guard ก่อนทำงานต่อ · งานใน handoff เสร็จหรือผู้ใช้เปลี่ยนงาน → ลบ pointer <handoffPointerPath>
     ```
   - pointer per-worktree ยังเขียนตามข้อ 3 เสมอ (เส้น /clear ต้องใช้ · chip กับ pointer อยู่ร่วมกัน)
   > **อย่าตัด 3 step (ยกของ/ฐานโค้ด/prune) ออกจาก chip prompt** — spawn_task สร้าง worktree ใหม่เสมอตอนกด chip (ไม่มี option ปิด) และตัวกินดิสก์จริงคือ `node_modules` → ยกของจากบ้านเก่า = ไม่ต้อง npm install ใหม่ · worktree เก่ากลายเป็น snapshot เบา เก็บ 5 อันล่าสุด · **branch ไม่ลบเด็ดขาด** — ทุกจุดย้อนกู้ได้เสมอด้วย `git worktree add <path> <branch>` · กัน prune ถาวร: `git worktree lock <path>` หรือ `--keep-list ชื่อ1,ชื่อ2` · เหตุผลเต็ม: `specs/2026-07-02-chip-revival-d2-design.md`
5. บอกผู้ใช้ชัดเจน: "context ~Xk แล้ว — **กด chip 'ต่อ <N>. <focus>' เพื่อเปิด session ต่อ** (แชทเก่าค้างไว้ย้อนดูได้) หรือพิมพ์ `/clear` ถ้าไม่ต้องการเก็บแชทเก่า · handoff จะโหลดเอง → `<handoff path>`" + สรุปงานค้าง 2-3 บรรทัด

### 4. ถ้าตัดสินว่าทำต่อ
- ทำเฉพาะ step ที่ค้างให้จบ แล้ววนกลับมา handoff (marker กันเตือนซ้ำจนกว่าจะถึง tier ถัดไป)
- **ห้ามเริ่ม feature/refactor ใหม่**

## Layer 4: Recovery (เมื่อ session ใหม่ resume งานต่อ)
SessionStart hook ฉีด pointer ให้อ่าน handoff doc · โชว์สรุป (title/สถานะ/งานถัดไป) ผ่าน `systemMessage` (render เฉพาะ terminal CLI ณ 2026-07 — ดู issue #15344; ในแอป ผู้ใช้ต้องพิมพ์ข้อความแรกก่อน Claude ถึงเริ่มอ่าน) — **อ่านแล้วอย่าเพิ่งลุยต่อทันที รัน verify ก่อน continue:**
0. **(เฉพาะ session จาก chip)** ทำ 3 step ใน chip prompt ให้ครบก่อน (ยกของ / ฐานโค้ด / prune) — เปิดด้วย /clear ข้ามข้อนี้
1. **`git status`** — ไฟล์ uncommitted ตรงกับที่ handoff ระบุไหม (ที่ note ว่า "ค้าง" มีจริงไหม / ที่บอกว่า commit แล้วค้างจริงหรือเปล่า)
2. **branch / worktree** — อยู่ตัวเดียวกับที่ handoff บอกไหม (`git branch --show-current`, path)
3. **validation gate ของโปรเจกต์** — state ไม่พังจาก session ก่อน (ใช้ตัวที่โปรเจกต์นั้นมี เช่น `npm run check` / `npm test` / lint · ไม่มี gate → ข้ามข้อนี้)
4. **งานค้างใน handoff ตรงกับโค้ดจริงไหม** — เปิดไฟล์ที่ handoff อ้างดูว่าอยู่สถานะที่ระบุ → ค่อย continue
5. **ปิดวงจร: งานใน handoff เสร็จแล้ว (หรือผู้ใช้เปลี่ยนไปงานอื่น) → ลบไฟล์ pointer ทิ้ง** (path อยู่ในข้อความ inject ของ hook) — pointer ที่ไม่ลบ = เด้งงานเก่าซ้ำทุก `/clear` จนหมดอายุ 7 วัน · doc ใน `handoffs/` เก็บไว้ตามเดิมไม่ต้องลบ

> ถ้า verify **ไม่ตรง** (เช่น handoff บอก "commit แล้ว" แต่ git ยังค้าง, หรือ build พังทั้งที่ handoff บอกผ่าน) → **แจ้งผู้ใช้ก่อน อย่า continue ทับ** — handoff อาจถูกเขียนตอน session ก่อนกำลังจะตาย state เลยไม่ครบ

## ติดตั้ง / verify / จูน
ดู [SETUP.md](SETUP.md) — รวมตารางเพดานต่อโมเดล, การจูน env (`HANDOFF_GUARD_THRESHOLD` / `THRESHOLD2` / `PREDICT_TURNS` / `EMA_ALPHA`), และหลักการออกแบบ (ทำไม observe/predict เป็น deterministic ใน hook, การตัดสินเป็น AI ใน skill)
````

- [ ] **Step 2: Verify — เลข hardcode หมดไฟล์ + ของ functional ยังครบ**

Run:
```bash
cd /c/Users/George.AK/Documents/ClaudeCode/handoff-guard
grep -nE "184k|218k|144k|170k|369k|435k|256k|512k" SKILL.md; echo "GREP_EXIT:$? (ต้องเป็น 1 = ไม่เจอ)"
grep -c "prune-worktrees.mjs" SKILL.md   # template chip ยังอยู่ → expect ≥1
grep -c "name: handoff-guard" SKILL.md   # frontmatter intact → expect 1
grep -c "อย่า continue ทับ" SKILL.md      # L4 mismatch warning ยังอยู่ → expect 1
wc -l SKILL.md                            # expect ~85 (จากเดิม 100)
```
Expected: grep เลข = ไม่เจอ (exit 1) · สามตัวหลังเจอครบ · บรรทัด ≤ 90

- [ ] **Step 3: Commit**

```bash
git add SKILL.md
git commit -m "refactor: slim SKILL.md — อ้าง T1/T2/MAX เชิงสัญลักษณ์แทนเลข hardcode + ตัดส่วน non-instruction (ตาราง 4 ชั้น/หลักการ ชี้ไป SETUP.md แทน)"
```

---

### Task 3: เขียน SKILL.en.md ใหม่ (mirror)

**Files:**
- Modify (เขียนทับทั้งไฟล์): `C:/Users/George.AK/Documents/ClaudeCode/handoff-guard/SKILL.en.md`

- [ ] **Step 1: Write ทับด้วยเนื้อหานี้ทั้งไฟล์ (ตรงตัวอักษร)**

````markdown
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
1. Create the **handoff doc** with the `handoff` skill (superpowers/Matt) — **required (a dependency of this guard)**
   Invoke skill `handoff` · pass the next session's focus as the argument + require it to cover **atomic/uncommitted, worktree/branch/env, BLOCKED**
   **Doc location: `~/.claude/.handoff-guard/handoffs/` (create the folder if missing) — override the `handoff` skill's default of saving to OS temp** (Temp can be swept by Disk Cleanup/Storage Sense → the doc disappears while the pointer still points at it)
   > **If `handoff` is not installed** — don't let the work be lost; do 3 things:
   > 1. Write a short `HANDOFF.md` **right now** (what's pending / worktree-branch-env / next steps + BLOCKED / gotchas · redact secrets)
   > 2. **Install handoff for next time automatically:** `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs`
   > 3. Tell the user: `handoff` is installed — **restart the session** to load it (skills load at session start; it can't be used immediately)
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
````

- [ ] **Step 2: Verify (เกณฑ์เดียวกับ Task 2)**

Run:
```bash
grep -nE "184k|218k|144k|170k|369k|435k|256k|512k" SKILL.en.md; echo "GREP_EXIT:$? (ต้องเป็น 1)"
grep -c "prune-worktrees.mjs" SKILL.en.md   # expect ≥1
grep -c "do NOT continue on top" SKILL.en.md # expect 1
```
Expected: เลข = ไม่เจอ · สองตัวหลังเจอ

- [ ] **Step 3: โครงสร้างสองไฟล์ต้องตรงกัน**

Run:
```bash
diff <(grep -E "^#{1,3} " SKILL.md | wc -l) <(grep -E "^#{1,3} " SKILL.en.md | wc -l) && echo "HEADINGS MATCH"
```
Expected: `HEADINGS MATCH` (จำนวน heading เท่ากัน — TH มี frontmatter เพิ่มแต่ไม่ใช่ heading)

- [ ] **Step 4: Commit**

```bash
git add SKILL.en.md
git commit -m "docs: mirror EN translation of slimmed SKILL.md"
```

---

### Task 4: Reinstall + selftest + push + PR

**Files:** ไม่แก้ — deploy และตรวจ

- [ ] **Step 1: commit แผนนี้เข้า branch ด้วย (convention repo เก็บ plans/)**

```bash
git add plans/2026-07-04-skill-slim-symbolic-tiers.md
git commit -m "docs: add plan for skill slim + symbolic tiers"
```

- [ ] **Step 2: ติดตั้งทับ installed copy จาก working tree**

Run:
```bash
node scripts/install.mjs
diff SKILL.md /c/Users/George.AK/.claude/skills/handoff-guard/SKILL.md && echo "INSTALLED COPY UPDATED"
```
Expected: installer จบด้วย 🎉 + `INSTALLED COPY UPDATED`

- [ ] **Step 3: selftest ต้องยังผ่านครบ (โค้ด hook ไม่ถูกแตะ — นี่คือ sanity check)**

Run:
```bash
node /c/Users/George.AK/.claude/skills/handoff-guard/scripts/selftest.mjs | tail -2
```
Expected: `ALL PASS ✅ — 47 pass, 0 fail`

- [ ] **Step 4: Push + เปิด PR**

```bash
git push -u origin claude/skill-slim-symbolic-tiers
gh pr create --repo angkaworn-dotcom/handoff-guard --base main --head claude/skill-slim-symbolic-tiers --title "refactor: slim SKILL.md + symbolic T1/T2 refs" --body "- แทนเลข threshold hardcode (184k/218k/144k/170k/256k/512k) ด้วยการอ้าง T1/T2/MAX เชิงสัญลักษณ์ — guidance ไม่ผิดเมื่อ pin MAX เอง (เคสจริง: pin 300000 → T1/T2 = 216k/255k แต่ skill เดิมสอน 184k)
- trim ส่วน non-instruction (~20-25% tokens): ตาราง 4 ชั้น + section หลักการ → ชี้ไป SETUP.md · rationale ยาว → ชี้ไป specs doc · กฎเชิงพฤติกรรม + เหตุผลสั้นกำกับกฎคงครบทุกข้อ
- EN mirror sync
- ไม่แตะโค้ด hook/script — selftest 47/47 PASS

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: ได้ URL ของ PR

- [ ] **Step 5: รายงานผู้ใช้**

แจ้ง: PR URL · สรุปว่าเปลี่ยนอะไร · **เตือน 2 ข้อ:** (1) installed copy อัปเดตแล้วจาก working tree — SKILL.md ใหม่จะโหลดตอนเปิด session ถัดไป (2) **อย่ารัน `/handoff-guard-update` ก่อน merge PR** — update ดึงจาก main บน GitHub จะ revert installed copy กลับเป็นเวอร์ชันเก่า → merge PR ก่อนแล้วค่อย update ได้

---

## Self-Review Checklist (executor ตรวจก่อนปิดงาน)

- [ ] SKILL.md: ไม่มีเลข 184k/218k/144k/170k/369k/435k/256k/512k เหลือ
- [ ] SKILL.md: frontmatter `name: handoff-guard` + description ยังมี trigger phrases ("context-guard Stop hook", "/handoff-guard", "token limit")
- [ ] chip prompt template อยู่ครบ 6 บรรทัด ตรงตัวอักษรกับของเดิม (functional — ห้าม paraphrase)
- [ ] L4 checklist 0-5 + คำเตือน "อย่า continue ทับ" ยังครบ
- [ ] EN mirror โครงสร้าง heading ตรงกับ TH
- [ ] selftest 47/47 · installed copy = repo copy
- [ ] ทั้ง 3 commit (SKILL.md / SKILL.en.md / plan) push ขึ้น branch + PR เปิดแล้ว
