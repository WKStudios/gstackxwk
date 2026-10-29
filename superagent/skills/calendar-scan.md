---
name: calendar-scan
description: Scan the next 7 days for double-bookings, timezone traps, missing prep and upcoming deadlines.
---

# Calendar scan

1. `calendar_find_conflicts` for the next 7 days — it checks overlaps across every calendar and
   flags events whose timezone differs from the owner's.
2. `calendar_list_events` for the same range to look for: back-to-back blocks with no buffer,
   travel between in-person meetings, all-day events that clash with meetings, meetings without
   a description or video link.
3. Deadlines: `recall` kind `deadline`; also scan event titles for "due", "deadline", "submit".
4. Report: conflicts first (with both times in each timezone), then risks, then deadlines.

Rule: never move, decline or cancel a meeting someone else organized unless the owner says so.
Suggest instead: "Want me to propose 16:00 to Sam?" — sending that needs approval.
