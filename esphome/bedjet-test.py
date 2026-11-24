#!/usr/bin/env python3
"""BedJet stage 2 read-back test — runs on a Mac on the same LAN,
talks to the Atom over the ESPHome API (port 6053). The Atom's
address comes from the BEDJET_ATOM_ADDRESS environment variable,
defaulting to its mDNS name bedjet-atom.local; set it to the Atom's
IP address if mDNS does not resolve on your network.

Reads the API encryption key from secrets.yaml in this folder,
locally — the key is never printed. Sequence:
  1. connect, list entities, read the BedJet climate state as found
  2. if the as-found state already matches the HEAT test state,
     command OFF first and verify OFF — otherwise a dropped HEAT
     command could "pass" against the stale state it never changed
  3. command HEAT, target 38 C, fan level 10/20
  4. read back — mode must be HEAT and target must read 38 C
     (tolerance 0.25 C: half the BedJet's 0.5 C setpoint step, so
     the adjacent 38.5 C setpoint cannot pass for 38.0); when the
     device exposes a fan entity, it must also report on at speed
     level 10, and a fan command that failed to send fails the
     fan check — any mismatch fails this test
  5. command OFF, read back — state must show OFF
  6. leave the BedJet OFF (its as-found state is reported in the
     log); if anything raises after HEAT was commanded, a
     best-effort OFF is attempted before the failure propagates
Exit code 0 only if every read-back matches what was commanded —
mode alone is not verification.
"""
import asyncio
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADDRESS = os.environ.get("BEDJET_ATOM_ADDRESS") or "bedjet-atom.local"
PORT = 6053
TARGET_C = 38.0
TARGET_TOLERANCE_C = 0.25  # half the device's 0.5 C setpoint step


def read_api_key() -> str:
    text = (HERE / "secrets.yaml").read_text()
    m = re.search(r'api_encryption_key:\s*"([^"]+)"', text)
    if not m:
        print("FAIL: api_encryption_key not found in secrets.yaml")
        sys.exit(2)
    return m.group(1)


async def main() -> int:
    from aioesphomeapi import APIClient
    from aioesphomeapi.model import ClimateMode

    key = read_api_key()
    cli = APIClient(ADDRESS, PORT, "", noise_psk=key)
    await cli.connect(login=True)
    print(f"CONNECTED to bedjet-atom API at {ADDRESS}:{PORT}")
    info = await cli.device_info()
    print(f"Device: {info.name} esphome={info.esphome_version} mac={info.mac_address}")

    entities, _services = await cli.list_entities_services()
    climate = next((e for e in entities if e.__class__.__name__ == "ClimateInfo"), None)
    fan = next((e for e in entities if e.__class__.__name__ == "FanInfo"), None)
    if climate is None:
        print("FAIL: no climate entity on the device")
        return 1
    print(f"Climate entity: {climate.name} key={climate.key}")
    if fan:
        print(f"Fan entity: {fan.name} key={fan.key}")

    states = {}

    def on_state(state):
        states[state.key] = state

    cli.subscribe_states(on_state)  # not a coroutine in aioesphomeapi — awaiting it was the 23:16 TypeError
    await asyncio.sleep(6)

    def mode_name(m):
        try:
            return ClimateMode(int(m)).name
        except Exception:  # noqa: BLE001
            return str(m)

    def show(label):
        s = states.get(climate.key)
        if s is None:
            print(f"{label}: no climate state yet")
            return None
        print(
            f"{label}: mode={mode_name(s.mode)} target={s.target_temperature}C "
            f"current={s.current_temperature}C fan_mode={getattr(s, 'fan_mode', '?')}"
        )
        return s

    def fan_matches():
        """True/False when a fan entity exists and reported; the
        caller decides what no-fan-entity means."""
        fs = states.get(fan.key)
        if fs is None:
            print("READ-BACK fan: no fan state received")
            return False
        print(f"READ-BACK fan: state={fs.state} speed_level={fs.speed_level}")
        return bool(fs.state) and int(fs.speed_level or 0) == 10

    found = show("AS FOUND")
    if found is None:
        print("FAIL: never received a climate state — BLE link down?")
        return 1

    heat_sent = False
    off_verified = False
    try:
        # Transition guarantee: if the bed already sits in exactly
        # the state this test commands, a dropped HEAT command would
        # be indistinguishable from a landed one. Drive it OFF and
        # verify OFF first, so the HEAT read-back below can only be
        # the result of a real transition.
        already_at_target = (
            int(found.mode) == int(ClimateMode.HEAT)
            and abs(float(found.target_temperature) - TARGET_C) <= TARGET_TOLERANCE_C
            and (fan is None or fan_matches())
        )
        if already_at_target:
            print("AS FOUND already matches the test state — commanding OFF first to force a real transition")
            cli.climate_command(climate.key, mode=ClimateMode.OFF)  # sync send in aioesphomeapi — awaiting it was the 23:18 TypeError
            await asyncio.sleep(8)
            baseline = show("READ-BACK baseline OFF")
            if baseline is None or int(baseline.mode) != int(ClimateMode.OFF):
                print("FAIL: could not establish an OFF baseline; not trusting a HEAT read-back from here")
                return 1

        print("COMMAND: HEAT, target 38C")
        cli.climate_command(climate.key, mode=ClimateMode.HEAT, target_temperature=TARGET_C)  # sync send, as above
        heat_sent = True
        fan_command_failed = False
        if fan:
            try:
                cli.fan_command(fan.key, state=True, speed_level=10)  # 10 of 20 levels = 50%; 'percentage' kwarg does not exist in this version (23:19 TypeError)
                print("COMMAND: fan on, speed level 10/20")
            except Exception as exc:  # noqa: BLE001 - any send failure fails the fan check, not the whole test
                fan_command_failed = True
                print(f"WARN: fan command failed to send ({type(exc).__name__}: {exc}) — fan read-back will be marked FAIL")
        await asyncio.sleep(8)
        after_heat = show("READ-BACK after HEAT")
        heat_ok = (
            after_heat is not None
            and int(after_heat.mode) == int(ClimateMode.HEAT)
            and abs(float(after_heat.target_temperature) - TARGET_C) <= TARGET_TOLERANCE_C
        )
        if fan is None:
            fan_status = "SKIP (no fan entity)"
        elif fan_command_failed:
            fan_status = "FAIL"
        else:
            fan_status = "OK" if fan_matches() else "FAIL"

        print("COMMAND: OFF")
        cli.climate_command(climate.key, mode=ClimateMode.OFF)  # sync send, as above
        await asyncio.sleep(8)
        after_off = show("READ-BACK after OFF")
        off_ok = after_off is not None and int(after_off.mode) == int(ClimateMode.OFF)
        off_verified = off_ok
    except BaseException:
        # Never leave the bed heating because this script died
        # mid-test: best-effort OFF, then let the failure propagate.
        if heat_sent and not off_verified:
            try:
                print("RESTORE: exception during test — attempting OFF")
                cli.climate_command(climate.key, mode=ClimateMode.OFF)
                await asyncio.sleep(2)
            except BaseException as restore_exc:  # noqa: BLE001 - restore is best-effort
                print(f"RESTORE FAILED: {type(restore_exc).__name__}: {restore_exc}")
        raise

    _disc = cli.disconnect()
    if asyncio.iscoroutine(_disc):
        await _disc
    print(f"RESULT: heat_readback={'OK' if heat_ok else 'FAIL'} fan_readback={fan_status} off_readback={'OK' if off_ok else 'FAIL'}")
    return 0 if (heat_ok and fan_status != "FAIL" and off_ok) else 1


if __name__ == "__main__":
    try:
        code = asyncio.run(asyncio.wait_for(main(), timeout=120))
    except Exception as exc:  # noqa: BLE001 — log anything, exit nonzero
        print(f"FAIL: {type(exc).__name__}: {exc}")
        code = 1
    sys.exit(code)
