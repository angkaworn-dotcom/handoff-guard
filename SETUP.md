# Context Manager (V2) — Setup / Verify / Tune

> [English](SETUP.en.md)

> slug ยังเป็น `handoff-guard` · ดีไซน์เต็มดู [docs/V2-design.md](docs/V2-design.md)

## องค์ประกอบ (3 ส่วน + 1 state)

| ไฟล์ | บทบาท |
|------|-------|
| `~/.claude/hooks/context-guard.mjs` | **Stop hook** — L1 วัด token + โมเดลจริงทุกเทิร์น + L2 EWMA growth → ETA · เพดาน **auto-detect ตามโมเดล** (fable/opus 256k · sonnet/haiku 200k · `[1m]` 1M) · ทริก (predict / ≥T1 / ≥T2) → block + ฉีดให้ invoke skill `handoff-guard` |
| `~/.claude/hooks/session-resume.mjs` | **SessionStart hook** — เจอไฟล์ handoff ในโปรเจกต์/last-handoff → ฉีดตัวชี้ให้ session ใหม่อ่าน |
| `~/.claude/skills/handoff-guard/SKILL.md` | **AI eval (L3+L4)** — ตัดสินว่าควรขึ้น session ใหม่ไหม + ทำ handoff + verify ตอน resume |
| `~/.claude/.handoff-guard/<session>.state.json` | **L2 state** — `{lastTokens, ema, turns}` ต่อ session (hook เขียน/อ่านเอง คำนวณ EWMA ข้ามเทิร์น) |
| `~/.claude/.handoff-guard/config.json` | **MAX/T1/T2 ที่ pin เอง** — เขียนโดย `scripts/set-max.mjs` (ผ่านคำสั่ง `/handoff-guard-max`), hook อ่านทุกเทิร์น · **pin ทุกโมเดล (override auto-detect)** · ไม่มีไฟล์ = auto-detect ตามโมเดล |
| `~/.claude/commands/handoff-guard-max.md` | **slash command** — `/handoff-guard-max <max>` ตั้งเพดานเองโดยไม่ต้องแก้ `settings.json` |

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

ทุกเทิร์น hook คำนวณ `delta = tokens - lastTokens` → อัปเดต **EWMA**: `ema = α·delta + (1-α)·ema` (α=0.4 ถ่วงล่าสุด, ทน spike อ่านไฟล์ใหญ่) → `etaTurns = ceil((218k - tokens) / max(ema, 500))`
ทริก **predict** เมื่อ `etaTurns ≤ K(3)` & มี ≥2 observation & token ยังไม่ถึง 184k → เตือนล่วงหน้าก่อนวิกฤต (`delta` ติดลบ = compaction → ไม่นับ, reset baseline)

## Verify

**1. ทดสอบสคริปต์แบบ deterministic** (ไม่ต้องรอ session โต) — ดู `scripts/selftest.mjs`:
```
node "C:/Users/Dell/.claude/skills/handoff-guard/scripts/selftest.mjs"
```
ครอบ: absolute (183k ไม่ block · 185k tier1 · 218k tier2 · fire ซ้ำเงียบ) + **predict** (โตสม่ำเสมอ → ยิงตอน ETA≤K ก่อน 184k · cold-start turns<2 ไม่ยิง · spike เดียวไม่ทำ ETA กระโดด · compaction delta ลบไม่พัง)

**2. Live test** (พิสูจน์ว่า `decision:block` ปลุก Claude จริงในเวอร์ชันนี้):
- ตั้งชั่วคราว `HANDOFF_GUARD_THRESHOLD=1` (env หรือแก้ default) → คุยอะไรก็ได้ 1 ประโยค → Claude ควรถูก "block" แล้วเด้งมา invoke `handoff-guard` ทันที
- ผ่านแล้วคืนค่า 184320 + ลบ marker เก่า: ลบ `~/.claude/.handoff-guard/*.{p,t1,t2}` + `*.state.json`

## เพดาน MAX มาจากไหน (priority)

hook เลือก MAX ต่อเทิร์นตามลำดับ **หยุดที่ตัวแรกที่มีค่า**:

1. **env** `HANDOFF_GUARD_MAX` — override ชั่วคราว/testing (ชนะทุกอย่าง)
2. **config.json** (`fileConfig.max`) — pin ถาวรผ่าน `/handoff-guard-max <n>` · **override auto-detect ทุกโมเดล**
3. **auto-detect จากโมเดล** — อ่าน `message.model` ของ assistant message ล่าสุดใน transcript → `[1m]` (long-context) 1M · `fable`/`mythos`/`opus` 256k · `sonnet`/`haiku`/ไม่รู้จัก 200k (ไม่รู้จัก = สมมติเล็กสุด ยิงเร็วดีกว่าไม่ยิง)

T1/T2 ก็ priority เดียวกัน (env → config → `round(MAX×0.72)` / `round(MAX×0.85)`) · โมเดลเปลี่ยนกลางเซสชันได้ → เพดานปรับตามอัตโนมัติถ้าไม่ได้ pin

> **สลับ Opus/Sonnet บ่อย → อย่า pin** (ปล่อย auto-detect) · **จูน auto-compact ให้โมเดลเดียว → pin ด้วย `/handoff-guard-max`**

## Tune

| อยากได้ | ทำ |
|--------|----|
| ล็อกเพดาน (MAX) เองแบบเร็ว ไม่แตะ settings.json | สั่ง `/handoff-guard-max <max>` (เช่น `/handoff-guard-max 200000`) — คำนวณ T1/T2 ให้ (72%/85%), เขียน config.json, มีผลเทิร์นถัดไป · **pin ทุกโมเดล** · `/handoff-guard-max reset` = กลับไป auto-detect · ติดตั้งครั้งเดียว: `cp commands/handoff-guard-max.md ~/.claude/commands/` |
| เตือน (absolute) เร็ว/ช้าขึ้น (แบบ manual/override) | env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` (default = `round(MAX×0.72)` / `round(MAX×0.85)`) — env ชนะ config.json เสมอ |
| บังคับเพดาน (display) แบบ manual/override | env `HANDOFF_GUARD_MAX` (default = auto-detect ตามโมเดล) — เกินนี้เริ่มเสียบริบท · เปลี่ยนแล้วควรปรับ T1/T2 ตาม (72%/85%) |
| predict เตือนล่วงหน้ามาก/น้อย | env `HANDOFF_GUARD_PREDICT_TURNS` (K, default 3) — มาก=เตือนเบาๆ เร็ว, น้อย=ดึงใกล้ค่อยเตือน |
| predict ไวต่อ spike มาก/น้อย | env `HANDOFF_GUARD_EMA_ALPHA` (default 0.4) — สูง=react ไว แต่กระตุกตาม spike, ต่ำ=นิ่งแต่ lag |
| auto-compact ยิงก่อน T1 (ไม่ทันเตือน) | pin เพดานต่ำลง `/handoff-guard-max <ต่ำกว่าจุด compact จริง>` — สังเกตจาก live ว่า compaction เกิดที่กี่ token |
| รีเซ็ตการเตือนของ session | ลบ marker `~/.claude/.handoff-guard/<session_id>.{p,t1,t2}` + `.state.json` (รีเซ็ต EWMA) |

## ข้อจำกัด (ตรงไปตรงมา)
- Stop hook fire **หลัง** Claude จบเทิร์น — ถ้าเทิร์นเดียวพุ่งทะลุหลาย tier จะ fire tier สูงสุดที่ถึง
- **predict ต้องมีอย่างน้อย 2 เทิร์น** กว่า EWMA จะตั้งตัว — session ที่พุ่งเร็วมากตั้งแต่ 2 เทิร์นแรกอาจข้าม predict ไปโดน absolute tier แทน (ตั้งใจ — fail-safe คุมอยู่)
- EWMA ทำนายจาก growth ที่ผ่านมา — ถ้าพฤติกรรมเปลี่ยนกะทันหัน (เริ่มอ่านไฟล์ใหญ่รัวๆ) ETA จะ lag 1-2 เทิร์นก่อนปรับ (α คุม trade-off ไว/นิ่ง)
- ถ้า auto-compact ของ Claude Code ยิง **ก่อน** ถึง threshold → ต้องลด threshold (จูนตามที่สังเกตจริง)
- chip / spawn_task **ทำให้ deterministic ไม่ได้** (เป็นดุลพินิจ model) — guard นี้คุมเรื่อง handoff/context เท่านั้น
