#!/bin/bash
# BedJet Atom Lite — Stage 2 flash (CUTOVER), run by the owner on the flashing Mac.
# What this does, in order:
#   1. Validates + compiles bedjet-atom.yaml (BedJet hub bound to the
#      MAC learned in stage 1b, already filled into the YAML) — BEFORE anything
#      is stopped, so a config/compile failure leaves the watcher
#      running and the bed untouched.
#   2. Stops any previous BLE owner's watcher LaunchAgent (the
#      one-BLE-owner rule; set WATCHER_LABEL below to yours — the
#      reference build used a household watcher agent), then flashes
#      over USB. Rollback any time: launchctl bootstrap
#      gui/$(id -u) ~/Library/LaunchAgents/$WATCHER_LABEL.plist
#      (and unplug/stop the Atom first, same rule back).
#   3. Captures 45s of logs so the BLE connection and the climate
#      entity can be verified from flash-log-2.txt / scan-log-2.txt.
# Your part besides launching: fully close the BedJet iOS app
# before/while this runs — it also holds a BLE connection.
# Reuses the stage 1 venv + secrets.yaml. Logs to flash-log-2.txt.
set -u
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
LOG="$HERE/flash-log-2.txt"
exec > >(tee -a "$LOG") 2>&1
echo ""
echo "=== BedJet Atom stage 2 CUTOVER flash — $(date) — $HERE ==="
caffeinate -dimsu -w $$ &

PORT="$(find /dev -maxdepth 1 \( -name 'cu.usbserial-*' -o -name 'cu.SLAB_USBtoUART*' -o -name 'cu.wchusbserial*' -o -name 'cu.usbmodem*' \) 2>/dev/null | head -n 1)"
if [ -z "${PORT:-}" ]; then
  echo "STOP: no USB serial port — plug the Atom into this Mac with the data cable first."
  echo "=== FAILED: no serial port (watcher NOT stopped) ==="
  read -r -p "Press Enter to close… " _
  exit 1
fi
echo "Serial port: $PORT"
if [ ! -x "$HERE/.venv/bin/esphome" ] || [ ! -f "$HERE/secrets.yaml" ]; then
  echo "STOP: stage 1 venv/secrets missing — run flash-stage1.command first."
  read -r -p "Press Enter to close… " _
  exit 1
fi

echo ""
echo "--- Validate + compile (stage 2) — watcher still running ---"
"$HERE/.venv/bin/esphome" config bedjet-atom.yaml || { echo "STOP: config validation failed — watcher NOT stopped, nothing changed"; read -r -p "Press Enter to close… " _; exit 1; }
"$HERE/.venv/bin/esphome" compile bedjet-atom.yaml || { echo "STOP: compile failed — watcher NOT stopped, nothing changed"; read -r -p "Press Enter to close… " _; exit 1; }

echo ""
WATCHER_LABEL="com.example.bedjet-watcher"  # set to your previous BLE owner's LaunchAgent label, or leave — a missing agent is reported and the script continues
if [ "$WATCHER_LABEL" = "com.example.bedjet-watcher" ]; then
  echo "WARNING: WATCHER_LABEL is still the placeholder — NO watcher will be stopped by this script."
  echo "If another program holds the BedJet's Bluetooth connection, stop it by hand now (Ctrl-C to abort, Enter to continue without stopping anything)."
  read -r -p "Press Enter to continue… " _
fi
echo "--- Cutover: stopping the previous BLE owner watcher ($WATCHER_LABEL) ---"
if [ "$WATCHER_LABEL" = "com.example.bedjet-watcher" ]; then
  echo "Skipping the watcher stop (placeholder label — nothing is stopped)."
else
  launchctl bootout "gui/$(id -u)/$WATCHER_LABEL" 2>/dev/null \
    && echo "Watcher stopped." \
    || echo "Watcher was not running (or already stopped) — continuing."
fi
echo "Reminder: the BedJet iOS app must be fully closed (it holds BLE too)."

echo ""
echo "--- Flash over USB ($PORT) ---"
"$HERE/.venv/bin/esphome" upload bedjet-atom.yaml --device "$PORT" || {
  echo "STOP: upload failed — restoring the previous BLE owner so the bed is not left without a controller:"
  if [ "$WATCHER_LABEL" = "com.example.bedjet-watcher" ]; then
    echo "No watcher was stopped (placeholder label), so there is nothing to restore."
    read -r -p "Press Enter to close… " _
    exit 1
  fi
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$WATCHER_LABEL.plist \
    && echo "Watcher restored. The Atom may be mid-flash; re-run this script to retry the cutover." \
    || echo "Watcher restore FAILED — start it by hand: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$WATCHER_LABEL.plist"
  read -r -p "Press Enter to close… " _
  exit 1
}
echo "FLASH OK"

echo ""
echo "--- Capturing 45s of logs to scan-log-2.txt ---"
"$HERE/.venv/bin/esphome" logs bedjet-atom.yaml --device "$PORT" > "$HERE/scan-log-2.txt" 2>&1 &
LOGPID=$!
sleep 45
kill "$LOGPID" 2>/dev/null; wait "$LOGPID" 2>/dev/null
grep -i "bedjet\|ble_client\|connected" "$HERE/scan-log-2.txt" | head -n 40 || true
echo ""
echo "=== DONE: stage 2 flashed (upload hash-verified by ESPHome; BLE ownership NOT yet verified). Verify from scan-log-2.txt, then run bedjet-test.py. ==="
echo "Rollback if needed: unplug the Atom, then run:"
echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$WATCHER_LABEL.plist"
read -r -p "Press Enter to close… " _
