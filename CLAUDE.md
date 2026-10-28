# gstack development

## Commands

```bash
bun install          # install dependencies
bun run test         # browse + superagent tests (separate processes)
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # compile binary to browse/dist/browse
bun run test:superagent    # superagent tests (fake Claude + fake WhatsApp)
bun run typecheck          # tsc over superagent/
bun run superagent:console # chat with the WhatsApp agent in the terminal
```

`bun run test` runs browse and superagent tests in separate processes: the browse
tests end with `process.exit(0)` in `afterAll`, which would cut off any test file
that runs after them in the same process.

## Project structure

```
gstack/
├── browse/          # Headless browser CLI (Playwright)
│   ├── src/         # CLI + server + commands
│   ├── test/        # Integration tests + fixtures
│   └── dist/        # Compiled binary
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── retro/           # Retrospective skill
├── superagent/      # Personal agent on WhatsApp (Claude API + gstack browse)
│   ├── src/         # router, agent loop, tools, integrations, scheduler, server
│   ├── skills/      # built-in playbooks the agent reads on demand
│   └── test/        # bun tests with a fake Claude client
├── setup            # One-time setup: build binary + symlink skills
├── SKILL.md         # Browse skill (Claude discovers this)
└── package.json     # Build scripts for browse
```

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

Or copy the binary directly: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
