const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFrame, parseFrame, decode42, decode44, derive } = require("../pace");

// Test-only copy of the frame maths (no allowlist) to check the checksum against a published Pylontech frame.
function pylonFrame(ver, adr, cid2, info) {
  const n = info.length;
  const lchk = (~((n & 0xf) + ((n >> 4) & 0xf) + ((n >> 8) & 0xf)) + 1) & 0xf;
  const body = `${ver}${adr}46${cid2}${((lchk << 12) | n).toString(16).toUpperCase().padStart(4, "0")}${info}`;
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  return `~${body}${((~sum + 1) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}\r`;
}

const R42 =
  "~25014600D07C0001100DC00DDD0DB10DA80DBC0D170DB20DC30D910D960DCE0DB90DAA0DB00D0D0DD2060BAA0BB20BAC0BAB0BB20BB90000DA251DD004271000C727104CE1CA";
const R44 = "~25014600004C0001100000000000000000000000000000000006000000000000000000000006000000000000EF49";
const RUNSUPPORTED = "~250146040000FDAA";

test("buildFrame reproduces the published request frames", () => {
  assert.equal(buildFrame("42", "01"), "~25014642E00201FD30\r");
  assert.equal(buildFrame("44", "01"), "~25014644E00201FD2E\r");
  assert.equal(pylonFrame("20", "02", "42", "02"), "~20024642E00202FD33\r");
});

test("buildFrame refuses every command except 42 and 44", () => {
  for (const cid2 of ["45", "47", "49", "4F", "99"]) {
    assert.throws(() => buildFrame(cid2, "01"), /refusing/, cid2);
  }
});

test("decode42 decodes the captured analog frame", () => {
  const a = decode42(parseFrame(R42, { ver: "25", adr: "01" }).info);
  assert.equal(a.packNo, 1);
  assert.deepEqual(a.cellsMv, [3520, 3549, 3505, 3496, 3516, 3351, 3506, 3523, 3473, 3478, 3534, 3513, 3498, 3504, 3341, 3538]);
  assert.deepEqual(a.temps, [25.5, 26.3, 25.7, 25.6, 26.3, 27.0]);
  assert.equal(a.current, 0);
  assert.equal(a.voltage, 55.845);
  assert.equal(a.remainingAh, 76.32);
  assert.equal(a.fullAh, 100);
  assert.equal(a.cycles, 199);
  assert.equal(a.designAh, 100);
  assert.equal(a.soc, 76);
  const d = derive(a);
  assert.equal(d.cell_min, 3.341);
  assert.equal(d.cell_min_index, 15);
  assert.equal(d.cell_max, 3.549);
  assert.equal(d.cell_max_index, 2);
  assert.equal(d.cell_delta_mv, 208);
  assert.equal(d.cell_avg.toFixed(3), "3.490");
  assert.equal(d.soc_calc, 76.3);
});

test("decode42 tolerates a missing trailing SOC byte", () => {
  const info = parseFrame(R42).info.slice(0, -2);
  assert.equal(decode42(info).soc, null);
});

test("decode44 decodes the captured alarm frame", () => {
  const a = decode44(parseFrame(R44, { ver: "25", adr: "01" }).info);
  assert.equal(a.packNo, 1);
  assert.equal(a.cellAlarms.length, 16);
  assert.ok(a.cellAlarms.every((x) => x === 0));
  assert.equal(a.tempAlarms.length, 6);
  assert.ok(a.tempAlarms.every((x) => x === 0));
  assert.equal(a.statusRaw, "000000000006000000000000");
  assert.equal(a.alarm, false);
});

test("an unsupported command reply raises an RTN 04 error", () => {
  assert.throws(() => parseFrame(RUNSUPPORTED), /RTN 04/);
});

test("a frame with one altered INFO character fails the checksum", () => {
  const bad = R42.slice(0, 20) + (R42[20] === "0" ? "1" : "0") + R42.slice(21);
  assert.throws(() => parseFrame(bad), /CHKSUM/);
});

test("a frame with a wrong LENGTH fails the LCHKSUM/LENID check", () => {
  // Corrupt LENGTH, then fix CHKSUM so only the length check can catch it.
  const body = "25014600D07D" + R42.slice(13, -4);
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chk = ((~sum + 1) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  assert.throws(() => parseFrame(`~${body}${chk}`), /LCHKSUM|LENID/);
});

test("parseFrame rejects wrong VER/ADR echo", () => {
  assert.throws(() => parseFrame(R42, { ver: "20" }), /VER echo/);
  assert.throws(() => parseFrame(R42, { adr: "02" }), /ADR echo/);
});
