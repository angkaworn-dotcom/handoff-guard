# Context Manager (V2) — Setup / Verify / Tune

> slug ยังเป็น `handoff-guard` · ดีไซน์เต็มดู [docs/V2-design.md](docs/V2-design.md)

## องค์ประกอบ (3 ส่วน + 1 state)

| ไฟล์ | บทบาท |
|------|-------|
| `~/.claude/hooks/context-guard.mjs` | **Stop hook** — L1 วัด token จริงทุกเทิร์น + L2 EWMA growth → ETA · ทริก (predict / ≥170k / ≥188k) → block + ฉีดให้ invoke skill `handoff-guard` |
| `~/.claude/hooks/session-resume.mjs` | **SessionStart hook** — เจอไฟล์ handoff ในโปรเจกต์/last-handoff → ฉีดตัวชี้ให้ session ใหม่อ่าน |
| `~/.claude/skills/handoff-guard/SKILL.md` | **AI eval (L3+L4)** — ตัดสินว่าควรขึ้น session ใหม่ไหม + ทำ handoff + verify ตอน resume |
| `~/.claude/.handoff-guard/<session>.state.json` | **L2 state** — `{lastTokens, ema, turns}` ต่อ session (hook เขียน/อ่านเอง คำนวณ EWMA ข้ามเทิร์น) |

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

## วิธี predict ทำงาน (L2)

ทุกเทิร์น hook คำนวณ `delta = tokens - lastTokens` → อัปเดต **EWMA**: `ema = α·delta + (1-α)·ema` (α=0.4 ถ่วงล่าสุด, ทน spike อ่านไฟล์ใหญ่) → `etaTurns = ceil((188k - tokens) / max(ema, 500))`
ทริก **predict** เมื่อ `etaTurns ≤ K(3)` & มี ≥2 observation & token ยังไม่ถึง 170k → เตือนล่วงหน้าก่อนวิกฤต (`delta` ติดลบ = compaction → ไม่นับ, reset baseline)

## Verify

**1. ทดสอบสคริปต์แบบ deterministic** (ไม่ต้องรอ session โต) — ดู `scripts/selftest.mjs`:
```
node "C:/Users/Dell/.claude/skills/handoff-guard/scripts/selftest.mjs"
```
ครอบ: absolute (169k ไม่ block · 171k tier1 · 188k tier2 · fire ซ้ำเงียบ) + **predict** (โตสม่ำเสมอ → ยิงตอน ETA≤K ก่อน 170k · cold-start turns<2 ไม่ยิง · spike เดียวไม่ทำ ETA กระโดด · compaction delta ลบไม่พัง)

**2. Live test** (พิสูจน์ว่า `decision:block` ปลุก Claude จริงในเวอร์ชันนี้):
- ตั้งชั่วคราว `HANDOFF_GUARD_THRESHOLD=1` (env หรือแก้ default) → คุยอะไรก็ได้ 1 ประโยค → Claude ควรถูก "block" แล้วเด้งมา invoke `handoff-guard` ทันที
- ผ่านแล้วคืนค่า 170000 + ลบ marker เก่า: ลบ `~/.claude/.handoff-guard/*.{p,t1,t2}` + `*.state.json`

## Tune

| อยากได้ | ทำ |
|--------|----|
| เตือน (absolute) เร็ว/ช้าขึ้น | env `HANDOFF_GUARD_THRESHOLD` (default 170000), `HANDOFF_GUARD_THRESHOLD2` (188000) |
| predict เตือนล่วงหน้ามาก/น้อย | env `HANDOFF_GUARD_PREDICT_TURNS` (K, default 3) — มาก=เตือนเบาๆ เร็ว, น้อย=ดึงใกล้ค่อยเตือน |
| predict ไวต่อ spike มาก/น้อย | env `HANDOFF_GUARD_EMA_ALPHA` (default 0.4) — สูง=react ไว แต่กระตุกตาม spike, ต่ำ=นิ่งแต่ lag |
| auto-compact ยิงก่อน 170k (ไม่ทันเตือน) | ลด threshold ลง (เช่น 160000) — สังเกตจาก live ว่า compaction เกิดที่กี่ token |
| รีเซ็ตการเตือนของ session | ลบ marker `~/.claude/.handoff-guard/<session_id>.{p,t1,t2}` + `.state.json` (รีเซ็ต EWMA) |

## ข้อจำกัด (ตรงไปตรงมา)
- Stop hook fire **หลัง** Claude จบเทิร์น — ถ้าเทิร์นเดียวพุ่งทะลุหลาย tier จะ fire tier สูงสุดที่ถึง
- **predict ต้องมีอย่างน้อย 2 เทิร์น** กว่า EWMA จะตั้งตัว — session ที่พุ่งเร็วมากตั้งแต่ 2 เทิร์นแรกอาจข้าม predict ไปโดน absolute tier แทน (ตั้งใจ — fail-safe คุมอยู่)
- EWMA ทำนายจาก growth ที่ผ่านมา — ถ้าพฤติกรรมเปลี่ยนกะทันหัน (เริ่มอ่านไฟล์ใหญ่รัวๆ) ETA จะ lag 1-2 เทิร์นก่อนปรับ (α คุม trade-off ไว/นิ่ง)
- ถ้า auto-compact ของ Claude Code ยิง **ก่อน** ถึง threshold → ต้องลด threshold (จูนตามที่สังเกตจริง)
- chip / spawn_task **ทำให้ deterministic ไม่ได้** (เป็นดุลพินิจ model) — guard นี้คุมเรื่อง handoff/context เท่านั้น
