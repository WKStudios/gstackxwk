# Changelog

## 0.4.0 — 2026-10-28

### Superagent: a personal agent on WhatsApp

- `superagent/` — message it on WhatsApp (official Cloud API), in a web chat, or in the terminal; one brain and one memory across all three
- Claude Opus 5.5 agent loop with adaptive thinking, prompt caching, server-side refusal fallback and on-demand compaction for long threads
- Approval gates enforced in code with WhatsApp buttons: sending email, invites, changing or cancelling meetings with guests, RSVPs, browser submits, phone calls. Any other reply counts as "no, do this instead"
- Gmail (search, read, attachments, drafts, send, labels), Google Calendar (all calendars, conflicts, timezone traps), Google Drive, Notion (search, read, write, databases, The Hub capture)
- Discord as a channel: a bot you DM, linked to you with a pairing code. It needs no business verification and no public URL, has approval buttons, and handles voice notes and files. `PRIMARY_CHANNEL` picks where reminders and briefs go
- Several Google accounts at once: `/connect google` once per account; searches, the daily brief, Gmail triggers and the double-booking check cover all of them
- Real browser via gstack browse, with a secrets vault (`{{secret:name}}`) the model never sees
- Schedules in your timezone, page watchers and Gmail triggers that only call Claude when something changed, multi-day missions, up to 12 parallel sub-agents, background research
- Code sandbox, PDF generation, expiring download links, image generation, voice notes in and out
- Quiet hours, WhatsApp 24h-window handling with template nudges and an outbox, daily spend cap, audit log, instant `/commands` and a `stop` kill switch
- Built-in playbooks: daily brief, inbox triage, reply in your voice, calendar scan, meeting prep, The Hub, deep research, automation debugging
- `bun run test` now runs browse and superagent tests in separate processes

## 0.3.1 — 2026-03-12

### Phase 3.5: Browser cookie import

- `cookie-import-browser` command — decrypt and import cookies from real Chromium browsers (Comet, Chrome, Arc, Brave, Edge)
- Interactive cookie picker web UI served from the browse server (dark theme, two-panel layout, domain search, import/remove)
- Direct CLI import with `--domain` flag for non-interactive use
- `/setup-browser-cookies` skill for Claude Code integration
- macOS Keychain access with async 10s timeout (no event loop blocking)
- Per-browser AES key caching (one Keychain prompt per browser per session)
- DB lock fallback: copies locked cookie DB to /tmp for safe reads
- 18 unit tests with encrypted cookie fixtures

## 0.3.0 — 2026-03-12

### Phase 3: /qa skill — systematic QA testing

- New `/qa` skill with 6-phase workflow (Initialize, Authenticate, Orient, Explore, Document, Wrap up)
- Three modes: full (systematic, 5-10 issues), quick (30-second smoke test), regression (compare against baseline)
- Issue taxonomy: 7 categories, 4 severity levels, per-page exploration checklist
- Structured report template with health score (0-100, weighted across 7 categories)
- Framework detection guidance for Next.js, Rails, WordPress, and SPAs
- `browse/bin/find-browse` — DRY binary discovery using `git rev-parse --show-toplevel`

### Phase 2: Enhanced browser

- Dialog handling: auto-accept/dismiss, dialog buffer, prompt text support
- File upload: `upload <sel> <file1> [file2...]`
- Element state checks: `is visible|hidden|enabled|disabled|checked|editable|focused <sel>`
- Annotated screenshots with ref labels overlaid (`snapshot -a`)
- Snapshot diffing against previous snapshot (`snapshot -D`)
- Cursor-interactive element scan for non-ARIA clickables (`snapshot -C`)
- `wait --networkidle` / `--load` / `--domcontentloaded` flags
- `console --errors` filter (error + warning only)
- `cookie-import <json-file>` with auto-fill domain from page URL
- CircularBuffer O(1) ring buffer for console/network/dialog buffers
- Async buffer flush with Bun.write()
- Health check with page.evaluate + 2s timeout
- Playwright error wrapping — actionable messages for AI agents
- Context recreation preserves cookies/storage/URLs (useragent fix)
- SKILL.md rewritten as QA-oriented playbook with 10 workflow patterns
- 166 integration tests (was ~63)

## 0.0.2 — 2026-03-12

- Fix project-local `/browse` installs — compiled binary now resolves `server.ts` from its own directory instead of assuming a global install exists
- `setup` rebuilds stale binaries (not just missing ones) and exits non-zero if the build fails
- Fix `chain` command swallowing real errors from write commands (e.g. navigation timeout reported as "Unknown meta command")
- Fix unbounded restart loop in CLI when server crashes repeatedly on the same command
- Cap console/network buffers at 50k entries (ring buffer) instead of growing without bound
- Fix disk flush stopping silently after buffer hits the 50k cap
- Fix `ln -snf` in setup to avoid creating nested symlinks on upgrade
- Use `git fetch && git reset --hard` instead of `git pull` for upgrades (handles force-pushes)
- Simplify install: global-first with optional project copy (replaces submodule approach)
- Restructured README: hero, before/after, demo transcript, troubleshooting section
- Six skills (added `/retro`)

## 0.0.1 — 2026-03-11

Initial release.

- Five skills: `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/ship`, `/browse`
- Headless browser CLI with 40+ commands, ref-based interaction, persistent Chromium daemon
- One-command install as Claude Code skills (submodule or global clone)
- `setup` script for binary compilation and skill symlinking
