#!/bin/bash
# BedJet Atom Lite — Stage 1 flash, run by the owner on the flashing Mac.
# Stage this file + bedjet-atom-scan.yaml together in one folder
# on the flashing Mac. Double-click this .command (or run it in
# Terminal). It:
#   1. logs everything to flash-log.txt in the same folder (no secrets in the log)
#   2. checks the Atom Lite is visible on USB and lists serial ports
#   3. creates a Python 3.14 venv and installs ESPHome into it
#   4. creates secrets.yaml on THIS Mac if missing — Wi-Fi password is typed
#      here, hidden, and never leaves this machine / never enters the log
#   5. validates, compiles, and flashes bedjet-atom-scan.yaml over USB
#   6. captures 60 seconds of device logs to scan-log.txt (BLE scan results)
# Safe to re-run: venv, secrets, and build are reused.
set -u
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
LOG="$HERE/flash-log.txt"
exec > >(tee -a "$LOG") 2>&1
echo ""
echo "=== BedJet Atom stage 1 flash — $(date) — $HERE ==="

# Keep the Mac awake for this run only (ends when this script ends).
caffeinate -dimsu -w $$ &

PY=/opt/homebrew/bin/python3.14
if [ ! -x "$PY" ]; then PY="$(command -v python3.14 || command -v python3)"; fi
echo "Python: $PY ($($PY --version 2>&1))"

echo ""
echo "--- USB / serial check ---"
system_profiler SPUSBDataType 2>/dev/null | grep -i -B2 -A8 "cp210\|espressif\|esp32\|silicon labs\|m5stack\|atom" || \
  echo "(no named ESP32/CP210x entry found in the USB tree — full tree is in usb-tree.txt)"
system_profiler SPUSBDataType > "$HERE/usb-tree.txt" 2>/dev/null
find /dev -maxdepth 1 \( -name 'cu.*' -o -name 'tty.*' \) 2>/dev/null | grep -v -i "bluetooth\|debug" || true
PORT="$(find /dev -maxdepth 1 \( -name 'cu.usbserial-*' -o -name 'cu.SLAB_USBtoUART*' -o -name 'cu.wchusbserial*' -o -name 'cu.usbmodem*' \) 2>/dev/null | head -n 1)"
if [ -z "${PORT:-}" ]; then
  echo "STOP: no USB serial port found for the Atom Lite."
  echo "Likely a charge-only cable, or the device is not plugged in."
  echo "Swap in a USB-C DATA cable, keep the Atom plugged in, and run this again."
  echo "=== FAILED: no serial port ==="
  read -r -p "Press Enter to close… " _
  exit 1
fi
echo "Serial port: $PORT"

echo ""
echo "--- ESPHome install (venv, reused on re-runs) ---"
if [ ! -x "$HERE/.venv/bin/esphome" ]; then
  "$PY" -m venv "$HERE/.venv" || { echo "STOP: venv creation failed"; read -r -p "Press Enter to close… " _; exit 1; }
  "$HERE/.venv/bin/pip" install --upgrade pip esphome || { echo "STOP: ESPHome install failed (check network)"; read -r -p "Press Enter to close… " _; exit 1; }
fi
"$HERE/.venv/bin/esphome" version

echo ""
echo "--- secrets.yaml (stays on this Mac only) ---"
if [ ! -f "$HERE/secrets.yaml" ]; then
  IFS= read -r -p "Wi-Fi SSID: " SSID
  if [ -z "$SSID" ]; then
    echo "STOP: empty Wi-Fi SSID — nothing written. Re-run and type the SSID."
    read -r -p "Press Enter to close… " _
    exit 1
  fi
  IFS= read -r -s -p "Wi-Fi password (hidden, stored only in secrets.yaml here; the SSID is not printed so it cannot land in the log): " WIFI_PW
  echo ""
  if [ -z "$WIFI_PW" ]; then
    echo "STOP: empty Wi-Fi password — nothing written. Re-run and type the password."
    read -r -p "Press Enter to close… " _
    exit 1
  fi
  API_KEY="$(openssl rand -base64 32)"
  OTA_PW="$(openssl rand -hex 12)"
  AP_PW="$(openssl rand -hex 8)"
  if [ -z "$API_KEY" ] || [ -z "$OTA_PW" ] || [ -z "$AP_PW" ]; then
    echo "STOP: key generation failed (openssl produced an empty value) — nothing written. Re-run."
    read -r -p "Press Enter to close… " _
    exit 1
  fi
  # YAML-escape backslashes and double quotes so an SSID/password
  # containing them cannot break (or alter) the YAML mapping.
  yaml_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  # umask 077 for the write itself: this file holds the Wi-Fi
  # password and the API key, so it must never exist world-readable
  # — not even between creation and a later chmod.
  ( umask 077
    {
      echo "wifi_ssid: \"$(yaml_esc "$SSID")\""
      echo "wifi_password: \"$(yaml_esc "$WIFI_PW")\""
      echo "api_encryption_key: \"$API_KEY\""
      echo "ota_password: \"$OTA_PW\""
      echo "fallback_ap_password: \"$AP_PW\""
    } > "$HERE/secrets.yaml" )
  chmod 600 "$HERE/secrets.yaml"
  unset WIFI_PW API_KEY OTA_PW AP_PW
  echo "secrets.yaml created (permissions 600 from creation, values not logged)."
else
  chmod 600 "$HERE/secrets.yaml"
  echo "secrets.yaml already exists — reusing it."
fi

echo ""
echo "--- Validate + compile ---"
cd "$HERE" || exit 1
"$HERE/.venv/bin/esphome" config bedjet-atom-scan.yaml || { echo "STOP: config validation failed"; read -r -p "Press Enter to close… " _; exit 1; }
"$HERE/.venv/bin/esphome" compile bedjet-atom-scan.yaml || { echo "STOP: compile failed"; read -r -p "Press Enter to close… " _; exit 1; }

echo ""
echo "--- Flash over USB ($PORT) ---"
"$HERE/.venv/bin/esphome" upload bedjet-atom-scan.yaml --device "$PORT" || { echo "STOP: upload/flash failed — if the Atom has no bootloader entry, hold its side button while plugging in, then re-run"; read -r -p "Press Enter to close… " _; exit 1; }
echo "FLASH OK"

echo ""
echo "--- Capturing 60s of scan logs to scan-log.txt ---"
"$HERE/.venv/bin/esphome" logs bedjet-atom-scan.yaml --device "$PORT" > "$HERE/scan-log.txt" 2>&1 &
LOGPID=$!
sleep 60
kill "$LOGPID" 2>/dev/null; wait "$LOGPID" 2>/dev/null
grep -i "bedjet\|Found device\|address:" "$HERE/scan-log.txt" | head -n 40 || true
echo ""
echo "=== DONE: stage 1 flashed. Next: read flash-log.txt and scan-log.txt in this folder. ==="
echo "You can now unplug the Atom and plug it into any USB charger near the bed."
read -r -p "Press Enter to close… " _
