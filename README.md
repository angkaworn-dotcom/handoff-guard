# handoff-guard

> [English](README.en.md)

พอคุยกับ Claude Code ไปนานๆ context จะเต็ม แล้ว Claude Code จะ **auto-compact** — บีบอัดบทสนทนาโดยทิ้งของเก่าทิ้งไป ซึ่งมักทำให้งานที่ค้างอยู่หายหรือเพี้ยน วิธีที่คนใช้กันคือเขียนกฎใน CLAUDE.md/memory ว่า "ใกล้เต็มแล้วให้สรุปงานส่งต่อ" แต่ model มักลืม หรือปล่อยจนเต็มไปก่อน

**handoff-guard แก้ตรงนี้** — เป็น skill + hook ของ Claude Code ที่คอยวัด token จริงทุกเทิร์น พอใกล้เต็มมันจะ **หยุด Claude แล้วบังคับให้สรุปงานเป็นเอกสารส่งต่อ (handoff) ก่อน** จากนั้นเปิด session ใหม่ Claude จะอ่านเอกสารนั้นทำงานต่อได้เลย ไม่ต้องพึ่งความจำของ model

## ทำงานยังไง

ทุกครั้งที่ Claude ตอบจบ hook จะทำ 4 อย่าง:

1. **วัด** — อ่านจำนวน token ที่ใช้ไปจริงจาก transcript
2. **ทำนาย** — จำอัตราการโตของ context ไว้ แล้วประเมินว่า "อีกกี่เทิร์นจะเต็ม"
3. **เตือน** — ถ้าใกล้เต็ม (หรือคาดว่าจะเต็มเร็วๆ นี้) จะหยุด Claude แล้วสั่งให้ทำ handoff
4. **ต่อ** — พอเปิด session ใหม่ hook อีกตัวจะชี้ให้ Claude อ่าน handoff ก่อนเริ่มงาน

การเตือนมี 3 ระดับ:

- 🟡 **ล่วงหน้า** — คาดว่าอีกไม่กี่เทิร์นจะเต็ม (ยังมีเวลาปิดงานที่ค้างให้เรียบร้อยก่อน)
- ⚠️ **ใกล้เต็ม** — ถึง 72% ของเพดาน (ยิงก่อน Claude Code auto-compact ที่ ~85%)
- 🔴 **ด่วน** — ถึง 85% ของเพดาน

มันรู้เพดานของแต่ละ model เอง (Fable/Mythos 512k, Opus 256k, Sonnet/Haiku 200k, โหมด long-context `[1m]` 1M) และถ้า session โดน compact ไปแล้วโตกลับมาใกล้เต็มอีก มันจะเตือนซ้ำได้

## ต้องมีอะไรก่อน

- **Node.js** อยู่บน PATH (hook เขียนด้วย Node ใช้ได้ทุก OS ไม่ต้องพึ่ง jq/bash)
- skill `handoff` ของ Matt Pocock (ตัวที่สร้างเอกสาร handoff จริงๆ) — **ถ้ายังไม่มี ตัวติดตั้งจะจัดให้อัตโนมัติ**

## ติดตั้ง

คำสั่งเดียวจบ — คัดลอกไฟล์ + ตั้งค่าใน `settings.json` + ติดตั้ง dependency ให้ครบ:

```bash
# Windows (PowerShell)
pwsh -File install.ps1
# macOS / Linux
sh install.sh
```

รันซ้ำได้ปลอดภัย (ทับด้วยของล่าสุด, เพิ่ม hook เฉพาะที่ยังไม่มีโดยไม่ทับของเดิม, สำรองไฟล์ `.bak` ให้) เสร็จแล้ว **restart Claude Code** เพื่อโหลด skill/hook ใหม่

<details><summary>ติดตั้งเอง (ถ้าไม่อยากใช้ตัวติดตั้ง)</summary>

```bash
# 1) skill (รวม scripts/ กับ vendor/ ที่มีสำเนา handoff ไว้ติดตั้งอัตโนมัติ)
cp -r SKILL.md SETUP.md scripts vendor  ~/.claude/skills/handoff-guard/
# 2) ให้แน่ใจว่า skill handoff ติดตั้งแล้ว (ถ้ายังไม่มีจะ copy จากสำเนาให้)
node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs
# 3) hooks
cp hooks/context-guard.mjs hooks/session-resume.mjs  ~/.claude/hooks/
# 4) เพิ่ม hook ใน ~/.claude/settings.json (ดูตัวอย่างใน settings.example.json แก้ path ตามเครื่อง)
# 5) (ทางเลือก) คำสั่ง /handoff-guard-max สำหรับตั้งเพดานเอง
cp commands/handoff-guard-max.md  ~/.claude/commands/
```

path ใน `settings.json` ต้องเป็น absolute:
- Windows: `node "C:/Users/<you>/.claude/hooks/context-guard.mjs"`
- macOS/Linux: `node "$HOME/.claude/hooks/context-guard.mjs"`
</details>

## เช็คว่าใช้ได้

```bash
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs   # ต้องขึ้น ALL PASS (38 เคส)
```

อยากลองของจริง: ตั้ง `HANDOFF_GUARD_THRESHOLD=1` ชั่วคราว แล้วพิมพ์อะไรสักประโยค — Claude ควรโดนหยุดแล้วเด้งไปทำ handoff เสร็จแล้ว `unset HANDOFF_GUARD_THRESHOLD` (กลับไป auto) และลบไฟล์ marker ใน `~/.claude/.handoff-guard/` (`*.p`, `*.t1`, `*.t2`, `*.state.json`)

## ปรับแต่ง

ปกติไม่ต้องตั้งอะไร — มันปรับเพดานตาม model ให้เอง แต่ถ้าอยากกำหนดเอง:

**ง่ายสุด** พิมพ์ในแชท `/handoff-guard-max <ตัวเลข>` — ตั้งเพดานทันที มีผลเทิร์นถัดไปไม่ต้อง restart **ตั้งให้ตรงกับการใช้งานจริงของคุณ**:

| ใช้งานแบบไหน | ตั้งยังไง |
|---|---|
| สลับหลายโมเดล / ไม่อยากคิดมาก | `/handoff-guard-max reset` → ปล่อยให้ auto-detect ตามโมเดล **(แนะนำ)** |
| อยู่โมเดลเดียวเป็นหลัก | pin เท่า window โมเดลนั้น — Opus `256000` · Fable/Mythos `512000` · Sonnet/Haiku `200000` |
| อยากให้เตือนเร็ว/ถี่ขึ้น | pin ต่ำลง เช่น `/handoff-guard-max 150000` |
| อยากปิดการเตือน (ให้ Claude Code auto-compact เองไปเลย) | `/handoff-guard-max 0` — ปิด guard สนิท ไม่เตือน/ไม่ block · เปิดคืนด้วย `/handoff-guard-max reset` |

หรือตั้งผ่าน env (env ชนะทุกอย่างเสมอ เหมาะกับ override ชั่วคราว/ทดสอบ):

| env | ค่า default | ความหมาย |
|-----|-------------|----------|
| `HANDOFF_GUARD_MAX` | auto ตาม model | เพดาน context — Fable/Mythos 512k, Opus 256k, Sonnet/Haiku/ไม่รู้จัก 200k, `[1m]` 1M · **`0` = ปิด guard** |
| `HANDOFF_GUARD_THRESHOLD` | 72% ของเพดาน | ระดับ "ใกล้เต็ม" (ยิงก่อน CC auto-compact ~85%) |
| `HANDOFF_GUARD_THRESHOLD2` | 85% ของเพดาน | ระดับ "ด่วน" |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | เตือนล่วงหน้าเมื่อคาดว่าอีก ≤ กี่เทิร์นจะเต็ม |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | ความไวในการจับอัตราการโต (สูง = ไวขึ้น, ต่ำ = นิ่งขึ้น) |

ลำดับความสำคัญของเพดาน: **env > ค่าที่ pin ด้วย `/handoff-guard-max` > auto-detect ตาม model > 200k (ค่าปลอดภัยสุด)**

## ข้อควรรู้ / ข้อจำกัด

- **ถ้า Claude Code auto-compact ก่อนที่ handoff-guard จะเตือน** guard จะเงียบ (เกิดได้บน model เพดานต่ำอย่าง Sonnet) — แก้ด้วยการลดเพดานลง เช่น `/handoff-guard-max 150000` ให้เตือนเร็วขึ้น
- **Fable/Mythos ตั้งเพดานไว้ 512k** (สูงกว่าโมเดลอื่น) เพราะ context window จริงใหญ่มาก — spec คือ 1M และสังเกตจริงว่าโตทะลุ 400k โดยที่ Claude Code ยังไม่ auto-compact ถ้าตั้งเท่า Opus (256k) guard จะเตือนเร็วเกินไปทั้งที่ยังเหลือ buffer อีกมหาศาล · ถ้าอยากดันให้สุดตาม spec ใช้ `/handoff-guard-max 1000000` (แต่ยังไม่ยืนยันว่า Claude Code สั่ง auto-compact ที่จุดไหนบน window 1M)
- เป็น **เครื่องมือส่วนตัว** ที่ผูกกับรูปแบบ transcript ภายในของ Claude Code — ถ้า Claude Code เปลี่ยน format วันหลังอาจต้องมาอัปเดต
- การเตือนล่วงหน้าต้องรออย่างน้อย 2 เทิร์นให้จับอัตราการโตก่อน (ถ้าพุ่งเร็วมากตั้งแต่ต้น จะใช้เกณฑ์ % แทน)

รายละเอียดเต็มอยู่ใน [SETUP.md](SETUP.md) · แนวคิดออกแบบใน [docs/V2-design.md](docs/V2-design.md)

---

ตัวสร้างเอกสาร handoff ใช้ skill `handoff` ของ Matt Pocock ([mattpocock/skills](https://github.com/mattpocock/skills)) · `vendor/handoff/` คือสำเนา offline ไว้ติดตั้งตอนไม่มีเน็ต (© Matt Pocock)
