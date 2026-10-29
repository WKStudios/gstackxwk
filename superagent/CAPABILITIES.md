# Capabilities, A to Z

The Base44 super agent list, item by item, and what this agent does for each.

✅ built &nbsp;·&nbsp; 🔌 built, needs that integration's key &nbsp;·&nbsp; 🟡 partly &nbsp;·&nbsp; ⛔ not built

## 1. Email (Gmail)

| # | Capability | | How |
|---|---|---|---|
| 1 | Daily brief, no newsletters/digests/promos | ✅ | `daily-brief` playbook; `/starter` schedules it for 07:30 on weekdays. Skips Gmail's promo/social/update tabs and anything that looks like bulk mail (unsubscribe headers, no-reply senders) |
| 2 | Flag what needs a reply | ✅ | `inbox-triage` playbook; labels threads `Needs reply` / `Waiting` / `FYI` |
| 3 | Draft replies in your voice | ✅ | `reply-in-voice` playbook learns your style from sent mail and saves it as a memory; drafts never send without approval |
| 4 | Label and organize | ✅ | create labels, label, archive, mark read; trash needs approval |
| 5 | Search history ("when did Jai first email me") | ✅ | full Gmail query syntax (`from:`, `before:`, `has:attachment`…) |
| 6 | Read attachments and invoices | ✅ | PDFs and images read directly; Word/Excel/zip through the code sandbox |
| 7 | Chase threads that went quiet | ✅ | finds threads where you're waiting on a reply and proposes nudges; `/starter` runs it Wednesdays |

## 2. Calendar

| # | Capability | | How |
|---|---|---|---|
| 8 | Scan 7 days for double-bookings | ✅ | `calendar_find_conflicts` checks overlaps across every calendar in code; declined and "free" events don't count |
| 9 | Warn about deadlines before they hit | ✅ | deadlines saved as memories, scanned by the brief and the Sunday calendar check; one-off reminders on request |
| 10 | Prep on who you're meeting and why | ✅ | `meeting-prep` playbook: memory, email history, then the web |
| 11 | Events across calendars, timezone traps | ✅ | all calendars in every connected Google account at once (`/connect google` once per account); a meeting on two accounts counts once; events set in another timezone show both times and get flagged |
| 12 | Never move or cancel someone else's meeting without you | ✅ | **enforced in code**: changing, cancelling or RSVPing to a meeting with guests, or one you don't organize, waits for your Approve |

## 3. Notion and the note system

| # | Capability | | How |
|---|---|---|---|
| 13 | File captures into The Hub, tagged by project | 🔌 | `capture_to_hub` reads your Hub's columns and fills title, tags, project, status=Inbox, link |
| 14 | Saturday Inbox sweep to zero | 🔌 | `hub-capture` playbook; `/starter` schedules it for Saturday 10:00 |
| 15 | Read and update any page or database | 🔌 | pages shared with the integration: read, query, update properties, append content |
| 16 | Build new databases and templates | 🟡 | creates databases with typed columns and template pages; Notion's API can't register a page as a database's built-in template |
| 17 | Pull hooks and ideas back out | 🔌 | query by tag, project or text |

## 4. Capture in the moment

| # | Capability | | How |
|---|---|---|---|
| 18 | Screenshots read and explained | ✅ | Claude vision |
| 19 | Voice notes transcribed | 🔌 | any OpenAI-compatible speech-to-text (OpenAI, Groq…) |
| 20 | Photos of receipts, documents, whiteboards | ✅ | read on arrival and saved to the files folder so they can be filed or forwarded |
| 21 | Half-formed thoughts, filed | ✅ | to The Hub, or to memory if Notion isn't connected |

## 5. Research

| # | Capability | | How |
|---|---|---|---|
| 22 | Web search on anything current | ✅ | Anthropic web search + fetch |
| 23 | Dig into a company, person or opportunity | ✅ | `deep-research` playbook fans out to sub-agents |
| 24 | A recommendation, not a list | ✅ | a standing rule in the agent's instructions |
| 25 | Verify a claim before you repeat it | ✅ | checks sources, gives links and a confidence level |

## 6. Browser work (real, not simulated)

| # | Capability | | How |
|---|---|---|---|
| 26 | Open sites and read them | ✅ | gstack's own headless Chromium, its own cookies and tabs |
| 27 | Fill forms and submit applications | ✅ | filling is free; anything that submits, books, buys or posts waits for Approve |
| 28 | Pull data from behind a login you give it | ✅ | `/vault set` stores the password; the model only ever writes `{{secret:name}}`, and the value is scrubbed from page output |
| 29 | Watch a page for a change | ✅ | fetches and diffs first; Claude only looks (and costs anything) when the page actually changed |
| 30 | Screenshot evidence and show you | ✅ | the agent sees the screenshot too, and can send it |

## 7. Files and media

| # | Capability | | How |
|---|---|---|---|
| 31 | Read any document you send | ✅ | PDF natively; text formats inline; Office files and archives through the sandbox |
| 32 | Generate images | 🔌 | OpenAI-compatible image API |
| 33 | Transcribe audio up to 25MB | 🔌 | same speech-to-text provider; 25MB limit enforced |
| 34 | Host files and send download links | ✅ | private, unguessable, expiring links served by your own server |
| 35 | Send a finished PDF here | ✅ | `make_pdf` renders HTML in Chromium, `send_file` delivers it as a WhatsApp document |
| 36 | Browse your Google Drive | 🔌 | search; read Docs, Sheets (as CSV), Slides, PDFs |

## 8. Automation

| # | Capability | | How |
|---|---|---|---|
| 37 | Recurring schedules ("every Friday at 6pm") | ✅ | cron in your timezone, confirmed back in plain words |
| 38 | Triggers on data changes | ✅ | page watchers, and any scheduled check with mode `if_changed` (only messages when the result changes) |
| 39 | Triggers on connected services | 🟡 | new email matching a search: ✅ (`watch_gmail`). New Drive files and calendar changes work as scheduled checks (polling every few minutes), not instant push |
| 40 | Multi-step workflows with waits and branches | ✅ | described in plain words: missions handle the branching; one-off follow-ups handle the waits ("if Sam hasn't replied by Friday, chase") |
| 41 | Pause or kill any of it on one word | ✅ | `stop`, `stop all`, `/pause`; or "pause the Friday report" |
| 42 | Debug a failing automation and say why | ✅ | every run is logged with output and error; you get one alert on the first failure; `automation-debug` playbook fixes and re-tests |

## 9. Heavy lifting in the background

| # | Capability | | How |
|---|---|---|---|
| 43 | Sub-agents, up to 12 at once | ✅ | `delegate`; sub-agents get read-only tools |
| 44 | Long research missions while you carry on | ✅ | `delegate` in the background; the answer arrives as a new message |
| 45 | Goals that survive across days | ✅ | missions: a goal, a progress log and a check-in schedule, until done, failed or past the deadline |
| 46 | Phone calls to chase people | 🔌 | Twilio: delivers your message and records the answer to one question, then reports back. Open-ended back-and-forth voice conversations aren't built |

## 10. Building

| # | Capability | | How |
|---|---|---|---|
| 47 | Custom skills for anything you repeat | ✅ | "save that as a skill" writes a Markdown playbook it follows next time |
| 48 | Backend functions, written, deployed, tested | ⛔ | Base44 hosts functions for you; this agent runs code in a sandbox but doesn't deploy services. For real code, use gstack in Claude Code (`/review`, `/ship`) |
| 49 | Databases and data models | 🟡 | Notion databases, plus its own SQLite for memory and automations |
| 50 | Read and edit your Base44 apps | ⛔ | Base44-specific. Add GitHub's MCP server (`MCP_SERVERS`) to read your repos |
| 51 | Run code in its own sandbox | ✅ | Anthropic's code execution container (Python, pandas, charts, file conversion), kept per conversation |

## 11. Talking to you

| # | Capability | | How |
|---|---|---|---|
| 52 | WhatsApp or web chat | ✅ | official WhatsApp Cloud API, a web chat page, and a terminal mode |
| 53 | Voice notes back | 🔌 | `/voice on`, or `mirror` (voice back when you send voice) |
| 54 | WhatsApp groups for a team | ⛔ | the official API's group support is limited. Instead, teammates in `MEMBER_PHONES` each get a private thread with their own memory, plus team memories you mark as shared; none of your email, calendar, Drive, Notion or vault |
| 55 | Same brain wherever you reach it | ✅ | WhatsApp and web chat share one thread, one memory and one set of automations |

## 12. Memory

| # | Capability | | How |
|---|---|---|---|
| 56 | Remembers your voice, projects, people | ✅ | typed memories (person, project, preference, voice, deadline…), the most important pinned into every conversation, the rest recalled by relevance |
| 57 | Notes that build up instead of resetting | ✅ | memories are updated in place; long threads are summarized, not dropped |
| 58 | Recall of past conversations | ✅ | full-text search over every message ever exchanged, even after summarizing |

---

## Beyond the list

Things this agent does that the list doesn't mention:

- **Approvals enforced in code, with real buttons.** The gates aren't a prompt the model could talk itself past. Reply "no, make it shorter" and it adjusts instead of just stopping. 👍 on the request also approves.
- **Prompt-injection posture.** Email, web and document content is marked as data; anything outward-facing still needs your tap.
- **A password vault the model never sees** (gstack's planned "auth vault", delivered here).
- **Quiet hours and the 24h rule handled.** Overnight results wait until morning; after a quiet day it sends an approved template and delivers the full message when you reply, instead of failing silently.
- **Watchers that cost nothing until something changes.** Pages are diffed and new emails are deduplicated before Claude sees anything.
- **A spend cap** (`DAILY_BUDGET_USD`), `/usage`, and an audit log of every action (`/log`).
- **Chat that works the way people text.** Three bubbles in a row become one request; messages sent while it's working join the next turn; `stop` works mid-task; quoting one of its earlier messages gives it that context.
- **Free, instant commands** for the things that shouldn't need a model call.
- **Yours.** One SQLite file on your server, open-source code, playbooks you edit as Markdown, and any Claude model you choose.
