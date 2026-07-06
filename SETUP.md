# Context Manager (V2) — Setup / Verify / Tune

> [English](SETUP.en.md)

> slug ยังเป็น `handoff-guard` · ดีไซน์เต็มดู [docs/V2-design.md](docs/V2-design.md)

## องค์ประกอบ (3 ส่วน + 1 state)

| ไฟล์ | บทบาท |
|------|-------|
| `~/.claude/hooks/context-guard.mjs` | **Stop hook** — L1 วัด token + โมเดลจริงทุกเทิร์น + L2 EWMA growth → ETA · เพดาน **auto-detect ตามโมเดล** (fable/mythos 512k · opus 256k · sonnet/haiku 200k · `[1m]` 1M) · ทริก (predict / ≥T1 / ≥T2) → block + ฉีดให้ invoke skill `handoff-guard` |
| `~/.claude/hooks/session-resume.mjs` | **SessionStart hook** — เจอไฟล์ handoff ในโปรเจกต์/pointer per-project (`pointers/*.json`, หมดอายุ 7 วัน) → ฉีดตัวชี้ให้ session ใหม่อ่าน |
| `~/.claude/skills/handoff-guard/SKILL.md` | **AI eval (L3+L4)** — ตัดสินว่าควรขึ้น session ใหม่ไหม + ทำ handoff + verify ตอน resume |
| `~/.claude/.handoff-guard/<session>.state.json` | **L2 state** — `{lastTokens, ema, turns, lastDelta}` ต่อ session (hook เขียน/อ่านเอง คำนวณ EWMA ข้ามเทิร์น) · marker/state ที่ไม่ถูกแตะเกิน 14 วันถูกเก็บกวาดอัตโนมัติ |
| `~/.claude/.handoff-guard/config.json` | **MAX/T1/T2 ที่ pin เอง** — เขียนโดย `scripts/set-max.mjs` (ผ่านคำสั่ง `/handoff-guard-max`), hook อ่านทุกเทิร์น · **pin ทุกโมเดล (override auto-detect)** · ไม่มีไฟล์ = auto-detect ตามโมเดล |
| `~/.claude/commands/handoff-guard-max.md` | **slash command** — `/handoff-guard-max <max>` ตั้งเพดานเองโดยไม่ต้องแก้ `settings.json` |
| `~/.claude/commands/handoff-guard-update.md` | **slash command** — `/handoff-guard-update` อัปเดต handoff-guard + skill `handoff` เป็นเวอร์ชันล่าสุด (เช็คก่อน ยืนยันแล้วค่อยอัปเดต) |
| `~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs` | **เก็บกวาด worktree ของ chip** — session จาก chip เรียกเอง (step 3) · เก็บ 5 อันล่าสุดเป็น snapshot, ถอนทะเบียนที่เหลือ (ข้าม dirty / locked / ที่ยังถูกใช้ · pin ถาวรด้วย `git worktree lock` หรือ `--keep-list`) · **ไม่ลบ branch** |
| `~/.claude/.handoff-guard/pointers/<slug>.json` + `handoffs/` | **pointer per-worktree** (key ด้วย path เต็ม, หมดอายุ 7 วัน) + ที่เก็บ handoff doc ถาวร (ไม่ใช้ OS temp — โดน Disk Cleanup กวาดได้) |

## settings.json (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"C:/Users/<you>/.claude/hooks/context-guard.mjs\"", "timeout": 15 }
      ]}
    ],
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/Users/<you>/.claude/hooks/session-resume.mjs\"", "timeout": 15 }
      ]}
    ]
  }
}
```

> เปลี่ยน path ตามเครื่อง · บน Windows ใช้ forward slash ใน path ของ node ได้

## วิธี token ถูกวัด (ทำไมแม่น)

Stop hook รับ `transcript_path` ทาง stdin → อ่าน JSONL **จากท้ายไฟล์** (ไม่โหลดทั้งไฟล์ — transcript โตหลาย MB ตอนใกล้เต็ม) → หา `message.usage` ของ assistant message **ล่าสุดของ main conversation** →
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` = ขนาด context จริงที่ API รายงาน
(ไม่ใช่เดาจากจำนวนบรรทัด/ตัวอักษร) · entry ของ subagent (`isSidechain`) ถูกข้าม — context ของ subagent เป็นคนละก้อน ถ้านับปนจะทำ delta/EWMA เพี้ยน

## วิธี predict ทำงาน (L2)

ทุกเทิร์น hook คำนวณ `delta = tokens - lastTokens` → อัปเดต **EWMA**: `ema = α·delta + (1-α)·ema` (α=0.4 ถ่วงล่าสุด, ทน spike อ่านไฟล์ใหญ่) → `etaTurns = ceil((T2 - tokens) / max(ema, 500))`
ทริก **predict** เมื่อ `etaTurns ≤ K(3)` & มี ≥2 observation & token ยังไม่ถึง T1 → เตือนล่วงหน้าก่อนวิกฤต (`delta` ติดลบ = compaction → ไม่นับ, reset baseline + re-arm marker)
**overshoot guard**: ถ้า delta ล่าสุดตัวเดียวก็พาทะลุ T2 ได้ในเทิร์นหน้า (`tokens + lastDelta ≥ T2`) → ทริก predict ทันทีไม่รอ EWMA ปรับตัว (กันเคส "เทิร์นยักษ์" อ่านไฟล์ใหญ่รวดเดียวข้าม T1 ไป T2)

## Verify

**1. ทดสอบสคริปต์แบบ deterministic** (ไม่ต้องรอ session โต) — มี **2 ชุด ต้องผ่านทั้งคู่**:
```
node ~/.claude/skills/handoff-guard/scripts/selftest.mjs    # ต้องขึ้น ALL PASS
node <repo>/scripts/updater-selftest.mjs                    # ต้องขึ้น ALL PASS — รันจาก repo checkout เท่านั้น
```
- `selftest.mjs` ครอบ hook: absolute (183k ไม่ block · 185k tier1 · 218k tier2 · fire ซ้ำเงียบ) + **predict** (โตสม่ำเสมอ → ยิงตอน ETA≤K ก่อน 184k · "ครั้งเดียว/session" ตัดสินด้วย marker จริง (α=0 คุมเลขคณิตไม่ให้ช่วยเงียบ) · cold-start turns<2 ไม่ยิง · spike เดียวไม่ทำ ETA กระโดด · compaction delta ลบไม่พัง) + **sidechain** ของ subagent ถูกข้าม (ไม่พัง EWMA) + **re-arm** ลบ marker ครบทุกตัวหลัง compact + **overshoot guard** เทิร์นยักษ์ยิง predict ทันที + **sweep** marker/state เก่าเกิน 14 วันถูกกวาด + เพดานต่อโมเดล + **env MAX override ข้าม t1/t2 ที่ pin ในไฟล์** (คิด % ใหม่จาก env MAX · env T1/T2 ยังชนะเสมอ) + kill switch (รวม env ว่าง `""` ไม่ mask config `{max:0}` · config max ไม่ใช่ตัวเลข → fallback เพดานโมเดล ไม่ใช่ NaN ปิด guard เงียบ) + **F3 cost warnings** (ทุก tier มี cost phrase "เหลือ ~ tok ก่อนเพดาน" + `etaTurns` ใน bracket · tier2 มีเหตุผล auto-compact/degrade + `etaTurns=0`) + **F4 ROI engine** (มี stats ≥5 → ช่วง ROI + label ตรงตาราง (tier2→Critical, tier1 ROI≥20→Recommended) · ไม่มี stats → default range + "ยังไม่มีสถิติ" · `HANDOFF_GUARD_ROI=0` → ไม่มีบรรทัด ROI · stats เสีย → ไม่ crash · env override prompts) · ทุกเช็คเงียบ assert exit 0 ด้วย (hook crash เงียบไม่ถูกนับเป็นผ่าน)
- `updater-selftest.mjs` ครอบ pipeline ติดตั้ง/อัปเดต (hermetic — fakeHome + mock GitHub, ไม่แตะ `~/.claude` จริง/เน็ต): install สด + idempotent · `update --check` ไม่ false-positive จาก CRLF≡LF (#7) · tar extract บน path `C:\` (#6) · detect เนื้อต่างจริง + `--check` ไม่เขียนทับ (อ่านไฟล์กลับยืนยัน) · update full end-to-end · `ensure-handoff --check` ทั้งเคสมีเวอร์ชันใหม่และเคส CRLF≡LF · **G** ปลายทางของ installMap (เทียบ full-equality + negative control ว่า dest วางผิดที่ถูก reject) · **H** ทุก dest ใน installMap โผล่จริงหลัง full update (+ ไม่มี `.en.md` หลุด) · **I** ลำดับใน installMap (scripts เรียง provider ก่อน importer: `update.mjs` → `ensure-handoff.mjs` → `install.mjs` — กัน mixed-version window ถ้า copy ถูกขัดกลางคัน) · **J** drift guard เทียบ repo จริง (ทุก hook จริง + ทุก command ที่ไม่ใช่ `.en.md` ใน checkout ต้องอยู่ใน installMap) · **K** `prune-worktrees.mjs` บน fixture git repo + worktree จริง (`--dry` ไม่แตะอะไร · ลบเฉพาะ clean+เก่าเกิน keep แล้วถอนทะเบียนจริง · dirty / locked / keep-list (รวม case-insensitive) / recent / self / worktree นอก `.claude/worktrees` รอดครบทุกชั้น · `--keep 0` ไม่ถูกกลืนเป็น default · `--keep` ติดลบ → error ไม่ใช่ clamp เป็น 0 · rename ที่ต้นทางใต้ ignore-dirt แต่ปลายทางเป็นไฟล์จริงนับ dirty · dir ตกค้างที่ git ไม่รู้จักได้แค่คำเตือน ไม่ถูกลบ) · **L** `set-max.mjs` เขียน config แบบ merge (field ที่ไม่รู้จักเช่น `windows` ไม่หาย ทั้งตั้งค่าปกติและ kill switch) + floor t1/t2 (ใส่เป็น % โดยเข้าใจผิด → ปฏิเสธ ไม่เขียนไฟล์) · **M** update full ที่ส่วน handoff ล้มเหลว → exit 1 + ไม่มี banner "🎉 อัปเดตเสร็จ" หลอก · **N** `ensure-handoff` เจอ SKILL.md torn (ว่าง/เขียนค้าง) → self-heal จาก vendored ไม่ใช่ "already installed" (ไฟล์สมบูรณ์ยัง already ตามเดิม) · **O** `install.mjs` กับ settings.json รูปทรงแปลก (`null`/`[]` → เตือน+ข้าม merge ไม่ crash/ไม่เขียนทับเงียบ · ชื่อไฟล์ hook ใน field อื่นไม่หลอกว่า "ติดตั้งแล้ว") · **P** sanity check `name: handoff` แบบ anchored (skill ผิดตัวเช่น `handoff-guard` ไม่ผ่าน · vendored เนื้อผิด → fail ดัง ไม่ติดตั้งขยะ) · **Q** `session-resume` (summarize "งานถัดไป" ไม่หยิบ bullet ข้าม section · path match case-insensitive บน win32) · เช็ค worker liveness (mock HTTP server ไม่ตายกลางชุดเทสต์) · **ต้องรันจาก repo checkout** (clone/worktree) — ทดสอบการติดตั้งจากโครง repo จริง สำเนาใน `~/.claude` ไม่มี `hooks/` `commands/` ครบ

**2. Live test** (พิสูจน์ว่า `decision:block` ปลุก Claude จริงในเวอร์ชันนี้):
- ตั้งชั่วคราว `HANDOFF_GUARD_THRESHOLD=1` (env หรือแก้ default) → คุยอะไรก็ได้ 1 ประโยค → Claude ควรถูก "block" แล้วเด้งมา invoke `handoff-guard` ทันที
- ผ่านแล้วคืนค่า 184320 + ลบ marker เก่า: ลบ `~/.claude/.handoff-guard/*.{p,t1,t2}` + `*.state.json`

## เพดาน MAX มาจากไหน (priority)

hook เลือก MAX ต่อเทิร์นตามลำดับ **หยุดที่ตัวแรกที่มีค่า**:

1. **env** `HANDOFF_GUARD_MAX` — override ชั่วคราว/testing (ชนะทุกอย่าง)
2. **config.json** (`fileConfig.max`) — pin ถาวรผ่าน `/handoff-guard-max <n>` · **override auto-detect ทุกโมเดล**
3. **auto-detect จากโมเดล** — อ่าน `message.model` ของ assistant message ล่าสุดใน transcript → `[1m]` (long-context) 1M · `fable`/`mythos` 512k (window ใหญ่มาก — spec 1M, ตั้ง 512k เป็นกันชนกันเตือนเร็วเกิน) · `opus` 256k · `sonnet`/`haiku`/ไม่รู้จัก 200k (ไม่รู้จัก = สมมติเล็กสุด ยิงเร็วดีกว่าไม่ยิง)
   > pattern พวกนี้ผูกกับ format ชื่อโมเดลที่เปลี่ยนได้ — ถ้าโมเดลใหม่ detect ไม่ติด (โดน fallback 200k เตือนถี่เกิน) เพิ่ม mapping เองได้ใน `config.json`: `{"windows": {"<regex>": <tokens>}}` เช็คก่อน built-in โดยไม่ต้องแก้โค้ด

T1/T2 ก็ priority เดียวกัน (env → config → `round(MAX×0.72)` / `round(MAX×0.85)`) **ยกเว้น**: ถ้า env `HANDOFF_GUARD_MAX` ถูกตั้ง t1/t2 ใน config.json จะถูกข้าม (คิด % ใหม่จาก env MAX — t1/t2 ในไฟล์คำนวณจาก max ตัวเก่า เอามาใช้กับ MAX ใหม่จะเพี้ยนถึงขั้น T1 > MAX = เงียบตลอด) เว้นแต่ตั้ง env `HANDOFF_GUARD_THRESHOLD`/`THRESHOLD2` เองก็ชนะเสมอ · โมเดลเปลี่ยนกลางเซสชันได้ → เพดานปรับตามอัตโนมัติถ้าไม่ได้ pin

> **สลับ Opus/Sonnet บ่อย → อย่า pin** (ปล่อย auto-detect) · **จูน auto-compact ให้โมเดลเดียว → pin ด้วย `/handoff-guard-max`** · **อยากปิด guard สนิท → `/handoff-guard-max 0`** (เขียน `{max:0}` → hook exit ทันทีไม่เตือน · เปิดคืนด้วย `reset`)

## Tune

| อยากได้ | ทำ |
|--------|----|
| ล็อกเพดาน (MAX) เองแบบเร็ว ไม่แตะ settings.json | สั่ง `/handoff-guard-max <max>` (เช่น `/handoff-guard-max 200000`) — คำนวณ T1/T2 ให้ (72%/85%), เขียน config.json, มีผลเทิร์นถัดไป · **pin ทุกโมเดล** · `/handoff-guard-max reset` = กลับไป auto-detect · ติดตั้งครั้งเดียว: `cp commands/handoff-guard-max.md ~/.claude/commands/` |
| เตือน (absolute) เร็ว/ช้าขึ้น (แบบ manual/override) | env `HANDOFF_GUARD_THRESHOLD` / `HANDOFF_GUARD_THRESHOLD2` (default = `round(MAX×0.72)` / `round(MAX×0.85)`) — env ชนะ config.json เสมอ |
| บังคับเพดาน (display) แบบ manual/override | env `HANDOFF_GUARD_MAX` (default = auto-detect ตามโมเดล) — เกินนี้เริ่มเสียบริบท · T1/T2 คิด % ใหม่จากค่านี้อัตโนมัติ (t1/t2 ที่ pin ในไฟล์ถูกข้าม) |
| predict เตือนล่วงหน้ามาก/น้อย | env `HANDOFF_GUARD_PREDICT_TURNS` (K, default 3) — มาก=เตือนเบาๆ เร็ว, น้อย=ดึงใกล้ค่อยเตือน |
| predict ไวต่อ spike มาก/น้อย | env `HANDOFF_GUARD_EMA_ALPHA` (default 0.4) — สูง=react ไว แต่กระตุกตาม spike, ต่ำ=นิ่งแต่ lag |
| auto-compact ยิงก่อน T1 (ไม่ทันเตือน) | pin เพดานต่ำลง `/handoff-guard-max <ต่ำกว่าจุด compact จริง>` — สังเกตจาก live ว่า compaction เกิดที่กี่ token |
| รีเซ็ตการเตือนของ session | ลบ marker `~/.claude/.handoff-guard/<session_id>.{p,t1,t2}` + `.state.json` (รีเซ็ต EWMA) |
| อัปเดตทุกอย่างเป็นเวอร์ชันล่าสุด (handoff-guard + skill `handoff`) | `/handoff-guard-update` ในแชท หรือ `node ~/.claude/skills/handoff-guard/scripts/update.mjs --check` (ดูอย่างเดียว) → รันโดยไม่ใส่ `--check` (อัปเดต + สำรอง `.bak` · restart session) · เฉพาะส่วนของ Matt: `ensure-handoff.mjs --check`/`--update` |

## ข้อจำกัด (ตรงไปตรงมา)
- Stop hook fire **หลัง** Claude จบเทิร์น — ถ้าเทิร์นเดียวพุ่งทะลุหลาย tier จะ fire tier สูงสุดที่ถึง
- **predict ต้องมีอย่างน้อย 2 เทิร์น** กว่า EWMA จะตั้งตัว — session ที่พุ่งเร็วมากตั้งแต่ 2 เทิร์นแรกอาจข้าม predict ไปโดน absolute tier แทน (ตั้งใจ — fail-safe คุมอยู่)
- EWMA ทำนายจาก growth ที่ผ่านมา — ถ้าพฤติกรรมเปลี่ยนกะทันหัน (เริ่มอ่านไฟล์ใหญ่รัวๆ) ETA จะ lag 1-2 เทิร์นก่อนปรับ (α คุม trade-off ไว/นิ่ง)
- ถ้า auto-compact ของ Claude Code ยิง **ก่อน** ถึง threshold → ต้องลด threshold (จูนตามที่สังเกตจริง)
- การตัดสินใจ handoff (จะ handoff ไหม/ตอนไหน) **ทำให้ deterministic ไม่ได้** (เป็นดุลพินิจ model) — guard นี้คุมเรื่อง handoff/context เท่านั้น · ต่อ session ใหม่ใช้ `/clear` ไม่ใช่ chip (chip = git worktree ใหม่ทุก handoff)
