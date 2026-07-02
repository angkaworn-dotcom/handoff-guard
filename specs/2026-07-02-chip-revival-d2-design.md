# Spec: เอา chip กลับมา + คุม worktree แบบ D2 (snapshot เบา 5 อันล่าสุด)

> วันที่: 2026-07-02 · สถานะ: อนุมัติ design แล้ว รอ implement
> ที่เก็บ spec นี้อยู่ใน `~/.claude/skills/handoff-guard/specs/` (งานนี้แก้ tooling ระดับเครื่อง ไม่เกี่ยวกับ repo โปรเจกต์ใด — โฟลเดอร์นี้ไม่ใช่ git repo จึงไม่มี commit)

## เป้าหมาย

คืนประสบการณ์ chip ของ handoff-guard (คลิกเดียวไม่ต้องพิม · แชทเก่าไม่หาย · เห็นเป็นปุ่มชัดเจน) โดยไม่ให้ดิสก์บวมแบบเดิม (เคยกอง 60 worktree ≈ 10GB) และ**คงคุณค่า rollback**: worktree เก่า = จุดย้อนกลับถ้าทำผิด

## ข้อเท็จจริงที่ verify แล้ว (ฐานของ design)

- `spawn_task` สร้าง worktree ใหม่**เสมอ**ตอนกด chip — ไม่มี option ปิด (schema มีแค่ title/prompt/tldr/cwd) → ป้องกันการสร้างไม่ได้ ทำได้แค่จัดการหลังเกิด
- ตัวกินพื้นที่จริงคือ `node_modules` (206MB/อัน) ที่ session ใหม่ npm install — checkout เปล่าเล็กมาก (~10-30MB)
- สิ่งที่ทำให้ย้อนได้จริงคือ branch+commit (handoff-guard step 1 บังคับ commit ก่อน handoff) — โฟลเดอร์ worktree เป็นความสะดวกในการเปิดย้อนทันที
- harness ไม่ auto-clean worktree ของ session (ต่างจาก Agent tool)

## การตัดสินใจ (owner เคาะแล้ว)

| เรื่อง | เคาะ |
|---|---|
| กลไก | **D2** — session ใหม่อยู่ worktree ใหม่ตาม flow เดิมของ chip, "ยกของ" node_modules มาจาก worktree เก่า, เก็บ worktree เก่าเป็น snapshot เบา, เกิน **5 อัน**ลบอันเก่าสุด (branch ไม่ลบ) |
| chip title | `ต่อ <N>. <ชื่องานสั้น>` — N เป็นเลขวิ่งต่อโปรเจกต์ ดูปุ๊บรู้ว่าอันไหนล่าสุด (เช่น `ต่อ 12. google pull data`) |
| กองเก่า ~58 อัน | **ก. ลบ clean ทั้งหมดรอบแรก** (~45 อัน — branch ยังอยู่ครบ) · 13 อัน dirty ถูก guard ข้ามอัตโนมัติ รอจัดการมือ |
| /clear | ยังเป็นทางเลือกสำรอง (pointer + SessionStart hook ทำงานเหมือนเดิม ไม่แตะ) |

## ส่วนประกอบ

### 1. `~/.claude/skills/handoff-guard/SKILL.md` (+ `SKILL.en.md` mirror) — step 4-5

เปลี่ยนจาก "ห้าม chip แนะ /clear" → "สร้าง chip เป็นหลัก /clear เป็นทางเลือก":

- อ่าน-เพิ่มตัวนับจาก `~/.claude/.handoff-guard/counters.json` (ดู §3)
- เรียก `mcp__ccd_session__spawn_task`:
  - `title`: `ต่อ <N>. <focus สั้น>` (≤60 ตัวอักษร — focus ตัวเดียวกับที่ส่งให้ skill `handoff`)
  - `tldr`: 1-2 ประโยค มีเลข N กำกับ
  - `prompt`: **self-contained** ตาม template §2 (session ใหม่ไม่เห็นบทสนทนาเดิม)
- แจ้งผู้ใช้: "กด chip 'ต่อ N. …' เพื่อเปิด session ต่อ (แชทเก่าค้างไว้ย้อนดูได้) หรือพิม `/clear` ถ้าไม่ต้องการเก็บแชท"
- pointer per-worktree เขียนเหมือนเดิมทุกอย่าง (chip กับ /clear อยู่ร่วมกัน — เส้นไหนก็ resume ได้)

### 2. Chip prompt template (ฝังใน SKILL.md)

ค่าที่ skill ต้อง interpolate ตอนสร้าง chip: `<N>`, `<focus>`, `<handoffPath>`, `<pointerPath>`, `<oldWorktreePath>`, `<oldBranch>`, `<lastCommitHash>`, `<mainRepoRoot>`

```
ต่องานจาก handoff #<N>: <focus>

คุณคือ session ที่เกิดจาก chip ของ handoff-guard — cwd ปัจจุบันคือ worktree ใหม่ที่ harness เพิ่งสร้าง
ทำ 3 step นี้ก่อนเริ่มงาน (ตามลำดับ):

1. ยกของ: ถ้า "<oldWorktreePath>\node_modules" มีอยู่ และ cwd ยังไม่มี node_modules
   → ย้ายด้วย PowerShell: Move-Item "<oldWorktreePath>\node_modules" "<cwd>\node_modules"
   ถ้าย้ายไม่ได้ (ไฟล์ถูกล็อก เช่น dev server เก่าค้าง / โฟลเดอร์ไม่มี) → ข้าม แล้วค่อย npm install เมื่อจำเป็น — ห้าม force ห้าม kill process มั่ว
2. ตรวจฐานโค้ด: HEAD ของ cwd ต้องมี commit <lastCommitHash> (tip ของ branch <oldBranch>)
   → ถ้าไม่มี: git merge --ff-only <oldBranch> · ff ไม่ได้ = หยุดถามผู้ใช้ (อย่าเดา)
3. Prune snapshot: node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5

จากนั้นอ่าน <handoffPath> แล้วรัน verify ตาม Layer 4 ของ skill handoff-guard (git status / branch / validation gate ของโปรเจกต์)
ก่อนทำงานต่อ · งานใน handoff เสร็จหรือผู้ใช้เปลี่ยนงาน → ลบ pointer <pointerPath>
```

### 3. `~/.claude/.handoff-guard/counters.json` (ใหม่)

- รูปแบบ: `{"<project-slug>": 12}` — slug = path เต็มของ **main repo root** (ไม่ใช่ worktree) lowercase, อักขระนอก a-z/0-9/ไทย → `-` (กติกาเดียวกับ pointer)
- handoff-guard อ่าน → +1 → ใช้เป็น N → เขียนกลับด้วย **Write tool เท่านั้น** (กฎ BOM เดิม)
- ไฟล์/คีย์ยังไม่มี → เริ่มจากจำนวนไฟล์ `handoffs/handoff-<ชื่อโปรเจกต์>-*.md` ที่มีอยู่ (กันเลขถอยหลัง) แล้ว +1

### 4. `~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs` (ใหม่ — deterministic)

- Args: `--repo <mainRepoRoot>` (บังคับ) · `--keep N` (default 5) · `--dry`
- ขอบเขต: เฉพาะโฟลเดอร์ใต้ `<repo>/.claude/worktrees/` เท่านั้น
- **Guard (ข้ามเสมอ ไม่มีข้อยกเว้น):**
  - cwd ปัจจุบันของ process (ห้ามลบบ้านตัวเอง)
  - keep-list: `['leave-db-redesign-feat']` (const แก้ในไฟล์)
  - dirty: `git -C <wt> status --porcelain` มีบรรทัดที่**อยู่นอก `node_modules/`** (แก้ไขจากตอนแรก — ค้นพบตอน implement ว่า repo นี้ track node_modules ใน git และ clean script เคยลบทิ้ง ทำให้ 57 อันขึ้น dirty ทั้งที่ไม่มีงานจริงค้าง; dirt ใน node_modules = git มีเนื้อไฟล์อยู่แล้ว ไม่ใช่งาน) · การลบใช้ `git worktree remove --force` — ปลอดภัยเพราะ candidate ผ่านเช็ค realDirt ว่างแล้ว (git เองนับ node_modules หาย/ไฟล์ ignored เป็น dirty เลยต้อง force)
  - mtime ภายใน 2 วัน
- ที่เหลือเรียง mtime ใหม่→เก่า เก็บ N อันแรก ลบที่เหลือด้วย `git -C <mainRepoRoot> worktree remove <path>` (ไม่ใช้ `--force` — git ปฏิเสธ dirty ให้อีกชั้น) · ลบ fail = log แล้วข้าม ไม่ throw
- **ไม่ลบ branch เด็ดขาด** — ทุกจุดย้อนอยู่ที่ branch
- stdout: สรุป กี่อันเก็บ/ลบ/ข้าม(เหตุผล) · `--dry` แสดงรายการที่จะลบโดยไม่ลบ
- รอบแรกที่รัน = กวาดกองเก่า ~45 อัน clean ตามข้อ ก (13 dirty เหลือรอจัดการมือ)

### 5. อัปเดต docs/memory ให้ไม่ขัดกัน

- `SKILL.md` + `SKILL.en.md`: กล่อง "ทำไม /clear แทน chip" เดิม → เขียนใหม่เป็น "chip กลับมาแล้วพร้อมกลไกยกของ+prune (spec นี้)"
- memory `worktree-node-modules-bloat.md`: ประโยค "อย่ากลับไปใช้ chip" → superseded โดย spec นี้ (chip + D2)
- Layer 4 (recovery checklist): ใช้ได้ทั้งเส้น chip และ /clear — เพิ่มบรรทัดว่า chip session ต้องผ่าน 3 step ใน §2 ก่อน

## Error handling

| เคส | พฤติกรรม |
|---|---|
| worktree เก่า dirty (handoff note งานค้าง uncommitted) | ยกของได้ปกติ · prune ไม่มีวันลบ (dirty guard) — งานไม่หาย |
| worktree เก่าไม่มี node_modules | ข้าม step ยกของ → npm install เมื่อจำเป็น |
| node_modules ถูกล็อก (wrangler/vite orphan — เคยเกิดจริง) | Move-Item fail → ข้าม ไม่ force ไม่ kill |
| HEAD worktree ใหม่ไม่มี commit ล่าสุด | `git merge --ff-only <oldBranch>` · ff ไม่ได้ = หยุดถามผู้ใช้ |
| กด chip ค้าง/ซ้ำหลังงานเสร็จไปแล้ว | ทุก step idempotent (ยกของเจอปลายทางมี = ข้าม · prune รันซ้ำได้ · verify L4 จะเห็นว่า state ไปไกลกว่า handoff → แจ้งผู้ใช้ตามกฎเดิม) |
| prune ลบ fail รายตัว | log + ข้าม ไม่ล้มทั้ง run |

## การทดสอบ (ก่อนประกาศเสร็จ)

1. **prune script**: สร้าง git repo ทดลองใน scratchpad + worktree ปลอม 7-8 อัน (คละ clean/dirty/ใหม่/เก่า/keep-list/cwd ตัวเอง) → `--dry` ตรวจรายการ → รันจริง → เช็คเหลือถูกอัน + `git branch` ครบทุกตัว
2. **ยกของ**: Move-Item node_modules ระหว่าง worktree จริง 1 คู่ในโปรเจกต์นี้ + จับเวลา + ย้ายกลับ
3. **counter**: ไม่มีไฟล์ → เริ่มถูก · มีแล้ว → +1 · เขียนกลับไม่มี BOM
4. **end-to-end**: รอบ handoff จริงถัดไป — กด chip → ดู session ใหม่ทำ 3 step ครบ + กองเก่าโดนกวาด · จนกว่าจะถึงตอนนั้น ทดสอบ prune กับกองจริงด้วย `--dry` ได้ทันที

## นอกขอบเขต (จงใจไม่ทำ)

- dismiss chip เก่าอัตโนมัติเมื่อมี handoff ใหม่ — `task_id` ไม่ persist ข้าม restart ของแอป ทำไม่ได้จริง; chip เก่าที่ไม่กดจะค้างเฉยๆ ไม่สร้าง worktree (worktree เกิดตอนกด)
- จัดการ 13 worktree dirty เก่า — งานมือแยกตามคิวเดิมของ owner
- แตะ `session-resume.mjs` / pointer format — เส้น /clear ทำงานดีอยู่แล้ว ไม่เกี่ยวกับงานนี้
