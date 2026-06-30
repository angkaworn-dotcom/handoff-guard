# handoff-guard — Context Manager (V2)

Claude Code skill + hooks ที่ทำให้ **handoff ตอน context ใกล้เต็มแม่นยำ** — แทนที่จะพึ่งกฎนุ่มๆ ใน CLAUDE.md/memory (ที่ model มักลืม/ปล่อยจนเต็ม 256k) ใช้ **Stop hook อ่าน token จริงทุกเทิร์น** เป็นตัว trigger + **AI ประเมิน**ว่าควรขึ้น session ใหม่ไหม + **chip/handoff doc** ให้ต่อสะดวก

> **V2 = predictive** เพิ่ม "มิติเวลา" — ไม่ใช่แค่รอ token ถึง 218k แต่ติดตามอัตราโตของ context ข้ามเทิร์น (EWMA) → **ทำนายว่าอีกกี่เทิร์นจะเต็ม** → เตือนล่วงหน้าตั้งแต่ยังไม่วิกฤต โดยคง threshold เดิมเป็น safety net · slug ยังเป็น `handoff-guard` (invoke ด้วยชื่อนี้)

## 4 ชั้น: Observe → Predict → Decide → Recover

| Layer | หน้าที่ | อยู่ที่ |
|-------|---------|--------|
| **L1 Observe** | อ่าน token จริง + delta/เทิร์น | `hooks/context-guard.mjs` (deterministic) |
| **L2 Predict** | EWMA growth → ETA "อีกกี่เทิร์นถึง 240k" | `hooks/context-guard.mjs` (deterministic) |
| **L3 Decide** | finish step vs handoff (ดู tier ที่ทริก) | `SKILL.md` (AI) |
| **L4 Recover** | resume → **verify** → continue | `hooks/session-resume.mjs` + `SKILL.md` |

**Dependency:** ใช้ skill `handoff` ของ Matt Pocock ([mattpocock/skills](https://github.com/mattpocock/skills) → `skills/productivity/handoff`) สร้าง handoff doc — guard นี้ **บังคับใช้** (คุณภาพดีกว่า: เซฟ temp ไม่รก repo, suggested-skills, เลี่ยง duplicate, redact secret) · **ถ้ายังไม่มี → ติดตั้งให้อัตโนมัติ** ผ่าน `scripts/ensure-handoff.mjs` (ดึงจาก upstream → fallback สำเนา `vendor/handoff/` ถ้า offline) แล้ว restart · นอกนั้นพึ่งแค่ `node` บน PATH

> `vendor/handoff/` = สำเนา offline ของ skill `handoff` (© Matt Pocock, mattpocock/skills) bundle ไว้เป็น fallback ตอน ensure

## ทำไมถึงแม่นกว่ากฎนุ่มๆ

| ส่วน | กลไก |
|------|------|
| **Observe** | `Stop` hook (`hooks/context-guard.mjs`) อ่าน `transcript_path` → รวม `usage` ของ assistant message ล่าสุด (`input + cache_read + cache_creation + output`) = token จริงที่ API รายงาน |
| **Predict** | เก็บ `<session>.state.json` `{lastTokens, ema, turns}` → EWMA growth (α=0.4, ทน spike อ่านไฟล์ใหญ่) → `etaTurns = ceil((240k − tokens) / max(ema, 500))` |
| **Trigger** | `decision:block` ปลุก Claude ให้ทำ handoff · priority: **predict** (etaTurns ≤ K=3, ยังไม่ถึง 218k) → **tier1** (≥218k) → **tier2** (≥240k ด่วน) · marker `.p/.t1/.t2` กันเตือนซ้ำ · ส่ง `tier/tokens/rate/etaTurns` ให้ skill |
| **ตัดสิน** | skill `SKILL.md` — AI ประเมิน (ปิด atomic op ก่อน → handoff เลย vs ทำต่อให้จบ step) · predict = buffer เยอะ ปิด step ได้ก่อน · ยืดหยุ่นกว่า hard cutoff |
| **Recovery** | `SessionStart` hook (`hooks/session-resume.mjs`) เจอ `HANDOFF.md`/last-handoff → ฉีดตัวชี้ให้ session ใหม่อ่าน → skill รัน **verify** (git status/branch/`npm run check`/ตรง handoff ไหม) ก่อน continue |

> ข้อจำกัด: predict ต้องมี ≥2 เทิร์นให้ EWMA ตั้งตัว (พุ่งเร็วตั้งแต่ต้น → absolute tier คุมแทน) · ถ้า auto-compact ยิงก่อนถึง threshold ต้องลด threshold (จูนที่ env) · chip/spawn_task เป็นดุลพินิจ model ทำ deterministic ไม่ได้

## ติดตั้ง

```bash
# 1) skill (รวม scripts/ + vendor/ — vendor มีสำเนา handoff ไว้ auto-install)
cp -r SKILL.md SETUP.md scripts vendor  ~/.claude/skills/handoff-guard/
# 1b) ensure handoff ติดตั้ง (ถ้ายังไม่มี จะ copy จาก vendored ให้)
node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs
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
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # ต้อง ALL PASS (21 เคส)
```
ครอบ: absolute tier (regression) + predict (โตสม่ำเสมอ→ยิงก่อน 218k) + cold-start + spike-dampening + compaction
Live test: ตั้ง `HANDOFF_GUARD_THRESHOLD=1` ชั่วคราว → คุย 1 ประโยค → Claude ควรถูก block แล้วเด้งไป skill `handoff-guard` → คืน 218000 + ลบ marker ใน `~/.claude/.handoff-guard/` (`*.{p,t1,t2}` + `*.state.json`)

## จูน

| env | default | ความหมาย |
|-----|---------|----------|
| `HANDOFF_GUARD_THRESHOLD` | 218000 | tier1 (absolute) — เตือน/ประเมิน · = 85% ของเพดาน 256k |
| `HANDOFF_GUARD_THRESHOLD2` | 240000 | tier2 (absolute) — ด่วน + เป้าของ ETA · = 94% ของเพดาน 256k |
| `HANDOFF_GUARD_MAX` | 256000 | เพดานบริบท (display) — เกินนี้เริ่มเสียบริบท |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | K — predict ยิงเมื่อคาดอีก ≤ K เทิร์นจะเต็ม |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | น้ำหนัก EWMA (สูง=react ไว, ต่ำ=นิ่ง) |

> เพดาน 256k → T1/T2 = 85%/94% · เปลี่ยนเพดานในอนาคต: T1 = MAX×0.85, T2 = MAX×0.94

ดูรายละเอียดเต็มใน [SETUP.md](SETUP.md) · ดีไซน์ V2 ใน [docs/V2-design.md](docs/V2-design.md)
