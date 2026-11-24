#!/bin/bash
# BedJet Atom Lite — Stage 1b re-flash, run by the owner on the flashing Mac.
# Why 1b: the stage 1 firmware's BLE tracker had no advertise listener, so
# it logged no nearby devices at all (flash-log.txt / scan-log.txt,
# Nov 23, 2026). The updated bedjet-atom-scan.yaml adds an
# on_ble_advertise logger that prints every advertiser's address, RSSI,
# and name. Reuses the venv + secrets.yaml from stage 1 — no prompts
# except this window staying open. Logs to flash-log-1b.txt.
set -u
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
LOG="$HERE/flash-log-1b.txt"
exec > >(tee -a "$LOG") 2>&1
echo ""
echo "=== BedJet Atom stage 1b flash — $(date) — $HERE ==="
caffeinate -dimsu -w $$ &

PORT="$(find /dev -maxdepth 1 \( -name 'cu.usbserial-*' -o -name 'cu.SLAB_USBtoUART*' -o -name 'cu.wchusbserial*' -o -name 'cu.usbmodem*' \) 2>/dev/null | head -n 1)"
if [ -z "${PORT:-}" ]; then
  echo "STOP: no USB serial port — is the Atom still plugged into this Mac with the data cable?"
  echo "=== FAILED: no serial port ==="
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
echo "--- Validate + compile (1b) ---"
"$HERE/.venv/bin/esphome" config bedjet-atom-scan.yaml || { echo "STOP: config validation failed"; read -r -p "Press Enter to close… " _; exit 1; }
"$HERE/.venv/bin/esphome" compile bedjet-atom-scan.yaml || { echo "STOP: compile failed"; read -r -p "Press Enter to close… " _; exit 1; }

echo ""
echo "--- Flash over USB ($PORT) ---"
"$HERE/.venv/bin/esphome" upload bedjet-atom-scan.yaml --device "$PORT" || { echo "STOP: upload failed"; read -r -p "Press Enter to close… " _; exit 1; }
echo "FLASH OK"

echo ""
echo "--- Capturing 90s of BLE advertise logs to scan-log-1b.txt ---"
"$HERE/.venv/bin/esphome" logs bedjet-atom-scan.yaml --device "$PORT" > "$HERE/scan-log-1b.txt" 2>&1 &
LOGPID=$!
sleep 90
kill "$LOGPID" 2>/dev/null; wait "$LOGPID" 2>/dev/null
echo "Advertisers seen:"
grep "ble_scan" "$HERE/scan-log-1b.txt" | sort -u | head -n 60 || true
echo ""
echo "=== DONE: stage 1b flashed. Next: read scan-log-1b.txt in this folder for the BedJet MAC. ==="
read -r -p "Press Enter to close… " _
