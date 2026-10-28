---
name: daily-brief
description: Morning brief — what needs a reply, today's calendar with prep notes, deadlines coming up. Filters out newsletters and promos.
---

# Daily brief

Goal: one message the owner can read in 30 seconds and act on.

## Gather
1. `calendar_list_events` for today and tomorrow morning (all calendars).
2. `gmail_search` with `in:inbox newer_than:1d -category:promotions -category:social -category:updates -category:forums`.
   Then drop anything that is clearly a newsletter, digest, receipt, notification or marketing
   (sender like noreply/news/updates, "unsubscribe" footers, bulk sender names).
3. `recall` deadlines and open commitments (`kind: deadline`, `kind: commitment`).
4. Active missions from the context block.

## Decide what matters
- Needs a reply: a real person asked a question, requested something, or is waiting on the owner.
  Put the oldest-waiting and most important first. Say who, what they want, and how long they've waited.
- Calendar: flag double-bookings, back-to-backs with no travel time, events in another timezone
  (show both times), and meetings with no agenda. One line of prep per external meeting
  (who they are — check memory first, then email history).
- Deadlines in the next 7 days.

## Write it
```
☀️ *Tuesday brief*

*Needs you (3)*
• Jai — wants sign-off on the Q4 deck (waiting 2 days)
• …

*Today*
• 10:00 Acme intro (Priya, CTO — met at Web Summit) — prep: …
• ⚠️ 15:00 overlaps with 15:30 dentist

*Coming up*
• Fri: VAT return due
```
Skip empty sections. If nothing needs the owner, say so in one line. Offer: "Want drafts for any of these?"
