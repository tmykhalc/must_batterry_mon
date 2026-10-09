# must-battery-mon

Reads a **Must LP16-48100** LiFePO4 battery's BMS over RS232 (**read-only**), publishes the values to MQTT with Home Assistant discovery, and serves a small web dashboard. It is meant to run on a Raspberry Pi next to the inverter monitor (`must-inverter-mon`) and follows the same conventions (Node + Express + MQTT + pm2).

Full specification: [docs/SPEC.md](docs/SPEC.md).

## Safety

- Only two BMS commands can ever be sent: `42` (analog values) and `44` (alarm info). `pace.js` enforces an allowlist and throws for anything else.
- The web UI and API are read-only.
- Open the battery adapter **only by its `/dev/serial/by-id/...` path**. `/dev/ttyUSBn` numbers can swap after a reboot, and the other adapter belongs to the inverter. The service warns if a `/dev/ttyUSBn` path is configured.

## Layout

| File | Purpose |
|---|---|
| `pace.js` | Pure protocol code: frame build/parse, `decode42`, `decode44`, derived values |
| `bms_link.js` | Serial transport, one request in flight (shared by the service and the probe) |
| `server.js` | Polling loop, MQTT, watchdog, Express API and UI |
| `ha_discovery.js` | Entity list and HA discovery publisher |
| `public/index.html` | Dashboard (no build step, Chart.js from CDN) |
| `scripts/probe.js` | One-shot read-only hardware check |
| `test/` | `node --test` unit tests (captured real frames as fixtures) |

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in `MQTT_PASSWORD`.

| Key | Default | Meaning |
|---|---|---|
| `SERIAL_PORT` | (required) | by-id path of the battery's RS232 adapter |
| `SERIAL_BAUD` | 9600 | |
| `BMS_VER` / `BMS_ADDR` | 25 / 01 | protocol version / battery address |
| `POLL_INTERVAL_MS` | 5000 | analog poll (`42`) |
| `ALARM_POLL_INTERVAL_MS` | 30000 | alarm poll (`44`) |
| `MQTT_URL`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` | | broker |
| `MQTT_PREFIX` | `home/battery` | topic prefix |
| `HTTP_PORT` | 3001 | dashboard / API |
| `CURRENT_SIGN` | 1 | set `-1` if the BMS reports discharge as positive |

## Run

```bash
yarn install
yarn test        # all tests must pass
yarn probe       # stop the service first: only one process can hold the port
yarn pm2:start
yarn -s pm2 save # keep it across reboots
```

## MQTT

- `home/battery/<key>`: plain-string values, not retained (HA `expire_after` is 120 s)
- `home/battery/json`: full snapshot including `timestamp`
- `home/battery/status`: `online` (retained); last-will `offline`

Keys: `soc`, `soc_calc`, `voltage`, `current`, `power`, `remaining_ah`, `full_ah`, `design_ah`, `cycles`, `cell_01`..`cell_16`, `cell_min`, `cell_max`, `cell_avg`, `cell_min_index`, `cell_max_index`, `cell_delta_mv`, `temp_1`..`temp_6`, `alarm`, `alarm_status_raw`.

Discovery is published (retained) on every MQTT connect under `homeassistant/<component>/must_lp16_battery/<key>/config`, unique ids `must_lp16_<key>`. The entity list in `ha_discovery.js` is the single source of truth. Do not rename entities after the first deploy.

## HTTP API (GET, read-only)

`/api/status`, `/api/history?hours=N` (N up to 48, in-memory, one sample per minute, lost on restart), `/api/health`.

## Findings (spec section 10)

Written from the first captured frames; items marked **open** need checking against the real battery.

1. **Current sign: open.** The captured frame shows 0.00 A. Watch the value while discharging and while charging, compare with the inverter's battery power, and set `CURRENT_SIGN=-1` if it is reversed. The published convention is positive = charging.
2. **Temperature mapping: open.** PACE BMS units usually report T1-T4 cells, T5 MOSFET, T6 ambient. Unverified, so sensors are named "Temperature 1..6".
3. **`44` status bytes: open.** Published raw (observed in normal operation: `000000000006000000000000`). The service logs whenever the string changes so the meaning can be worked out.
4. If the BMS SOC byte is missing, `soc` falls back to `soc_calc`.

## Notes

- Verified protocol facts (from the inverter session on 2026-10-09): VER `25`, ADR `01`, 9600 8N1. Commands `4F`, `51`, `47` return RTN `04` (unsupported) on this battery, which is one more reason to send nothing but `42` and `44`.
- The watchdog exits with code 1 if no analog read succeeds for 90 s, and pm2 restarts the service.
