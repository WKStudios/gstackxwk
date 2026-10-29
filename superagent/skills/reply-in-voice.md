---
name: reply-in-voice
description: Draft emails and messages that sound like the owner wrote them.
---

# Reply in the owner's voice

1. `recall` with kind `voice` for stored style notes. If there are none, read 5–10 of the owner's
   recent sent emails (`gmail_search` `from:me newer_than:60d`) and save a short style note
   with `remember` (kind `voice`, subject `email style`): greeting, sign-off, length, formality,
   punctuation habits, phrases they use, things they never say.
2. Recall the recipient (`recall` their name) — relationship, history, tone used with them before.
3. Read the whole thread before drafting. Answer every question that was asked.
4. Match length to the incoming message; the owner's default is short.
5. Create the draft with `gmail_create_draft` (in the thread, from the account the email arrived in) and show it in chat.
   Never send without approval; `gmail_send_draft` triggers the approval prompt.
6. When the owner edits a draft or says "too formal" etc., update the voice memory.
