# gstack superagent

A personal agent that lives on WhatsApp. Message it whenever you need something: it reads and drafts your email, runs your calendar, files notes in Notion, researches, uses a real browser, makes PDFs, runs code, and keeps working on things in the background. It messages you when there's something you should know.

It runs on your own server, uses your own accounts, and won't send an email, accept an invite or submit a form until you tap **Approve**.

```
You (WhatsApp / web chat / terminal)
      │  text · photos · voice notes · documents · locations
      ▼
┌────────────────────────────────────────────────────────────────────┐
│ router   allowlist → approval answer? → command? → debounce → queue │
│            (one turn at a time per conversation; "stop" cuts in)    │
├────────────────────────────────────────────────────────────────────┤
│ agent    Claude (Opus 5.5) · adaptive thinking · prompt caching     │
│          memory in context · compaction when the thread gets long   │
│   tools: Gmail · Calendar · Drive · Notion · web search/fetch ·     │
│          real browser (gstack browse) · code sandbox · PDF · files ·│
│          schedules · watchers · missions · sub-agents · calls       │
│   gates: approvals for anything outward-facing or hard to undo      │
├────────────────────────────────────────────────────────────────────┤
│ scheduler  cron tasks · page/email watchers · multi-day missions    │
│ delivery   quiet hours · WhatsApp 24h window · outbox               │
│ store      SQLite: history, memory (full-text), jobs, usage, audit  │
└────────────────────────────────────────────────────────────────────┘
```

What it can do, item by item against the Base44 super agent list: **[CAPABILITIES.md](CAPABILITIES.md)**.

---

## Try it in two minutes (no WhatsApp needed)

```bash
cd ~/.claude/skills/gstack     # or wherever you cloned gstack
./setup                         # bun install + browser (once)
cp superagent/.env.example .env
# edit .env: ANTHROPIC_API_KEY, OWNER_NAME, OWNER_TIMEZONE
bun run superagent:console
```

```
▶ remember that Jai Patel is the CFO at Acme and prefers calls
◀ Got it — Jai Patel, CFO at Acme, prefers calls.
▶ what's the latest on Acme's funding? one-paragraph answer with links
◀ …
▶ every friday at 6pm send me a weekly review
◀ Done — "Weekly review" runs Fridays at 18:00 (Europe/London), first on Fri 30 Oct.
```

## Go live on WhatsApp

You need a server with a public **https** URL (a $5 VPS with Caddy, Fly.io, Railway, or a Cloudflare Tunnel to your own machine while testing).

### 1. Run the server

```bash
bun run superagent            # listens on $PORT (8787)
bun run superagent:check      # verifies every connection
```

To keep it running on a VPS, a systemd unit is enough:

```ini
# /etc/systemd/system/superagent.service
[Service]
WorkingDirectory=/home/you/gstack
ExecStart=/home/you/.bun/bin/bun run superagent
Restart=always
User=you

[Install]
WantedBy=multi-user.target
```

and Caddy for https: `agent.example.com { reverse_proxy localhost:8787 }`.

### 2. Connect WhatsApp (Meta Cloud API — official, no ban risk)

1. Create an app at developers.facebook.com → **Business** type → add the **WhatsApp** product.
2. **Phone number**: use the test number to start, or add a real number that isn't on a personal WhatsApp account. Copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. **Token**: Business Settings → Users → System users → add an admin system user → *Generate token* for your app with `whatsapp_business_messaging` and `whatsapp_business_management` → `WHATSAPP_TOKEN` (this one doesn't expire, unlike the 24h token on the getting-started page).
4. **App secret**: App settings → Basic → `WHATSAPP_APP_SECRET`. Every webhook is checked against it.
5. **Webhook**: WhatsApp → Configuration → Callback URL `https://agent.example.com/webhook/whatsapp`, Verify token = your `WHATSAPP_VERIFY_TOKEN`. Subscribe to the **messages** field.
6. **Allowlist**: put your own number in `OWNER_PHONES`. Messages from any other number are ignored.
7. **Re-engagement template** (recommended): WhatsApp only lets a business send free-form messages within 24 hours of your last message. For your 7:30 brief after a quiet day, create a *Utility* template, e.g. name `agent_update`, body `You have an update from your agent: {{1}}`. Once it's approved, set `WHATSAPP_TEMPLATE_NAME`. The agent sends the template as a nudge and delivers the full message the moment you reply. Without a template, proactive messages wait until you next write.

Save the number in your phone as your agent and say hi.

### 3. Connect your accounts (each optional)

| Integration | Set | Then |
|---|---|---|
| **Gmail + Calendar + Drive** | Google Cloud console → new project → enable Gmail API, Google Calendar API, Google Drive API → OAuth consent screen (External; add yourself as a test user) → Credentials → OAuth client ID, type *Web application*, redirect URI `https://agent.example.com/oauth/google/callback` → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | send **/connect google** and tap the link. Set the consent screen to *In production* (unverified is fine for personal use), otherwise Google expires the connection every 7 days. |
| **Notion** | notion.so/profile/integrations → new internal integration → `NOTION_TOKEN`. On each page/database it should see: ••• → Connections → add it. Your capture inbox ("The Hub") id → `NOTION_HUB_DATABASE_ID` | "save this to the hub" |
| **Voice notes in, voice replies, images** | `OPENAI_API_KEY` (or per-feature `STT_*`, `TTS_*`, `IMAGE_*` for any OpenAI-compatible provider, e.g. Groq Whisper) | send a voice note; `/voice on` to always reply with audio |
| **Phone calls** | Twilio account + number: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | "call Sam and ask when the contract will be signed" |
| **Anything with a remote MCP server** (Linear, Asana, Stripe, GitHub…) | `MCP_SERVERS` JSON | they show up as tools. These run without approval prompts, so prefer read-only tokens. |
| **Web chat** | `ADMIN_TOKEN` | open `https://agent.example.com/chat?token=…` once per device |

## Using it

Talk normally. Some things to try:

- "What needs my reply today?" · "Draft a reply to Jai saying yes but next week" · "Send it" *(→ Approve button)*
- "Any double-bookings next week?" · "Prep me for my 2pm" · "Move my gym block to 7am"
- *(photo of a receipt)* "file this under expenses" · *(voice note)* "idea: …save it to the hub"
- "Dig into Acme before my call tomorrow — background" *(sub-agents; you get the answer when it's done)*
- "Watch this page and tell me when the price is under £200: https://…"
- "Every weekday at 7:30 send me a brief" · "Pause the Friday report" · "Why did the brief fail?"
- "Get me a refund from the airline for BA123 — keep at it until it's done" *(a mission that checks in for days)*
- "Turn this into a PDF" · "Make a chart from this spreadsheet" · "Log into my utility account and get last month's bill"

### Commands (instant, never sent to the model)

| | |
|---|---|
| `stop` / `stop all` | stop the current task / also cancel background work |
| `/pause` · `/resume` | pause every schedule, watcher and mission |
| `/jobs` · `/missions` | what's scheduled, what's in progress |
| `/memory [search]` · `/forget <id>` | inspect and edit what it remembers |
| `/usage` · `/budget <usd>` | today's spend; raise today's cap |
| `/voice on\|off\|mirror` | voice replies always / never / when you send voice |
| `/vault set <name> <value>` | store a password for browser logins; the model only ever sees `{{secret:name}}` |
| `/connect google` · `/disconnect google` | link or unlink Google |
| `/new` | fresh conversation thread (memory and automations stay) |
| `/log` · `/status` · `/starter` · `/help` | recent actions · what's connected · install starter automations · help |

## How it keeps you safe

- **Only your numbers.** `OWNER_PHONES` is required; everyone else is ignored. Teammates in `MEMBER_PHONES` get their own thread, memories and files folder, and never see your email, calendar, Drive, Notion, vault or personal memories. Memories you mark as shared ("remember for the team: …") are visible to everyone.
- **Approval gates enforced in code, not by prompt:** sending email, inviting people, changing or cancelling meetings with guests (or anyone else's meeting), RSVPs, trashing mail, archiving Notion pages, browser actions that submit, and phone calls all wait for your **Approve**. Reply with anything else ("no, make it shorter") and it adjusts instead.
- **Untrusted content stays data.** Emails, web pages and documents are marked as information; the agent is told never to follow instructions inside them, and the approval gate backs that up.
- **Secrets never reach the model.** Vault values are swapped in at execution time and redacted from page output.
- **Public internet only.** The browser and page watchers refuse localhost, private networks and cloud-metadata addresses.
- **Kill switches:** `stop`, `stop all`, `/pause`.
- **Spend cap:** `DAILY_BUDGET_USD` (default $15/day) blocks new turns once reached; `/usage` shows where you are.
- **Audit log:** every tool call is recorded; `/log` shows the last 15.

## Costs

Claude Opus 5.5 is $4 / $20 per million input/output tokens, and the stable part of the prompt (persona, rules, tool definitions) is cached. Expect a few cents for a quick question and roughly 10–50¢ for a daily brief or a research task with web searches; `/usage` shows the real numbers. Long threads are summarized automatically (`COMPACT_AT_TOKENS`) so every message doesn't resend weeks of history. `SUPERAGENT_EFFORT=low` makes everyday replies cheaper and faster. WhatsApp charges per template message outside the 24h window (replies inside it are free).

## Customizing

- **Playbooks** live in `superagent/skills/*.md` (daily brief, inbox triage, reply in your voice, calendar scan, meeting prep, The Hub, deep research, debugging automations). Edit them, or ask the agent to "save that as a skill" — it writes new ones to `<data>/skills/`.
- **Persona and rules**: `src/agent/prompt.ts`.
- **Model and depth**: `SUPERAGENT_MODEL`, `SUPERAGENT_EFFORT`, `SUPERAGENT_BACKGROUND_EFFORT`.
- **New tools**: add a `defineTool({...})` to `src/tools/` with a zod schema and, if it acts on the world, an `approval` function.

## Development

```bash
bun run test:superagent    # fake Claude client, fake WhatsApp, real SQLite
bun run typecheck
```

```
superagent/
├── src/
│   ├── index.ts            serve | console | check
│   ├── app.ts              wiring
│   ├── server.ts           webhook, web chat, files, OAuth + Twilio callbacks
│   ├── router.ts           allowlist, debounce, per-conversation queue, stop
│   ├── commands.ts         /commands
│   ├── approvals.ts        Approve/Deny gates
│   ├── delivery.ts         quiet hours, 24h window, outbox
│   ├── scheduler.ts        jobs, watchers, missions
│   ├── inbound.ts          photos, voice, documents → Claude content
│   ├── store.ts            SQLite (history, memory, jobs, usage, audit)
│   ├── agent/              loop, prompt, pricing
│   ├── tools/              everything Claude can call
│   ├── integrations/       Google, Notion, browser, media, Twilio
│   └── channels/           WhatsApp, web, console
├── skills/                 built-in playbooks
└── test/
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Webhook verification fails | `WHATSAPP_VERIFY_TOKEN` must match what you typed in Meta; the URL must be reachable over https. |
| Nothing happens when you message it | Check the server log for "ignoring message from unknown sender" — fix `OWNER_PHONES` (digits with country code). With Meta's test number, your phone must also be in the test recipients list. |
| Error 131047 (re-engagement) | More than 24h since you last wrote: set up the template (step 7) or just message it first. |
| Google keeps disconnecting weekly | Publish the OAuth consent screen (*In production*). |
| "Nothing found" in Notion | Share the page/database with the integration (••• → Connections). |
| Browser/PDF errors about a missing Chromium | Run `./setup` (installs the Chromium matching your Playwright), or set `CHROMIUM_PATH` for PDFs. |
| It's too chatty / too terse | Tell it ("keep replies to two lines") — it saves preferences to memory. |
