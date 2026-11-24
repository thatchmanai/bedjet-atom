# When you plug in the Atom Lite — start here

State Nov 24, 2026: this runbook has been fully executed — the Atom was
plugged in, flashed (stages 1, 1b, 2, and the 2.1–3.0.2 updates), and is
live by the bed as the BedJet's BLE owner. The steps below are kept as
the rebuild/re-flash runbook; read them as the record of the procedure,
not as pending work. (Original Nov 23, 2026 state: the owner chose "prep
only for now" — everything was staged, nothing flashed.)

## Your part (5 minutes, at the Mac)

1. Plug the Atom Lite into the Mac with a USB-C **data** cable
   (a charge-only cable will power it but no flash is possible).
2. Tell your assistant (or note for yourself) which Mac it's plugged into.
3. Be there for two moments an assistant can't do for you: entering
   the Wi-Fi password in the secrets file on that Mac, and any macOS
   prompt that needs your password.

## The assistant's part (after that)

1. Install ESPHome on that Mac, stage these configs + secrets.yaml.
2. Compile and flash stage 1 (`bedjet-atom-scan.yaml`) over USB.
3. You move the Atom to any USB charger near the bed.
4. Read the scan logs, record the BedJet's BLE MAC.
5. Cutover (one BLE owner): stop M4 watcher/poller, close BedJet app.
6. Flash stage 2 (`bedjet-atom.yaml`), then test heat / off / fan
   with read-back (`bedjet-test.py`, or the Atom's own web page).

Full detail: README.md in this kit.
