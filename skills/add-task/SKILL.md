---
name: add-task
description: Add a new task to the Lotus Planner task file in the user's Obsidian vault by interviewing them binary-search style about where it belongs in the "## Next" priority stack. Use when the user says "add a task", "new task", "add X to my list/frontlog/lotus", or messages a to-do to file.
---

# Add a task to Lotus Planner

**Find the file.** The repo is wherever this skill's symlink points (usually `~/code/lotus-planner`).
`<repo>/config.sh` sets `LOTUS_VAULT`. The task file is `$LOTUS_VAULT/<file>`, where `<file>` is the `"file"` key in
`<repo>/plugin/data.json` (default `Planner.md`).

Under `# Frontlog` there is a `## Next` section: a stack of top-level `- [ ]` items, highest priority first, with
tab-indented sub-items. The nightly planner pops from the top, so position = priority. The user prioritizes; your
job is to find the right slot with as few questions as possible.

## Steps

1. **Pull first:** `bash <repo>/bin/lotus-sync "$LOTUS_VAULT"`
2. **Read** `## Next` and list its **open top-level items** in order (ignore `- [x]` items and sub-items).
   Call them `items[0..n-1]`.
3. **Date shortcut:** if the user says the task is for today/tomorrow/a date, put it at the end of that date's
   `## <Mon D>` section in `# Frontlog` (create the heading just above `## Next` if missing), skip the search, go to 6.
4. **Binary search for the slot.** `lo = 0`, `hi = n`. While `lo < hi`:
   - `mid = (lo + hi) // 2`
   - Ask exactly one short question: **"More important than “<items[mid]>”?"** (yes / no)
   - yes → `hi = mid`; no → `lo = mid + 1`
   - The user can answer "top" (slot 0), "bottom" (slot n), or "between X and Y" instead.
   About log2(n) questions; for 30 items that's 5. One at a time, phone-friendly, no preamble.
5. **Insert** `- [ ] <task>` (keep the user's wording; any sub-steps they gave become tab-indented `- [ ]` children)
   directly before `items[lo]`'s line, or after the last item's block (including its sub-items) if `lo == n`.
   Touch nothing else. Indent with tabs.
6. **Push:** `bash <repo>/bin/lotus-sync "$LOTUS_VAULT"`
7. **Confirm in one line:** "Added *<task>* as #<lo+1> of <n+1>, between “<above>” and “<below>”."

Several tasks in one message: one at a time, each with its own search.
