require("dotenv").config();

const path = require("path");
const express = require("express");
const mqtt = require("mqtt");
const { BmsLink } = require("./bms_link");
const { decode42, decode44, derive } = require("./pace");
const { publishDiscovery } = require("./ha_discovery");

const env = process.env;
const CONFIG = {
  serial: { path: env.SERIAL_PORT, baud: parseInt(env.SERIAL_BAUD) || 9600, ver: env.BMS_VER || "25", adr: env.BMS_ADDR || "01" },
  pollMs: parseInt(env.POLL_INTERVAL_MS) || 5000,
  alarmPollMs: parseInt(env.ALARM_POLL_INTERVAL_MS) || 30000,
  mqtt: { url: env.MQTT_URL, port: parseInt(env.MQTT_PORT) || 1883, username: env.MQTT_USERNAME || "", password: env.MQTT_PASSWORD || "", prefix: env.MQTT_PREFIX || "home/battery" },
  httpPort: parseInt(env.HTTP_PORT) || 3001,
  // Set to -1 if the BMS reports discharge as positive (see README, "current sign").
  currentSign: parseInt(env.CURRENT_SIGN) === -1 ? -1 : 1
};

if (!CONFIG.serial.path) {
  console.error("SERIAL_PORT is not set. Use the /dev/serial/by-id/... path of the battery adapter.");
  process.exit(1);
}
if (CONFIG.serial.path.startsWith("/dev/ttyUSB")) {
  console.warn("WARNING: SERIAL_PORT is a /dev/ttyUSBn path; these numbers can swap after a reboot. Use /dev/serial/by-id/....");
}

const WATCHDOG_MS = 90 * 1000;
const HISTORY_MAX = 48 * 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const round = (v, d) => (v === null || v === undefined ? v : Math.round(v * 10 ** d) / 10 ** d);

const state = {
  snapshot: null,
  alarm: null, // { alarm, statusRaw } once the first 44 succeeded
  lastSuccess: 0,
  lastError: null,
  failures: 0,
  history: [],
  lastSample: 0
};
let startedAt = Date.now();

// ------------------------------------------------------------------ MQTT

const prefix = CONFIG.mqtt.prefix;
const mqttClient = mqtt.connect(CONFIG.mqtt.url, {
  port: CONFIG.mqtt.port,
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  will: { topic: `${prefix}/status`, payload: "offline", retain: true, qos: 1 }
});
mqttClient.on("connect", () => {
  mqttClient.publish(`${prefix}/status`, "online", { retain: true, qos: 1 });
  publishDiscovery(mqttClient, prefix, { cells: state.snapshot ? state.snapshot._cells : 16, temps: state.snapshot ? state.snapshot._temps : 6 });
});
mqttClient.on("error", (e) => console.error("MQTT:", e.message));

function publishSnapshot(snap) {
  const json = {};
  for (const [k, v] of Object.entries(snap)) {
    if (k.startsWith("_") || v === null || v === undefined) continue;
    json[k] = v;
    mqttClient.publish(`${prefix}/${k}`, String(v));
  }
  mqttClient.publish(`${prefix}/json`, JSON.stringify({ ...json, timestamp: Date.now() }));
}

// ------------------------------------------------------------------ snapshot

function buildSnapshot(a42) {
  a42.current = a42.current === null ? null : a42.current * CONFIG.currentSign;
  const d = derive(a42);
  const s = {
    soc: a42.soc !== null ? a42.soc : d.soc_calc !== undefined ? Math.round(d.soc_calc) : null,
    soc_calc: d.soc_calc,
    voltage: round(a42.voltage, 2),
    current: round(a42.current, 2),
    power: round(d.power, 0),
    remaining_ah: round(a42.remainingAh, 2),
    full_ah: round(a42.fullAh, 2),
    design_ah: round(a42.designAh, 2),
    cycles: a42.cycles
  };
  a42.cellsMv.forEach((mv, i) => (s[`cell_${pad(i + 1)}`] = round(mv / 1000, 3)));
  Object.assign(s, {
    cell_min: round(d.cell_min, 3),
    cell_max: round(d.cell_max, 3),
    cell_avg: round(d.cell_avg, 3),
    cell_min_index: d.cell_min_index,
    cell_max_index: d.cell_max_index,
    cell_delta_mv: d.cell_delta_mv
  });
  a42.temps.forEach((t, i) => (s[`temp_${i + 1}`] = round(t, 1)));
  if (state.alarm) {
    s.alarm = state.alarm.alarm ? 1 : 0;
    s.alarm_status_raw = state.alarm.statusRaw;
  }
  s._cells = a42.cellsMv.length;
  s._temps = a42.temps.length;
  s._cellsV = a42.cellsMv.map((mv) => mv / 1000);
  s._tempsC = a42.temps;
  return s;
}

function recordHistory(s) {
  const now = Date.now();
  if (now - state.lastSample < 60000) return;
  state.lastSample = now;
  state.history.push({
    t: now,
    soc: s.soc,
    voltage: s.voltage,
    current: s.current,
    cell_min: s.cell_min,
    cell_max: s.cell_max,
    cell_delta_mv: s.cell_delta_mv,
    temp_max: s._tempsC.length ? Math.max(...s._tempsC) : null
  });
  if (state.history.length > HISTORY_MAX) state.history.shift();
}

// ------------------------------------------------------------------ polling loop

const link = new BmsLink({ ...CONFIG.serial, timeoutMs: 1500 });
state.lastSuccess = Date.now();

async function pollAnalog() {
  const a42 = decode42(await link.request("42"));
  const snap = buildSnapshot(a42);
  state.snapshot = snap;
  state.lastSuccess = Date.now();
  state.failures = 0;
  state.lastError = null;
  publishSnapshot(snap);
  recordHistory(snap);
  console.log(`SOC ${snap.soc}% ${snap.voltage}V ${snap.current}A Δ${snap.cell_delta_mv}mV`);
}

async function pollAlarms() {
  const a44 = decode44(await link.request("44"));
  if (!state.alarm || state.alarm.statusRaw !== a44.statusRaw) console.log(`BMS status bytes: ${a44.statusRaw} (alarm=${a44.alarm})`);
  state.alarm = { alarm: a44.alarm, statusRaw: a44.statusRaw };
  mqttClient.publish(`${prefix}/alarm`, a44.alarm ? "1" : "0");
  mqttClient.publish(`${prefix}/alarm_status_raw`, a44.statusRaw);
  if (state.snapshot) {
    state.snapshot.alarm = a44.alarm ? 1 : 0;
    state.snapshot.alarm_status_raw = a44.statusRaw;
  }
}

async function loop() {
  let lastAlarmPoll = 0;
  for (;;) {
    if (!link.port) {
      try {
        await link.open();
        console.log(`Opened ${CONFIG.serial.path}`);
      } catch (e) {
        state.lastError = `open failed: ${e.message}`;
        console.error(state.lastError);
        await sleep(5000);
        continue;
      }
    }
    try {
      await pollAnalog();
      if (Date.now() - lastAlarmPoll >= CONFIG.alarmPollMs) {
        lastAlarmPoll = Date.now();
        await pollAlarms().catch((e) => console.error("alarm poll:", e.message));
      }
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      console.error(`poll failed (${state.failures}): ${e.message}`);
      if (state.failures % 3 === 0) {
        console.error("3 consecutive failures: reopening port in 5 s");
        await link.close();
        await sleep(5000);
        continue;
      }
    }
    await sleep(CONFIG.pollMs);
  }
}

setInterval(() => {
  const idle = Date.now() - state.lastSuccess;
  if (idle > WATCHDOG_MS) {
    console.error(`WATCHDOG: no successful analog read for ${Math.round(idle / 1000)} s (${state.lastError || "no error recorded"}). Exiting for pm2 restart.`);
    process.exit(1);
  }
}, 15000);

// ------------------------------------------------------------------ HTTP (read-only)

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  const snap = state.snapshot;
  const out = snap ? Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith("_"))) : {};
  res.json({
    ...out,
    cells: snap ? snap._cellsV : [],
    temps: snap ? snap._tempsC : [],
    age_s: state.lastSuccess && snap ? Math.round((Date.now() - state.lastSuccess) / 1000) : null,
    last_error: state.lastError,
    alarm_status_raw: state.alarm ? state.alarm.statusRaw : null,
    uptime_s: Math.round((Date.now() - startedAt) / 1000)
  });
});

app.get("/api/history", (req, res) => {
  const hours = Math.min(Math.max(parseFloat(req.query.hours) || 24, 0.1), 48);
  const from = Date.now() - hours * 3600 * 1000;
  res.json(state.history.filter((p) => p.t >= from));
});

app.get("/api/health", (req, res) => {
  const ok = state.snapshot !== null && Date.now() - state.lastSuccess < WATCHDOG_MS;
  res.status(ok ? 200 : 503).json({ ok, last_success_ts: state.lastSuccess || null, consecutive_failures: state.failures });
});

app.listen(CONFIG.httpPort, () => {
  console.log(`Battery monitor UI on port ${CONFIG.httpPort}`);
  loop();
});
