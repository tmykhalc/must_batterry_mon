// Serial transport for the BMS: one request in flight at a time.
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { buildFrame, parseFrame } = require("./pace");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BmsLink {
  constructor({ path, baud = 9600, ver = "25", adr = "01", timeoutMs = 1500 }) {
    Object.assign(this, { path, baud, ver, adr, timeoutMs });
    this.port = null;
    this.pending = null;
    this.chain = Promise.resolve();
  }

  open() {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: this.baud, dataBits: 8, stopBits: 1, parity: "none", rtscts: false, autoOpen: false });
      const parser = port.pipe(new ReadlineParser({ delimiter: "\r" }));
      parser.on("data", (line) => {
        if (!this.pending) return; // stale or unsolicited data
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(line);
      });
      port.on("error", (e) => this._fail(e));
      port.on("close", () => this._fail(new Error("serial port closed")));
      port.open((err) => {
        if (err) return reject(err);
        this.port = port;
        resolve();
      });
    });
  }

  _fail(err) {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  async close() {
    const port = this.port;
    this.port = null;
    if (port && port.isOpen) await new Promise((r) => port.close(() => r()));
  }

  // cid2 must be "42" or "44": buildFrame enforces the allowlist.
  request(cid2) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (!this.port || !this.port.isOpen) return reject(new Error("serial port not open"));
        const frame = buildFrame(cid2, this.adr, { ver: this.ver, adr: this.adr });
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error(`timeout waiting for reply to ${cid2}`));
        }, this.timeoutMs);
        this.pending = {
          timer,
          resolve: (line) => {
            try {
              resolve(parseFrame(line, { ver: this.ver, adr: this.adr }).info);
            } catch (e) {
              reject(e);
            }
          },
          reject
        };
        this.port.flush(() => this.port.write(frame, (err) => err && this._fail(err)));
      });
    const result = this.chain.then(run, run);
    this.chain = result.then(() => sleep(100), () => sleep(100)); // small gap between requests
    return result;
  }
}

module.exports = { BmsLink };
