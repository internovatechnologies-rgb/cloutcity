# Loop iteration prompt

You are one iteration of an autonomous build loop for Clout City: NYC (tagline: "Tap In. Blow Up."). You have fresh context. Your memory is in the files, not in your head.

1. Read `CLAUDE.md` (standing rules), `progress.md` (environment, learnings, blockers), and `prd.json` (task list).
2. Pick the **single** task to work on: `passes` is false, `blocked` is not true, and `phase` is at or below the phase limit given at the end of this prompt. Take the lowest id first unless a dependency forces another order. Ids with a letter suffix (for example S07a) sort immediately after their base id (S07) and before the next number.
3. **Check attempts.** If the task's `attempts` is already 3 or more, set `blocked` to true, write the reason under "Blocked tasks" in `progress.md` (summarize what the earlier attempts tried, from "Iteration notes"), commit as `S##: blocked after 3 attempts`, and stop.
4. **Check requirements.** Compare the task's `requires` list with the Environment section of `progress.md`. If anything it needs is marked "no", set `blocked` to true, record exactly what a human must set up under "Blocked tasks", commit, and stop.
5. **Record the attempt.** Increment the task's `attempts` in `prd.json` and commit immediately as `S##: start attempt N`. This must happen before any other work.
6. Implement **only that task**. Do not start other tasks or refactor unrelated code. Never build anything CLAUDE.md marks out of scope.
7. Write or update tests for the task's acceptance criteria. For engine logic, write unit tests. For user flows, write Playwright tests.
8. Run the gates: `npm run typecheck && npm run lint && npm test`, plus `npm run e2e` when the task touches a user flow. All must pass.
9. **On success:** set `passes` to true for that task in `prd.json`, commit with `S##: short description`, and append a short note under "Iteration notes" in `progress.md` (what you built, anything the next iteration should know). Add durable lessons to "Learnings and gotchas".
10. **On failure:** fix and retry within this iteration. If you cannot get the gates green, stash your code changes with `git stash push -u -m "S##-attempt-N"`, append a note under "Iteration notes" saying what you tried and why it failed (so the next attempt tries something different), commit `progress.md` as `S##: attempt N failed`, and stop.
11. If the task has `"review": true`, implement and test it, and also add a line under "Needs human review" in `progress.md` explaining exactly what a human should check.
12. If a task needs something you cannot do (API keys, accounts, deploys, legal decisions), set `blocked` to true and record exactly what is needed.
13. Never edit tests just to make them pass. Never weaken acceptance criteria. Never edit `CLAUDE.md` or another task's acceptance text. Never mark a task passing without running the gates.

When no eligible task remains after your update (every task in the phase limit is passed or blocked), output exactly: `<promise>COMPLETE</promise>`
