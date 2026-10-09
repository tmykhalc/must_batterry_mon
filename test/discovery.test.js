const test = require("node:test");
const assert = require("node:assert/strict");
const { discoveryMessages, entities } = require("../ha_discovery");

test("discovery covers all spec entities with unique ids and topics", () => {
  const msgs = discoveryMessages("home/battery");
  assert.equal(msgs.length, entities().length);
  assert.equal(msgs.length, 9 + 16 + 6 + 6 + 2); // base + cells + cell stats + temps + alarm
  const ids = new Set();
  for (const { topic, payload } of msgs) {
    const p = JSON.parse(payload);
    assert.match(topic, /^homeassistant\/(sensor|binary_sensor)\/must_lp16_battery\/[a-z0-9_]+\/config$/);
    assert.match(p.unique_id, /^must_lp16_/);
    assert.ok(!ids.has(p.unique_id), `duplicate ${p.unique_id}`);
    ids.add(p.unique_id);
    assert.ok(p.state_topic.startsWith("home/battery/"));
    assert.equal(p.availability_topic, "home/battery/status");
    assert.equal(p.expire_after, 120);
    assert.deepEqual(p.device.identifiers, ["must_lp16_battery"]);
  }
});

test("binary_sensor alarm uses 1/0 payloads", () => {
  const m = discoveryMessages("home/battery").find((x) => x.topic.includes("/alarm/config"));
  const p = JSON.parse(m.payload);
  assert.equal(p.payload_on, "1");
  assert.equal(p.payload_off, "0");
  assert.match(m.topic, /binary_sensor/);
});

test("cell and temperature counts are configurable", () => {
  const msgs = discoveryMessages("x", { cells: 8, temps: 4 });
  assert.equal(msgs.filter((m) => /\/cell_\d\d\/config$/.test(m.topic)).length, 8);
  assert.equal(msgs.filter((m) => /\/temp_\d\/config$/.test(m.topic)).length, 4);
});
