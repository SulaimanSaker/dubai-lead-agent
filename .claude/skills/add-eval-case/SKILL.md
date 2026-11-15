---
name: add-eval-case
description: Add a golden test conversation to the eval suite (evals/cases/) with the expected lead fields, tool calls and handoff decision. Use when adding a tool, fixing an agent bug, or covering a new buyer behaviour.
---

# Add an eval case

Eval cases are the ground truth for "is the agent good?". They must describe what a **correct** agent does —
never what the current agent happens to do.

## Steps

1. **Pick one behaviour** to test (e.g. "cash buyer gives budget and area in the first message").
   One behaviour per case keeps failures easy to read.
2. **Name the file** after the behaviour: `evals/cases/<kebab-behaviour>.json`.
3. **Write the case** (the hook will ask the human to approve the new file — that is expected):
   ```json
   {
     "id": "cash-buyer-marina-2bed",
     "description": "Buyer gives area, beds, budget and cash in one message",
     "messages": [
       {
         "role": "user",
         "content": "Hi, looking for a 2 bed in Dubai Marina, budget around 120k a year, paying cash"
       }
     ],
     "expect": {
       "leadFields": { "area": "Dubai Marina", "beds": 2, "budget": 120000, "financing": "cash" },
       "toolCalls": [{ "name": "search_listings", "args": { "area": "Dubai Marina", "beds": 2 } }],
       "handoff": false
     }
   }
   ```
   - `toolCalls.args` lists only the arguments that matter (partial match).
   - Use realistic buyer language: typos, Arabic, mixed Arabic-English, vague budgets ("around 1.5M").
4. **Run it** on the local model first (free), then Claude: `npm run evals -- --provider local --case <id>`.
5. **Record** why this case exists in the feature's plan in `docs/plans/` (e.g. "seen in a trace on <date>").

## Rules

- Never edit an existing case to make it pass. If a case is wrong, explain why to the human first.
- Prefer real failures seen in testing or traces — they are the most valuable cases.
