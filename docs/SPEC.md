# Must LP16-48100 Battery Monitor — Development Specification

## 1. Goal

Build a small Node.js service that runs on the Raspberry Pi. It polls the battery's BMS over RS232 and does three things:

- publishes the readings to MQTT;
- registers them in Home Assistant through MQTT discovery;
- serves a read-only web dashboard.

It sits next to an existing app on the same Pi, `~/must-inverter-mon`, which does the same for the solar inverter. Copy that app's conventions (Node + Express + MQTT + pm2), but **do not modify it**.

Everything you need is in this document. The protocol details and the sample frames in §4 were captured from this exact battery on 2026-10-09.

---

## 2. Hard rules (never violate)

1. **Send only two BMS commands: `42` (get analog values) and `44` (get alarm info).** Enforce this in the frame builder with an allowlist that throws for anything else. The same protocol also has commands that change BMS settings or switch its MOSFETs, and those must never be sent, not even for testing.
2. **Do not touch the inverter app or its port.** Never open the CH340 adapter (`/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`, today `/dev/ttyUSB0`). Never stop, restart or edit the pm2 process `must-inverter` or anything in `~/must-inverter-mon`.
3. **Open the battery port only by its stable path:** `/dev/serial/by-id/usb-Prolific_Technology_Inc._USB-Serial_Controller_DGDIb136G03-if00-port0`. Never use `/dev/ttyUSBn`: those numbers can swap after a reboot, and then you'd be talking to the inverter.
4. **One request at a time.** Wait for the reply or the timeout before sending the next frame.
5. **Don't write to the SD card on every poll.** Keep history in memory. Optionally flush it to disk at most every 10 minutes.
6. **No secrets in code or git.** Secrets go in `.env`, and `.env` goes in `.gitignore`. Never print the MQTT password.
7. **The web UI and API are read-only.** No endpoints that send anything to the battery.

---

## 3. Environment

| Item | Value |
|---|---|
| Host | Raspberry Pi 3B+, Debian aarch64, 905 MB RAM, hostname `rasphome`, IP 192.168.1.202 |
| User | `tmykhalc` (already in the `dialout` group) |
| Runtime | Node v20.19.2, yarn 1.22.22 |
| Process manager | pm2 as a per-app devDependency (`pm2 ^5.3.0`), run via `yarn -s pm2 …`. The systemd unit `pm2-tmykhalc.service` is enabled; run `yarn -s pm2 save` after adding the app so it survives reboots. |
| App directory | `~/must-battery-mon` (new) |
| Battery port | path from rule 3; Prolific PL2303 USB-RS232 adapter cabled directly to the battery's RS232 port |
| MQTT broker | Mosquitto at `mqtt://192.168.1.201`, port 1883, username `ha`. The password is the `MQTT_PASSWORD` value in `~/must-inverter-mon/.env`; copy it into the new `.env` without printing it. |
| Home Assistant | 192.168.1.201:8123, MQTT discovery prefix `homeassistant` |
| Reference app | `~/must-inverter-mon`: read `server.js`, `ha_discovery.js`, `ecosystem.config.js`, `public/index.html` for conventions |

---

## 4. BMS protocol (PACE BMS, Pylontech-style ASCII)

### 4.1 Serial settings
9600 baud, 8 data bits, no parity, 1 stop bit, no flow control, raw mode.

### 4.2 Frame format
All fields except SOI and EOI are uppercase ASCII hex.

| Field | Chars | Value / meaning |
|---|---|---|
| SOI | 1 | `~` |
| VER | 2 | `25` (protocol version for this BMS) |
| ADR | 2 | `01` (battery address) |
| CID1 | 2 | `46` |
| CID2 | 2 | request: command code (`42` or `44`). Response: **RTN** return code (`00` = OK) |
| LENGTH | 4 | see 4.3 |
| INFO | LENID | payload (hex chars) |
| CHKSUM | 4 | see 4.4 |
| EOI | 1 | `\r` (0x0D) |

### 4.3 LENGTH field
- `LENID` = number of ASCII characters in INFO (12 bits, 0–4095).
- `LCHKSUM` = `(~(n0 + n1 + n2) + 1) & 0xF`, where n0, n1, n2 are the three 4-bit nibbles of LENID.
- `LENGTH` = `(LCHKSUM << 12) | LENID`, written as 4 hex chars.
- Example: INFO `"01"` → LENID 2 → LCHKSUM 0xE → LENGTH `E002`. Empty INFO → `0000`.

### 4.4 CHKSUM field
Add up the ASCII codes of every character after `~` and before CHKSUM, i.e. VER through the end of INFO. CHKSUM = `(~sum + 1) & 0xFFFF`, written as 4 uppercase hex chars.

### 4.5 Request test vectors (your builder must reproduce these exactly)

| Purpose | Frame (without trailing `\r`) |
|---|---|
| Get analog values, battery 01 (INFO = `01`) | `~25014642E00201FD30` |
| Get alarm info, battery 01 (INFO = `01`) | `~25014644E00201FD2E` |
| Published Pylontech reference (VER 20, ADR 02, CID2 42, INFO `02`), used only to check the checksum maths | `~20024642E00202FD33` |

### 4.6 Response validation (reject the frame if any check fails)
1. Starts with `~` and ends with `\r`. Drop any bytes before `~`.
2. CHKSUM matches (4.4).
3. LCHKSUM matches, and LENID equals the actual INFO length.
4. VER and ADR echo the request.
5. RTN (the CID2 position) is `00`. Otherwise report an error with the code:
   - `01` VER error
   - `02` CHKSUM error
   - `03` LCHKSUM error
   - `04` CID2 invalid / unsupported
   - `05` command format error
   - `06` invalid data

   This battery has been seen returning `00`, and `04` for unsupported commands.

### 4.7 Command `42`: get analog values
Request INFO = ADR (`01`). In the response INFO, B = 1 byte (2 hex chars) and W = 2-byte big-endian word (4 hex chars):

| # | Field | Size | Decoding |
|---|---|---|---|
| 1 | DATAFLAG | B | ignore |
| 2 | PACK_NO | B | integer |
| 3 | M (cell count) | B | 16 on this battery; **read it from the frame, don't hardcode** |
| 4 | cell voltage × M | W each | mV, unsigned |
| 5 | K (temperature count) | B | 6 on this battery; read it from the frame |
| 6 | temperature × K | W each | °C = (raw − 2731) / 10 |
| 7 | current | W | signed 16-bit (two's complement) × 0.01 A. Sign convention unverified, see §10 |
| 8 | pack voltage | W | mV |
| 9 | remaining capacity | W | raw × 10 mAh → Ah = raw / 100 |
| 10 | USER_DEF | B | observed `04`; informational |
| 11 | full capacity | W | Ah = raw / 100 |
| 12 | cycle count | W | integer |
| 13 | design capacity | W | Ah = raw / 100 |
| 14 | SOC | B | percent. Present on this battery; parse it only if ≥ 2 hex chars remain |

Stop parsing when INFO runs out. Missing trailing fields become `null`, not an error.

### 4.8 Command `44`: get alarm info
Request INFO = ADR (`01`). Response INFO:

| # | Field | Size | Decoding |
|---|---|---|---|
| 1 | DATAFLAG | B | ignore |
| 2 | PACK_NO | B | integer |
| 3 | M | B | cell count |
| 4 | cell alarm × M | B each | `00` normal, `01` below lower limit, `02` above upper limit, `F0` other |
| 5 | K | B | temperature count |
| 6 | temp alarm × K | B each | same codes as cell alarms |
| 7 | remaining bytes | rest | status/protection bytes. **Meaning not verified.** Publish as a raw hex string and don't interpret. Observed in normal operation: `000000000006000000000000` (12 bytes) |

Define `alarm = true` when any cell or temperature alarm byte ≠ `00`. Log a line whenever the raw status string changes, so its meaning can be worked out later.

### 4.9 Captured real frames (use as test fixtures)

**Analog values (`42`) response:**
```
~25014600D07C0001100DC00DDD0DB10DA80DBC0D170DB20DC30D910D960DCE0DB90DAA0DB00D0D0DD2060BAA0BB20BAC0BAB0BB20BB90000DA251DD004271000C727104CE1CA
```
Expected decode:
- pack_no 1, M 16
- cells (mV): `3520 3549 3505 3496 3516 3351 3506 3523 3473 3478 3534 3513 3498 3504 3341 3538`
- K 6, temperatures (°C): `25.5 26.3 25.7 25.6 26.3 27.0`
- current 0.00 A, pack voltage 55.845 V
- remaining 76.32 Ah, USER_DEF 4, full 100.00 Ah, cycles 199, design 100.00 Ah, SOC 76
- derived (§5): cell_min 3.341 V (#15), cell_max 3.549 V (#2), cell_delta_mv 208, cell_avg 3.490 V, soc_calc 76.3

**Alarm info (`44`) response:**
```
~25014600004C0001100000000000000000000000000000000006000000000000000000000006000000000000EF49
```
Expected decode: pack_no 1, 16 cell alarms all `00`, 6 temperature alarms all `00`, status_raw `000000000006000000000000`, alarm false.

**Unsupported-command response** (what the battery returned for command `4F`):
```
~250146040000FDAA
```
Expected: valid frame, RTN `04`, so the parser raises "CID2 invalid".

---

## 5. Derived values

Compute after every successful `42`:
- `cell_min`, `cell_max` (V), plus `cell_min_index` and `cell_max_index` (1-based)
- `cell_delta_mv` = (max − min) in mV, integer
- `cell_avg` (V)
- `power` = pack voltage × current (W)
- `soc_calc` = remaining / full × 100, 1 decimal (cross-check for the BMS SOC byte)

---

## 6. Polling behaviour

- Send `42` every `POLL_INTERVAL_MS` (default 5000). Send `44` every `ALARM_POLL_INTERVAL_MS` (default 30000), queued after a `42`, never concurrently.
- Response timeout 1500 ms. Read until `\r`.
- After 3 consecutive failed polls, close the port, wait 5 s and reopen it.
- **Watchdog:** if no `42` has succeeded for 90 s, log the reason and `process.exit(1)` so pm2 restarts the service. The inverter app does the same.
- Logging: one concise line per poll at most (e.g. `SOC 76% 55.85V 0.00A Δ208mV`). Errors on stderr.

---

## 7. MQTT

- Prefix: `MQTT_PREFIX`, default `home/battery`.
- Per-value topics `${prefix}/${key}`, payload a plain string. **Not retained**; Home Assistant's `expire_after` handles stale data.
- Full snapshot: `${prefix}/json` (JSON object of all keys, plus `timestamp` in ms).
- Availability: on connect publish `online` to `${prefix}/status` (retained). Set an MQTT last-will of `offline` on the same topic (retained).
- Rounding:
  - cell voltages 3 decimals (V)
  - pack voltage 2 decimals
  - current 2 decimals
  - power 0 decimals
  - temperatures 1 decimal
  - capacities 2 decimals
  - SOC integer, soc_calc 1 decimal

### Keys

| Key | Example | Notes |
|---|---|---|
| `soc` | 76 | from the BMS SOC byte (§4.7 #14); omit if absent |
| `soc_calc` | 76.3 | remaining / full |
| `voltage` | 55.85 | V |
| `current` | 0.00 | A, positive = charging (after §10 check) |
| `power` | 0 | W |
| `remaining_ah` / `full_ah` / `design_ah` | 76.32 / 100.00 / 100.00 | |
| `cycles` | 199 | |
| `cell_01` … `cell_16` | 3.520 | V; zero-padded index, M keys |
| `cell_min` / `cell_max` / `cell_avg` | 3.341 / 3.549 / 3.490 | V |
| `cell_min_index` / `cell_max_index` | 15 / 2 | |
| `cell_delta_mv` | 208 | mV |
| `temp_1` … `temp_6` | 25.5 | °C, K keys |
| `alarm` | 0 | `1`/`0` |
| `alarm_status_raw` | 000000000006000000000000 | from `44` |

---

## 8. Home Assistant MQTT discovery

Publish on **every** MQTT (re)connect, with `retain: true` and `qos: 1`.

- Topic: `homeassistant/<component>/must_lp16_battery/<key>/config`
- Payload:
  ```json
  {
    "name": "<Name>",
    "unique_id": "must_lp16_<key>",
    "state_topic": "home/battery/<key>",
    "availability_topic": "home/battery/status",
    "expire_after": 120,
    "device": {
      "identifiers": ["must_lp16_battery"],
      "name": "Must LP16-48100 Battery",
      "manufacturer": "Must",
      "model": "LP16-48100",
      "via_device": "must_pv18_inverter"
    }
  }
  ```
  Add `device_class`, `unit_of_measurement`, `state_class`, `entity_category` and `suggested_display_precision` per the table below. For `binary_sensor`, add `"payload_on": "1", "payload_off": "0"`.
- To remove an entity later, publish an empty retained payload to its config topic.
- Keep the entity list in a single array (like `ha_discovery.js` in the inverter app), so the code that publishes values and the code that publishes discovery read from the same list.

| Component | Key | Name | device_class | Unit | state_class | Category |
|---|---|---|---|---|---|---|
| sensor | soc | SOC | battery | % | measurement | |
| sensor | soc_calc | SOC (calculated) | battery | % | measurement | diagnostic |
| sensor | voltage | Voltage | voltage | V | measurement | |
| sensor | current | Current | current | A | measurement | |
| sensor | power | Power | power | W | measurement | |
| sensor | remaining_ah | Remaining Capacity | | Ah | measurement | |
| sensor | full_ah | Full Capacity | | Ah | measurement | diagnostic |
| sensor | design_ah | Design Capacity | | Ah | | diagnostic |
| sensor | cycles | Cycles | | | total_increasing | |
| sensor | cell_01…cell_16 | Cell 01 … Cell 16 | voltage | V | measurement | diagnostic |
| sensor | cell_min | Cell Min | voltage | V | measurement | |
| sensor | cell_max | Cell Max | voltage | V | measurement | |
| sensor | cell_avg | Cell Average | voltage | V | measurement | diagnostic |
| sensor | cell_delta_mv | Cell Delta | voltage | mV | measurement | |
| sensor | cell_min_index | Cell Min Index | | | | diagnostic |
| sensor | cell_max_index | Cell Max Index | | | | diagnostic |
| sensor | temp_1…temp_6 | Temperature 1 … 6 | temperature | °C | measurement | |
| binary_sensor | alarm | BMS Alarm | problem | | | |
| sensor | alarm_status_raw | BMS Status (raw) | | | | diagnostic |

HA derives entity IDs from the device and entity names, e.g. `sensor.must_lp16_48100_battery_cell_delta`. Don't rename entities after the first deploy, or their history splits.

---

## 9. Web UI

- Express on `HTTP_PORT`, default **3001** (the inverter app uses 3000). Serve `public/` statically.
- Endpoints (all GET, read-only):
  - `/api/status`: latest decoded snapshot plus `age_s`, `last_error`, `alarm_status_raw`
  - `/api/history?hours=N` (N ≤ 48): from an in-memory ring buffer, one sample per minute (SOC, voltage, current, cell_min, cell_max, cell_delta_mv, max temperature)
  - `/api/health`: `{ ok, last_success_ts, consecutive_failures }`
- `public/index.html`: single page, no build step. Match the inverter UI style: dark background `#1a1a1a`, cards `#2d2d2d`, sans-serif. Chart.js from `https://cdn.jsdelivr.net/npm/chart.js`, as the inverter UI does. Must work on a phone. Auto-refresh every 5 s.
  - SOC gauge, plus voltage / current / power, remaining / full Ah, cycles
  - **Cell bar chart, 16 bars:** colour the lowest bar blue and the highest red; show the y-axis zoomed around the cell range (not from 0)
  - Cell delta, colour-coded: < 100 mV green, 100–250 mV amber, > 250 mV red
  - Temperatures 1–6, alarm banner (shown only when `alarm` is true), "last update N s ago"
  - History charts (24 h default): SOC; cell delta; cell min/max

---

## 10. Unknowns to resolve during development (document your findings in README.md)

1. **Current sign.** The sample frame shows 0.00 A. Watch it while the battery is clearly discharging (e.g. grid off with load) and clearly charging. Compare with HA sensor `sensor.must_pv18_inverter_battery_power` from the inverter app. Publish **positive = charging**, inverting in code if needed, and write down what you observed.
2. **Temperature mapping.** PACE BMS usually reports T1–T4 cells, T5 MOSFET, T6 ambient. Unverified, so keep the neutral names "Temperature 1…6".
3. **`44` status bytes.** Don't interpret them; log changes.
4. If the BMS SOC byte is ever missing, use `soc_calc` for `soc`.

---

## 11. Project layout and configuration

```
~/must-battery-mon/
  package.json          # deps: serialport ^12, @serialport/parser-readline ^12, mqtt ^5, express ^4, dotenv ^17; devDeps: pm2 ^5.3.0
  .env.example          # every key below, with placeholder values
  .env                  # real values (gitignored)
  .gitignore            # node_modules, .env, logs, history file
  ecosystem.config.js   # pm2 app "must-battery", copy options from the inverter app
  server.js             # serial loop, MQTT, Express
  pace.js               # PURE protocol code: buildFrame, parseFrame, decode42, decode44 (no I/O)
  ha_discovery.js       # entity list + discovery publisher
  public/index.html
  scripts/probe.js      # one-shot read-only hardware check (one 42 + one 44, print decoded)
  test/pace.test.js     # node:test unit tests
  README.md
```

`.env` keys:
```
SERIAL_PORT=/dev/serial/by-id/usb-Prolific_Technology_Inc._USB-Serial_Controller_DGDIb136G03-if00-port0
SERIAL_BAUD=9600
BMS_VER=25
BMS_ADDR=01
POLL_INTERVAL_MS=5000
ALARM_POLL_INTERVAL_MS=30000
MQTT_URL=mqtt://192.168.1.201
MQTT_PORT=1883
MQTT_USERNAME=ha
MQTT_PASSWORD=
MQTT_PREFIX=home/battery
HTTP_PORT=3001
```

`package.json` scripts: `start`, `test` (`node --test`), `probe` (`node scripts/probe.js`), and `pm2:start|stop|restart|logs|status` like the inverter app, using the name `must-battery`.

`ecosystem.config.js`:
- `script: "./server.js"`, `exec_mode: "fork"`, `instances: 1`, `autorestart: true`
- `max_restarts: 10`, `min_uptime: "10s"`, `restart_delay: 4000`, `max_memory_restart: "200M"`
- logs in `./logs/`, `log_date_format: "YYYY-MM-DD HH:mm:ss Z"`

---

## 12. Tests (`node --test`, no extra test framework)

`test/pace.test.js` must cover:
1. `buildFrame` reproduces the three vectors in §4.5 exactly (with `\r` appended).
2. `buildFrame` throws for any CID2 other than `42` and `44` (test `45`, `47`, `49`, `4F`, `99`).
3. `decode42` on the §4.9 analog fixture returns every expected value listed there (cells, temperatures, capacities, cycles, SOC and derived values).
4. `decode44` on the §4.9 alarm fixture returns all-zero alarms, `alarm: false`, `status_raw: "000000000006000000000000"`.
5. Parsing `~250146040000FDAA` raises an error mentioning RTN `04`.
6. A frame with one altered INFO character fails the checksum check.
7. A frame with a wrong LENGTH fails the LCHKSUM/LENID check.

`scripts/probe.js` is the only hardware test. Run it only while the service is stopped (only one process can hold the port).

---

## 13. Deployment steps

1. Create `~/must-battery-mon`, run `yarn install`, then `yarn test` (all tests must pass).
2. Copy `.env.example` to `.env` and fill it in (MQTT password from the inverter app's `.env`).
3. `yarn probe`: you should see a decoded snapshot with 16 cells and SOC.
4. `yarn pm2:start`, then `yarn -s pm2 save`.
5. Check `yarn -s pm2 ls`: both `must-inverter` and `must-battery` are online.

---

## 14. Acceptance criteria

- [ ] `yarn test` passes.
- [ ] The service runs under pm2 as `must-battery`, survives a Pi reboot, and `must-inverter` keeps running untouched.
- [ ] `home/battery/json` updates about every 5 s; `home/battery/status` is `online`, and becomes `offline` when the service is stopped.
- [ ] HA shows the device "Must LP16-48100 Battery" with every entity from §8 and live values. Battery SOC matches the inverter's `sensor.must_pv18_inverter_battery_soc` within ±2 %.
- [ ] `http://192.168.1.202:3001` shows the dashboard: cell bars, delta, temperatures, history.
- [ ] Unplugging the RS232 adapter for 2 minutes makes the watchdog restart the service, and it recovers once the adapter is plugged back in.
- [ ] Code search confirms the only CID2 values ever sent are `42` and `44`.
- [ ] README.md documents setup, env keys, topics, and the findings from §10.

## 15. Out of scope

- Any change to `~/must-inverter-mon` or its pm2 process.
- Home Assistant automations or alerts (the owner will add e.g. "cell delta > 250 mV for 10 min" separately).
- Grafana or Prometheus integration.
- Any command that writes to or controls the BMS.
