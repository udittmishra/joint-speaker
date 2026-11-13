#!/bin/bash
# Double-click this file to start Joint Speaker and open a new party in Chrome.
# Keep the Terminal window it opens running during the party; close it to stop.

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

PORT=3000
URL="http://localhost:$PORT/?host"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js isn't installed. Get it from https://nodejs.org, then double-click this file again."
  echo
  read -r -p "  Press Return to close." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run: installing…"
  npm install --silent || { read -r -p "  Install failed. Press Return to close." _; exit 1; }
fi

open_browser() {
  for app in "Google Chrome" "Brave Browser" "Microsoft Edge" "Arc"; do
    if [ -d "/Applications/$app.app" ]; then
      open -a "$app" "$URL"
      return
    fi
  done
  open "$URL"
}

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo
  echo "  Joint Speaker is already running — opening a new party."
  open_browser
  sleep 2
  exit 0
fi

node server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM HUP

# Wait until the server answers, then open the party.
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://localhost:$PORT/api/info" && break
  sleep 0.1
done
open_browser

echo "  Keep this window open while the party is on. Close it to stop."
echo

# Keep the Mac (and its screen) awake for as long as the server runs.
caffeinate -dims -w $SERVER
