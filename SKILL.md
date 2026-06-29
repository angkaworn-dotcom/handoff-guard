---
name: handoff-guard
description: Decide whether to hand off to a fresh session when context is near the token limit, and produce a clean handoff if so. Use when the context-guard Stop hook injects a near-limit warning, when the user invokes /handoff-guard, or when context usage is high (~170k+/200k) and you must decide whether to keep working or start a new session.
---

# Handoff Guard

ปกป้องงานไม่ให้เสียตอน context ใกล้เต็ม — ประเมินด้วยวิจารณญาณว่า "ควรขึ้น session ใหม่ไหม" แล้วทำ handoff ให้สะอาดถ้าควร

กลไก: **trigger แม่น (Stop hook อ่าน token จริง)** + **ตัดสินด้วย AI (skill นี้)** + **recovery อัตโนมัติ (SessionStart hook)**

## เมื่อไหร่ถูกเรียก
- Stop hook `context-guard` พบ token จริง ≥ 170k (tier1) หรือ ≥ 188k (tier2 ด่วน) → ฉีด instruction มาให้ invoke skill นี้
- ผู้ใช้พิมพ์ `/handoff-guard` เอง

## ขั้นตอน (ทำตามลำดับ)

### 1. ทำ atomic state ให้ปลอดภัยก่อน (สำคัญสุด — ห้ามทิ้งงานครึ่งทาง)
- แก้หลายไฟล์ยังไม่ commit + ผ่าน validation → commit ถ้าผู้ใช้อนุญาต · ไม่งั้น **note ชัดใน handoff** ว่า "ค้าง uncommitted ที่ไฟล์ X"
- migration / `db.batch` ค้างกลางทาง → ปิดให้จบ หรือ note ว่ายังไม่จบ + ผลกระทบ
- subagent/background task รันอยู่ → รอผลหรือ note สถานะ + วิธีเช็คต่อ

### 2. ประเมิน: handoff เลย vs ทำต่อได้อีกนิด
| สัญญาณ | ตัดสิน |
|--------|--------|
| tier2 (≥188k) | **handoff ทันที** — buffer น้อย เสี่ยง compaction กินงาน |
| tier1 (≥170k) + อยู่กลาง task ใหญ่ ยังเหลือหลาย step | ปิด step ปัจจุบันให้ปลอดภัย → **handoff** |
| tier1 + งานใกล้จบใน 1-2 step สั้น | ทำต่อให้จบ step นั้น → **handoff ทันที** (อย่าเริ่มงานใหญ่ใหม่) |

### 3. ถ้าตัดสินว่า handoff
1. เขียน **handoff doc** เอง (standalone — ไม่พึ่ง skill อื่น) ที่ `HANDOFF.md` ของ repo ตามโครงนี้:
   ```
   # Handoff — <topic> (<date>)
   ## ค้างทันที          atomic ที่ห้ามทิ้ง — uncommitted ไฟล์ไหน / migration ค้าง / background task + วิธีต่อ
   ## Worktree/branch/env  path, branch, env (token/account id), คำสั่ง validate
   ## ทำเสร็จใน session นี้  bullets
   ## งานถัดไป            bullets เรียงลำดับ + ของที่ BLOCKED
   ## กฎเหล็ก/gotchas     commit policy, จุดพลาดที่ต้องรู้
   ```
   (ถ้ามี skill `handoff` แยกติดตั้งอยู่ จะ invoke ใช้แทนก็ได้ — optional)
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

## หลักการ (ทำไมถึงแม่นกว่ากฎนุ่มๆ)
- **trigger = deterministic** — Stop hook อ่าน token จริงจาก transcript usage ทุกเทิร์น (`~/.claude/hooks/context-guard.mjs`) ไม่พึ่ง model ให้ "นึกได้เอง"
- **การตัดสิน = AI** — skill นี้ ยืดหยุ่นกว่า hard cutoff (ไม่ตัดกลาง atomic op)
- **recovery = อัตโนมัติ** — SessionStart hook (`session-resume.mjs`) ฉีดตัวชี้ handoff ให้ session ใหม่
- ปรับ threshold ที่ env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2`

## ติดตั้ง / verify / จูน
ดู [SETUP.md](SETUP.md)
