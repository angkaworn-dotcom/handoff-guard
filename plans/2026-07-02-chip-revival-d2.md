# Chip Revival + D2 Worktree Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** คืน chip (spawn_task) ให้ handoff-guard พร้อมกลไก D2: ยกของ node_modules, เก็บ snapshot เบา 5 อันล่าสุด, prune ที่เหลือแบบ deterministic โดยไม่ลบ branch

**Architecture:** chip prompt (ใน SKILL.md) สั่ง session ใหม่ทำ 3 step แรก (ยกของ → ตรวจฐานโค้ด → prune) · prune เป็น script node แยก deterministic · ตัวนับเลข chip อยู่ใน counters.json · spec เต็ม: `../specs/2026-07-02-chip-revival-d2-design.md`

**Tech Stack:** Node.js (ESM .mjs, ไม่มี dependency), git worktree CLI, Claude Code skill markdown

**สำคัญ:** ทุกไฟล์อยู่ใต้ `~/.claude/` ซึ่ง**ไม่ใช่ git repo** → ไม่มี step commit; ใช้ `node --check` + test script แทน validation gate · ไฟล์ config/pointer เขียนด้วย Write tool เท่านั้น (กัน BOM)

---

### Task 1: `prune-worktrees.mjs` (TDD ด้วย fixture repo)

**Files:**
- Create: `C:\Users\Dell\.claude\skills\handoff-guard\scripts\prune-worktrees.mjs`
- Test (throwaway): `<scratchpad>\test-prune.mjs`

- [ ] **Step 1: เขียน test fixture + assertion ก่อน** — `<scratchpad>\test-prune.mjs`:

```js
#!/usr/bin/env node
// test-prune.mjs — fixture test สำหรับ prune-worktrees.mjs (throwaway)
// สร้าง repo ปลอม + worktree 7 แบบ → รัน --dry / จริง → assert ผล
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.env.TEMP || '/tmp', 'prune-fixture');
const REPO = join(ROOT, 'repo');
const WT = join(REPO, '.claude', 'worktrees');
const SCRIPT = join(process.env.USERPROFILE, '.claude', 'skills', 'handoff-guard', 'scripts', 'prune-worktrees.mjs');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const node = (cwd, ...a) => execFileSync('node', a, { cwd, encoding: 'utf8' });
const old = new Date(Date.now() - 10 * 864e5); // 10 วันก่อน — พ้น guard 2 วัน

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-b', 'main');
git(REPO, 'config', 'user.email', 't@t'); git(REPO, 'config', 'user.name', 't');
writeFileSync(join(REPO, 'a.txt'), 'x');
git(REPO, 'add', '.'); git(REPO, 'commit', '-m', 'init');
mkdirSync(WT, { recursive: true });

// worktree: ชื่อ → ปรับสภาพ
const make = (name) => git(REPO, 'worktree', 'add', join(WT, name), '-b', `br-${name}`);
for (const n of ['old1', 'old2', 'old3', 'dirty1', 'recent1', 'leave-db-redesign-feat', 'selfwt']) make(n);
writeFileSync(join(WT, 'dirty1', 'uncommitted.txt'), 'dirty'); // dirty
for (const n of ['old1', 'old2', 'old3', 'dirty1', 'leave-db-redesign-feat', 'selfwt'])
  utimesSync(join(WT, n), old, old); // ทุกอันเก่า ยกเว้น recent1

// --dry จาก cwd = selfwt, keep 1 → eligible = old1,old2,old3 (เรียง mtime เท่ากัน) → ลบ 2
const dry = node(join(WT, 'selfwt'), SCRIPT, '--repo', REPO, '--keep', '1', '--dry');
console.log(dry);
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
assert((dry.match(/\[dry\] would remove/g) || []).length === 2, 'dry ต้องจะลบ 2 อัน');
assert(!dry.includes('dirty1') || dry.includes('skip'), 'dirty1 ต้องไม่โดนลบ');
assert(existsSync(join(WT, 'old1')), 'dry ต้องไม่ลบจริง');

// รันจริง
const real = node(join(WT, 'selfwt'), SCRIPT, '--repo', REPO, '--keep', '1');
console.log(real);
const gone = ['old1', 'old2', 'old3'].filter((n) => !existsSync(join(WT, n)));
assert(gone.length === 2, `ต้องหาย 2 อัน (หายจริง: ${gone.length})`);
for (const n of ['dirty1', 'recent1', 'leave-db-redesign-feat', 'selfwt'])
  assert(existsSync(join(WT, n)), `${n} ต้องยังอยู่ (guard)`);
// branch ต้องครบทุกตัวรวมของที่ worktree โดนลบ
const branches = git(REPO, 'branch', '--list');
for (const n of ['old1', 'old2', 'old3', 'dirty1', 'recent1', 'selfwt'])
  assert(branches.includes(`br-${n}`), `branch br-${n} ต้องไม่หาย`);
// idempotent: รันซ้ำไม่พัง ไม่ลบเพิ่ม
const again = node(join(WT, 'selfwt'), SCRIPT, '--repo', REPO, '--keep', '1');
assert(again.includes('removed=0'), 'รันซ้ำต้อง removed=0');
console.log('ALL PASS');
```

- [ ] **Step 2: รันให้ fail ก่อน** — `node <scratchpad>\test-prune.mjs` → Expected: FAIL (`Cannot find module ... prune-worktrees.mjs` หรือ ENOENT)

- [ ] **Step 3: implement script** — `scripts\prune-worktrees.mjs`:

```js
#!/usr/bin/env node
// prune-worktrees.mjs — เก็บ snapshot worktree เบา N อันล่าสุด ลบ clean ที่เก่ากว่า (ไม่แตะ branch)
// ใช้โดย chip session ของ handoff-guard — spec: ../specs/2026-07-02-chip-revival-d2-design.md
// usage: node prune-worktrees.mjs --repo "<mainRepoRoot>" [--keep 5] [--dry]
import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const KEEP_LIST = ['leave-db-redesign-feat']; // worktree งาน dev จริง — ห้ามลบเด็ดขาด
const RECENT_DAYS = 2;

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const repo = argVal('--repo', '');
const keep = Math.max(0, parseInt(argVal('--keep', '5'), 10) || 5);
const dry = args.includes('--dry');
if (!repo || !existsSync(repo)) {
  console.error('usage: prune-worktrees.mjs --repo <mainRepoRoot> [--keep N] [--dry]');
  process.exit(1);
}

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

const wtRoot = norm(join(repo, '.claude', 'worktrees'));
const self = norm(process.cwd());
const skipped = [];
const skip = (why, path) => { skipped.push(why); console.log(`skip (${why}): ${path}`); };

// enumerate จาก git = source of truth (readdir อาจเจอ dir ที่ไม่ใช่ worktree จริง)
const blocks = git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
const candidates = [];
for (const b of blocks) {
  const m = b.match(/^worktree (.+)$/m);
  if (!m) continue;
  const path = m[1].trim();
  const np = norm(path);
  if (!np.startsWith(wtRoot + sep)) continue; // เฉพาะใต้ .claude/worktrees
  if (np === self || self.startsWith(np + sep)) { skip('self', path); continue; }
  const base = np.slice(wtRoot.length + 1).split(sep)[0];
  if (KEEP_LIST.includes(base)) { skip('keep-list', path); continue; }
  if (!existsSync(path)) { skip('missing', path); continue; }
  let dirtyOut = '';
  try { dirtyOut = git(path, 'status', '--porcelain'); } catch { skip('status-error', path); continue; }
  if (dirtyOut.trim()) { skip('dirty', path); continue; }
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { skip('stat-error', path); continue; }
  if (Date.now() - mtime < RECENT_DAYS * 864e5) { skip('recent', path); continue; }
  candidates.push({ path, mtime });
}

candidates.sort((a, b) => b.mtime - a.mtime);
const removals = candidates.slice(keep);
let removed = 0;
for (const r of removals) {
  if (dry) { console.log(`[dry] would remove: ${r.path}`); continue; }
  try {
    git(repo, 'worktree', 'remove', r.path); // ไม่ --force — git ปฏิเสธ dirty ให้อีกชั้น
    console.log(`removed: ${r.path}`);
    removed++;
  } catch (e) {
    console.log(`skip (remove-failed): ${r.path} — ${String(e.message || e).split('\n')[0]}`);
  }
}
console.log(`done: kept=${Math.min(keep, candidates.length)} removed=${dry ? 0 : removed}${dry ? ` would-remove=${removals.length}` : ''} skipped=${skipped.length}`);
```

- [ ] **Step 4: `node --check`** — `node --check ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs` → Expected: เงียบ (exit 0)
- [ ] **Step 5: รัน test ให้ผ่าน** — `node <scratchpad>\test-prune.mjs` → Expected: `ALL PASS` · ไม่ผ่าน = แก้ script (ไม่แก้ assertion เว้นแต่ assertion ผิดจริง)
- [ ] **Step 6: ลบ fixture** — `rmSync ROOT` อยู่ต้น test แล้ว (รันซ้ำได้) · ปล่อยไฟล์ test ไว้ใน scratchpad

### Task 2: SKILL.md step 4-5 + Layer 4 (ภาษาไทย — ไฟล์ functional)

**Files:**
- Modify: `C:\Users\Dell\.claude\skills\handoff-guard\SKILL.md` (step 4-5 คือบรรทัด 61-65 ฉบับปัจจุบัน + L4 บรรทัด 72)

- [ ] **Step 1: แทน step 4-5 ทั้ง block** (ตั้งแต่ `4. **บอกผู้ใช้ให้เปิด session ใหม่เอง` ถึงจบบรรทัด `5. บอกผู้ใช้ชัดเจน: ...`) ด้วย:

```markdown
4. **สร้าง chip ให้กดต่อคลิกเดียว (`mcp__ccd_session__spawn_task`)** — /clear เป็นทางเลือกสำรอง
   - เลขลำดับ N: อ่าน `~/.claude/.handoff-guard/counters.json` (`{"<slug ของ path main repo root — กติกาเดียวกับ pointer>": N}`) → ใช้ค่าเดิม+1 · ไฟล์/คีย์ไม่มี → N = จำนวนไฟล์ `handoffs/handoff-<ชื่อโปรเจกต์>-*.md` + 1 · เขียนกลับด้วย **Write tool เท่านั้น**
   - `title` = `ต่อ <N>. <focus สั้น>` (≤60 ตัว — เลขทำให้รู้ว่า chip ไหนล่าสุด) · `tldr` 1-2 ประโยคมีเลข N · `prompt` ตาม template (เติมค่าจริงทุก `<...>` — session ใหม่ไม่เห็นบทสนทนานี้):
     ```
     ต่องานจาก handoff #<N>: <focus>
     คุณคือ session จาก chip ของ handoff-guard — cwd ปัจจุบันคือ worktree ใหม่ที่ harness เพิ่งสร้าง ทำ 3 step ก่อนเริ่มงาน:
     1. ยกของ: ถ้า "<oldWorktree>\node_modules" มีอยู่ และ cwd ยังไม่มี node_modules → PowerShell: Move-Item "<oldWorktree>\node_modules" ".\node_modules" · ย้ายไม่ได้ (ถูกล็อก/ไม่มี) → ข้ามแล้ว npm install เมื่อจำเป็น — ห้าม force ห้าม kill process
     2. ฐานโค้ด: HEAD ต้องมี commit <lastCommitHash> (tip ของ <oldBranch>) — เช็ค git merge-base --is-ancestor <lastCommitHash> HEAD · ไม่มี → git merge --ff-only <oldBranch> · ff ไม่ได้ = หยุดถามผู้ใช้ อย่าเดา
     3. node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5
     จากนั้นอ่าน <handoffPath> → รัน verify ตาม Layer 4 ของ skill handoff-guard ก่อนทำงานต่อ · งานใน handoff เสร็จหรือผู้ใช้เปลี่ยนงาน → ลบ pointer <handoffPointerPath>
     ```
   - pointer per-worktree ยังเขียนตามข้อ 3 เสมอ (เส้น /clear ต้องใช้ · chip กับ pointer อยู่ร่วมกัน)
   > **ทำไมต้องยกของ+prune (อย่าตัด 3 step ออกจาก prompt):** spawn_task สร้าง worktree ใหม่เสมอตอนกด chip (ไม่มี option ปิด) และตัวกินดิสก์จริงคือ node_modules ~206MB/อัน (เคยกอง 60 อัน ≈10GB) → ยกของจากบ้านเก่า = ไม่ต้อง npm install ใหม่ · worktree เก่ากลายเป็น snapshot เบาไว้ย้อนกลับ เก็บ 5 อันล่าสุด · **branch ไม่ลบเด็ดขาด** = จุดย้อนทุกจุดกู้ได้เสมอด้วย `git worktree add <path> <branch>` · รายละเอียด: `specs/2026-07-02-chip-revival-d2-design.md`
5. บอกผู้ใช้ชัดเจน: "context ~Xk แล้ว — **กด chip 'ต่อ <N>. <focus>' เพื่อเปิด session ต่อ** (แชทเก่าค้างไว้ย้อนดูได้) หรือพิมพ์ `/clear` ถ้าไม่ต้องการเก็บแชทเก่า · handoff จะโหลดเอง → `<handoff path>`" + สรุปงานค้าง 2-3 บรรทัด
```

- [ ] **Step 2: เพิ่มบรรทัดแรกใน Layer 4 checklist** — หลังประโยคเปิด L4 (ก่อนข้อ 1. `git status`) เพิ่ม:

```markdown
0. **(เฉพาะ session จาก chip)** ทำ 3 step ใน chip prompt ให้ครบก่อน (ยกของ / ฐานโค้ด / prune) — ถ้าเปิดด้วย /clear ข้ามข้อนี้
```

- [ ] **Step 3: validate** — อ่านไฟล์ทั้งไฟล์ซ้ำ เช็ค: ไม่มีข้อความ "อย่าใช้ chip/ห้ามกลับไปใช้ chip" หลงเหลือ · numbering ถูก · code fence ปิดครบ

### Task 3: SKILL.en.md mirror

**Files:**
- Modify: `C:\Users\Dell\.claude\skills\handoff-guard\SKILL.en.md` (step 4-5 = บรรทัด 54-58 ฉบับปัจจุบัน + L4 บรรทัด 65-70)

- [ ] **Step 1: แทน step 4-5** ด้วยฉบับแปล:

```markdown
4. **Create a chip for one-click continuation (`mcp__ccd_session__spawn_task`)** — /clear remains the fallback
   - Sequence number N: read `~/.claude/.handoff-guard/counters.json` (`{"<slug of the main repo root path — same rule as pointers>": N}`) → new N = old value + 1 · file/key missing → N = count of `handoffs/handoff-<project name>-*.md` files + 1 · write back with the **Write tool ONLY**
   - `title` = `ต่อ <N>. <short focus>` (≤60 chars — the number shows which chip is newest) · `tldr` 1-2 sentences including N · `prompt` per the template (fill in every `<...>` with real values — the new session cannot see this conversation):
     ```
     ต่องานจาก handoff #<N>: <focus>
     You are a session spawned from a handoff-guard chip — your current cwd is a fresh worktree the harness just created. Do these 3 steps before starting work:
     1. Carry-over: if "<oldWorktree>\node_modules" exists and cwd has no node_modules → PowerShell: Move-Item "<oldWorktree>\node_modules" ".\node_modules" · if the move fails (locked/missing) → skip and npm install when needed — never force, never kill processes
     2. Code base: HEAD must contain commit <lastCommitHash> (tip of <oldBranch>) — check with git merge-base --is-ancestor <lastCommitHash> HEAD · if not → git merge --ff-only <oldBranch> · if ff fails = stop and ask the user, don't guess
     3. node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "<mainRepoRoot>" --keep 5
     Then read <handoffPath> → run the Layer 4 verify checklist of the handoff-guard skill before continuing · when the handoff's work is done or the user moves on → delete the pointer <handoffPointerPath>
     ```
   - Still write the per-worktree pointer per step 3 (the /clear path needs it · chip and pointer coexist)
   > **Why carry-over + prune (do not drop the 3 steps from the prompt):** spawn_task always creates a fresh worktree on chip click (no way to disable) and the real disk eater is node_modules ~206MB each (this project once piled up 60 worktrees ≈10GB) → carrying over = no reinstall · the old worktree becomes a light rollback snapshot, keep the 5 newest · **never delete branches** = every rollback point stays recoverable via `git worktree add <path> <branch>` · details: `specs/2026-07-02-chip-revival-d2-design.md`
5. Tell the user clearly: "context is ~Xk now — **click the chip 'ต่อ <N>. <focus>' to continue in a new session** (the old chat stays around to scroll back through), or type `/clear` if you don't need the old chat · the handoff loads automatically → `<handoff path>`" + a 2-3 line summary of what's pending
```

- [ ] **Step 2: เพิ่ม L4 item 0** ฉบับแปล:

```markdown
0. **(chip-spawned sessions only)** complete the 3 steps from the chip prompt first (carry-over / code base / prune) — skip this item when resuming via /clear
```

- [ ] **Step 3: validate** — เช็คว่าเนื้อหา 2 ไฟล์ตรงกันเชิงความหมาย + ไม่เหลือ "do NOT use ... chip"

### Task 4: อัปเดต memory ไม่ให้ขัดกับของใหม่

**Files:**
- Modify: `C:\Users\Dell\.claude\projects\C--Users-Dell-Documents---------------leave-web-svelte\memory\worktree-node-modules-bloat.md`
- Modify: `C:\Users\Dell\.claude\projects\C--Users-Dell-Documents---------------leave-web-svelte\memory\MEMORY.md` (บรรทัด index ของ memory นี้)

- [ ] **Step 1:** เพิ่ม section ท้าย worktree-node-modules-bloat.md (ก่อน "How to apply") + แก้ประโยคเก่า:
  - แก้ description frontmatter → `...use clean-worktree-node-modules.sh to reclaim space; chip revived 2026-07-02 with D2 carry-over+prune (see handoff-guard spec)`
  - ท้ายย่อหน้า "Fix ที่ทำแล้ว (2026-07-02)" และ "Fix รอบสาม" ที่เขียน "อย่ากลับไปใช้ chip / ไม่ต้องกลับไป chip" → เติมหมายเหตุ: `[superseded 2026-07-02: owner เคาะเอา chip กลับมาแบบ D2 — ดู section ล่าง]`
  - เพิ่ม section ใหม่:

```markdown
**Chip กลับมาแล้ว (2026-07-02, owner เคาะ):** ประโยค "อย่ากลับไปใช้ chip" ด้านบนถูก supersede — owner ต้องการ chip (คลิกเดียว/แชทเก่าอยู่/เห็นปุ่ม + เลขลำดับ `ต่อ N. งาน`) และมองว่า worktree เก่า = จุดย้อนกลับ. กลไกใหม่ (D2): chip prompt สั่ง session ใหม่ (1) ยกของ node_modules จาก worktree เก่าด้วย Move-Item — ไม่ npm install ใหม่ (2) ตรวจ HEAD มี commit ล่าสุด (3) รัน `prune-worktrees.mjs --keep 5` เก็บ snapshot เบา 5 อันล่าสุด ข้าม dirty/keep-list/ใหม่ 2 วัน/ตัวเอง **ไม่ลบ branch** = ย้อนได้เสมอ. Spec: `~/.claude/skills/handoff-guard/specs/2026-07-02-chip-revival-d2-design.md`
```

- [ ] **Step 2:** อัปเดตบรรทัดใน MEMORY.md → `- [Worktree node_modules bloat](worktree-node-modules-bloat.md) — chip revived 2026-07-02 แบบ D2 (ยกของ+prune เก็บ 5, branch ไม่ลบ); ตัวกินดิสก์คือ node_modules 206MB/อัน; clean-worktree-node-modules.sh ล้าง manual`

### Task 5: รันจริงกับกองเก่า ~58 อัน (owner เคาะข้อ ก แล้ว)

- [ ] **Step 1: `--dry` กับ repo จริง** — `node ~/.claude/skills/handoff-guard/scripts/prune-worktrees.mjs --repo "C:\Users\Dell\Documents\ระบบ ลง วันลา\leave-web-svelte" --keep 5 --dry`
  Expected: would-remove ≈ 40+ · skip dirty ≈ 13 · skip keep-list = leave-db-redesign-feat · skip self = objective-williams-6800ec (cwd session นี้)
- [ ] **Step 2: sanity check รายการ** — ไล่ดูชื่อที่จะลบ: ทุกอันอยู่ใต้ `.claude/worktrees` · ไม่มี leave-db-redesign-feat / worktree ปัจจุบัน · จำนวน skip dirty สอดคล้อง ~13
- [ ] **Step 3: วัดพื้นที่ก่อนลบ** — PowerShell: `(Get-ChildItem "<repo>\.claude\worktrees" -Directory | Measure-Object).Count` + du รวม
- [ ] **Step 4: รันจริง** — คำสั่งเดิมตัด `--dry` → Expected: removed ≈ would-remove จาก dry, ไม่มี error ค้าง
- [ ] **Step 5: verify หลังลบ** — จำนวน dir เหลือ ≈ 5 (snapshot) + 13 dirty + keep-list + ตัวเอง + recent · `git -C <repo> branch --list "claude/*" | measure` ต้องไม่ลดลงจากก่อนลบ · รายงานพื้นที่ที่คืนมา

### Task 6: ทดสอบยกของ (Move-Item) 1 คู่จริง

- [ ] **Step 1:** สร้าง dummy: `New-Item -ItemType Directory <scratchpad>\mv-test\src\node_modules; 1..50 | % { Set-Content "<scratchpad>\mv-test\src\node_modules\f$_.txt" 'x' }; New-Item -ItemType Directory <scratchpad>\mv-test\dst`
- [ ] **Step 2:** `Measure-Command { Move-Item <scratchpad>\mv-test\src\node_modules <scratchpad>\mv-test\dst\node_modules }` → Expected: < 1 วินาที (same-volume rename)
- [ ] **Step 3:** เคสปลายทางมีอยู่แล้ว (idempotent guard ของ chip prompt): รัน Move-Item ซ้ำ → Expected: error "already exists" → ยืนยันว่า prompt ต้องเช็ค existsSync ก่อน (ตามที่เขียนไว้แล้ว)
- [ ] **Step 4:** ลบ mv-test ทิ้ง

### Task 7: ปิดงาน

- [ ] **Step 1:** เช็คทุกไฟล์ที่แก้: `node --check` script อีกรอบ · เปิด SKILL.md/SKILL.en.md ดู formatting
- [ ] **Step 2:** end-to-end จริง (chip คลิก→3 step) ทำได้ตอน handoff จริงรอบหน้า — note ให้ owner ว่า session นี้เองจะเป็นตัวทดสอบแรกถ้า context ถึง threshold
- [ ] **Step 3:** รายงานผลตาม Final Delivery Format (Summary/Evidence/Risks/Validation/Confidence)

## Self-Review (ทำแล้ว)

- Spec coverage: §1 SKILL→Task 2-3 · §2 template→Task 2-3 · §3 counter→Task 2 (คำสั่งใน SKILL — ไม่มีโค้ดแยก, model ทำตอน handoff) · §4 script→Task 1 · §5 docs/memory→Task 2-4 · Error handling→อยู่ใน template+script guards · Testing→Task 1, 5, 6 · กองเก่าข้อ ก→Task 5
- Placeholder: ไม่มี TBD/TODO — โค้ด+ข้อความเต็มทุก step
- Type consistency: ชื่อ args (`--repo/--keep/--dry`), path script, ชื่อไฟล์ counters.json ตรงกันทุก task
