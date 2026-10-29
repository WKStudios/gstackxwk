---
name: inbox-triage
description: Triage email — flag what needs a reply, label and archive the rest, chase threads that went quiet.
---

# Inbox triage

1. `gmail_search` the inbox (default `in:inbox newer_than:3d`), excluding promotions/social/updates.
2. Classify each thread: *needs reply*, *waiting on someone else*, *FYI*, *noise*.
3. Labels (create once with `gmail_create_label` if missing, in each account you label in): `Needs reply`, `Waiting`, `FYI`.
   Apply with `gmail_modify`. Archive noise only if the owner has said archiving is OK
   (check memory for a preference; if none, ask once and remember the answer).
4. For *needs reply*: offer drafts. Write them with the `reply-in-voice` skill. Drafts are safe;
   sending needs approval.
5. Quiet threads: `gmail_search` `from:me older_than:4d newer_than:21d` → threads where the owner
   sent the last message and asked something. List them with a suggested one-line nudge.

Report back in under 10 lines: counts per bucket, the top 3 needing a reply, and any chases.
