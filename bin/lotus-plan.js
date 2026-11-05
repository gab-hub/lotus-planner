#!/usr/bin/env node
// Headless 8pm planner for the Mac mini (no Obsidian needed).
//   pull -> roll today's unfinished tasks into tomorrow -> pop tomorrow's tasks from ## Next -> commit -> push
// Usage: lotus-plan.js [--force] [--dry-run]
// Env: LOTUS_VAULT (set in config.sh by lotus-run). Settings (file, budgets, claudePath…) come from
// plugin/data.json if present (copy it from the laptop), else the plugin defaults.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'obsidian') return { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Setting: class {}, TFile: class {} };
  return origLoad.call(this, req, ...rest);
};
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const c = require('../plugin/main.js').core;

const DIR = path.resolve(__dirname, '..');
const VAULT = process.env.LOTUS_VAULT;
if (!VAULT) {
  console.error('Set LOTUS_VAULT (run via bin/lotus-run, which reads config.sh).');
  process.exit(2);
}
let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin/data.json'), 'utf8'));
} catch {
  /* defaults */
}
const S = { ...c.DEFAULTS, ...saved };
const FILE = path.join(VAULT, S.file);
// data.json copied from another Mac may carry that Mac's home path; fall back to this user's default.
const CLAUDE = process.env.LOTUS_CLAUDE || (fs.existsSync(S.claudePath) ? S.claudePath : c.DEFAULTS.claudePath);
const force = process.argv.includes('--force');
const dry = process.argv.includes('--dry-run');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sync = () => {
  if (dry) return;
  try {
    execFileSync('/bin/bash', [path.join(DIR, 'bin/lotus-sync'), VAULT], { stdio: 'inherit' });
  } catch {
    log('sync failed');
  }
};
const git = (msg) => {
  if (dry) return;
  try {
    execFileSync('/usr/bin/git', ['-C', VAULT, 'add', '-A']);
    execFileSync('/usr/bin/git', ['-C', VAULT, 'commit', '-q', '-m', msg]);
  } catch {
    /* nothing to commit */
  }
};

(async () => {
  sync();
  const now = new Date();
  // Normally 8pm -> plan tomorrow. If the job only ran after midnight/next morning, plan today.
  const date = now.getHours() >= 12 ? c.addDays(now, 1) : c.startOfDay(now);
  const key = c.dayKey(date);
  const shared = c.readShared(VAULT);
  if (shared.planned[key] && !force) return log(`${key} already planned`);

  const lines = fs.readFileSync(FILE, 'utf8').split('\n');
  const moved = c.rollover(lines, date);
  const events = c.eventsOn(c.loadEvents(path.join(DIR, 'cache/events.jsonl'), S.excludeCalendars).events, date);
  const r = await c.choosePicks({ lines, date, now, events, ask: (p) => c.askClaude(CLAUDE, p), settings: S });
  if (r && r.error) log('claude failed, using fallback:', r.error.message);
  const { titles, sizes } = r ? c.commitPicks(lines, date, r.picks) : { titles: [], sizes: {} };

  log(`${key}: rolled over ${moved}, added ${titles.length}:`, titles.join(' | '));
  if (r) log('note:', r.note);
  if (dry) return console.log(lines.join('\n'));

  fs.writeFileSync(FILE, lines.join('\n'));
  shared.planned[key] = { note: r ? r.note : 'Nothing left in ## Next.', at: now.toISOString(), by: os.hostname() };
  Object.assign(shared.sizes, sizes);
  c.writeShared(VAULT, shared, now);
  git(`Planned ${c.dateLabel(date)} on ${os.hostname().split('.')[0]}: rolled over ${moved}, added ${titles.length}`);
  sync();
})().catch((e) => {
  log('plan failed:', e);
  process.exit(1);
});
