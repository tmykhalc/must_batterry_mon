# must-battery-mon

**Live battery data from a Must LP16-48100 LiFePO4 battery in Home Assistant: state of charge, all 16 cell voltages, temperatures, current, cycles and alarms.**

A small Node.js service for a Raspberry Pi. It talks to the battery's BMS over RS232, publishes everything to MQTT with Home Assistant auto-discovery, and serves a compact web dashboard. It is **read-only by design**: the service cannot send any command that changes battery settings.

```
 Must LP16-48100        USB-RS232        Raspberry Pi                         Home Assistant
┌────────────────┐     ┌─────────┐     ┌───────────────────────────┐        ┌──────────────┐
│  BMS (RS232)   ├─────┤ adapter ├─────┤ must-battery-mon          ├─ MQTT ─┤ 39 entities  │
└────────────────┘     └─────────┘     │  • polls the BMS          │        └──────────────┘
                                       │  • web dashboard :3001    │
                                       └───────────────────────────┘
```

## What you get

- **Home Assistant device "Must LP16-48100 Battery"** with 39 entities, created automatically through MQTT discovery:
  - SOC (from the BMS) and a calculated SOC from remaining and full capacity
  - pack voltage, current, power, remaining / full / design capacity, cycle count
  - **each of the 16 cell voltages**, plus min, max, average and **cell delta in mV**, the best early warning for an unbalanced pack
  - 6 temperature sensors
  - a BMS alarm flag and the raw BMS status bytes
- **A web dashboard** (`http://<pi>:3001`): SOC ring, voltage / current / power, a 16-bar cell chart with the weakest and strongest cells highlighted, a colour-coded cell delta, temperatures and 24 h history charts.
- **Availability tracking:** if the service stops, Home Assistant marks the entities as unavailable instead of showing stale numbers.
- **Self-healing:** reopens the serial port after repeated failures, and a watchdog restarts the process if the battery stops answering (pm2 brings it back).

## Tested hardware

| | |
|---|---|
| Battery | Must LP16-48100 (16 cells, 48 V nominal, 100 Ah) |
| Connection | the battery's RS232 port, through a USB-RS232 adapter (a Prolific PL2303 in the reference setup) |
| Computer | Raspberry Pi 3B+, Node.js 20 |
| Home Assistant | with an MQTT broker (Mosquitto) |

The BMS speaks the PACE protocol at 9600 baud 8N1. Other batteries that use the same protocol may work, but only the LP16-48100 has been tested.

## Quick start

You need Node.js 20+, yarn, and an MQTT broker that Home Assistant already uses.

```bash
git clone https://github.com/tmykhalc/must_batterry_mon.git
cd must_batterry_mon
yarn install
yarn test            # all tests should pass

cp .env.example .env
nano .env            # set SERIAL_PORT and the MQTT password (see below)

yarn probe           # one read-only reading from the battery; prints cells, SOC, alarms
yarn pm2:start       # run it as a service
yarn -s pm2 save     # keep it running after reboots
```

Then open `http://<raspberry-pi-ip>:3001`. In Home Assistant the device appears on its own under Settings → Devices & services → MQTT.

> **Use the `/dev/serial/by-id/...` path for `SERIAL_PORT`.** List yours with `ls -l /dev/serial/by-id/`. Plain `/dev/ttyUSB0` / `ttyUSB1` numbers can swap after a reboot, especially if the Pi also has an inverter adapter plugged in, and you would end up talking to the wrong device.

## Configuration

All settings live in `.env` (copy `.env.example`):

| Setting | Default | What it does |
|---|---|---|
| `SERIAL_PORT` | none (required) | by-id path of the battery's RS232 adapter |
| `SERIAL_BAUD` | `9600` | serial speed |
| `BMS_VER`, `BMS_ADDR` | `25`, `01` | protocol version and battery address |
| `POLL_INTERVAL_MS` | `5000` | how often to read voltages, cells, temperatures |
| `ALARM_POLL_INTERVAL_MS` | `30000` | how often to read the alarm status |
| `MQTT_URL`, `MQTT_PORT` | `mqtt://…`, `1883` | your broker |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | | broker login |
| `MQTT_PREFIX` | `home/battery` | topic prefix |
| `HTTP_PORT` | `3001` | dashboard and API port |
| `CURRENT_SIGN` | `1` | set to `-1` if the current's direction is reversed (see below) |

## Home Assistant entities

Entity IDs follow the device name, for example `sensor.must_lp16_48100_battery_soc`.

| Entity | Example | Notes |
|---|---|---|
| SOC | 76 % | reported by the BMS |
| SOC (calculated) | 76.2 % | remaining ÷ full capacity |
| Voltage, Current, Power | 55.85 V, 0 A, 0 W | |
| Remaining / Full / Design Capacity | 76.2 / 100 / 100 Ah | |
| Cycles | 200 | |
| Cell 01 … Cell 16 | 3.52 V | diagnostic |
| Cell Min / Max / Average | 3.342 / 3.549 / 3.490 V | min and max also show which cell |
| **Cell Delta** | 207 mV | max − min |
| Temperature 1 … 6 | 26.1 °C | |
| BMS Alarm | off | on if the BMS reports any cell or temperature alarm |
| BMS Status (raw) | `000000000006000000000000` | diagnostic; meaning not documented by the vendor |

**Tip for alerts:** a cell delta that stays above about 250 mV for a while is worth a notification. LiFePO4 cells naturally spread out near full charge, but a steadily growing gap points to a weak cell or poor balancing.

## MQTT topics

- `<prefix>/<key>`: one topic per value, plain text, not retained (for example `home/battery/soc`, `home/battery/cell_07`)
- `<prefix>/json`: the full reading as one JSON object
- `<prefix>/status`: `online`, or `offline` (the MQTT last-will, so HA knows when the service dies)

Discovery messages are published (retained) on every MQTT connect under `homeassistant/<component>/must_lp16_battery/<key>/config`.

## Web API

Read-only, GET only:

| Endpoint | Returns |
|---|---|
| `/api/status` | latest reading (including the cell and temperature arrays), age in seconds, last error |
| `/api/history?hours=N` | one sample per minute for up to 48 h (kept in memory, cleared on restart) |
| `/api/health` | `ok`, time of last success, consecutive failures; HTTP 503 when stale |

## Safety: it only reads

The BMS protocol also has commands that change settings or switch the battery's MOSFETs. This project never sends them:

- only two commands exist in the code: **`42`** (analog values) and **`44`** (alarm info);
- the frame builder uses an allowlist and throws for any other command code;
- the web UI and API have no write endpoints;
- the port is opened only by its stable by-id path.

The unit tests cover the command allowlist.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `SERIAL_PORT is not set` | copy `.env.example` to `.env` and set it |
| `timeout waiting for reply` | wrong adapter, wrong cable or the battery is off. Check `ls -l /dev/serial/by-id/` and `yarn probe` |
| `Permission denied` opening the port | add your user to the `dialout` group and log in again |
| `BMS returned RTN 04` | the battery does not support that command. Expected for anything other than `42` and `44`; the service never sends others |
| `yarn probe` fails while the service runs | only one process can hold the serial port: stop the service first (`yarn pm2:stop`) |
| Entities missing in Home Assistant | check that MQTT discovery is on and the `MQTT_*` settings are right. `home/battery/status` should read `online` |
| The service restarts every ~90 s | the watchdog saw no valid reading for 90 s, see the pm2 error log (`yarn pm2:logs`) |

## Known limitations

- **Current direction is unverified.** Only 0 A has been seen so far. The service publishes positive for charging; if your pack shows discharge as positive, set `CURRENT_SIGN=-1`.
- **Temperature sensors are named 1 to 6.** On PACE BMS units these are usually four cells, the electronics and ambient, but this is not confirmed for this battery.
- **The BMS status bytes are published raw** and logged when they change; their meaning is undocumented.
- The 24 h history lives in memory, so it resets when the service restarts.

## Project layout

| File | Purpose |
|---|---|
| `server.js` | polling loop, MQTT, watchdog, web server |
| `pace.js` | pure protocol code: frame building and parsing, decoding, derived values |
| `bms_link.js` | serial transport, one request at a time |
| `ha_discovery.js` | the entity list and the Home Assistant discovery messages |
| `public/index.html` | the dashboard (no build step; Chart.js from a CDN) |
| `scripts/probe.js` | one-shot read-only hardware check |
| `test/` | unit tests built on frames captured from a real battery |
| `docs/SPEC.md` | the original specification and the full protocol description |

Run the tests with `yarn test` (they need no hardware). To update a deployed copy: `git pull && yarn install --frozen-lockfile && yarn pm2:restart`.

## Companion project

Reads the same installation's solar inverter (Must PV18) and publishes it to the same Home Assistant: [must_pv18_5248_pro](https://github.com/tmykhalc/must_pv18_5248_pro).

## Disclaimer

An independent, hobby project. It is not affiliated with or endorsed by Must. It talks to a battery that stores a lot of energy: use it at your own risk, and keep the read-only safeguards intact.
