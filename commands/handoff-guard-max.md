---
description: ตั้งเพดาน context (MAX) ของ handoff-guard เอง — คำนวณ tier1/tier2 ใหม่อัตโนมัติ, มีผลทันทีไม่ต้อง restart
argument-hint: <max_tokens>|reset
allowed-tools: ["Bash"]
---

# /handoff-guard-max

> [English reference translation](handoff-guard-max.en.md) (this file is the one Claude Code actually loads as the command)

ตั้งเพดาน context (`MAX`) ที่ handoff-guard ใช้เตือน/predict เอง แทนการแก้ env var มือใน `settings.json`

## Argument

`$ARGUMENTS` = จำนวน token สูงสุดของ context window เช่น:
- `200000` — Claude มาตรฐาน (200k)
- `256000` — ค่า default ปัจจุบันของ handoff-guard
- `1000000` — long-context beta (1M)
- `reset` หรือ `default` — ลบ config กลับไปใช้ default (256000)

## ขั้นตอน

1. ถ้า `$ARGUMENTS` ว่าง → ถามผู้ใช้ด้วย AskUserQuestion ว่าอยากตั้งเท่าไหร่ (เสนอ 200000 / 256000 / 1000000 / reset เป็นตัวเลือก) ก่อนรันสคริปต์
2. ถ้า `$ARGUMENTS` ไม่ใช่ตัวเลขและไม่ใช่ `reset`/`default` → บอกผู้ใช้ว่าใส่ผิดรูปแบบ พร้อมตัวอย่างที่ถูก แล้วหยุด (อย่าเดาค่า)
3. รันสคริปต์ตั้งค่า (หา path จริงก่อนด้วย `ls ~/.claude/skills/handoff-guard/scripts/set-max.mjs` เผื่อผู้ใช้ติดตั้งคนละ path):
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/set-max.mjs $ARGUMENTS
   ```
4. อ่าน stdout ของสคริปต์ (บอก MAX/tier1/tier2 ที่ตั้งใหม่ หรือ error ถ้าค่าไม่ถูกต้อง เช่น tier1 ≥ tier2, เกินขอบเขต) แล้วสรุปให้ผู้ใช้อ่านรู้เรื่อง — ไม่ต้อง paraphrase ตัวเลข ยกมาตรง ๆ
5. ถ้าสคริปต์หา path ไม่เจอ (ยังไม่ได้ติดตั้ง handoff-guard หรือ path ต่างจากที่คาด) → บอกผู้ใช้ตรง ๆ ว่าไม่เจอไฟล์ที่ path ไหน และให้เช็ค `~/.claude/skills/handoff-guard/scripts/` หรือ path ที่ตั้งไว้ตอนติดตั้งจริง — ห้ามสร้างสคริปต์ใหม่ทับ

## หมายเหตุ

- ตั้งค่าแล้วมีผล **เทิร์นถัดไปทันที** — hook (`context-guard.mjs`) อ่าน `~/.claude/.handoff-guard/config.json` สดทุกครั้งที่ทำงาน ไม่ต้อง restart session
- ถ้าเคยตั้ง env var `HANDOFF_GUARD_MAX`/`HANDOFF_GUARD_THRESHOLD`/`HANDOFF_GUARD_THRESHOLD2` ไว้ใน `settings.json` — env var จะ**ชนะ**ค่าที่ตั้งผ่านคำสั่งนี้เสมอ (ไว้สำหรับ override ชั่วคราว/testing) ถ้าตั้งผ่าน `/handoff-guard-max` แล้วดูเหมือนไม่มีผล ให้เช็คว่ามี env var ค้างอยู่หรือไม่
- tier1/tier2 คำนวณอัตโนมัติที่ 72%/85% ของ MAX เว้นแต่ระบุเองครบ 3 ค่า (`node set-max.mjs <max> <t1> <t2>`)
