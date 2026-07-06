# Spec: Session Economics (F1–F4) — observability ก่อน optimizer

> วันที่: 2026-07-06 · สถานะ: อนุมัติ design แล้ว รอผู้ใช้ review spec → implement ทีละ branch
>
> ที่มา: ข้อเสนอ "Session Economics Engine" ของ owner (7 stage) — รับทั้ง 4 ส่วนแบบ phased
> โดยแก้จุดที่ข้อเสนอเข้าใจคลาดเคลื่อนจากข้อเท็จจริงของระบบ (ดู "ฐานข้อเท็จจริง")

## เป้าหมาย

เปลี่ยนคำเตือนของ guard จาก "% threshold" เป็นเหตุผลเชิงต้นทุนที่**ยึดข้อมูลจริง** —
เก็บสถิติ handoff จริงก่อน (F1) เพื่อให้ ROI engine (F4) มีฐานข้อมูล ไม่ใช่เลขเดาล้วน ·
เพิ่มเครื่องมือ attribution ว่า context หายไปกับอะไร (F2) · เกลาข้อความเตือนให้สื่อต้นทุน
จากข้อมูลที่มีอยู่แล้ว (F3)

## ฐานข้อเท็จจริง (แก้ความเข้าใจในข้อเสนอเดิม)

- hook วัด token จาก `usage` ของ API (input + cache_read + cache_creation + output) =
  ครอบ Preload/Static + Dynamic + Hidden overhead **ทั้งหมดอยู่แล้ว** — ไม่ใช่ "วัดได้แค่ Dynamic"
  → Preload scanner มีค่าเป็น **attribution/breakdown** (อะไรกินเท่าไหร่) ไม่ได้เพิ่มความแม่นของการวัด
- Reserved buffer มีอยู่แล้วโดยพฤตินัย: T2 = 85% ของ MAX = สำรอง 15%
- "expected remaining prompts" เป็นค่าเดาโดยธรรมชาติ → ตัวเลข ROI เดี่ยวๆ (เช่น "188x")
  เป็น pseudo-precision — spec นี้บังคับแสดงเป็น **ช่วง** และระบุว่าเป็นการประมาณเสมอ
- หลัก V2 คงเดิม: observe/predict/คำนวณ = deterministic ใน hook/script · **ตัดสิน = AI ใน skill**

## การตัดสินใจ (owner เคาะแล้ว 2026-07-06)

| เรื่อง | เคาะ |
|---|---|
| scope | รับทั้ง 4 feature (stats / scanner / cost warnings / ROI เต็ม) |
| กลยุทธ์ | observability-first: F1 ก่อนเพื่อให้ F4 มีข้อมูลจริง · แยก branch ละ feature ทดสอบก่อน merge |
| ROI input (remaining prompts) | **ช่วง + สถิติ** — p25–p75 จาก stats.jsonl เมื่อมีข้อมูล ≥5 session · ไม่มี → default 5–15 (config override) |
| Recommendation 4 ระดับ | **ซ้อนบน tier เดิม** — tier (predict/t1/t2) ยังเป็น trigger + กลไก marker เดิมทุกอย่าง · ROI เป็นข้อมูลเสริมใน additionalContext |
| Preload scanner UX | script + คำสั่ง `/handoff-guard-scan` |
| ลำดับ branch | F1 → F2 → F3 (อิสระ แตกจาก main) → F4 (แตกหลัง F1+F3 merge) |

## F1 — Handoff stats (`claude/econ-f1-handoff-stats`)

### script ใหม่ `scripts/handoff-stats.mjs` (deterministic, ติดตั้งไป `skills/handoff-guard/scripts/`)

- `record-handoff --project <mainRepoRoot> --tokens <n> --max <n> --model <id> --doc <path> --turns <n> --rate <n>`
  → append 1 บรรทัด JSON ลง `~/.claude/.handoff-guard/stats.jsonl`:
  `{"v":1,"kind":"handoff","ts":"<ISO>","project":"<slug กติกาเดียวกับ pointer>","tokens":N,"max":N,"model":"...","turns":N,"rate":N,"docBytes":N,"docTokensEst":N,"compressionRatio":N}`
  - `docTokensEst` จาก heuristic เดียวกับ F2 (ดูข้างล่าง) · `compressionRatio = tokens / docTokensEst` (ปัด 1 ตำแหน่ง)
  - doc อ่านไม่ได้ → บันทึกเฉพาะ field ที่มี (docBytes/docTokensEst/compressionRatio = null) ไม่ fail
- `record-resume --project <mainRepoRoot> --verify pass|fail`
  → append `{"v":1,"kind":"resume","ts":"...","project":"...","verify":"pass|fail"}`
- `summary [--project <mainRepoRoot>]` → พิมพ์: จำนวน session · avg/median tokens ณ จุด handoff ·
  avg compression ratio · avg turns/session · avg rate · resume success rate
- ความทนทาน: บรรทัด JSON เสีย → ข้ามบรรทัดนั้น (ไม่ crash) · ไฟล์ไม่มี → summary บอก "ยังไม่มีข้อมูล" exit 0 ·
  เขียนด้วย `appendFileSync` UTF-8 ไม่มี BOM

### SKILL.md / SKILL.en.md

- step 3 (หลังเขียน handoff doc + pointer): เพิ่มข้อ "รัน `node ~/.claude/skills/handoff-guard/scripts/handoff-stats.mjs record-handoff ...`
  (ค่า tokens/rate เอาจาก additionalContext ของ hook · turns จาก state ถ้ารู้ ไม่รู้ให้ข้าม flag)"
- Layer 4: หลัง verify จบ เพิ่ม "รัน `record-resume --verify pass|fail` ตามผลจริง"
- ล้มเหลว = ไม่ block flow หลัก (stats เป็น best-effort เสมอ — handoff สำคัญกว่าสถิติ)

## F2 — Preload scanner (`claude/econ-f2-preload-scan`)

### script ใหม่ `scripts/scan-preload.mjs`

- one-shot diagnostic (read-only ทั้งตัว) · args: `--project <path>` (default cwd) · `--json` · `--max <n>` (default: config.json max หรือ 200k)
- สแกนสิ่งที่ถูก preload เข้า context ตอนเปิด session:
  | หมวด | แหล่ง |
  |---|---|
  | user CLAUDE.md | `~/.claude/CLAUDE.md` |
  | project CLAUDE.md | `<project>/CLAUDE.md` + `<project>/.claude/CLAUDE.md` (ถ้ามี) |
  | memory index | `~/.claude/projects/<slug>/memory/MEMORY.md` (ถ้ามี) |
  | skill descriptions | frontmatter `description:` ของทุก `SKILL.md` ใต้ `~/.claude/skills/` + `~/.claude/plugins/cache/` (เฉพาะ description — body โหลดตอน invoke ไม่ใช่ preload) |
  | commands | ชื่อ + เนื้อ frontmatter ของ `~/.claude/commands/*.md` และ `<project>/.claude/commands/*.md` |
  | agents | `~/.claude/agents/*.md` + `<project>/.claude/agents/*.md` (ถ้ามี) |
  | settings/hooks | ขนาด `settings.json` (user + project) |
- ประมาณ token ต่อไฟล์: `ascii_chars/4 + non_ascii_chars/1.5` ปัดขึ้น — **ระบุใน output เสมอว่า ±30% เป็น attribution ไม่ใช่การวัด** (ของจริง hook วัดจาก usage อยู่แล้ว)
- output (text): ตารางหมวด → est tokens + % ของ MAX · top 10 ไฟล์ใหญ่สุดข้ามหมวด · บรรทัดสรุป "รวม preload ≈ Xk (~Y% ของ MAX Z)"
- `--json`: โครงเดียวกันเป็น JSON (ให้ Claude/เครื่องมืออื่น parse)
- dir/ไฟล์อ่านไม่ได้ → ข้าม + นับใน "skipped" (ไม่ crash)

### คำสั่งใหม่ `commands/handoff-guard-scan.md` (+ `.en.md` doc)

- สั่งให้ Claude รัน script กับ project ปัจจุบัน แล้วสรุปผล: หมวดไหนกินสุด แนะนำได้แค่เชิง attribution
  (เช่น "CLAUDE.md global 8k = 4% ของ MAX") — ห้ามแนะให้ลบไฟล์อัตโนมัติ
- เพิ่มทั้งคู่ใน `installMap` ของ `scripts/install.mjs` (`.en.md` ไม่ติดตั้ง — filter เดิม) — test G/H/J บังคับอยู่แล้ว

## F3 — ข้อความเตือนเชิง cost (`claude/econ-f3-cost-warnings`)

แก้เฉพาะสตริง message ใน `hooks/context-guard.mjs` (logic/trigger/marker ไม่แตะ):

- ทั้ง 3 tier เพิ่มข้อมูลต้นทุนจากค่าที่มีอยู่แล้ว: "เหลือ ~<MAX−tokens> ก่อนเพดาน ≈ ~<ceil((MAX−tokens)/rate)> เทิร์นที่ rate ปัจจุบัน"
- tier1/tier2 เพิ่ม `etaTurns=<ceil((T2−tokens)/rate)>` ใน bracket ของ additionalContext (ปัจจุบันมีเฉพาะ predict — skill L3 จะได้เห็นความเร่งจากทุก tier · tier2 ที่ tokens ≥ T2 แล้วให้ etaTurns=0)
- tier2 เพิ่มเหตุผล: "ทำต่อจนชนเพดาน = โดน auto-compact แล้วคุณภาพ context degrade — ต้นทุนจริงของการไม่ handoff"
- **ไม่มีตัวเลขเดาใน F3** — ใช้เฉพาะ tokens/rate/MAX/T2 ที่วัดจริง (ตัวเลขเชิงเดาไปอยู่ F4 ซึ่งแสดงเป็นช่วง)

## F4 — ROI engine (`claude/econ-f4-roi` — แตกหลัง F1+F3 merge แล้ว)

### การคำนวณ (deterministic, ใน `context-guard.mjs` — รันเฉพาะจังหวะ trigger ไม่เพิ่ม I/O per-turn)

1. **remaining prompts (ช่วง)** — อ่าน `stats.jsonl` (เฉพาะตอนกำลังจะ emit):
   - มี handoff record ของ project นี้ ≥5 → ช่วง = [p25, p75] ของ `turns` ในอดีต ลบ turns ปัจจุบัน, clamp ต่ำสุด 1
   - ไม่ถึง 5 → ใช้ทุก project รวม ≥5 → ไม่ถึงอีก → default `[5, 15]`
   - override: config.json `roiPrompts: [lo, hi]` หรือ env `HANDOFF_GUARD_ROI_PROMPTS=lo,hi`
2. **Replay cost (ช่วง)** = `tokens × [lo, hi]` — ความหมาย: context ปัจจุบันจะถูกแบกซ้ำทุกเทิร์นที่เหลือ
   (หมายเหตุใน message: billing จริงถูกกว่ามากเพราะ prompt cache — ต้นทุนหลักคือความเสี่ยง degrade ไม่ใช่เงิน)
3. **Handoff cost** = median ของ `docTokensEst` จาก stats + ค่าคงที่ resume overhead 3k · ไม่มี stats → 10k
4. **ROI (ช่วง)** = replay / handoff cost → ปัดเป็นจำนวนเต็ม แสดง "~Nx–Mx"
5. **Recommendation ซ้อนบน tier** (ตาราง deterministic — tier ยังเป็น trigger เดิม):
   | เงื่อนไข | label |
   |---|---|
   | tier2 | `Critical` (เสมอ — ความจริงเชิง buffer ชนะ ROI) |
   | tier1 และ ROI_lo ≥ 20 | `Recommended` |
   | tier1 และ ROI_lo < 20 | `Soon` |
   | predict และ ROI_lo ≥ 20 | `Soon` |
   | predict และ ROI_lo < 20 | `Continue` (ปิด step แล้วค่อยว่ากัน — ข้อความเดิมของ predict คงอยู่) |
6. ต่อท้าย additionalContext ของทุก tier:
   `💰 ROI(est): replay ~<lo>–<hi> vs handoff ~<c> → ~<r1>x–<r2>x · <label> (ช่วงประมาณจากสถิติ N session — ไม่ใช่การวัด)`
   - ไม่มี stats → ระบุ "(default range — ยังไม่มีสถิติ)"
7. ปิดได้: env `HANDOFF_GUARD_ROI=0` หรือ config `roi: 0` → ไม่อ่าน stats ไม่ต่อท้ายบรรทัด ROI (พฤติกรรม = ก่อน F4 ทุกประการ)

### SKILL.md (ตาราง step 2)

- เพิ่มแถวการอ่าน ROI: label เป็น**ข้อมูลเสริม**การตัดสิน — ROI สูง = เอนไป handoff เร็วขึ้น ·
  tier ยังกำหนดความเร่งหลัก (Critical/tier2 = ทันทีเหมือนเดิม) · การตัดสินสุดท้ายเป็นของ AI ตามหลัก V2
- Adaptive Learning (stage 7 ของข้อเสนอเดิม) = ผลพลอยได้ของโครงนี้: ROI ใช้ stats ต่อ project อยู่แล้ว
  ข้อมูลยิ่งเยอะช่วงยิ่งแคบ — **ไม่มีระบบ threshold-per-project แยก** (YAGNI จนกว่าจะมีข้อมูล ≥30 session ค่อยประเมินใหม่)

## Error handling (รวมทุก feature)

| เคส | พฤติกรรม |
|---|---|
| stats.jsonl ไม่มี / บรรทัดเสีย / อ่านไม่ได้ | ข้ามบรรทัดเสีย · F4 ตกไป default range · ไม่มีทาง crash hook |
| record-handoff เขียน fail (dir ล็อก ฯลฯ) | script exit ≠0 + stderr · SKILL.md ระบุว่า best-effort — flow handoff เดินต่อ |
| scanner เจอ dir ใหญ่ผิดปกติ (plugins cache) | จำกัดที่ frontmatter description เท่านั้น ไม่อ่าน body → เร็ว · ไฟล์ >1MB ข้าม + นับ skipped |
| ROI คำนวณแล้วช่วงกลับด้าน (lo>hi จาก stats แปลก) | swap ให้เรียงถูก · hi=0 → ไม่แสดงบรรทัด ROI |
| env/config ROI ปิด | ข้อความทุก tier กลับไปเหมือนก่อน F4 ทุกตัวอักษร (selftest ล็อกไว้) |

## การทดสอบ (TDD ต่อ branch — test ต้องแดงก่อนแก้ หรือ sabotage ยืนยัน)

- **F1**: section ใหม่ใน `updater-selftest.mjs` (hermetic fakeHome): record-handoff/record-resume append ถูกโครง ·
  summary คำนวณถูก (ค่า fixture รู้คำตอบ) · บรรทัดเสียถูกข้าม · ไฟล์ไม่มี → exit 0 + installMap มี `handoff-stats.mjs`
- **F2**: fixture home ปลอม (CLAUDE.md/skills/commands ขนาดรู้ค่า) → หมวดครบ, est ตาม heuristic, `--json` parse ได้,
  ไฟล์อ่านไม่ได้ → skipped + installMap/command ครบ (test G/H/J)
- **F3**: อัปเดต assertion selftest ที่เช็คข้อความ 3 tier — เพิ่มเช็ค "เหลือ ~" และ etaTurns ใน tier1/tier2
- **F4**: section ใหม่ใน selftest: (ก) fake stats ≥5 session → ROI ช่วงตรงเลขที่คำนวณมือ + label ถูกตามตาราง
  (ข) ไม่มี stats → default range + ข้อความ "ยังไม่มีสถิติ" (ค) `HANDOFF_GUARD_ROI=0` → ไม่มีบรรทัด ROI
  (ง) tier2 → Critical เสมอ (จ) stats เสีย → ไม่ crash
- ทุก branch ก่อน PR: `selftest` + `updater-selftest` เขียวทั้งคู่ · อัปเดต bullet enumerate section ใน SETUP.md/SETUP.en.md (ธรรมเนียม docs)

## แผน branch / merge

| ลำดับ | branch | ฐาน | รอ |
|---|---|---|---|
| 1 | `claude/econ-f1-handoff-stats` | main | — |
| 2 | `claude/econ-f2-preload-scan` | main | — (อิสระ ทำขนานได้) |
| 3 | `claude/econ-f3-cost-warnings` | main | — (อิสระ) |
| 4 | `claude/econ-f4-roi` | main (หลัง F1+F3 merge) | F1 (stats schema) + F3 (โครงข้อความ) |

ทุก branch: push → PR → **owner ทดสอบเอง → merge เอง** (flow เดิมของโปรเจกต์)

## นอกขอบเขต (จงใจไม่ทำ)

- ROI เป็น trigger แทน threshold — owner เคาะให้ tier เดิมเป็น trigger ต่อไป (trigger ผูกค่าเดา = เตือนเร็ว/ช้าเกินคาดเดาไม่ได้)
- threshold-per-project อัตโนมัติ (stage 7 เต็มรูป) — รอข้อมูลจริง ≥30 session ค่อยเปิด spec ใหม่
- Preload scanner แบบ per-turn / ฝังใน hook — เป็น CLI one-shot เท่านั้น (per-turn ไม่เพิ่มความแม่น — usage วัดของจริงอยู่แล้ว)
- การวัด token แบบ tokenizer จริง — heuristic พอสำหรับ attribution · อย่าอ้างความแม่นเกิน ±30%
