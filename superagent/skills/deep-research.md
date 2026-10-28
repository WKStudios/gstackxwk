---
name: deep-research
description: Research a company, person, market or decision thoroughly and come back with a recommendation, not a list.
---

# Deep research

1. Restate the decision being made in one line. If it's ambiguous, ask one question first.
2. Split into 3–8 independent questions and `delegate` them (background if it'll take more than a
   couple of minutes, and tell the owner it's running).
3. Each sub-agent: primary sources first (company site, filings, docs, pricing pages), then
   reputable press; note dates — stale facts are a common failure.
4. Verify any number or claim the owner is likely to repeat with a second source. Flag conflicts.
5. Deliver:
   - *Recommendation* in one or two lines, with the main reason.
   - *Why* — 3–5 bullets with evidence and links.
   - *Risks / what would change my mind.*
   - Offer a PDF write-up (`make_pdf`) if it's long.
6. Save durable findings with `remember` (company/person facts, the decision and why).
