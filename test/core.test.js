// Run: node test/core.test.js
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'obsidian') return { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Setting: class {}, TFile: class {} };
  return origLoad.call(this, req, ...rest);
};
const assert = require('assert');
const c = require('../plugin/main.js').core;

// Daily sub-sections
{
  const L = `# Daily
- [ ] Loose
## Morning
- [x] Stretch
	- note
## Evening
- [ ] Workout
- [ ] Shutdown
# Frontlog
## Next
- [ ] x`.split('\n');
  const g = c.dailyGroups(L);
  assert.deepEqual(g.map((x) => [x.title, x.items.map((i) => i.text)]), [[null, ['Loose']], ['Morning', ['Stretch']], ['Evening', ['Workout', 'Shutdown']]]);
  assert.equal(c.dailyItems(L).length, 4, 'sub-headings stay inside # Daily');
  assert.equal(c.resetDaily(L), 1);
  const O = ['# Daily', '- [x] Call IT (one-off)', '\t- [x] ticket', '- [ ] Pending (one-off)', '- [x] Steps', '# Frontlog'];
  c.resetDaily(O);
  assert.deepEqual(O, ['# Daily', '- [ ] Pending (one-off)', '- [ ] Steps', '# Frontlog'], 'finished one-offs drop, open ones stay');
  assert.equal(c.currentPart(new Date(2026, 10, 6, 9)), 'morning');
  assert.equal(c.currentPart(new Date(2026, 10, 6, 13)), 'day');
  const ev = (h, title, allDay = false) => ({ title, allDay, start: new Date(2026, 10, 6, h), end: new Date(2026, 10, 6, h + 1) });
  const tl = c.dayTimeline(g, [ev(18, 'Luke'), ev(0, 'Holiday', true), ev(16, 'TJs'), ev(17, 'Lex')]);
  assert.deepEqual(tl.map((b) => [b.part, b.items.map((i) => i.text), b.events.map((e) => e.title)]), [
    ['morning', ['Stretch'], ['Holiday']],
    ['day', ['Loose'], ['TJs']],
    ['evening', ['Workout', 'Shutdown'], ['Lex', 'Luke']],
  ]);
  assert.equal(c.currentPart(new Date(2026, 10, 6, 18)), 'evening');
  // hold the evening: weekdays before eveningHour only, and only when switched on
  const hold = { ...c.DEFAULTS, holdEvening: true };
  assert.equal(c.eveningHeld(new Date(2026, 10, 10, 9), hold), true, 'Tue 9am held');
  assert.equal(c.eveningHeld(new Date(2026, 10, 10, 17), hold), false, 'Tue 5pm open');
  assert.equal(c.eveningHeld(new Date(2026, 10, 7, 9), hold), false, 'Sat never held');
  assert.equal(c.eveningHeld(new Date(2026, 10, 10, 9), c.DEFAULTS), false, 'off by default');
}

const doc = `# Daily
- [x] Morning: stretch
	- note stays
- [ ] Steps
- [x] Today's backlog ↓
# Backlog
## Nov 4
- [x] done thing
- [ ] leftover
	- [ ] leftover child
## Nov 5
- [ ] today task
## Next
- [ ] Call the bank
- [x] already done
- [ ] Taxes
	- [ ] Receipts
		- [ ] scan (90%)
		- [ ] file
	- [ ] estimate
- [ ] Cancel gym trial
`.split('\n');

const today = new Date(2026, 10, 5);

// reset
let L = [...doc];
assert.equal(c.resetDaily(L), 2);
assert.ok(!L.slice(0, 5).some((l) => l.includes('[x]')));
assert.ok(L.includes('- [x] done thing'), 'reset only touches Daily');

// rollover
assert.equal(c.rollover(L, today), 1);
assert.ok(!L.includes('## Nov 4'));
assert.ok(!L.includes('- [x] done thing'));
const n5 = L.indexOf('## Nov 5');
assert.deepEqual(L.slice(n5 + 1, n5 + 4), ['- [ ] leftover', '\t- [ ] leftover child', '- [ ] today task']);

// queue ids skip checked items
const q = c.nextQueue(L);
assert.deepEqual([...q.index.keys()], ['1', '2', '2.1', '2.1.1', '2.1.2', '2.2', '3']);

// picks: whole item + nested child; emptied parents are removed
const tomorrow = new Date(2026, 10, 6);
let titles = c.applyPicks(L, tomorrow, ['1', '2.1.1', '2.1.2']);
assert.deepEqual(titles, ['Call the bank', 'Taxes › Receipts › scan (90%)', 'Taxes › Receipts › file']);
const n6 = L.indexOf('## Nov 6');
assert.ok(n6 > L.indexOf('## Nov 5') && n6 < L.indexOf('## Next'), 'Nov 6 sits between Nov 5 and Next');
const next = L.slice(L.indexOf('## Next') + 1).filter(Boolean);
assert.deepEqual(next, ['- [x] already done', '- [ ] Taxes', '\t- [ ] estimate', '- [ ] Cancel gym trial']);
assert.deepEqual(c.dayItems(L, tomorrow).map((i) => i.text), titles);

// picking an ancestor and its child doesn't duplicate
titles = c.applyPicks(L, tomorrow, ['1', '1.1']);
assert.deepEqual(titles, ['Taxes']);
assert.ok(L.includes('\t- [ ] estimate') && L.indexOf('\t- [ ] estimate') < L.indexOf('## Next'));

// labels across the year boundary
assert.equal(c.labelToDate('Jan 2', new Date(2026, 11, 30)).getFullYear(), 2027);

// claude reply parsing
assert.deepEqual(c.parseClaudeReply('sure\n{"picks":[{"id":"1","size":"quick"}],"note":"x"}').picks, [{ id: '1', size: 'quick' }]);

// routine sustainability
const day = (missed) => ({ items: ['Morning', 'Steps', 'Read', 'Blog'], missed });
assert.equal(c.routineHealth({ '2026-11-01': day([]), '2026-11-02': day([]) }), null, 'needs 3+ days');
assert.equal(c.routineHealth({ a: day([]), b: day(['Blog']), c: day([]) }), null, 'healthy routine: no nudge');
const h = c.routineHealth({ a: day(['Read', 'Blog']), b: day(['Read']), c: day(['Read', 'Blog']), d: day([]) });
assert.ok(h && h.flagged.length === 1 && h.flagged[0].text === 'Read' && h.rate < 0.7);
assert.match(h.message, /Read \(3\/4\)/);
// one zero day drags the average under 70%, but nothing is skipped repeatedly -> no nudge
const all = ['Morning', 'Steps', 'Read', 'Blog'];
assert.equal(c.routineHealth({ a: day(all), b: day(['Blog']), c: day(['Read']), d: day([]) }), null, 'low average without a flagged item: no nudge');

// live frontlog summary
const fi = [{ text: 'A', checked: false }, { text: 'B', checked: true }, { text: 'C', checked: false }, { text: 'D', checked: false }];
assert.equal(c.frontlogSummary(fi, { A: 'big', B: 'quick', C: 'quick' }), '3 of 4 left (1 big, 1 quick) · about 1h 40m plus the unsized ones.');
assert.equal(c.frontlogSummary(fi.map((i) => ({ ...i, checked: true }))), 'All 4 done for today.');
assert.equal(c.frontlogSummary([]), '');
const snap = c.dailySnapshot(doc);
assert.deepEqual(snap.missed, ['Steps']);
const trail = c.itemTrail({ '2026-11-04': { items: ['Steps'], missed: ['Steps'] }, '2026-11-03': { items: ['Steps'], missed: [] } }, 'Steps', today, 3);
assert.deepEqual(trail, [null, 'done', 'missed']);
// changing a goal in parentheses keeps the item's history
const goalTrail = c.itemTrail({ '2026-11-04': { items: ['Steps (8.7k)'], missed: ['Steps (8.7k)'] }, '2026-11-03': { items: ['Steps (8.7k)'], missed: [] } }, 'Steps (8.8k)', today, 3);
assert.deepEqual(goalTrail, [null, 'done', 'missed']);
const gh = c.routineHealth({ a: { items: ['Steps (8.7k)'], missed: ['Steps (8.7k)'] }, b: { items: ['Steps (8.7k)'], missed: ['Steps (8.7k)'] }, c: { items: ['Steps (8.8k)'], missed: ['Steps (8.8k)'] } });
assert.ok(gh && gh.flagged.length === 1 && gh.flagged[0].of === 3 && gh.flagged[0].text === 'Steps (8.8k)');

// a plan with no picks doesn't leave an empty date heading
const before = [...doc];
c.applyPicks(before, new Date(2026, 10, 9), []);
assert.ok(!before.includes('## Nov 9'));

// UV window: interpolated crossings, rounded to 5 min
{
  const times = [8, 9, 10, 11, 12, 13, 14, 15, 16].map((h) => `2026-11-06T${String(h).padStart(2, '0')}:00`);
  const w = c.uvWindow(times, [1, 2, 4, 5, 6, 5, 3.5, 2, 1], 3);
  assert.strictEqual(w.start.getHours() * 60 + w.start.getMinutes(), 9 * 60 + 30);
  assert.strictEqual(w.end.getHours() * 60 + w.end.getMinutes(), 14 * 60 + 20);
  assert.strictEqual(w.peak, 6);
  assert.strictEqual(c.uvWindow(times, [0, 1, 2, 2.5, 2, 1, 0, 0, 0], 3).start, null);
  // Austin, Nov 9 2026: cloud-adjusted peaks at 2.25 ("low all day") but clear sky reaches 4.95 -> use the worst case
  const cloudy = [0.35, 1.25, 0.75, 1.5, 2.25, 1.95, 2.0, 0.5, 0.25];
  const clear = [0.35, 1.45, 2.8, 4.0, 4.75, 4.95, 4.45, 3.35, 2.05];
  assert.strictEqual(c.uvWindow(times, cloudy, 3).start, null);
  const worst = c.uvWindow(times, c.worstUv(cloudy, clear), 3);
  assert.ok(worst.start && worst.peak === 4.95);
  assert.deepEqual(c.worstUv([1, null], [null, 2]), [1, 2]);
}

// 8pm on the mini: roll today into tomorrow, then plan tomorrow
(async () => {
  const L2 = [...doc];
  const nov6 = new Date(2026, 10, 6);
  assert.equal(c.rollover(L2, nov6), 2, 'Nov 4 leftover + Nov 5 task roll into Nov 6');
  assert.ok(!L2.includes('## Nov 5'));
  let prompt = '';
  const r = await c.choosePicks({ lines: L2, date: nov6, now: new Date(2026, 10, 5, 20), events: [],
    ask: async (p) => { prompt = p; return '{"picks":[{"id":"1","size":"quick"}],"note":"ok"}'; } });
  assert.match(prompt, /- leftover/, 'carried items count against the estimate');
  const { titles, sizes } = c.commitPicks(L2, nov6, r.picks);
  assert.deepEqual(titles, ['Call the bank']);
  assert.deepEqual(sizes, { 'Call the bank': 'quick' });
  assert.deepEqual(c.dayItems(L2, nov6).map((i) => i.text), ['leftover', 'today task', 'Call the bank']);
  // claude down -> top of queue
  const f = await c.choosePicks({ lines: L2, date: nov6, now: new Date(2026, 10, 5, 20), events: [], ask: async () => { throw new Error('x'); } });
  assert.ok(f.error && f.picks.length === 2);
  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
