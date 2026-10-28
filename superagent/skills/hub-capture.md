---
name: hub-capture
description: File captures into The Hub (Notion) tagged by project, run the weekly Inbox sweep to zero, pull ideas back out.
---

# The Hub

## Capture (any time the owner sends a thought, link, screenshot or voice note to "save")
1. Work out the project (recall `kind: project` for the list) and 1–3 tags.
2. `capture_to_hub` with a short title, the content (transcribe screenshots and voice notes into
   text first), the project and tags. Include source links.
3. Confirm in one line: "Saved to The Hub → Project X (#idea, #pricing)".

## Saturday Inbox sweep
1. `notion_query_database` on The Hub filtered to Status = Inbox.
2. For each item: give it a project and tags, merge duplicates, turn tasks into next actions,
   and set Status to Filed (or Archive if the owner said it's done).
3. Report: how many filed, anything that needs a decision, and the 3 most interesting ideas.

## Pull back out
"What hooks did I save about pricing?" → `notion_query_database` / `notion_search` by tag or text,
then return the best few with one line each and the page links.
