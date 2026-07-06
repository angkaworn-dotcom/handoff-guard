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

> **ROI (ถ้ามีในข้อความ hook — F4)**: บรรทัด `💰 ROI(est): … · <label>` เป็น *ข้อมูลเสริม* การตัดสิน ไม่ใช่ตัวสั่ง — ROI สูง / label `Recommended`/`Critical` = เอนไป handoff เร็วขึ้น · แต่ **tier ยังกำหนดความเร่งหลัก** (tier2/`Critical` = ทันทีเสมอ) · ตัวเลขเป็น *ช่วงประมาณจากสถิติ* (input "เทิร์นที่เหลือ" เป็นค่าเดา) — อย่าถือเป็นความแม่น การตัดสินสุดท้ายเป็นของ AI ตามหลัก V2 · ยิ่งมี stats (F1) เยอะ ช่วงยิ่งแคบ (adaptive โดยปริยาย — ไม่มี threshold-per-project แยก)

### 3. ถ้าตัดสินว่า handoff
1. เขียน **handoff doc เอง** ตามฟอร์แมตของ skill `handoff` (Matt Pocock) — **อย่า invoke ผ่าน Skill tool**: skill นั้นตั้ง `disable-model-invocation: true` โดยเจตนา (โมเดลเรียกเองไม่ได้) · **ตัว doc สำคัญ ไม่ใช่ว่าใครเขียน**
   - ฟอร์แมตต้นฉบับ: `Read ~/.claude/skills/handoff/SKILL.md` แล้วทำตามทุกข้อ (มี suggested-skills section · อ้าง artifact ที่มีอยู่ด้วย path/URL ไม่ duplicate · redact secret · ปรับตาม focus ของ session ถัดไป) + **บังคับเพิ่ม (guard): atomic/uncommitted, worktree/branch/env, BLOCKED**
   - **เขียนด้วย Write tool** (UTF-8 ไม่มี BOM — เนื้อ/path ไทยไม่เพี้ยน) ที่ `~/.claude/.handoff-guard/handoffs/` (สร้างโฟลเดอร์ถ้ายังไม่มี) — **ตั้งชื่อไฟล์ `handoff-<ชื่อโปรเจกต์>-<วันที่/focus สั้น>.md`** ให้เข้า pattern `handoff-<ชื่อโปรเจกต์>-*.md` ที่ข้อ 4 ใช้นับเลขลำดับ (ตั้งนอก pattern = ไฟล์ไม่ถูกนับ เลข chip ซ้ำ) — **override** default ของ Matt ที่เซฟลง OS temp (Temp โดน Disk Cleanup/Storage Sense กวาดได้ → doc หายทั้งที่ pointer ยังชี้)
   > **ถ้า `~/.claude/skills/handoff/SKILL.md` ไม่มี** (ยังไม่ติดตั้ง) — เขียน doc เลยด้วยฟอร์แมตข้างบน (ค้างทันที / worktree-branch-env / งานถัดไป+BLOCKED / gotchas / suggested-skills · redact secret) แล้วติดตั้งไว้รอบหน้า: `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs` (ไว้เป็นแหล่งอ้างฟอร์แมต — `Read` ได้ทันทีหลังติดตั้ง · ส่วนคำสั่ง `/handoff` ผู้ใช้จะใช้ได้ตั้งแต่ **session ถัดไป** เพราะ skill โหลดตอนเปิด session — อย่าบอกผู้ใช้ว่าใช้ได้ทันที)
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
6. **บันทึกสถิติ handoff (best-effort — F1)**: `node ~/.claude/skills/handoff-guard/scripts/handoff-stats.mjs record-handoff --project "<mainRepoRoot>" --tokens <tokens> --max <MAX> --model <model> --doc "<handoff path>" --turns <turns> --rate <rate>` — ค่า `tokens`/`rate`/`MAX`/`model` อ่านได้จาก bracket ของ additionalContext ที่ hook แนบมา (`turns` ข้ามได้ถ้าไม่รู้) · **ล้มเหลว = ข้ามเลย ไม่กระทบ flow** (สถิติสำคัญน้อยกว่า handoff) · ข้อมูลนี้เป็นฐานให้ ROI engine (F4) — ดู `specs/2026-07-06-session-economics-design.md`

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
6. **บันทึกผล resume (best-effort — F1)**: หลัง verify ข้อ 1-4 เสร็จ รัน `node ~/.claude/skills/handoff-guard/scripts/handoff-stats.mjs record-resume --project "<mainRepoRoot>" --verify pass|fail` ตามผลจริง (ผ่านทุกข้อ = `pass` · เจอ state ไม่ตรง/พัง = `fail`) — ล้มเหลว = ข้าม ไม่กระทบ flow

> ถ้า verify **ไม่ตรง** (เช่น handoff บอก "commit แล้ว" แต่ git ยังค้าง, หรือ build พังทั้งที่ handoff บอกผ่าน) → **แจ้งผู้ใช้ก่อน อย่า continue ทับ** — handoff อาจถูกเขียนตอน session ก่อนกำลังจะตาย state เลยไม่ครบ

## ติดตั้ง / verify / จูน
ดู [SETUP.md](SETUP.md) — รวมตารางเพดานต่อโมเดล, การจูน env (`HANDOFF_GUARD_THRESHOLD` / `THRESHOLD2` / `PREDICT_TURNS` / `EMA_ALPHA`), และหลักการออกแบบ (ทำไม observe/predict เป็น deterministic ใน hook, การตัดสินเป็น AI ใน skill)
