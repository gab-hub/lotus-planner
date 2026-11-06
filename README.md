# Lotus Planner

An Obsidian plugin (macOS) that turns one markdown note into a calm daily dashboard:

- **Today / Tonight:** what's left on your calendar (read from macOS Calendar, so Google/iCloud/Exchange all work).
- **Daily routine:** a checklist that resets itself every morning, with 7-day dots per item and a gentle nudge
  when the routine keeps going unfinished (a sign it's too big). Optional `## Morning` / `## Afternoon` /
  `## Evening` sub-headings group it, and the dashboard highlights the part of the day you're in.
- **Frontlog:** each day gets a few tasks popped from the top of your `## Next` stack. You prioritize the stack;
  Claude only decides *how many* fit, using an effort budget (light on weeknights, more on weekends, less on
  evenings you have plans). Projects are split: their first open sub-item gets assigned as `Project › step`.
- **Tomorrow:** a look-ahead with tomorrow's events and planned tasks.
- Two progress rings, a greeting that follows the time of day, and everything committed to git.

Requirements: macOS, Obsidian desktop, Node, Xcode command line tools (`swiftc`), and
[Claude Code](https://claude.com/claude-code) signed in (`claude` on your PATH) for planning. Without Claude it
falls back to "top N of the stack".

## The note

One file in your vault (default `Planner.md`; see [example/Planner.md](example/Planner.md)):

```markdown
# Daily
## Morning                      ← optional sub-sections
- [ ] Morning routine
## Evening
- [ ] Today's frontlog ↓        ← ticks itself when today's tasks are all done
# Frontlog
## Nov 5                        ← one section per day; unfinished tasks roll forward
- [ ] Reply to the landlord
## Next                         ← your priority stack, top = most important
- [ ] Book dentist
- [ ] Renew passport
	- [ ] Get photos taken
```

## Install

    git clone https://github.com/gab-hub/lotus-planner ~/code/lotus-planner
    cd ~/code/lotus-planner
    VAULT=~/path/to/your/vault ./install.sh laptop

This builds the calendar reader, symlinks `plugin/` into the vault, writes `config.sh` (your vault path, not in
git) and loads the launchd jobs. Then in Obsidian: Settings → Community plugins → enable **Lotus Planner**, and
set the task file, budgets and (optional) workout schedule in its settings tab. The first calendar read asks for
Calendar access.

## Schedule (launchd; a job missed while asleep runs on wake)

| When | What |
|---|---|
| 5am | Obsidian opens in the background; the plugin pulls, resets Daily, rolls unfinished tasks into today |
| 8am daily, 5pm weekdays | Dashboard comes to the front |
| 8pm | Tomorrow gets planned (on this Mac, or on an always-on Mac, below) |
| every 30 min | Calendar cache refresh + git sync |

### Optional: an always-on Mac does the planning

If your laptop is often asleep at 8pm, let a second Mac (e.g. a Mac mini) plan. Both clone the vault from the same
private git remote; `bin/lotus-sync` commits, `pull --rebase`s and pushes.

- Laptop: `./install.sh laptop`: resets Daily on wake, pushes at 7:50pm and every 30 minutes.
- Always-on Mac: `VAULT=… ./install.sh mini`: at 8pm `bin/lotus-plan.js` (no Obsidian needed) pulls, rolls today's
  unfinished tasks into tomorrow, plans tomorrow, pushes. Copy `plugin/data.json` from the laptop so it uses the
  same settings. Plan notes and task sizes travel in the vault at `.lotus/plan.json`.

Without a second Mac, add `plan` to the laptop's job list in `install.sh`.

### Adding tasks by talking to Claude

`install.sh` links `skills/add-task` into `~/.claude/skills`. Tell Claude Code "add a task: renew passport" and it
finds the slot binary-search style ("More important than *Book dentist*?"), about 5 questions for 30 items, then
inserts and pushes. Run a session on the always-on Mac with Remote Control to do this from your phone.

## Develop

    node test/core.test.js                                   # markdown logic
    LOTUS_VAULT=~/path/to/vault node bin/lotus-plan.js --dry-run   # what would be planned, no writes

Plain CommonJS, no build step. Pure functions are exported as `require('./plugin/main.js').core`.
