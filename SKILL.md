---
name: handoff-guard
description: Context Manager (V2) — observe→predict→decide→recover. Decide whether to hand off to a fresh session when context is near (or predicted to reach) the token limit, and produce a clean handoff if so. Use when the context-guard Stop hook injects a near-limit OR predictive warning, when the user invokes /handoff-guard, or when context usage is high/rising fast (~218k+/256k, or predicted to hit the limit within a few turns) and you must decide whether to keep working or start a new session.
---

# Context Manager (V2)

> [English reference translation](SKILL.en.md) (this `SKILL.md` is the functional file Claude Code loads — the English copy is documentation only)

ปกป้องงานไม่ให้เสียตอน context ใกล้เต็ม — **ทำนายล่วงหน้า**ว่าอีกกี่เทิร์นจะเต็ม → ประเมินด้วยวิจารณญาณว่า "ควรขึ้น session ใหม่ไหม" แล้วทำ handoff ให้สะอาดถ้าควร

> เดิมชื่อ **Handoff Guard** (reactive — รอถึง 218k ค่อยทำ) · V2 เพิ่มมิติเวลา (predictive) แต่ slug ยังเป็น `handoff-guard` (invoke ด้วยชื่อนี้)

## 4 ชั้น (Observe → Predict → Decide → Recover)
| Layer | หน้าที่ | อยู่ที่ |
|---|---|---|
| **L1 Observe** | อ่าน token จริง + delta/เทิร์น | `hooks/context-guard.mjs` (deterministic) |
| **L2 Predict** | EWMA growth → ETA "อีกกี่เทิร์นถึง 240k" | `hooks/context-guard.mjs` (deterministic) |
| **L3 Decide** | finish step vs handoff (ดู tier ที่ทริก) | **skill นี้** (AI) |
| **L4 Recover** | resume → verify → continue | `session-resume.mjs` + skill นี้ (verify checklist) |

## เมื่อไหร่ถูกเรียก
- Stop hook `context-guard` ทริกอย่างใดอย่างหนึ่ง → ฉีด instruction มาให้ invoke skill นี้ (additionalContext แนบ `tier/tokens/rate/etaTurns`):
  - **predict** — คาดว่าอีก ≤ K (3) เทิร์นจะแตะ 240k (token ยังไม่ถึง 218k — buffer เยอะ)
  - **tier1** — token จริง ≥ 218k (absolute safety net)
  - **tier2** — token จริง ≥ 240k (ด่วน)
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
| **predict** (token < 218k, คาดอีก ~etaTurns เทิร์นจะเต็ม) | มี buffer — **ปิด step ปัจจุบันให้จบสวยๆ ได้** แล้วค่อย handoff · **ห้ามเริ่ม feature/refactor ใหม่** · ถ้างานเหลือยาวเกิน etaTurns → handoff หลังปิด step นี้ |
| tier2 (≥240k) | **handoff ทันที** — buffer น้อย เสี่ยง compaction กินงาน |
| tier1 (≥218k) + อยู่กลาง task ใหญ่ ยังเหลือหลาย step | ปิด step ปัจจุบันให้ปลอดภัย → **handoff** |
| tier1 + งานใกล้จบใน 1-2 step สั้น | ทำต่อให้จบ step นั้น → **handoff ทันที** (อย่าเริ่มงานใหญ่ใหม่) |

### 3. ถ้าตัดสินว่า handoff
1. สร้าง **handoff doc** ด้วย skill `handoff` (superpowers/Matt) — **บังคับใช้ (dependency ของ guard นี้)**
   invoke skill `handoff` · ส่ง focus ของ session ถัดไปเป็น argument + บังคับให้ครอบ **atomic/uncommitted, worktree/branch/env, BLOCKED**
   > **ถ้า `handoff` ยังไม่ติดตั้ง** — อย่าปล่อยงานหาย ทำ 3 อย่าง:
   > 1. เขียน `HANDOFF.md` สั้นๆ **ตอนนี้** (ค้างทันที / worktree-branch-env / งานถัดไป+BLOCKED / gotchas · redact secret)
   > 2. **ติดตั้ง handoff ให้รอบหน้าอัตโนมัติ:** `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs` (ดึงจาก github.com/mattpocock/skills → fallback vendored ถ้า offline)
   > 3. บอกผู้ใช้: ติดตั้ง `handoff` แล้ว — **restart session** เพื่อให้โหลด (skill โหลดตอนเปิด session ใช้ทันทีไม่ได้)
2. อัปเดต state file ของ repo (เช่น `task.md`) ให้สดล่าสุด
3. เขียน path ของ handoff ลง `~/.claude/.handoff-guard/last-handoff.txt` (ให้ SessionStart hook ของ session ใหม่หาเจอ)
4. **chip session ใหม่ให้ผู้ใช้** (สะดวก ไม่ต้องเปิดเอง) — เรียก `mcp__ccd_session__spawn_task`:
   - `title`: สั้น imperative เช่น "ต่องาน &lt;เรื่อง&gt; (handoff)"
   - `prompt`: self-contained — สั่งให้ session ใหม่อ่าน handoff doc ที่ path นั้นก่อน + สรุปงานถัดไป/ไฟล์ค้าง (session ใหม่ไม่เห็นบทสนทนานี้)
   - `tldr`: 1-2 ประโยคว่าจะทำอะไรต่อ
   → คลิกเดียวเปิด session ใหม่ที่ pre-load งานต่อ
5. บอกผู้ใช้ชัดเจน: "context ~Xk แล้ว — กด chip เพื่อเปิด session ใหม่ (หรือเปิดเองชี้ไป <handoff path>)" + สรุปงานค้าง 2-3 บรรทัด

### 4. ถ้าตัดสินว่าทำต่อ
- ทำเฉพาะ step ที่ค้างให้จบ แล้ววนกลับมา handoff (marker กันเตือนซ้ำจนกว่าจะถึง tier ถัดไป)
- **ห้ามเริ่ม feature/refactor ใหม่**

## Layer 4: Recovery (เมื่อ session ใหม่ resume งานต่อ)
SessionStart hook ฉีด pointer ให้อ่าน handoff doc — **อ่านแล้วอย่าเพิ่งลุยต่อทันที รัน verify ก่อน continue:**
1. **`git status`** — ไฟล์ uncommitted ตรงกับที่ handoff ระบุไหม (ที่ note ว่า "ค้าง" มีจริงไหม / ที่บอกว่า commit แล้วค้างจริงหรือเปล่า)
2. **branch / worktree** — อยู่ตัวเดียวกับที่ handoff บอกไหม (`git branch --show-current`, path)
3. **`npm run check`** — state ไม่พังจาก session ก่อน (โปรเจกต์ leave-web ใช้ตัวนี้เป็น validation gate)
4. **งานค้างใน handoff ตรงกับโค้ดจริงไหม** — เปิดไฟล์ที่ handoff อ้างดูว่าอยู่สถานะที่ระบุ → ค่อย continue

> ถ้า verify **ไม่ตรง** (เช่น handoff บอก "commit แล้ว" แต่ git ยังค้าง, หรือ build พังทั้งที่ handoff บอกผ่าน) → **แจ้งผู้ใช้ก่อน อย่า continue ทับ** — handoff อาจถูกเขียนตอน session ก่อนกำลังจะตาย state เลยไม่ครบ

## หลักการ (ทำไมถึงแม่นกว่ากฎนุ่มๆ)
- **observe + predict = deterministic** — Stop hook อ่าน token จริงจาก transcript usage ทุกเทิร์น + คำนวณ EWMA growth → ETA เป็นคณิตศาสตร์ (`~/.claude/hooks/context-guard.mjs`) ไม่พึ่ง model ให้ "นึกได้เอง"
- **predict ก่อนวิกฤต** — ทริกตั้งแต่คาดว่าอีก ≤ K เทิร์นจะเต็ม (ก่อนแตะ 218k) → มี buffer ปิด step สวยๆ · absolute tier (218k/240k) ยังเป็น fail-safe ถ้า predict พลาด
- **การตัดสิน = AI** — skill นี้ ยืดหยุ่นกว่า hard cutoff (ไม่ตัดกลาง atomic op)
- **recovery = อัตโนมัติ + verify** — SessionStart hook (`session-resume.mjs`) ฉีดตัวชี้ handoff ให้ session ใหม่ → skill รัน verify checklist (L4) ก่อน continue
- ปรับจูนที่ env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` / `HANDOFF_GUARD_PREDICT_TURNS` (K) / `HANDOFF_GUARD_EMA_ALPHA`

## ติดตั้ง / verify / จูน
ดู [SETUP.md](SETUP.md)
