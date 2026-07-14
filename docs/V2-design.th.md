# Context Manager (V2) — Design Spec

> [English](V2-design.md)

> อัปเกรด `handoff-guard` จาก **reactive** (รอถึง 184k ค่อยทำ) เป็น **predictive** (คาดว่าอีก ~N เทิร์นจะแตะเขตอันตราย → เตรียม handoff ตั้งแต่ตอนนี้) โดยคงกลไกเดิมทั้งหมดเป็น **safety net**
>
> Slug ยังเป็น `handoff-guard` (ไม่แตะ `/handoff-guard`, hook injection text, settings.json, marker dir) — retitle หัวเรื่อง+description เป็น "Context Manager (V2)" เท่านั้น

## 1. ปรัชญา / Goal

ระบบเดิมตัดสินจาก **ระดับ token ปัจจุบัน** เท่านั้น → ถ้าเทิร์นเดียวพุ่งทะลุหลาย tier จะเตือนช้า/ตัดกลางงาน
V2 เพิ่ม **มิติเวลา**: ติดตามอัตราการโตของ context ข้ามเทิร์น → ทำนายว่า "อีกกี่เทิร์นจะเต็ม" → เตือนล่วงหน้าตั้งแต่ context ยังไม่วิกฤต เพื่อให้ปิด step ปัจจุบันได้สวยๆ ก่อน handoff

**Success criteria:**
- hook คำนวณ EWMA growth + ETA ได้ deterministic, ทน spike (อ่านไฟล์ใหญ่ทีเดียว) ไม่ false-positive
- ยิง "predict" trigger เมื่อคาดว่าอีก ≤ K เทิร์นจะถึง T2 — **ก่อน** token แตะ T1
- absolute tier เดิม (T1/T2) ยังทำงานครบเป็น fail-safe (เผื่อ predict พลาด)
- session ใหม่ตอน resume รัน verify checklist ก่อน continue
- `node selftest.mjs` ครอบ logic ใหม่ทั้งหมด ผ่าน

## 2. สถาปัตยกรรม 4 ชั้น (แมปไฟล์จริง)

| Layer | หน้าที่ | ที่อยู่ | กลไก |
|---|---|---|---|
| **L1 Observe** | อ่าน token จริงจาก `message.usage` ล่าสุด + คำนวณ delta/เทิร์น | `hooks/context-guard.mjs` | deterministic |
| **L2 Predict** | EWMA ของ growth → ETA "อีกกี่เทิร์นถึง T2" | `hooks/context-guard.mjs` | deterministic (คณิต) |
| **L3 Decision** | finish step vs handoff (รู้ว่าโดน predictive/absolute trigger) | `skills/handoff-guard/SKILL.md` | AI |
| **L4 Recovery** | resume → **verify** → continue | `hooks/session-resume.mjs` (pointer) + `SKILL.md` (verify checklist) | AI |

## 3. L1+L2 — การเปลี่ยนใน `context-guard.mjs`

### 3.1 State file ใหม่ (ต่อ session)
`~/.claude/.handoff-guard/<session>.state.json`
```jsonc
{
  "lastTokens": 216340,  // token รอบก่อน (ไว้คำนวณ delta)
  "ema": 8200,           // EWMA ของ growth rate (token/เทิร์น)
  "turns": 18            // จำนวนครั้งที่ hook fire ใน session นี้ (ไว้เช็คว่า ema ตั้งตัวแล้ว)
}
```
> marker เดิม `.t1/.t2` ยังอยู่ (กัน fire ซ้ำ) — state.json เป็นไฟล์ใหม่แยก ไม่ทับของเดิม

### 3.2 อัปเดต EWMA ทุก Stop hook
```
const ALPHA = 0.4;        // ถ่วงน้ำหนัก delta ล่าสุด 40%
const FLOOR = 500;        // rate ต่ำสุดที่ยอมใช้หาร (กัน ETA ระเบิดเป็น Infinity)

ถ้าไม่มี state.json (fire แรกของ session):
    → สร้าง { lastTokens: tokens, ema: 0, turns: 1 }  // baseline เท่านั้น ยังไม่มี delta
    → จบ (ไม่ยิง predict — turns < 2)

ถ้ามี state อยู่แล้ว:
    delta = tokens - state.lastTokens
    if (delta < 0)            → compaction/รีเซ็ต → ไม่นับ delta ลบ, คง ema เดิม
    else if (state.ema === 0) → ema = delta                          // delta จริงตัวแรก
    else                      → ema = ALPHA*delta + (1-ALPHA)*ema     // EWMA

    state.lastTokens = tokens
    state.turns += 1
    เขียน state.json กลับ
```
> ผล: fire#1 = baseline (turns 1, ema 0) · fire#2 = delta จริงตัวแรก (turns 2, ema ตั้งตัว) → predict เริ่มพิจารณาได้เร็วสุดที่ fire#2 (สอดคล้องเงื่อนไข `turns ≥ 2` ใน 3.4)

### 3.3 คำนวณ ETA
```
rate = max(ema, FLOOR)
turnsToT2 = Math.ceil((T2 - tokens) / rate)   // อีกกี่เทิร์นจะแตะ T2
```

### 3.4 Trigger — priority สูง→ต่ำ (ยิงอันแรกที่เข้าเงื่อนไข)
```
1. tokens ≥ T2 (218k) & !marker.t2   → fire "tier2"   (ด่วน — เดิม)
2. tokens ≥ T1 (184k) & !marker.t1   → fire "tier1"   (เดิม)
3. turnsToT2 ≤ K (3) & state.turns ≥ 2 & tokens < T1 & !marker.p
                                     → fire "predict"  (ใหม่)
```
- `K = 3` (env `HANDOFF_GUARD_PREDICT_TURNS`) — lead time ระดับกลาง
- เงื่อนไข `state.turns ≥ 2` = ต้องมีอย่างน้อย 2 observation ก่อนเชื่อ ema (กัน cold-start ยิงมั่ว)
- เงื่อนไข `tokens < T1` = ถ้าเลย T1 แล้วให้ absolute tier จัดการแทน (ไม่ยิงซ้อน)
- marker ใหม่ `.p` กัน predict ยิงซ้ำใน session

### 3.5 additionalContext ที่ส่งให้ skill (ทุก tier)
ส่งตัวเลขจริงให้ AI ตัดสิน — รวม field ใหม่:
```
tier: 'predict' | 'tier1' | 'tier2'
tokens: <ปัจจุบัน>
rate: <ema, token/เทิร์น>
etaTurns: <turnsToT2>
```
ตัวอย่างข้อความ predict:
> 🟡 คาดการณ์: context ~183k, โตเฉลี่ย ~11.6k/เทิร์น → อีก ~3 เทิร์นจะแตะ 218k. ปิด step ปัจจุบันให้จบ แล้ว invoke skill "handoff-guard" เพื่อเตรียม handoff. อย่าเริ่มงานใหญ่ใหม่.

## 4. L3 — การเปลี่ยนใน `SKILL.md` (decision table)

เพิ่มแถวในตาราง "ประเมิน: handoff เลย vs ทำต่อ":

| สัญญาณ | ตัดสิน |
|---|---|
| **predict tier (token ยังไม่ถึง 184k, buffer เยอะ)** | **ปิด step ปัจจุบันให้จบสวยๆ ได้** แล้วค่อย handoff · ห้ามเริ่ม feature/refactor ใหม่ |
| tier1 (≥184k) ... | (เดิม) |
| tier2 (≥218k) ... | (เดิม) |

หลักการที่เพิ่ม: predict = มี buffer มากกว่า absolute → ตัดสินใจแบบไม่เร่ง แต่ห้ามเริ่มงานใหญ่ · อ่าน `tier/etaTurns` จาก additionalContext เพื่อรู้ว่าเร่งแค่ไหน

## 5. L4 — Recovery verify checklist (section ใหม่ใน `SKILL.md`)

เพิ่ม section "### Layer 4: Recovery (เมื่อ session ใหม่ resume)":
session ใหม่อ่าน handoff doc แล้ว **รัน verify ก่อน continue:**
1. `git status` — uncommitted ตรงกับที่ handoff ระบุไหม (ไฟล์ที่ note ว่า "ค้าง" มีจริงไหม)
2. branch/worktree ถูกตัวไหม (เทียบ handoff)
3. `npm run check` ผ่านไหม — state ไม่พังจาก session ก่อน
4. งานค้างใน handoff ตรงกับความจริงในโค้ดไหม → ค่อย continue
ถ้า verify ไม่ตรง (เช่น handoff บอก commit แล้วแต่ git ยังค้าง) → แจ้งผู้ใช้ก่อน อย่า continue ทับ

> `session-resume.mjs` คงเดิม (ฉีด pointer) — verify เป็นหน้าที่ AI ใน skill

## 6. Tunables (env)

| env | default | ความหมาย |
|---|---|---|
| `HANDOFF_GUARD_THRESHOLD` | 184320 | T1 (absolute tier1) = 72% ของเพดาน 256k |
| `HANDOFF_GUARD_THRESHOLD2` | 217600 | T2 (absolute tier2 + เป้าของ ETA) = 85% ของเพดาน 256k |
| `HANDOFF_GUARD_MAX` | 256000 | เพดานบริบท (display เท่านั้น) — เกินนี้เริ่มเสียบริบท |
| `HANDOFF_GUARD_PREDICT_TURNS` | 3 | K — lead time (เทิร์น) ของ predict trigger |
| `HANDOFF_GUARD_EMA_ALPHA` | 0.4 | น้ำหนัก EWMA |

> **เพดาน 256k** — T1/T2 ตั้งไว้ 72%/85% ของเพดาน (ของเดิมเคยอิง 200k = 144k/170k) · ถ้าเปลี่ยนเพดานในอนาคต คำนวณ T1=ceil(MAX×0.72), T2=ceil(MAX×0.85)

## 7. ไฟล์ที่กระทบ

| ไฟล์ | เปลี่ยน |
|---|---|
| `hooks/context-guard.mjs` | + state.json read/write, EWMA, ETA, predict trigger, marker `.p`, additionalContext fields |
| `skills/handoff-guard/SKILL.md` | retitle "Context Manager (V2)", + decision row (predict), + L4 verify section, + อธิบาย 4 layers |
| `skills/handoff-guard/SETUP.md` | + env ใหม่ (K, alpha), + อธิบาย state.json, + predict tier ใน verify |
| `skills/handoff-guard/scripts/selftest.mjs` | + เคส: EWMA โต, predict ยิงตอน ETA≤K, compaction (delta ลบ) ไม่พัง, cold-start (turns<2) ไม่ยิง |
| `session-resume.mjs` | **ไม่แตะ** |
| `settings.json` | **ไม่แตะ** |

## 8. Test plan

`node selftest.mjs` เพิ่มเคส (deterministic, ไม่ต้องรอ session โต):
1. โต ~11.6k/เทิร์นสม่ำเสมอ → predict ยิงตอน ETA ≤ 3 (≈183k) ก่อนถึง T1=184320
2. cold-start (turns=1) → ไม่ยิง predict (ema ยังไม่ตั้งตัว)
3. spike เทิร์นเดียว +40k แล้วกลับมานิ่ง → EWMA ไม่ทำให้ ETA กระโดดยิงมั่ว
4. compaction (tokens ลดจาก 180k → 90k) → delta ลบ ไม่นับ, ไม่ crash, baseline reset
5. absolute tier เดิม: 183k ไม่ยิง / 185k ยิง tier1 / 218k ยิง tier2 (regression — ต้องคงผ่าน)
6. marker กัน fire ซ้ำ: predict ยิงแล้ว session เดิมเงียบ
