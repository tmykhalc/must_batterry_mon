// PACE BMS (Pylontech-style ASCII) protocol: pure functions, no I/O.
// Only the two read-only commands below may ever be built.

const ALLOWED_CID2 = new Set(["42", "44"]);

const RTN_TEXT = {
  "01": "VER error",
  "02": "CHKSUM error",
  "03": "LCHKSUM error",
  "04": "CID2 invalid",
  "05": "command format error",
  "06": "invalid data"
};

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

function lengthField(lenid) {
  const sum = (lenid & 0xf) + ((lenid >> 4) & 0xf) + ((lenid >> 8) & 0xf);
  const lchk = (~sum + 1) & 0xf;
  return hex4((lchk << 12) | lenid);
}

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += body.charCodeAt(i);
  return hex4((~sum + 1) & 0xffff);
}

// Returns the frame including the trailing "\r".
function buildFrame(cid2, info = "", { ver = "25", adr = "01" } = {}) {
  if (!ALLOWED_CID2.has(cid2)) throw new Error(`refusing to build non-read command CID2=${cid2}`);
  const body = `${ver}${adr}46${cid2}${lengthField(info.length)}${info}`;
  return `~${body}${checksum(body)}\r`;
}

function parseFrame(raw, { ver, adr } = {}) {
  const start = raw.indexOf("~");
  if (start < 0) throw new Error("no SOI (~) in frame");
  const s = raw.slice(start).replace(/\r$/, "");
  if (!/^~[0-9A-F]+$/.test(s)) throw new Error("frame contains non-hex characters");
  if (s.length < 17) throw new Error("frame too short");

  const body = s.slice(1, -4);
  if (checksum(body) !== s.slice(-4)) throw new Error("CHKSUM mismatch");

  const lengthHex = s.slice(9, 13);
  const lenid = parseInt(lengthHex, 16) & 0x0fff;
  if (lengthField(lenid) !== lengthHex) throw new Error("LCHKSUM mismatch");
  const info = s.slice(13, -4);
  if (info.length !== lenid) throw new Error(`LENID ${lenid} != INFO length ${info.length}`);

  const frame = { ver: s.slice(1, 3), adr: s.slice(3, 5), cid1: s.slice(5, 7), rtn: s.slice(7, 9), info };
  if (ver && frame.ver !== ver) throw new Error(`VER echo mismatch (${frame.ver})`);
  if (adr && frame.adr !== adr) throw new Error(`ADR echo mismatch (${frame.adr})`);
  if (frame.rtn !== "00") throw new Error(`BMS returned RTN ${frame.rtn} (${RTN_TEXT[frame.rtn] || "unknown"})`);
  return frame;
}

class Reader {
  constructor(hex) {
    this.hex = hex;
    this.i = 0;
  }
  left() {
    return this.hex.length - this.i;
  }
  b() {
    if (this.left() < 2) throw new Error("INFO truncated");
    const v = parseInt(this.hex.slice(this.i, this.i + 2), 16);
    this.i += 2;
    return v;
  }
  w() {
    if (this.left() < 4) throw new Error("INFO truncated");
    const v = parseInt(this.hex.slice(this.i, this.i + 4), 16);
    this.i += 4;
    return v;
  }
  rest() {
    return this.hex.slice(this.i);
  }
}

const signed16 = (v) => (v > 32767 ? v - 65536 : v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// Command 42: analog values. Trailing fields that are absent become null.
function decode42(info) {
  const r = new Reader(info);
  r.b(); // DATAFLAG
  const packNo = r.b();
  const m = r.b();
  const cellsMv = Array.from({ length: m }, () => r.w());
  const k = r.b();
  const temps = Array.from({ length: k }, () => round((r.w() - 2731) / 10, 1));
  const out = { packNo, cellsMv, temps, current: null, voltage: null, remainingAh: null, fullAh: null, cycles: null, designAh: null, soc: null };
  if (r.left() >= 4) out.current = signed16(r.w()) / 100;
  if (r.left() >= 4) out.voltage = r.w() / 1000;
  if (r.left() >= 4) out.remainingAh = r.w() / 100;
  if (r.left() >= 2) r.b(); // USER_DEF
  if (r.left() >= 4) out.fullAh = r.w() / 100;
  if (r.left() >= 4) out.cycles = r.w();
  if (r.left() >= 4) out.designAh = r.w() / 100;
  if (r.left() >= 2) out.soc = r.b();
  return out;
}

// Command 44: alarm info. The trailing status bytes are returned raw, not interpreted.
function decode44(info) {
  const r = new Reader(info);
  r.b(); // DATAFLAG
  const packNo = r.b();
  const m = r.b();
  const cellAlarms = Array.from({ length: m }, () => r.b());
  const k = r.b();
  const tempAlarms = Array.from({ length: k }, () => r.b());
  const statusRaw = r.rest();
  return { packNo, cellAlarms, tempAlarms, statusRaw, alarm: cellAlarms.some((a) => a !== 0) || tempAlarms.some((a) => a !== 0) };
}

function derive(a) {
  const cells = a.cellsMv;
  if (!cells.length) return {};
  const min = Math.min(...cells);
  const max = Math.max(...cells);
  const d = {
    cell_min: min / 1000,
    cell_max: max / 1000,
    cell_min_index: cells.indexOf(min) + 1,
    cell_max_index: cells.indexOf(max) + 1,
    cell_delta_mv: max - min,
    cell_avg: cells.reduce((s, v) => s + v, 0) / cells.length / 1000
  };
  if (a.voltage !== null && a.current !== null) d.power = a.voltage * a.current;
  if (a.remainingAh !== null && a.fullAh) d.soc_calc = round((a.remainingAh / a.fullAh) * 100, 1);
  return d;
}

module.exports = { ALLOWED_CID2, buildFrame, parseFrame, decode42, decode44, derive };
