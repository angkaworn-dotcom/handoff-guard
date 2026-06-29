# Handoff Guard — Setup / Verify / Tune

## องค์ประกอบ (3 ส่วน)

| ไฟล์ | บทบาท |
|------|-------|
| `~/.claude/hooks/context-guard.mjs` | **Stop hook** — วัด token จริงทุกเทิร์น, ≥ threshold → block + ฉีดให้ invoke skill `handoff-guard` |
| `~/.claude/hooks/session-resume.mjs` | **SessionStart hook** — เจอไฟล์ handoff ในโปรเจกต์/last-handoff → ฉีดตัวชี้ให้ session ใหม่อ่าน |
| `~/.claude/skills/handoff-guard/SKILL.md` | **AI eval** — ตัดสินว่าควรขึ้น session ใหม่ไหม + ทำ handoff |

## settings.json (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"C:/Users/Dell/.claude/hooks/context-guard.mjs\"", "timeout": 15 }
      ]}
    ],
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/Users/Dell/.claude/hooks/session-resume.mjs\"", "timeout": 15 }
      ]}
    ]
  }
}
```

> เปลี่ยน path ตามเครื่อง · บน Windows ใช้ forward slash ใน path ของ node ได้

## วิธี token ถูกวัด (ทำไมแม่น)

Stop hook รับ `transcript_path` ทาง stdin → อ่าน JSONL → หา `message.usage` ของ assistant message **ล่าสุด** →
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` = ขนาด context จริงที่ API รายงาน
(ไม่ใช่เดาจากจำนวนบรรทัด/ตัวอักษร)

## Verify

**1. ทดสอบสคริปต์แบบ deterministic** (ไม่ต้องรอ session โต) — ดู `scripts/selftest.mjs`:
```
node "C:/Users/Dell/.claude/skills/handoff-guard/scripts/selftest.mjs"
```
ครอบ: 169k → ไม่ block · 171k → block tier1 + JSON ถูก · 188k → block tier2 · fire ซ้ำ session เดิม → เงียบ (marker กัน)

**2. Live test** (พิสูจน์ว่า `decision:block` ปลุก Claude จริงในเวอร์ชันนี้):
- ตั้งชั่วคราว `HANDOFF_GUARD_THRESHOLD=1` (env หรือแก้ default) → คุยอะไรก็ได้ 1 ประโยค → Claude ควรถูก "block" แล้วเด้งมา invoke `handoff-guard` ทันที
- ผ่านแล้วคืนค่า 170000 + ลบ marker เก่า: ลบโฟลเดอร์ `~/.claude/.handoff-guard/*.t1 *.t2`

## Tune

| อยากได้ | ทำ |
|--------|----|
| เตือนเร็ว/ช้าขึ้น | env `HANDOFF_GUARD_THRESHOLD` (default 170000), `HANDOFF_GUARD_THRESHOLD2` (188000) |
| auto-compact ยิงก่อน 170k (ไม่ทันเตือน) | ลด threshold ลง (เช่น 160000) — สังเกตจาก live ว่า compaction เกิดที่กี่ token |
| รีเซ็ตการเตือนของ session | ลบไฟล์ marker ใน `~/.claude/.handoff-guard/<session_id>.t1/.t2` |

## ข้อจำกัด (ตรงไปตรงมา)
- Stop hook fire **หลัง** Claude จบเทิร์น — ถ้าเทิร์นเดียวพุ่งทะลุหลาย tier จะ fire tier สูงสุดที่ถึง
- ถ้า auto-compact ของ Claude Code ยิง **ก่อน** ถึง threshold → ต้องลด threshold (จูนตามที่สังเกตจริง)
- chip / spawn_task **ทำให้ deterministic ไม่ได้** (เป็นดุลพินิจ model) — guard นี้คุมเรื่อง handoff/context เท่านั้น
