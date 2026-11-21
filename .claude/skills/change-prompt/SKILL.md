---
name: change-prompt
description: Safely change the agent's system prompt — create a new prompt version, run evals on old vs new, and record the result. Use for any change to agent instructions or behaviour rules.
---

# Change the agent prompt

Prompts are code. A prompt change can fix one case and silently break five others, so every change is
**versioned and measured**.

## Steps

1. **Find the reason.** Name the failing eval cases or traces that motivate the change. No reason → no change.
2. **Copy** the current version: `src/agent/prompts/vN.ts` → `src/agent/prompts/vN+1.ts`. Never edit a released version in place.
3. **Make the smallest change** that addresses the reason. Prefer:
   - a clear rule with a priority ("Never quote a price that did not come from a tool"),
   - a short example of good behaviour,
     over long lists of "don'ts".
4. **Point the agent** at the new version (one constant, so the old one is still selectable for comparison).
5. **Run evals** for the new version on the same provider and judge as the old one, in its own folder:
   `npm run evals -- --provider claude --reps 3 --prompt vN+1 --variant v<next>`, with a `change.md` in that folder
   (first line: what changed). The old version's rows are already in `baseline` or an earlier `v<N>`; one folder
   never mixes versions. Then `npm run evals:compare` and `npm run evals:report -- evals/runs/<model>`.
   Also give the new version its own `priceCorrection` note if the change touches prices.
6. **Compare** per check (extraction, tool use, no invented prices, handoff, tone). Keep the new version only if
   it fixes the target cases **without** making other checks worse. Otherwise, try again or revert.
7. **Record** the before/after table in the plan file and the PR description (real numbers only).
