# handoff-guard

Claude Code skill + hooks ที่ทำให้ **handoff ตอน context ใกล้เต็มแม่นยำ** — แทนที่จะพึ่งกฎนุ่มๆ ใน CLAUDE.md/memory (ที่ model มักลืม/ปล่อยจนเต็ม 200k) ใช้ **Stop hook อ่าน token จริงทุกเทิร์น** เป็นตัว trigger + **AI ประเมิน**ว่าควรขึ้น session ใหม่ไหม + **chip/handoff doc** ให้ต่อสะดวก

**Standalone** — ไม่พึ่ง skill/plugin ภายนอก (เขียน handoff doc เองตามโครงในตัว skill) · ต้องการแค่ `node` บน PATH · ถ้ามี skill `handoff` แยกติดตั้งอยู่ จะใช้แทนได้ (optional)

## ทำไมถึงแม่นกว่ากฎนุ่มๆ

| ส่วน | กลไก |
|------|------|
| **Trigger** | `Stop` hook (`hooks/context-guard.mjs`) อ่าน `transcript_path` → รวม `usage` ของ assistant message ล่าสุด (`input + cache_read + cache_creation + output`) = token จริงที่ API รายงาน · ≥170k→เตือน, ≥188k→ด่วน · `decision:block` ปลุก Claude ให้ทำ handoff · marker กันเตือนซ้ำ |
| **ตัดสิน** | skill `SKILL.md` — AI ประเมิน (ปิด atomic op ก่อน → handoff เลย vs ทำต่อให้จบ step) ยืดหยุ่นกว่า hard cutoff |
| **Recovery** | `SessionStart` hook (`hooks/session-resume.mjs`) เจอ `HANDOFF.md`/last-handoff → ฉีดตัวชี้ให้ session ใหม่อ่านเอง |

> ข้อจำกัด: ถ้า Claude Code auto-compact ยิงก่อนถึง threshold ต้องลด threshold (จูนที่ env) · chip/spawn_task เป็นดุลพินิจ model ทำ deterministic ไม่ได้

## ติดตั้ง

```bash
# 1) skill
cp -r SKILL.md SETUP.md scripts  ~/.claude/skills/handoff-guard/
# 2) hooks
cp hooks/context-guard.mjs hooks/session-resume.mjs  ~/.claude/hooks/
# 3) เพิ่ม hooks ใน ~/.claude/settings.json (ดู settings.example.json — แก้ path ตามเครื่อง)
```

ต้องมี `node` บน PATH (hooks เขียนด้วย Node = ข้ามแพลตฟอร์ม ไม่พึ่ง jq/bash)

**command ใน settings.json** ต้องเป็น absolute path:
- Windows: `node "C:/Users/<you>/.claude/hooks/context-guard.mjs"`
- macOS/Linux: `node "$HOME/.claude/hooks/context-guard.mjs"`

## Verify

```bash
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # ต้อง ALL PASS
```
Live test: ตั้ง `HANDOFF_GUARD_THRESHOLD=1` ชั่วคราว → คุย 1 ประโยค → Claude ควรถูก block แล้วเด้งไป skill `handoff-guard` → คืน 170000 + ลบ marker ใน `~/.claude/.handoff-guard/`

## จูน

| env | default | ความหมาย |
|-----|---------|----------|
| `HANDOFF_GUARD_THRESHOLD` | 170000 | tier1 — เตือน/ประเมิน |
| `HANDOFF_GUARD_THRESHOLD2` | 188000 | tier2 — ด่วน |

ดูรายละเอียดเต็มใน [SETUP.md](SETUP.md)
