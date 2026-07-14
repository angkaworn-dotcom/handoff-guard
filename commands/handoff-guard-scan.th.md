---
description: สแกนว่า context ตอนเปิด session ถูก preload ไปกับอะไรบ้าง (CLAUDE.md/skills/commands/settings ฯลฯ) — attribution ±30% ไม่ใช่การวัด
argument-hint: [--json]
allowed-tools: ["Bash"]
---

# /handoff-guard-scan (ฉบับอ้างอิงภาษาไทย)

> [English (functional command)](handoff-guard-scan.md)

รันเครื่องมือ diagnostic one-shot ที่ประเมินว่า "context ก้อนที่ถูกโหลดตอนเปิด session (preload)" กระจายไปกับอะไร — CLAUDE.md ระดับ global/project, คำอธิบาย skill, commands, agents, settings/hooks, memory index

**นี่คือ attribution/breakdown (±30%) ไม่ใช่การวัด** — ของจริง hook วัดจาก `usage` ของ API อยู่แล้ว (ครอบ preload + dynamic + hidden ทั้งหมด) · เครื่องมือนี้แค่บอกสัดส่วนคร่าวๆ ว่าหมวดไหนกินเยอะ เพื่อให้ผู้ใช้ตัดสินใจว่าจะลด preload อะไรได้บ้าง

## ขั้นตอน

1. หา path จริงของสคริปต์ก่อน (`ls ~/.claude/skills/handoff-guard/scripts/scan-preload.mjs`) เผื่อ path ต่าง — ไม่เจอ → บอกผู้ใช้ตรงๆ ว่าไม่เจอ ให้เช็ค `~/.claude/skills/handoff-guard/scripts/` ห้ามสร้างสคริปต์ใหม่ทับ
2. รันสคริปต์กับ project ปัจจุบัน (cwd):
   ```bash
   node ~/.claude/skills/handoff-guard/scripts/scan-preload.mjs --project "$(pwd)" $ARGUMENTS
   ```
3. อ่าน stdout แล้วสรุปให้ผู้ใช้: หมวดไหนกิน token มากสุด (ยกตัวเลข/% ตรงจาก output ไม่ paraphrase) + ไฟล์ใหญ่สุด 2-3 อันดับแรก
4. แนะนำได้แค่**เชิง attribution** เท่านั้น เช่น "CLAUDE.md global ~8k = 4% ของ MAX" — **ห้ามลบ/แก้ไฟล์ให้อัตโนมัติ** ผู้ใช้เป็นคนตัดสินว่าจะลดอะไร

## หมายเหตุ

- read-only ล้วน — สคริปต์ไม่แก้ไฟล์ใดๆ
- เพดาน `MAX` ที่ใช้คิด % เอาจาก `~/.claude/.handoff-guard/config.json` (ถ้ามี pin ผ่าน `/handoff-guard-max`) หรือ default 200000 · override เฉพาะครั้งได้ด้วย `--max <n>`
- `--json` ให้ output เป็น JSON (เผื่อ pipe ต่อ/parse เอง)
- ไฟล์ > 1MB หรืออ่านไม่ได้ถูกข้ามและนับใน "skipped" — ไม่ทำให้สคริปต์ล้ม
