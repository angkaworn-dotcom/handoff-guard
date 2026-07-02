---
name: handoff-guard
description: Context Manager (V2) — observe→predict→decide→recover. Decide whether to hand off to a fresh session when context is near (or predicted to reach) the token limit, and produce a clean handoff if so. Use when the context-guard Stop hook injects a near-limit OR predictive warning, when the user invokes /handoff-guard, or when context usage is high/rising fast (~184k+/256k, or predicted to hit the limit within a few turns) and you must decide whether to keep working or start a new session.
---

# Context Manager (V2)

> [English reference translation](SKILL.en.md) (this `SKILL.md` is the functional file Claude Code loads — the English copy is documentation only)

ปกป้องงานไม่ให้เสียตอน context ใกล้เต็ม — **ทำนายล่วงหน้า**ว่าอีกกี่เทิร์นจะเต็ม → ประเมินด้วยวิจารณญาณว่า "ควรขึ้น session ใหม่ไหม" แล้วทำ handoff ให้สะอาดถ้าควร

> เดิมชื่อ **Handoff Guard** (reactive — รอถึง 184k ค่อยทำ) · V2 เพิ่มมิติเวลา (predictive) แต่ slug ยังเป็น `handoff-guard` (invoke ด้วยชื่อนี้)

## 4 ชั้น (Observe → Predict → Decide → Recover)
| Layer | หน้าที่ | อยู่ที่ |
|---|---|---|
| **L1 Observe** | อ่าน token จริง + delta/เทิร์น | `hooks/context-guard.mjs` (deterministic) |
| **L2 Predict** | EWMA growth → ETA "อีกกี่เทิร์นถึง 218k" | `hooks/context-guard.mjs` (deterministic) |
| **L3 Decide** | finish step vs handoff (ดู tier ที่ทริก) | **skill นี้** (AI) |
| **L4 Recover** | resume → verify → continue | `session-resume.mjs` + skill นี้ (verify checklist) |

## เมื่อไหร่ถูกเรียก
> T1/T2 = `round(MAX×0.72)` / `round(MAX×0.85)` · MAX **auto-detect ตามโมเดล** (fable/mythos 512k → T1≈369k/T2≈435k · opus 256k → T1≈184k/T2≈218k · sonnet/haiku 200k → T1=144k/T2=170k · `[1m]` 1M) หรือ pin เองด้วย `/handoff-guard-max` (`0` = ปิด guard สนิท)

- Stop hook `context-guard` ทริกอย่างใดอย่างหนึ่ง → ฉีด instruction มาให้ invoke skill นี้ (additionalContext แนบ `tier/tokens/rate/etaTurns`):
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
> อ่าน `tier/etaTurns` จาก additionalContext ก่อน — บอกว่าเร่งแค่ไหน (predict = buffer เยอะ · tier2 = น้อยสุด)

| สัญญาณ | ตัดสิน |
|--------|--------|
| **predict** (token < 184k, คาดอีก ~etaTurns เทิร์นจะเต็ม) | มี buffer — **ปิด step ปัจจุบันให้จบสวยๆ ได้** แล้วค่อย handoff · **ห้ามเริ่ม feature/refactor ใหม่** · ถ้างานเหลือยาวเกิน etaTurns → handoff หลังปิด step นี้ |
| tier2 (≥218k) | **handoff ทันที** — buffer น้อย เสี่ยง compaction กินงาน |
| tier1 (≥184k) + อยู่กลาง task ใหญ่ ยังเหลือหลาย step | ปิด step ปัจจุบันให้ปลอดภัย → **handoff** |
| tier1 + งานใกล้จบใน 1-2 step สั้น | ทำต่อให้จบ step นั้น → **handoff ทันที** (อย่าเริ่มงานใหญ่ใหม่) |

### 3. ถ้าตัดสินว่า handoff
1. สร้าง **handoff doc** ด้วย skill `handoff` (superpowers/Matt) — **บังคับใช้ (dependency ของ guard นี้)**
   invoke skill `handoff` · ส่ง focus ของ session ถัดไปเป็น argument + บังคับให้ครอบ **atomic/uncommitted, worktree/branch/env, BLOCKED**
   **ที่เก็บ doc: `~/.claude/.handoff-guard/handoffs/` (สร้างโฟลเดอร์ถ้ายังไม่มี) — override default ของ skill `handoff` ที่เซฟลง OS temp** (Temp โดน Disk Cleanup/Storage Sense กวาดได้ → doc หายทั้งที่ pointer ยังชี้)
   > **ถ้า `handoff` ยังไม่ติดตั้ง** — อย่าปล่อยงานหาย ทำ 3 อย่าง:
   > 1. เขียน `HANDOFF.md` สั้นๆ **ตอนนี้** (ค้างทันที / worktree-branch-env / งานถัดไป+BLOCKED / gotchas · redact secret)
   > 2. **ติดตั้ง handoff ให้รอบหน้าอัตโนมัติ:** `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs` (ดึงจาก github.com/mattpocock/skills → fallback vendored ถ้า offline)
   > 3. บอกผู้ใช้: ติดตั้ง `handoff` แล้ว — **restart session** เพื่อให้โหลด (skill โหลดตอนเปิด session ใช้ทันทีไม่ได้)
2. อัปเดต state file ของ repo (เช่น `task.md`) ให้สดล่าสุด
3. เขียน pointer **per-worktree** ด้วย **Write tool เท่านั้น**: `~/.claude/.handoff-guard/pointers/<slug ของ cwd เต็ม>.json` เนื้อหา `{"cwd":"<path cwd ปัจจุบันเต็ม>","handoff":"<path handoff doc เต็ม>"}`
   - **slug = path cwd เต็ม → lowercase → แทนอักขระที่ไม่ใช่ a-z, 0-9, อักษรไทย ด้วย `-`** (เช่น `c--users-dell-documents-ระบบ-ลง-วันลา-leave-web-svelte.json`) — key ด้วย **path เต็ม** ไม่ใช่ชื่อโฟลเดอร์: main/แต่ละ worktree/โปรเจกต์ชื่อซ้ำกันคนละที่ ต่างได้ไฟล์ของตัวเอง ไม่เขียนทับกัน (เคยทับกันจริงตอน key ด้วยชื่อโปรเจกต์ — /clear เด้ง handoff ผิดตัว) · ชื่อไฟล์ไม่มีผลกับ matching — hook อ่าน field `cwd` ข้างใน
   - **ห้ามเขียน pointer ผ่าน PowerShell (`Set-Content`/`Out-File`) หรือ bash `echo`** — BOM/UTF-16/path ไทยเพี้ยน ทำให้ hook parse ไม่ผ่านแบบเงียบแล้วไป fallback หยิบ handoff ตัวอื่น (Write tool = UTF-8 ไม่มี BOM · hook strip BOM กันไว้อีกชั้นแล้วแต่อย่าพึ่ง)
   - hook match: **exact cwd ก่อน** แล้ว fallback prefix (main↔worktree ใต้ `.claude/worktrees/` ถือเป็นโปรเจกต์เดียวกัน) · **ห้ามเขียน `last-handoff.txt` แบบเก่า** (slot เดียว = ข้ามโปรเจกต์ปน) · pointer หมดอายุเอง 7 วัน
4. **สร้าง chip ให้กดต่อคลิกเดียว (`mcp__ccd_session__spawn_task`)** — /clear เป็นทางเลือกสำรอง
   - เลขลำดับ N: อ่าน `~/.claude/.handoff-guard/counters.json` (`{"<slug ของ path main repo root — กติกาเดียวกับ pointer>": N}`) → ใช้ค่าเดิม+1 · ไฟล์/คีย์ไม่มี → N = จำนวนไฟล์ `handoffs/handoff-<ชื่อโปรเจกต์>-*.md` + 1 · เขียนกลับด้วย **Write tool เท่านั้น**
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
   > **ทำไมต้องยกของ+prune (อย่าตัด 3 step ออกจาก prompt):** spawn_task สร้าง worktree ใหม่เสมอตอนกด chip (ไม่มี option ปิด) และตัวกินดิสก์จริงคือ node_modules ~206MB/อัน (เคยกอง 60 อัน ≈10GB) → ยกของจากบ้านเก่า = ไม่ต้อง npm install ใหม่ · worktree เก่ากลายเป็น snapshot เบาไว้ย้อนกลับ เก็บ 5 อันล่าสุด · **branch ไม่ลบเด็ดขาด** = จุดย้อนทุกจุดกู้ได้เสมอด้วย `git worktree add <path> <branch>` · รายละเอียด: `specs/2026-07-02-chip-revival-d2-design.md`
5. บอกผู้ใช้ชัดเจน: "context ~Xk แล้ว — **กด chip 'ต่อ <N>. <focus>' เพื่อเปิด session ต่อ** (แชทเก่าค้างไว้ย้อนดูได้) หรือพิมพ์ `/clear` ถ้าไม่ต้องการเก็บแชทเก่า · handoff จะโหลดเอง → `<handoff path>`" + สรุปงานค้าง 2-3 บรรทัด

### 4. ถ้าตัดสินว่าทำต่อ
- ทำเฉพาะ step ที่ค้างให้จบ แล้ววนกลับมา handoff (marker กันเตือนซ้ำจนกว่าจะถึง tier ถัดไป)
- **ห้ามเริ่ม feature/refactor ใหม่**

## Layer 4: Recovery (เมื่อ session ใหม่ resume งานต่อ)
SessionStart hook ฉีด pointer ให้อ่าน handoff doc · โชว์สรุป handoff (title/สถานะ/งานถัดไป) ผ่าน `systemMessage` (render เฉพาะ terminal CLI — แอป/extension ยังไม่แสดง ณ 2026-07 ดู issue #15344; ในแอปผู้ใช้ต้องพิมพ์ข้อความแรกเองก่อน Claude ถึงเริ่มอ่าน — hook trigger turn เองไม่ได้) — **อ่านแล้วอย่าเพิ่งลุยต่อทันที รัน verify ก่อน continue:**
0. **(เฉพาะ session จาก chip)** ทำ 3 step ใน chip prompt ให้ครบก่อน (ยกของ / ฐานโค้ด / prune) — เปิดด้วย /clear ข้ามข้อนี้
1. **`git status`** — ไฟล์ uncommitted ตรงกับที่ handoff ระบุไหม (ที่ note ว่า "ค้าง" มีจริงไหม / ที่บอกว่า commit แล้วค้างจริงหรือเปล่า)
2. **branch / worktree** — อยู่ตัวเดียวกับที่ handoff บอกไหม (`git branch --show-current`, path)
3. **`npm run check`** — state ไม่พังจาก session ก่อน (โปรเจกต์ leave-web ใช้ตัวนี้เป็น validation gate)
4. **งานค้างใน handoff ตรงกับโค้ดจริงไหม** — เปิดไฟล์ที่ handoff อ้างดูว่าอยู่สถานะที่ระบุ → ค่อย continue
5. **ปิดวงจร: งานใน handoff เสร็จแล้ว (หรือผู้ใช้เปลี่ยนไปงานอื่น) → ลบไฟล์ pointer ทิ้ง** (path อยู่ในข้อความ inject ของ hook) — pointer ที่ไม่ลบ = เด้งงานเก่าซ้ำทุก `/clear` จนหมดอายุ 7 วัน · doc ใน `handoffs/` เก็บไว้ตามเดิมไม่ต้องลบ

> ถ้า verify **ไม่ตรง** (เช่น handoff บอก "commit แล้ว" แต่ git ยังค้าง, หรือ build พังทั้งที่ handoff บอกผ่าน) → **แจ้งผู้ใช้ก่อน อย่า continue ทับ** — handoff อาจถูกเขียนตอน session ก่อนกำลังจะตาย state เลยไม่ครบ

## หลักการ (ทำไมถึงแม่นกว่ากฎนุ่มๆ)
- **observe + predict = deterministic** — Stop hook อ่าน token + โมเดลจริงจาก transcript usage ทุกเทิร์น + คำนวณ EWMA growth → ETA เป็นคณิตศาสตร์ (`~/.claude/hooks/context-guard.mjs`) ไม่พึ่ง model ให้ "นึกได้เอง"
- **เพดาน adapt ตามโมเดล** — MAX auto-detect จาก `message.model` (fable/mythos 512k · opus 256k · sonnet/haiku 200k · `[1m]` 1M) → ยิงตรงเพดานจริงของแต่ละโมเดล ไม่ใช่ค่าตายตัว (สลับโมเดลกลางเซสชันได้) · pin เองได้ด้วย `/handoff-guard-max`
- **predict ก่อนวิกฤต** — ทริกตั้งแต่คาดว่าอีก ≤ K เทิร์นจะเต็ม (ก่อนแตะ T1) → มี buffer ปิด step สวยๆ · absolute tier (T1/T2) ยังเป็น fail-safe ถ้า predict พลาด
- **การตัดสิน = AI** — skill นี้ ยืดหยุ่นกว่า hard cutoff (ไม่ตัดกลาง atomic op)
- **recovery = อัตโนมัติ + verify** — SessionStart hook (`session-resume.mjs`) ฉีดตัวชี้ handoff ให้ session ใหม่ → skill รัน verify checklist (L4) ก่อน continue
- ปรับจูนที่ env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` / `HANDOFF_GUARD_PREDICT_TURNS` (K) / `HANDOFF_GUARD_EMA_ALPHA`

## ติดตั้ง / verify / จูน
ดู [SETUP.md](SETUP.md)
