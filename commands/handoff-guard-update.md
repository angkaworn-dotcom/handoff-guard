---
description: อัปเดต handoff-guard + skill handoff (Matt Pocock) เป็นเวอร์ชันล่าสุดในคำสั่งเดียว — เช็คก่อน อัปเดตเมื่อยืนยัน
argument-hint: (ไม่มี argument)
allowed-tools: ["Bash", "AskUserQuestion"]
---

# /handoff-guard-update

> [English reference translation](handoff-guard-update.en.md) (this file is the one Claude Code actually loads as the command)

อัปเดตสองส่วนพร้อมกัน: **handoff-guard เอง** (ดึงจาก repo main) และ **skill `handoff` ของ Matt Pocock** (ดึงจาก upstream) — การอัปเดตเป็นคำสั่งที่ผู้ใช้สั่งเองเสมอ ไม่มี auto-pull เงียบๆ

## ขั้นตอน

1. เช็คก่อนว่ามีอะไรใหม่ (ไม่เขียนอะไร):
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/update.mjs --check
   ```
2. อ่าน stdout แล้วสรุปให้ผู้ใช้: ส่วนไหนมีของใหม่บ้าง (รายชื่อไฟล์ที่เปลี่ยนของ handoff-guard / diff ของ skill handoff) — ยกจาก stdout ตรงๆ อย่า paraphrase ตัวเลขหรือชื่อไฟล์
3. **ทั้งสองส่วนตรงกับล่าสุดแล้ว** → บอกผู้ใช้ว่าล่าสุดแล้ว จบ ไม่ต้องทำต่อ
4. **มีของใหม่** → ถามผู้ใช้ด้วย AskUserQuestion ว่าจะอัปเดตเลยไหม (โชว์สรุปสิ่งที่จะเปลี่ยนในคำถาม) — ยืนยันแล้วค่อยรัน:
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/update.mjs
   ```
5. อ่านผลแล้วสรุป: อัปเดตอะไรไปบ้าง + เตือนว่าต้อง **restart Claude Code session** ถึงจะได้ hook/skill ตัวใหม่ (ของเดิมยังทำงานอยู่จนกว่าจะ restart)
6. สคริปต์ fail (เช่น เน็ตไม่ได้ / tarball ผิด / เนื้อหา upstream ไม่ผ่าน validation) → ยก error จาก stdout/stderr มาบอกตรงๆ ห้ามเดา ห้ามแก้ไฟล์มือแทนสคริปต์

## หมายเหตุ

- `--check` ปลอดภัยเสมอ (อ่านอย่างเดียว) — ส่วนอัปเดตจริงจะสำรองของเดิมให้: settings.json → `.bak`, skill handoff เดิม → `SKILL.md.bak`
- ส่วนของ Matt ผ่าน validation ก่อนเขียนเสมอ — เนื้อหาที่ไม่ใช่ skill `handoff` จริงถูกปฏิเสธ ไม่แตะไฟล์เดิม
- อัปเดตเฉพาะส่วนของ Matt อย่างเดียวก็ได้: `node ~/.claude/skills/handoff-guard/scripts/ensure-handoff.mjs --update`
