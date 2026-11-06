'use strict';
// Lotus Planner — Obsidian plugin.
// Dashboard for tonight + tomorrow, daily-checklist reset, and frontlog assignment from "## Next".
// Plain CommonJS so there is no build step: edit this file, reload the plugin.

const obsidian = require('obsidian');
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, TFile } = obsidian;
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VIEW_TYPE = 'lotus-planner-dashboard';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ITEM_RE = /^- \[( |x|X)\] (.*)$/;

const DEFAULTS = {
  file: 'Planner.md',
  claudePath: path.join(os.homedir(), '.local/bin/claude'),
  // Blank = next to the plugin's real (symlinked) folder: <repo>/cache/events.jsonl, <repo>/bin/lotus-sync.
  cacheFile: '',
  syncScript: '',
  excludeCalendars: 'Birthdays, US Holidays, Holidays in United States, Siri Suggestions, Scheduled Reminders',
  // Sun..Sat
  // Optional, 7 entries Sun..Sat, e.g. Rest, Lift, Run, ... Shown as a chip and on the "Workout…" Daily item.
  workouts: [],
  // Planning prompt. Weekday tasks happen after eveningHour; a weekday with an event after then is a busy evening.
  context: 'The person works a day job, so weekday tasks happen in the evening.',
  eveningHour: 17,
  planHour: 20,
  budgetWeekday: 'about 60 minutes after work: at most 1 medium task (~30 min) + quick ones. No big tasks. Max 5 items.',
  budgetBusyEvening: 'about 30 minutes: quick tasks only, max 3 items.',
  budgetWeekend: 'about 3 hours total: at most 1 big task (1-2h) + 2 medium + any quick ones. Max 7 items.',
  lastNewDay: null,
  lastNudge: null,
  planned: {},
  sizes: {},
  history: {},
};

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateLabel = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** "Nov 5" -> Date nearest to `ref` (handles the Dec/Jan boundary). */
function labelToDate(label, ref) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})$/.exec(label.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  let best = null;
  for (const y of [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1]) {
    const d = new Date(y, month, Number(m[2]));
    if (!best || Math.abs(d - ref) < Math.abs(best - ref)) best = d;
  }
  return best;
}

function timeLabel(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${pad(m)}${ampm}` : `${h}${ampm}`;
}

// ---------------------------------------------------------------- markdown structure

function headingLevel(line) {
  const m = /^(#{1,6}) /.exec(line);
  return m ? m[1].length : 0;
}

/** [start, end) of the section whose heading is at `idx` (end = next heading of same or higher level). */
function sectionEnd(lines, idx) {
  const level = headingLevel(lines[idx]);
  for (let i = idx + 1; i < lines.length; i++) {
    const l = headingLevel(lines[i]);
    if (l && l <= level) return i;
  }
  return lines.length;
}

function findHeading(lines, text, level, from = 0, to = lines.length) {
  for (let i = from; i < to; i++) {
    if (headingLevel(lines[i]) === level && lines[i].slice(level + 1).trim() === text) return i;
  }
  return -1;
}

/** "# Frontlog" (or the older "# Backlog"). */
function frontlogHeading(lines) {
  const f = findHeading(lines, 'Frontlog', 1);
  return f >= 0 ? f : findHeading(lines, 'Backlog', 1);
}

function greeting(d) {
  const h = d.getHours();
  if (h < 5) return 'Up late — go to bed 🌙';
  if (h < 8) return 'Early start ☀️';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 20) return 'Good evening';
  if (h < 22) return 'Winding down';
  return 'Good night 🌙';
}

/** Frontlog "## Nov 5"-style sections, in document order. */
function dateSections(lines, ref) {
  const b = frontlogHeading(lines);
  if (b < 0) return [];
  const bEnd = sectionEnd(lines, b);
  const out = [];
  for (let i = b + 1; i < bEnd; i++) {
    if (headingLevel(lines[i]) !== 2) continue;
    const label = lines[i].slice(3).trim();
    const date = labelToDate(label, ref);
    if (date) out.push({ idx: i, end: sectionEnd(lines, i), label, date });
  }
  return out;
}

/** Index of the "## <date>" heading, creating it in chronological position inside # Frontlog. */
function ensureDateSection(lines, date) {
  const label = dateLabel(date);
  const existing = dateSections(lines, date).find((s) => s.label === label);
  if (existing) return existing.idx;
  let b = frontlogHeading(lines);
  if (b < 0) {
    lines.push('# Frontlog');
    b = lines.length - 1;
  }
  const bEnd = sectionEnd(lines, b);
  let insertAt = bEnd;
  for (let i = b + 1; i < bEnd; i++) {
    if (headingLevel(lines[i]) !== 2) continue;
    const d = labelToDate(lines[i].slice(3).trim(), date);
    if (!d || d > date) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, `## ${label}`);
  return insertAt;
}

// ---------------------------------------------------------------- outline trees (tab-indented lists)

function parseTree(lines) {
  const root = { depth: -1, children: [] };
  const stack = [root];
  for (const line of lines) {
    if (line.trim() === '') {
      root.children.push({ depth: 0, text: '', blank: true, children: [] });
      stack.length = 1;
      continue;
    }
    const depth = /^\t*/.exec(line)[0].length;
    const node = { depth, text: line.slice(depth), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function serialize(nodes, shift = 0, out = []) {
  for (const n of nodes) {
    out.push(n.blank ? '' : '\t'.repeat(Math.max(0, n.depth + shift)) + n.text);
    serialize(n.children, shift, out);
  }
  return out;
}

const itemMatch = (n) => (n.blank ? null : ITEM_RE.exec(n.text));
const isOpenItem = (n) => {
  const m = itemMatch(n);
  return !!m && m[1] === ' ';
};
const itemText = (n) => {
  const m = itemMatch(n);
  return m ? m[2] : n.text.replace(/^- /, '');
};

/** Section body (lines after the heading, trailing blank lines excluded). */
function bodyRange(lines, idx) {
  let end = sectionEnd(lines, idx);
  while (end > idx + 1 && lines[end - 1].trim() === '') end--;
  return [idx + 1, end];
}

// ---------------------------------------------------------------- operations on Current.md

function resetDaily(lines) {
  const d = findHeading(lines, 'Daily', 1);
  if (d < 0) return 0;
  // A finished "(one-off)" item is removed (with its sub-items) instead of reset.
  for (let i = sectionEnd(lines, d) - 1; i > d; i--) {
    if (!/^- \[[xX]\] .*\(one-off\)\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && /^\t/.test(lines[j])) j++;
    lines.splice(i, j - i);
  }
  const end = sectionEnd(lines, d);
  let n = 0;
  for (let i = d + 1; i < end; i++) {
    const next = lines[i].replace(/^(\t*- )\[[xX]\]/, '$1[ ]');
    if (next !== lines[i]) {
      lines[i] = next;
      n++;
    }
  }
  return n;
}

/** Move open items from past date sections to the top of today's; drop the past sections (git keeps history). */
function rollover(lines, today) {
  const t = startOfDay(today);
  const past = dateSections(lines, t).filter((s) => s.date < t);
  if (!past.length) return 0;
  const carried = [];
  for (const s of past) {
    const [a, b] = bodyRange(lines, s.idx);
    carried.push(...parseTree(lines.slice(a, b)).filter(isOpenItem));
  }
  for (const s of [...past].reverse()) {
    let end = sectionEnd(lines, s.idx);
    lines.splice(s.idx, end - s.idx);
  }
  const idx = ensureDateSection(lines, t);
  lines.splice(idx + 1, 0, ...serialize(carried, -0));
  return carried.length;
}

/** Open items in "## Next" with ids like "4", "4.2", "4.2.1" (position among open siblings). */
function nextQueue(lines) {
  const idx = findHeading(lines, 'Next', 2);
  if (idx < 0) return { idx, nodes: [], index: new Map() };
  const [a, b] = bodyRange(lines, idx);
  const nodes = parseTree(lines.slice(a, b));
  const index = new Map();
  const walk = (list, prefix, chain) => {
    let k = 0;
    for (const n of list) {
      if (!isOpenItem(n)) continue;
      k++;
      const id = prefix ? `${prefix}.${k}` : String(k);
      index.set(id, { node: n, siblings: list, chain });
      walk(n.children, id, [...chain, { node: n, siblings: list }]);
    }
  };
  walk(nodes, '', []);
  return { idx, range: [a, b], nodes, index };
}

function queueOutline(queue, maxTop = 25) {
  const out = [];
  for (const [id, { node, chain }] of queue.index) {
    if (Number(id.split('.')[0]) > maxTop) break;
    out.push(`${'  '.repeat(chain.length)}[${id}] ${itemText(node)}`);
  }
  return out.join('\n');
}

/** Move picked queue items into the date's section. Child picks become "Parent › child". */
function applyPicks(lines, date, ids) {
  const queue = nextQueue(lines);
  if (queue.idx < 0) return [];
  const chosen = [...new Set(ids)].filter((id) => queue.index.has(id));
  // A picked ancestor already carries its descendants.
  const picks = chosen.filter((id) => !chosen.some((o) => o !== id && id.startsWith(o + '.')));
  const moved = [];
  const titles = [];
  for (const id of picks) {
    const { node, siblings, chain } = queue.index.get(id);
    const title = [...chain.map((c) => itemText(c.node)), itemText(node)].join(' › ');
    titles.push(title);
    moved.push(`- [ ] ${title}`, ...serialize(node.children, -node.depth));
    siblings.splice(siblings.indexOf(node), 1);
    // Parents emptied by the pick go away too.
    for (let i = chain.length - 1; i >= 0; i--) {
      const { node: p, siblings: ps } = chain[i];
      if (p.children.some((c) => !c.blank)) break;
      if (ps.includes(p)) ps.splice(ps.indexOf(p), 1);
    }
  }
  if (!moved.length) return titles;
  const [a, b] = queue.range;
  lines.splice(a, b - a, ...serialize(queue.nodes));
  const idx = ensureDateSection(lines, date);
  const [, end] = bodyRange(lines, idx);
  lines.splice(end, 0, ...moved);
  return titles;
}

/** Top-level checkbox items of a section: [{line, checked, text}]. */
function topItems(lines, idx) {
  if (idx < 0) return [];
  const end = sectionEnd(lines, idx);
  const out = [];
  for (let i = idx + 1; i < end; i++) {
    const m = ITEM_RE.exec(lines[i]);
    if (m) out.push({ line: i, checked: m[1] !== ' ', text: m[2] });
  }
  return out;
}

function dayItems(lines, date) {
  const s = dateSections(lines, date).find((x) => x.label === dateLabel(date));
  return s ? topItems(lines, s.idx) : [];
}

const dailyItems = (lines) => topItems(lines, findHeading(lines, 'Daily', 1));

/** Daily items grouped by optional "## Morning"-style sub-headings: [{title, items}]; title null before the first. */
function dailyGroups(lines) {
  const groups = [];
  let cur = null;
  const add = (title) => groups.push((cur = { title, items: [] }));
  const d = findHeading(lines, 'Daily', 1);
  if (d < 0) return groups;
  for (const it of dailyItems(lines)) {
    let title = null;
    for (let i = it.line - 1; i > d; i--) {
      if (headingLevel(lines[i])) {
        title = lines[i].replace(/^#+ /, '').trim();
        break;
      }
    }
    if (!cur || cur.title !== title) add(title);
    cur.items.push(it);
  }
  return groups;
}

/**
 * Today as one timeline: Daily routine groups merged with calendar events into three blocks.
 *   morning: "## Morning" routine items (+ all-day events), before anything else
 *   day:     "## Afternoon" (or unsectioned) items, then events starting before eveningHour
 *   evening: events from eveningHour on, then "## Evening" items
 * Returns [{part, title, items, events}] for blocks that have something in them.
 */
function dayTimeline(groups, events, eveningHour = 17) {
  const blocks = {
    morning: { part: 'morning', title: 'Morning', items: [], events: [] },
    day: { part: 'day', title: 'Daytime', items: [], events: [] },
    evening: { part: 'evening', title: 'Evening', items: [], events: [] },
  };
  const partOf = (title) =>
    /^morn/i.test(title || '') ? 'morning' : /^(even|night|tonight)/i.test(title || '') ? 'evening' : 'day';
  for (const g of groups) blocks[partOf(g.title)].items.push(...g.items);
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    const b = e.allDay ? 'morning' : e.start.getHours() >= eveningHour ? 'evening' : 'day';
    blocks[b].events.push(e);
  }
  return Object.values(blocks).filter((b) => b.items.length || b.events.length);
}

/** Which Daily group is "now" by its name: Morning before noon, Afternoon until eveningHour, Evening after. */
function currentPart(date, eveningHour = 17) {
  const h = date.getHours();
  return h < 12 ? 'morning' : h < eveningHour ? 'day' : 'evening';
}

// ---------------------------------------------------------------- routine sustainability

/** Snapshot of the Daily checklist for one day, taken right before the reset wipes it. */
function dailySnapshot(lines) {
  const items = dailyItems(lines);
  return {
    items: items.map((i) => i.text),
    missed: items.filter((i) => !i.checked).map((i) => i.text),
  };
}

/**
 * Looks at the last 7 recorded days. Returns null when there's too little data or the routine is holding up,
 * otherwise { rate, days, flagged: [{text, missed, of}], message }.
 */
function routineHealth(history, window = 7) {
  const keys = Object.keys(history || {}).sort().slice(-window);
  if (keys.length < 3) return null;
  let total = 0;
  let missed = 0;
  const per = new Map();
  for (const k of keys) {
    const h = history[k];
    total += h.items.length;
    missed += h.missed.length;
    for (const t of h.items) {
      const r = per.get(t) || { text: t, missed: 0, of: 0 };
      r.of++;
      if (h.missed.includes(t)) r.missed++;
      per.set(t, r);
    }
  }
  const rate = total ? (total - missed) / total : 1;
  const flagged = [...per.values()]
    .filter((r) => r.of >= 3 && r.missed / r.of >= 0.6)
    .sort((a, b) => b.missed / b.of - a.missed / a.of);
  if (rate >= 0.7 && !flagged.length) return null;
  const short = (t) => t.split(/[:(]/)[0].trim();
  const parts = [`Your routine averaged ${Math.round(rate * 100)}% over the last ${keys.length} days.`];
  if (flagged.length) {
    parts.push(`Most often skipped: ${flagged.slice(0, 3).map((r) => `${short(r.text)} (${r.missed}/${r.of})`).join(', ')}.`);
  }
  parts.push('That usually means the list is bigger than your days. Shrink, drop, or move one of these to fewer days.');
  return { rate, days: keys.length, flagged, message: parts.join(' ') };
}

/** Last `n` days for one Daily item: 'done' | 'missed' | null (no data). Oldest first. */
function itemTrail(history, text, today, n = 7) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const h = (history || {})[dayKey(addDays(today, -i))];
    out.push(!h || !h.items.includes(text) ? null : h.missed.includes(text) ? 'missed' : 'done');
  }
  return out;
}

// ---------------------------------------------------------------- planning prompt

function budgetFor(date, events, s = DEFAULTS) {
  if (isWeekend(date)) return `Weekend day, ${s.budgetWeekend}`;
  const busy = events.some((e) => !e.allDay && e.start.getHours() >= s.eveningHour);
  return busy ? `Weekday WITH evening plans, ${s.budgetBusyEvening}` : `Weekday, ${s.budgetWeekday}`;
}

function hourLabel(h) {
  return `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
}

function buildPrompt({ date, events, carried, queue, settings: s = DEFAULTS }) {
  const ev = events.length
    ? events.map((e) => `- ${e.allDay ? 'all day' : timeLabel(e.start)}: ${e.title}`).join('\n')
    : '- (none)';
  const already = carried.length ? carried.map((t) => `- ${t}`).join('\n') : '- (none)';
  return `You assign personal to-do tasks for ${WEEKDAYS[date.getDay()]} ${dateLabel(date)}. ${s.context} These tasks happen ${isWeekend(date) ? 'during the weekend day' : `after ${hourLabel(s.eveningHour)}`}.

Budget: ${budgetFor(date, events, s)}
Items already on that day (count them against the budget first):
${already}

Calendar that day:
${ev}

Queue, top = highest priority (the person prioritizes; you only pop from the top):
${queueOutline(queue)}

Sizes: quick = under 10 min (a text, a booking, a cancellation, reading a message); medium = about 30 min; big = 1-2 hours; project = needs multiple sessions.
Rules:
1. Walk the queue strictly in order from the top. Never reorder by your own preference.
2. If an item is a project or too big for the remaining budget and it has open sub-items, pick its FIRST open sub-item instead (by its id) if that fits.
3. If it still doesn't fit, skip it (it waits for a bigger day) and continue down the queue.
4. Stop when the budget is used.

Reply with JSON only, no prose: {"picks":[{"id":"3.1","size":"medium"}],"note":"one short sentence about the day"}`;
}

function parseClaudeReply(stdout) {
  const m = /\{[\s\S]*\}/.exec(stdout);
  if (!m) throw new Error('no JSON in reply');
  const j = JSON.parse(m[0]);
  if (!Array.isArray(j.picks)) throw new Error('reply missing picks');
  return { picks: j.picks.filter((p) => p && typeof p.id === 'string'), note: j.note || '' };
}

// ---------------------------------------------------------------- calendar cache

function loadEvents(cacheFile, exclude) {
  let raw;
  let updated = null;
  try {
    raw = fs.readFileSync(cacheFile, 'utf8');
    updated = fs.statSync(cacheFile).mtime;
  } catch {
    return { events: [], updated: null };
  }
  const skip = new Set(exclude.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (skip.has(String(e.calendar).toLowerCase())) continue;
      events.push({ title: e.title, start: new Date(e.start), end: new Date(e.end), allDay: !!e.allDay, calendar: e.calendar });
    } catch {
      /* ignore bad line */
    }
  }
  return { events, updated };
}

function eventsOn(events, date) {
  const a = startOfDay(date);
  const b = addDays(date, 1);
  return events.filter((e) => e.start < b && e.end > a);
}

// ---------------------------------------------------------------- shared planning (plugin + headless Mac mini)

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)
    );
  });
}

function askClaude(claudePath, prompt) {
  return run(
    claudePath,
    ['-p', prompt, '--model', 'sonnet', '--tools', '', '--setting-sources', 'project', '--disable-slash-commands',
      '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'],
    { cwd: os.tmpdir(), env: { ...process.env, PATH: `${path.dirname(claudePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` } }
  );
}

// Plan notes + task sizes live in the vault (tracked by git) so the laptop sees what the mini planned.
const SHARED_FILE = '.lotus/plan.json';

function readShared(vaultDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(vaultDir, SHARED_FILE), 'utf8'));
    return { planned: j.planned || {}, sizes: j.sizes || {} };
  } catch {
    return { planned: {}, sizes: {} };
  }
}

function writeShared(vaultDir, shared, now) {
  const cutoff = dayKey(addDays(now, -14));
  for (const k of Object.keys(shared.planned)) if (k < cutoff) delete shared.planned[k];
  const sizeKeys = Object.keys(shared.sizes);
  for (const k of sizeKeys.slice(0, Math.max(0, sizeKeys.length - 300))) delete shared.sizes[k];
  fs.mkdirSync(path.join(vaultDir, path.dirname(SHARED_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, SHARED_FILE), JSON.stringify(shared, null, 2) + '\n');
}

/** Ask Claude which queue items go on `date`. Returns null if ## Next is empty. Falls back to the top of the queue. */
async function choosePicks({ lines, date, now, events, ask, settings = DEFAULTS }) {
  const queue = nextQueue(lines);
  if (!queue.index.size) return null;
  const today = startOfDay(now);
  const open = (d) => dayItems(lines, d).filter((i) => !i.checked).map((i) => i.text);
  const carried = open(date);
  // Whatever is still open today will roll over, so it counts against tomorrow's budget.
  if (startOfDay(date) > today) carried.push(...open(today));
  try {
    return parseClaudeReply(await ask(buildPrompt({ date, events, carried, queue, settings })));
  } catch (error) {
    const picks = [...queue.index.keys()].filter((id) => !id.includes('.')).slice(0, isWeekend(date) ? 4 : 2).map((id) => ({ id, size: '' }));
    return { picks, note: 'Claude was unavailable, so these are just the top of the queue.', error };
  }
}

/** Move the picks into the date's section. Returns the titles and their sizes keyed by title. */
function commitPicks(lines, date, picks) {
  const q = nextQueue(lines);
  const sizes = {};
  for (const p of picks) {
    if (!p.size || !q.index.has(p.id)) continue;
    const { node, chain } = q.index.get(p.id);
    sizes[[...chain.map((c) => itemText(c.node)), itemText(node)].join(' › ')] = p.size;
  }
  const titles = applyPicks(lines, date, picks.map((p) => p.id));
  return { titles, sizes };
}

// ---------------------------------------------------------------- plugin

class LotusPlanner extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    // The plugin folder is a symlink into the repo; scripts and the calendar cache live next to it.
    let repo = null;
    try {
      repo = path.resolve(fs.realpathSync(path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir)), '..');
    } catch {
      /* not symlinked */
    }
    if (repo) {
      this.settings.cacheFile ||= path.join(repo, 'cache/events.jsonl');
      this.settings.syncScript ||= path.join(repo, 'bin/lotus-sync');
    }
    if (!this.settings.lastNewDay) {
      // First install: don't wipe checkboxes ticked earlier today.
      this.settings.lastNewDay = dayKey(new Date());
      await this.saveData(this.settings);
    }
    this.busy = Promise.resolve();

    this.registerView(VIEW_TYPE, (leaf) => new Dashboard(leaf, this));
    this.addRibbonIcon('sunrise', 'Lotus dashboard', () => this.show());
    this.addCommand({ id: 'open-dashboard', name: 'Open dashboard', callback: () => this.show() });
    this.addCommand({ id: 'plan-tomorrow', name: 'Plan tomorrow now', callback: () => this.plan(addDays(new Date(), 1), true) });
    this.addCommand({ id: 'plan-today', name: 'Add tasks to today', callback: () => this.plan(new Date(), true) });
    this.addCommand({ id: 'new-day', name: 'Run new-day reset now', callback: () => this.newDay(true) });
    this.registerObsidianProtocolHandler('lotus-planner', (p) => this.onUri(p));
    this.addSettingTab(new LotusSettings(this.app, this));

    this.app.workspace.onLayoutReady(() => this.newDay());
    this.registerInterval(window.setInterval(() => this.newDay(), 5 * 60 * 1000));
    this.registerDomEvent(window, 'focus', () => this.newDay());
    this.registerEvent(
      this.app.vault.on('modify', (f) => {
        if (f.path === this.settings.file) this.refreshViews();
      })
    );
  }

  save() {
    return this.saveData(this.settings);
  }

  /** Serialize all automated work so the reset and the 5pm/8am trigger never race. */
  exclusive(fn) {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  file() {
    const f = this.app.vault.getAbstractFileByPath(this.settings.file);
    return f instanceof TFile ? f : null;
  }

  async readLines() {
    const f = this.file();
    return f ? (await this.app.vault.read(f)).split('\n') : [];
  }

  async edit(fn) {
    const f = this.file();
    if (!f) throw new Error(`${this.settings.file} not found`);
    let result;
    await this.app.vault.process(f, (text) => {
      const lines = text.split('\n');
      result = fn(lines);
      return lines.join('\n');
    });
    return result;
  }

  base() {
    return this.app.vault.adapter.getBasePath();
  }

  async git(message) {
    try {
      await run('/usr/bin/git', ['-C', this.base(), 'add', '-A']);
      await run('/usr/bin/git', ['-C', this.base(), 'commit', '-q', '-m', message]);
    } catch {
      /* nothing to commit, or not a repo */
    }
  }

  /** Commit + pull --rebase + push via bin/lotus-sync. No remote yet -> no-op. */
  async sync() {
    if (!this.settings.syncScript) return;
    try {
      await run('/bin/bash', [this.settings.syncScript, this.base()], { timeout: 60000 });
    } catch (e) {
      console.error('lotus-planner: sync failed', e);
      new Notice('Lotus: git sync failed. Check the vault for a merge conflict.', 10000);
    }
  }

  events() {
    return loadEvents(this.settings.cacheFile, this.settings.excludeCalendars);
  }

  async onUri(params) {
    await this.newDay();
    if (params.action === 'show') {
      const now = new Date();
      await this.show();
      const health = routineHealth(this.settings.history);
      if (health && this.settings.lastNudge !== dayKey(now)) {
        new Notice(`🌱 ${health.message}`, 20000);
        this.settings.lastNudge = dayKey(now);
        await this.save();
      }
    } else if (params.action === 'plan') {
      // 8pm job. If the Mac was asleep and this fires on wake the next morning, plan today instead.
      const now = new Date();
      await this.plan(now.getHours() >= 12 ? addDays(now, 1) : now, false);
    }
  }

  newDay(force = false) {
    return this.exclusive(async () => {
      const now = new Date();
      if (!force && this.settings.lastNewDay === dayKey(now)) return;
      // Pull what the Mac mini planned last night before touching the file.
      await this.sync();
      await this.git('Snapshot before new day');
      const closing = this.settings.lastNewDay;
      const moved = await this.edit((lines) => {
        if (closing && closing !== dayKey(now)) this.settings.history[closing] = dailySnapshot(lines);
        resetDaily(lines);
        return rollover(lines, now);
      });
      const cutoff = dayKey(addDays(now, -30));
      for (const k of Object.keys(this.settings.history)) if (k < cutoff) delete this.settings.history[k];
      this.settings.lastNewDay = dayKey(now);
      await this.save();
      await this.git(`New day ${dateLabel(now)}: reset Daily, rolled over ${moved} task(s)`);
      await this.sync();
      this.refreshViews();
    });
  }

  plan(date, manual) {
    return this.exclusive(async () => {
      const key = dayKey(date);
      await this.sync();
      if (!manual && readShared(this.base()).planned[key]) return;
      const lines = await this.readLines();
      const notice = new Notice(`Lotus: planning ${dateLabel(date)}…`, 0);
      let r;
      try {
        r = await choosePicks({
          lines, date, now: new Date(), events: eventsOn(this.events().events, date),
          ask: (prompt) => askClaude(this.settings.claudePath, prompt),
          settings: this.settings,
        });
      } finally {
        notice.hide();
      }
      if (!r) {
        if (manual) new Notice('Nothing left in ## Next to assign.');
        return;
      }
      if (r.error) console.error('lotus-planner: claude failed, using fallback', r.error);

      await this.git('Snapshot before planning');
      const { titles, sizes } = await this.edit((l) => commitPicks(l, date, r.picks));
      const shared = readShared(this.base());
      shared.planned[key] = { note: r.note, at: new Date().toISOString(), by: os.hostname() };
      Object.assign(shared.sizes, sizes);
      writeShared(this.base(), shared, new Date());
      await this.git(`Planned ${dateLabel(date)}: ${titles.length} task(s)`);
      await this.sync();
      new Notice(`Lotus: ${titles.length} task(s) added to ${dateLabel(date)}.`);
      this.refreshViews();
    });
  }

  async toggle(lineIdx, text) {
    await this.edit((lines) => {
      let i = lineIdx;
      if (!(lines[i] || '').includes(text)) i = lines.findIndex((l) => ITEM_RE.test(l) && l.includes(text));
      if (i < 0) return;
      lines[i] = lines[i].replace(/^- \[( |x|X)\]/, (_, c) => (c === ' ' ? '- [x]' : '- [ ]'));
      // Tick "Today's frontlog" in Daily once every task for today is done (and untick if one reopens).
      const items = dayItems(lines, new Date());
      const daily = dailyItems(lines).find((d) => /^Today's (front|back)log/.test(d.text));
      if (daily && items.length) {
        const allDone = items.every((x) => x.checked);
        lines[daily.line] = lines[daily.line].replace(/^- \[( |x|X)\]/, allDone ? '- [x]' : '- [ ]');
      }
    });
  }

  async show() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshViews() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.render();
    }, 150);
  }
}

// ---------------------------------------------------------------- dashboard view

class Dashboard extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Lotus';
  }
  getIcon() {
    return 'sunrise';
  }
  async onOpen() {
    await this.render();
  }

  async render() {
    const p = this.plugin;
    const el = this.contentEl;
    const lines = await p.readLines();
    const now = new Date();
    const today = startOfDay(now);
    const tomorrow = addDays(now, 1);
    const { events, updated } = p.events();
    const workouts = p.settings.workouts;
    const history = p.settings.history;

    const hasWorkouts = Array.isArray(workouts) && workouts.length === 7;
    const evening = !isWeekend(now) && now.getHours() >= p.settings.eveningHour;
    const leftToday = eventsOn(events, today).filter((e) => e.allDay || e.end > now);
    const items = dayItems(lines, today);
    const daily = dailyItems(lines);
    const dailyDone = daily.filter((d) => d.checked).length;
    const tasksDone = items.filter((i) => i.checked).length;
    const health = routineHealth(history);

    el.empty();
    el.addClass('lotus-dash');

    // ---- header
    const head = el.createDiv({ cls: 'lotus-head' });
    const words = head.createDiv({ cls: 'lotus-head-words' });
    words.createDiv({ cls: 'lotus-greeting', text: greeting(now) });
    words.createDiv({ cls: 'lotus-date', text: WEEKDAYS[now.getDay()] });
    words.createDiv({ cls: 'lotus-date-sub', text: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) });
    const chips = words.createDiv({ cls: 'lotus-chips' });
    const chip = (icon, text) => {
      const c = chips.createDiv({ cls: 'lotus-chip' });
      obsidian.setIcon(c.createSpan({ cls: 'lotus-chip-icon' }), icon);
      c.createSpan({ text });
    };
    chip('calendar', `${leftToday.length} ${leftToday.length === 1 ? 'event' : 'events'} left`);
    chip('list-todo', items.length ? `${items.length - tasksDone} ${items.length - tasksDone === 1 ? 'task' : 'tasks'} open` : 'no tasks');
    if (hasWorkouts) chip('dumbbell', workouts[now.getDay()] === 'Rest' ? 'Rest day' : `${workouts[now.getDay()]} day`);
    const rings = head.createDiv({ cls: 'lotus-rings' });
    this.ring(rings, tasksDone, items.length, 'frontlog');
    this.ring(rings, dailyDone, daily.length, 'daily');

    // ---- routine nudge
    if (health) {
      const n = el.createDiv({ cls: 'lotus-nudge' });
      obsidian.setIcon(n.createSpan({ cls: 'lotus-nudge-icon' }), 'sprout');
      const body = n.createDiv();
      body.createDiv({ cls: 'lotus-nudge-title', text: 'Your routine might be too big' });
      body.createDiv({ text: health.message });
    }

    const shared = readShared(p.base());
    const sizes = { ...p.settings.sizes, ...shared.sizes };
    const grid = el.createDiv({ cls: 'lotus-grid' });
    const colA = grid.createDiv({ cls: 'lotus-col' });
    const colB = grid.createDiv({ cls: 'lotus-col' });

    // ---- today: routine + calendar as one timeline
    const hasHistory = Object.keys(history || {}).length > 0;
    const dcard = this.card(colA, 'Today', 'calendar-clock', `${dailyDone}/${daily.length}`);
    const part = currentPart(now, p.settings.eveningHour);
    const blocks = dayTimeline(dailyGroups(lines), eventsOn(events, today), p.settings.eveningHour);
    if (!blocks.length) dcard.createDiv({ cls: 'lotus-empty', text: 'Nothing on today.' });
    for (const b of blocks) {
      const isNow = b.part === part;
      const done = b.items.filter((d) => d.checked).length;
      const h = dcard.createDiv({ cls: 'lotus-group' + (isNow ? ' is-now' : '') });
      h.createSpan({ text: b.title });
      const bits = [isNow ? 'now' : '', b.items.length ? `${done}/${b.items.length}` : ''].filter(Boolean);
      h.createSpan({ cls: 'lotus-group-count', text: bits.join(' · ') });
      const rows = () => {
        for (const it of [...b.items.filter((d) => !d.checked), ...b.items.filter((d) => d.checked)]) {
          const w = workouts[now.getDay()];
          const label = hasWorkouts && /^Workout/.test(it.text) ? (w === 'Rest' ? 'Rest day (PT optional)' : `Workout: ${w} + PT`) : it.text;
          this.checkRow(dcard, it, { label, trail: hasHistory ? itemTrail(history, it.text, today) : null });
        }
      };
      // Evening: what's booked first, then the routine that follows it.
      if (b.part === 'evening') { this.eventList(dcard, b.events, null); rows(); }
      else { rows(); this.eventList(dcard, b.events, null); }
    }
    if (hasHistory) dcard.createDiv({ cls: 'lotus-legend', text: 'Dots: last 7 days, oldest → newest' });

    // ---- today's frontlog
    const tasks = this.card(colB, "Today's frontlog", 'list-todo', items.length ? `${tasksDone}/${items.length}` : '');
    if (items.length) this.bar(tasks, tasksDone, items.length);
    if (!items.length) tasks.createDiv({ cls: 'lotus-empty', text: 'No tasks assigned for today.' });
    for (const it of items) this.checkRow(tasks, it, { size: sizes[it.text] });
    const tnote = shared.planned[dayKey(today)]?.note;
    if (tnote) tasks.createDiv({ cls: 'lotus-note', text: tnote });

    // ---- tomorrow look-ahead
    const tcard = this.card(colB, `Tomorrow · ${WEEKDAYS[tomorrow.getDay()].slice(0, 3)} ${dateLabel(tomorrow)}`, 'sunrise', '', 'is-ahead');
    const tev = eventsOn(events, tomorrow);
    const timed = tev.filter((e) => !e.allDay);
    const stats = tcard.createDiv({ cls: 'lotus-stats' });
    const stat = (big, small) => {
      const s = stats.createDiv({ cls: 'lotus-stat' });
      s.createDiv({ cls: 'lotus-stat-big', text: big });
      s.createDiv({ cls: 'lotus-stat-small', text: small });
    };
    stat(timed.length ? timeLabel(timed[0].start) : '—', 'first event');
    stat(String(timed.length), timed.length === 1 ? 'event' : 'events');
    const titems = dayItems(lines, tomorrow);
    if (hasWorkouts) stat(workouts[tomorrow.getDay()], 'workout');
    else stat(String(titems.length), titems.length === 1 ? 'task' : 'tasks');
    this.eventList(tcard, tev, null);
    tcard.createDiv({ cls: 'lotus-label', text: 'Tasks' });
    if (titems.length) {
      for (const it of titems) this.checkRow(tcard, it, { size: sizes[it.text] });
    } else {
      tcard.createDiv({ cls: 'lotus-empty', text: evening || isWeekend(now) ? 'Not planned yet.' : `Gets planned at ${hourLabel(p.settings.planHour)}.` });
    }
    const btn = tcard.createEl('button', { cls: 'lotus-btn', text: titems.length ? 'Add more to tomorrow' : 'Plan tomorrow now' });
    btn.onclick = async () => {
      btn.disabled = true;
      btn.setText('Planning…');
      await p.plan(tomorrow, true);
      this.render();
    };
    const tn = shared.planned[dayKey(tomorrow)]?.note;
    if (tn) tcard.createDiv({ cls: 'lotus-note', text: tn });

    // ---- footer
    const foot = el.createDiv({ cls: 'lotus-foot' });
    const link = foot.createEl('a', { text: `Open ${path.basename(p.settings.file)}` });
    link.onclick = () => this.app.workspace.openLinkText(p.settings.file, '', false);
    foot.createSpan({ text: updated ? `Calendar synced ${timeLabel(updated)}` : 'Calendar not synced yet' });
  }

  card(parent, title, icon, badge, extraCls) {
    const c = parent.createDiv({ cls: 'lotus-card' + (extraCls ? ` ${extraCls}` : '') });
    const h = c.createDiv({ cls: 'lotus-card-title' });
    obsidian.setIcon(h.createSpan({ cls: 'lotus-card-icon' }), icon);
    h.createSpan({ cls: 'lotus-card-name', text: title });
    if (badge) h.createSpan({ cls: 'lotus-badge', text: badge });
    return c;
  }

  ring(parent, done, total, label) {
    const pct = total ? done / total : 0;
    const wrap = parent.createDiv({ cls: 'lotus-ring' + (total && done === total ? ' is-complete' : '') });
    const r = 30;
    const circ = 2 * Math.PI * r;
    const svg = wrap.createSvg('svg', { attr: { viewBox: '0 0 72 72', width: 84, height: 84 } });
    svg.createSvg('circle', { cls: 'lotus-ring-track', attr: { cx: 36, cy: 36, r, fill: 'none', 'stroke-width': 7 } });
    // Start from where this ring was on the last render so checking a box animates the ring forward.
    this.prevRing = this.prevRing || {};
    const from = this.prevRing[label] ?? 0;
    this.prevRing[label] = pct;
    const fill = svg.createSvg('circle', {
      cls: 'lotus-ring-fill',
      attr: { cx: 36, cy: 36, r, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', transform: 'rotate(-90 36 36)' },
    });
    // Set as a style (not an attribute) so the CSS transition animates it.
    fill.style.strokeDasharray = `${circ * from} ${circ}`;
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => (fill.style.strokeDasharray = `${circ * pct} ${circ}`))
    );
    const mid = wrap.createDiv({ cls: 'lotus-ring-mid' });
    mid.createDiv({ cls: 'lotus-ring-num', text: `${done}/${total}` });
    mid.createDiv({ cls: 'lotus-ring-label', text: label });
  }

  bar(parent, done, total) {
    const b = parent.createDiv({ cls: 'lotus-bar' });
    b.createDiv({ cls: 'lotus-bar-fill', attr: { style: `width:${total ? (100 * done) / total : 0}%` } });
  }

  eventList(parent, events, emptyText) {
    if (!events.length) {
      if (emptyText) parent.createDiv({ cls: 'lotus-empty', text: emptyText });
      return;
    }
    const list = parent.createDiv({ cls: 'lotus-events' });
    const now = new Date();
    for (const e of events) {
      const state = e.allDay ? '' : e.end <= now ? ' is-past' : e.start <= now ? ' is-now' : '';
      const row = list.createDiv({ cls: 'lotus-event' + state });
      const time = row.createDiv({ cls: 'lotus-time' });
      time.createDiv({ text: e.allDay ? 'All day' : timeLabel(e.start) });
      if (!e.allDay) {
        const mins = Math.round((e.end - e.start) / 60000);
        time.createDiv({ cls: 'lotus-dur', text: mins >= 60 ? `${+(mins / 60).toFixed(1)}h` : `${mins}m` });
      }
      row.createDiv({ cls: 'lotus-event-title', text: e.title });
    }
  }

  checkRow(parent, item, { size, label, trail } = {}) {
    const row = parent.createEl('label', { cls: 'lotus-row' + (item.checked ? ' is-done' : '') });
    const cb = row.createEl('input', { type: 'checkbox', cls: 'lotus-check' });
    cb.checked = item.checked;
    cb.onchange = () => this.plugin.toggle(item.line, item.text);
    row.createSpan({ cls: 'lotus-row-text', text: label || item.text });
    if (size) row.createSpan({ cls: `lotus-size lotus-size-${size}`, text: size });
    if (trail) {
      const t = row.createSpan({ cls: 'lotus-trail' });
      for (const s of trail) t.createSpan({ cls: `lotus-dot${s ? ` is-${s}` : ''}` });
    }
  }
}

// ---------------------------------------------------------------- settings

class LotusSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    const text = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(s[key]).onChange(async (v) => {
          s[key] = v.trim();
          await this.plugin.save();
        })
      );
    text('Task file', 'Vault path of the note with # Daily and # Frontlog.', 'file');
    text('Claude CLI', 'Absolute path to the claude binary.', 'claudePath');
    text('Calendar cache', 'events.jsonl written by lotus-run.', 'cacheFile');
    text('Sync script', 'bin/lotus-sync: commit, pull --rebase, push.', 'syncScript');
    text('Hidden calendars', 'Comma-separated calendar names to ignore.', 'excludeCalendars');
    text('About you', 'One sentence for the planner, e.g. when you have time for tasks.', 'context');
    text('Weekday budget', 'What fits on a normal weekday evening.', 'budgetWeekday');
    text('Busy-evening budget', 'Weekday with an event after the evening hour.', 'budgetBusyEvening');
    text('Weekend budget', 'What fits on a weekend day.', 'budgetWeekend');
    const num = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(String(s[key])).onChange(async (v) => {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 0 && n < 24) {
            s[key] = n;
            await this.plugin.save();
          }
        })
      );
    num('Evening starts (hour)', '0-23. Weekday tasks happen after this; also when the dashboard says "Tonight".', 'eveningHour');
    num('Planning hour', '0-23. Only used for the "Gets planned at…" hint; the schedule itself is the launchd job.', 'planHour');
    new Setting(containerEl)
      .setName('Workouts (Sun→Sat)')
      .setDesc('Optional. Comma-separated, 7 entries. Leave blank to hide workouts.')
      .addText((t) =>
        t.setValue(s.workouts.join(', ')).onChange(async (v) => {
          const w = v.split(',').map((x) => x.trim()).filter(Boolean);
          if (w.length === 7 || w.length === 0) {
            s.workouts = w;
            await this.plugin.save();
          }
        })
      );
  }
}

module.exports = LotusPlanner;
module.exports.core = {
  dayKey, dateLabel, labelToDate, addDays, parseTree, serialize, resetDaily, rollover, nextQueue,
  queueOutline, applyPicks, dayItems, dailyItems, dailyGroups, currentPart, dayTimeline, ensureDateSection, buildPrompt, parseClaudeReply,
  loadEvents, eventsOn, dailySnapshot, routineHealth, itemTrail, askClaude, readShared, writeShared,
  choosePicks, commitPicks, startOfDay, budgetFor, DEFAULTS,
};
