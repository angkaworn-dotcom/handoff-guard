# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed
- **`scan-preload.mjs`: commands filter excluded the wrong reference files** — it still skipped `.en.md` (a leftover from before the v1.1.0 language flip); the reference copies that are not installed/preloaded are now `.th.md`, so the filter excludes those instead. Attribution-only impact (±30% heuristic), no behavior change elsewhere. New regression test S11.

## [1.1.1] - 2026-07-18

Bugfix release.

### Fixed
- **Chip sequence numbers jumping (11 → 46 → 13)** — the chip number N is counted from files at handoff time, and the instruction left room for a loose `handoff-*.md` glob that matches every project's files in the shared handoffs folder (that's where 46 came from). `SKILL.md`/`SKILL.th.md` now pin the exact per-project glob `~/.claude/.handoff-guard/handoffs/handoff-<project name>-*.md`, define `<project name>` as the basename of mainRepoRoot (never the worktree folder name), forbid the bare `handoff-*.md` count, and add a sanity check when N jumps by more than a couple. (#27)

### Added
- **CI: skills.sh listing auto-refresh** — `.github/workflows/refresh-skills-sh.yml` runs `npx skills add` on every push to main that touches SKILL/SETUP/README (EN + TH), `hooks/`, or `scripts/` (plus manual dispatch), so the skills.sh listing stays in sync with main. (#26)
- **CI: release automation** — `.github/workflows/release.yml` creates the GitHub Release automatically when a `v*` tag is pushed, with notes extracted from the matching CHANGELOG.md section.

## [1.1.0] - 2026-07-14

Docs, hooks, and scripts now default to English. Thai versions are preserved as `*.th.md` reference files.

### Changed
- **Primary language flip**: `README.md`, `SKILL.md`, `SETUP.md`, `docs/V2-design.md`, and `commands/*.md` (the files Claude Code actually loads) are now English; the original Thai content moved to `*.th.md`.
- **Hooks translated**: every runtime string emitted by the Stop/SessionStart hooks (`context-guard.mjs`, `session-resume.mjs`) — tier1/tier2/predict warnings, ROI notes, cost phrasing — is now in English.
- **Scripts translated**: all user-facing output (console messages, thrown errors, install/update banners) across `scripts/handoff-stats.mjs`, `scan-preload.mjs`, `set-max.mjs`, `prune-worktrees.mjs`, `ensure-handoff.mjs`, `update.mjs`, and `install.mjs` is now in English.
- Code comments remain in Thai — this release only translates content users and Claude actually see at runtime, not source comments.

### Testing
Both self-test suites updated and green: `selftest.mjs` (66/66), `updater-selftest.mjs` (120/120).

### Compatibility
No behavior change — install/update flow (`installMap`) and file layout logic are unaffected. This is a content/i18n release, not a functional one.

## [1.0.0] - 2026-07-13

Initial release.

Claude Code skill that predicts context-window exhaustion before it happens and forces a clean handoff — instead of getting cut off mid-task or losing state to compaction.

### Architecture
Four-layer pipeline: Observe → Predict → Decide → Recover
- **Observe** — tracks token usage per turn across the session
- **Predict** — EWMA (exponentially weighted moving average) model forecasts when the context window will run out, based on recent consumption trend rather than a fixed token count
- **Decide** — compares prediction against a configurable threshold and decides whether to trigger a handoff now or let the session continue
- **Recover** — on trigger, writes a structured handoff document so the next session can resume without re-deriving lost context

### Why EWMA over a fixed threshold
Token burn rate isn't constant — it varies by task (heavy tool use vs. plain conversation). EWMA adapts the prediction to the session's actual trajectory instead of assuming a flat rate, which reduces both false-early triggers and late triggers that leave no runway to write a proper handoff.

### Testing
118 test assertions with hermetic coverage of destructive operations — the skill is tested to fail safe (no data loss, no silent skip) even under edge cases like rapid context spikes or malformed session state.

### Notes
- Default threshold is tunable; ships with a general-purpose default but was tuned against a large multi-module Next.js/Prisma workflow (250–300k token range) during development.
- MIT licensed.
