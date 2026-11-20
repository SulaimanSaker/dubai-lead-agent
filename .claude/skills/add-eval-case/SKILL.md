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
2. **Pick the category file** in `evals/cases/` (`qualification`, `search`, `booking`, `handoff`,
   `no-invented-fields`, `robustness`) and give the case an `id` named after the behaviour.
3. **Write the case** in that file's `cases` array (the hook will ask the human to approve the edit, that is
   expected). The schema is `evals/lib/cases.ts`:
   ```json
   {
     "id": "cash-buyer-marina-2bed",
     "description": "Buyer gives area, beds, budget and cash in one message: save all of it and search",
     "tags": ["qualification", "en"],
     "source": "real: Gemma probe 2026-11-15 searched but never saved budget or cash",
     "messages": [
       "Hi, I'm looking for a 2 bed in Dubai Marina, budget around 120k a year, paying cash."
     ],
     "expect": {
       "lead": {
         "purpose": "rent",
         "areas": ["Dubai Marina"],
         "beds": 2,
         "budgetAed": 120000,
         "financing": "cash"
       },
       "leadUnknown": ["timeline"],
       "toolCalls": [
         { "name": "update_lead" },
         { "name": "search_listings", "args": { "beds": 2, "maxPriceAed": 120000 } }
       ],
       "forbiddenTools": ["book_viewing"],
       "viewingBooked": false,
       "handoff": false,
       "language": "en"
     }
   }
   ```
   - `viewingBooked`, `handoff` and `language` are required, so every case says what must NOT happen too.
   - `toolCalls.args` lists only the arguments that matter (partial match).
   - Take expected listings from the seed data (`src/db/seed-data.ts`), never from a model's output.
   - Use realistic buyer language: typos, Arabic, mixed Arabic-English, vague budgets ("around 1.5M").
   - `npm run evals:cases` regenerates `evals/CASES.md` for the human review.
4. **Run it** on the local model first (free), then Claude: `npm run evals -- --provider local --case <id>`.
5. **Record** why this case exists in the feature's plan in `docs/plans/` (e.g. "seen in a trace on <date>").

## Rules

- Never edit an existing case to make it pass. If a case is wrong, explain why to the human first.
- Prefer real failures seen in testing or traces — they are the most valuable cases.
