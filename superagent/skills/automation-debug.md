---
name: automation-debug
description: Explain why a scheduled task, watcher or mission failed and fix it.
---

# Debug an automation

1. `list_tasks` to find it, then `task_history` for its recent runs (status, output, error).
2. Common causes:
   - Integration not connected or token expired → tell the owner to run /connect google.
   - The page being watched changed layout or now needs JavaScript → set `render: true`.
   - Gmail query matches nothing → test it with `gmail_search`.
   - Too-frequent schedule hitting rate limits → slow it down.
   - The prompt asks for something no tool can do.
3. Fix with `update_task` (schedule, prompt, mode) and `run_task_now` to prove it works.
4. Report: what broke, what you changed, and the result of the test run — in three lines.
