// One-shot, read-only hardware check: one 42 + one 44, printed decoded.
// Stop the service first (only one process can hold the port).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { BmsLink } = require("../bms_link");
const { decode42, decode44, derive } = require("../pace");

(async () => {
  if (!process.env.SERIAL_PORT) throw new Error("SERIAL_PORT is not set (see .env.example)");
  const link = new BmsLink({
    path: process.env.SERIAL_PORT,
    baud: parseInt(process.env.SERIAL_BAUD) || 9600,
    ver: process.env.BMS_VER || "25",
    adr: process.env.BMS_ADDR || "01"
  });
  await link.open();
  try {
    const a = decode42(await link.request("42"));
    const d = derive(a);
    console.log(`cells (${a.cellsMv.length}) mV:`, a.cellsMv.join(" "));
    console.log(`min ${d.cell_min} V (#${d.cell_min_index}), max ${d.cell_max} V (#${d.cell_max_index}), delta ${d.cell_delta_mv} mV`);
    console.log("temps C:", a.temps.join(" "));
    console.log(`pack ${a.voltage} V, ${a.current} A, remaining ${a.remainingAh}/${a.fullAh} Ah (design ${a.designAh}), cycles ${a.cycles}, SOC ${a.soc}% (calc ${d.soc_calc}%)`);
    const al = decode44(await link.request("44"));
    console.log(`alarm: ${al.alarm}, status bytes: ${al.statusRaw}`);
  } finally {
    await link.close();
  }
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
