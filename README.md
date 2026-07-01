# handoff-guard — Context Manager (V2)

> [English](README.en.md)

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

**ทางลัด — คำสั่งเดียวจบ** (คัดลอก skill+hooks+command → merge `settings.json` → ติดตั้ง dependency `handoff` ให้ครบ):

```bash
# Windows (PowerShell)
pwsh -File install.ps1        # หรือ: powershell -ExecutionPolicy Bypass -File install.ps1
# macOS / Linux
sh install.sh
```

installer เช็ค `node` ก่อน (ไม่มี → เตือน + ลิงก์ติดตั้ง แล้วหยุด) · idempotent (รันซ้ำได้ — copy ทับด้วยของล่าสุด, `settings.json` เพิ่มเฉพาะ hook ที่ยังไม่มี ไม่ทับของเดิม + สำรอง `.bak`) · เสร็จแล้ว **restart session** เพื่อโหลด skill/hooks

<details><summary>ติดตั้งมือ (ถ้าไม่อยากใช้ installer)</summary>

```bash
# 1) skill (รวม scripts/ + vendor/ — vendor มีสำเนา handoff ไว้ auto-install)
cp -r SKILL.md SETUP.md scripts vendor  ~/.claude/skills/handoff-guard/
# 1b) ensure handoff ติดตั้ง (ถ้ายังไม่มี จะ copy จาก vendored ให้)
node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs
# 2) hooks
cp hooks/context-guard.mjs hooks/session-resume.mjs  ~/.claude/hooks/
# 3) เพิ่ม hooks ใน ~/.claude/settings.json (ดู settings.example.json — แก้ path ตามเครื่อง)
# 4) (ทางเลือก) slash command /handoff-guard-max — ตั้งเพดาน MAX เองไม่ต้องแก้ env var
cp commands/handoff-guard-max.md  ~/.claude/commands/
```
</details>

ต้องมี `node` บน PATH (hooks เขียนด้วย Node = ข้ามแพลตฟอร์ม ไม่พึ่ง jq/bash)

**command ใน settings.json** ต้องเป็น absolute path:
- Windows: `node "C:/Users/<you>/.claude/hooks/context-guard.mjs"`
- macOS/Linux: `node "$HOME/.claude/hooks/context-guard.mjs"`

## Verify

```bash
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # ต้อง ALL PASS (28 เคส)
```
ครอบ: absolute tier (regression) + predict (โตสม่ำเสมอ→ยิงก่อน T1) + cold-start + spike-dampening + compaction + **model-adaptive ceiling (opus 256k vs sonnet 200k)**
Live test: ตั้ง `HANDOFF_GUARD_THRESHOLD=1` ชั่วคราว → คุย 1 ประโยค → Claude ควรถูก block แล้วเด้งไป skill `handoff-guard` → เสร็จแล้ว `unset HANDOFF_GUARD_THRESHOLD` (กลับไป auto) + ลบ marker ใน `~/.claude/.handoff-guard/` (`*.{p,t1,t2}` + `*.state.json`)

## จูน

**วิธีเร็วสุด — สั่ง `/handoff-guard-max <max>`** (เช่น `/handoff-guard-max 200000`) ตั้งเพดานเองได้ทันที ไม่ต้องแก้ `settings.json`/env — คำนวณ tier1/tier2 (85%/94%) ให้อัตโนมัติ, บันทึกที่ `~/.claude/.handoff-guard/config.json`, มีผลเทิร์นถัดไปไม่ต้อง restart · `/handoff-guard-max reset` กลับ default

หรือแก้ตรง env ก็ได้ (env ชนะ config.json เสมอ — เหมาะกับ override ชั่วคราว/testing):

| env | default | ความหมาย |
|-----|---------|----------|
| `HANDOFF_GUARD_THRESHOLD` | `round(MAX×0.85)` | tier1 (absolute) — เตือน/ประเมิน |
| `HANDOFF_GUARD_THRESHOLD2` | `round(MAX×0.94)` | tier2 (absolute) — ด่วน + เป้าของ ETA |
| `HANDOFF_GUARD_MAX` | auto-detect ตามโมเดล | เพดานบริบท — opus 256k · sonnet/haiku 200k · ไม่รู้จัก 200k |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | K — predict ยิงเมื่อคาดอีก ≤ K เทิร์นจะเต็ม |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | น้ำหนัก EWMA (สูง=react ไว, ต่ำ=นิ่ง) |

> priority ของ MAX: **env var > `config.json` (pin ผ่าน `/handoff-guard-max`, ทุกโมเดล) > auto-detect จาก `message.model` > fallback 200k** · T1/T2 ก็ priority เดียวกัน (env → config → `round(MAX×0.85)` / `round(MAX×0.94)`)
> **สลับ Opus/Sonnet บ่อย → ปล่อย auto-detect (อย่า pin)** · จูน auto-compact ให้โมเดลเดียว → pin ด้วย `/handoff-guard-max`

ดูรายละเอียดเต็มใน [SETUP.md](SETUP.md) · ดีไซน์ V2 ใน [docs/V2-design.md](docs/V2-design.md)
