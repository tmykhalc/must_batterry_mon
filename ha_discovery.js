// Home Assistant MQTT discovery for the Must LP16-48100 battery.
// ENTITIES is the single source of truth: server.js publishes values for exactly these keys.
// Entity names/unique_ids must stay stable after the first deploy, or HA history splits.

const DEVICE = {
  identifiers: ["must_lp16_battery"],
  name: "Must LP16-48100 Battery",
  manufacturer: "Must",
  model: "LP16-48100",
  via_device: "must_pv18_inverter"
};

const EXPIRE_AFTER = 120;

const pad = (n) => String(n).padStart(2, "0");

// [component, key, name, device_class, unit, state_class, entity_category, display_precision]
function entities(cells = 16, temps = 6) {
  const list = [
    ["sensor", "soc", "SOC", "battery", "%", "measurement", null, 0],
    ["sensor", "soc_calc", "SOC (calculated)", "battery", "%", "measurement", "diagnostic", 1],
    ["sensor", "voltage", "Voltage", "voltage", "V", "measurement", null, 2],
    ["sensor", "current", "Current", "current", "A", "measurement", null, 2],
    ["sensor", "power", "Power", "power", "W", "measurement", null, 0],
    ["sensor", "remaining_ah", "Remaining Capacity", null, "Ah", "measurement", null, 1],
    ["sensor", "full_ah", "Full Capacity", null, "Ah", "measurement", "diagnostic", 1],
    ["sensor", "design_ah", "Design Capacity", null, "Ah", null, "diagnostic", 1],
    ["sensor", "cycles", "Cycles", null, null, "total_increasing", null, 0]
  ];
  for (let i = 1; i <= cells; i++) list.push(["sensor", `cell_${pad(i)}`, `Cell ${pad(i)}`, "voltage", "V", "measurement", "diagnostic", 3]);
  list.push(
    ["sensor", "cell_min", "Cell Min", "voltage", "V", "measurement", null, 3],
    ["sensor", "cell_max", "Cell Max", "voltage", "V", "measurement", null, 3],
    ["sensor", "cell_avg", "Cell Average", "voltage", "V", "measurement", "diagnostic", 3],
    ["sensor", "cell_delta_mv", "Cell Delta", "voltage", "mV", "measurement", null, 0],
    ["sensor", "cell_min_index", "Cell Min Index", null, null, null, "diagnostic", 0],
    ["sensor", "cell_max_index", "Cell Max Index", null, null, null, "diagnostic", 0]
  );
  for (let i = 1; i <= temps; i++) list.push(["sensor", `temp_${i}`, `Temperature ${i}`, "temperature", "°C", "measurement", null, 1]);
  list.push(
    ["binary_sensor", "alarm", "BMS Alarm", "problem", null, null, null, null],
    ["sensor", "alarm_status_raw", "BMS Status (raw)", null, null, null, "diagnostic", null]
  );
  return list;
}

function discoveryMessages(prefix, { cells = 16, temps = 6 } = {}) {
  return entities(cells, temps).map(([component, key, name, deviceClass, unit, stateClass, category, precision]) => {
    const payload = {
      name,
      unique_id: `must_lp16_${key}`,
      state_topic: `${prefix}/${key}`,
      availability_topic: `${prefix}/status`,
      expire_after: EXPIRE_AFTER,
      device: DEVICE
    };
    if (deviceClass) payload.device_class = deviceClass;
    if (unit) payload.unit_of_measurement = unit;
    if (stateClass) payload.state_class = stateClass;
    if (category) payload.entity_category = category;
    if (precision !== null && precision !== undefined) payload.suggested_display_precision = precision;
    if (component === "binary_sensor") {
      payload.payload_on = "1";
      payload.payload_off = "0";
    }
    return { topic: `homeassistant/${component}/must_lp16_battery/${key}/config`, payload: JSON.stringify(payload) };
  });
}

function publishDiscovery(client, prefix, opts) {
  for (const { topic, payload } of discoveryMessages(prefix, opts)) {
    client.publish(topic, payload, { retain: true, qos: 1 });
  }
}

module.exports = { publishDiscovery, discoveryMessages, entities };
