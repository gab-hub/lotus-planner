#!/bin/bash
# VAULT=/path/to/vault ./install.sh laptop|mini      (VAULT is remembered in config.sh)
#   laptop (default): builds the calendar reader, links the plugin into the vault,
#                     loads: morning reset, 8am/5pm show, 7:50pm push, 30-min calendar+sync
#   mini:             builds the calendar reader, loads: 8pm headless plan, 30-min calendar+sync
# Both: links the add-task skill into ~/.claude/skills.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE="${1:-laptop}"
[ -f "$DIR/config.sh" ] && . "$DIR/config.sh"
VAULT="${VAULT:-${LOTUS_VAULT:-}}"
[ -n "$VAULT" ] && [ -d "$VAULT" ] || { echo "Set VAULT=/path/to/your/obsidian/vault" >&2; exit 2; }
echo "LOTUS_VAULT=\"$VAULT\"" > "$DIR/config.sh"
case "$ROLE" in
  laptop) JOBS="morning show sync calendar" ;;
  mini)   JOBS="plan calendar" ;;
  *) echo "usage: ./install.sh laptop|mini" >&2; exit 2 ;;
esac

swiftc -O "$DIR/calendar/lotus-cal.swift" -o "$DIR/bin/lotus-cal" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/calendar/Info.plist"
chmod +x "$DIR/bin/lotus-run" "$DIR/bin/lotus-sync" "$DIR/bin/lotus-plan.js"

if [ "$ROLE" = laptop ]; then
  mkdir -p "$VAULT/.obsidian/plugins"
  ln -sfn "$DIR/plugin" "$VAULT/.obsidian/plugins/lotus-planner"
  CP="$VAULT/.obsidian/community-plugins.json"
  if [ ! -f "$CP" ]; then echo '["lotus-planner"]' > "$CP"
  elif ! grep -q lotus-planner "$CP"; then
    /usr/bin/python3 -c 'import json,sys; p=sys.argv[1]; l=json.load(open(p)); l.append("lotus-planner"); json.dump(l,open(p,"w"))' "$CP"
  fi
fi

mkdir -p "$HOME/.claude/skills"
ln -sfn "$DIR/skills/add-task" "$HOME/.claude/skills/add-task"

mkdir -p "$HOME/Library/LaunchAgents"
# Unload every lotus job first so switching roles doesn't leave stale ones behind.
for dest in "$HOME"/Library/LaunchAgents/com.lotus.planner.*.plist; do
  [ -e "$dest" ] || continue
  launchctl bootout "gui/$(id -u)" "$dest" 2>/dev/null || true
  rm -f "$dest"
done
for job in $JOBS; do
  name="com.lotus.planner.$job.plist"; dest="$HOME/Library/LaunchAgents/$name"
  sed "s#__DIR__#$DIR#g" "$DIR/launchd/$name" > "$dest"
  launchctl bootstrap "gui/$(id -u)" "$dest"
done
echo "Installed as $ROLE. Jobs:"; launchctl list | grep com.lotus.planner
