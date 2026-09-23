// POST /api/quote  ->  server-side freight rating engine (Vercel serverless function)
const RATE_PER_KG = { // INR per chargeable kg, by lane and mode
  domestic: { Air: 95, Road: 28, Ocean: 18 },
  gulf: { Air: 210, Road: null, Ocean: 55 },
  asia: { Air: 260, Road: null, Ocean: 62 },
  europe: { Air: 340, Road: null, Ocean: 78 },
  americas: { Air: 420, Road: null, Ocean: 92 }
};
const TRANSIT = { Air: 4, Road: 6, Ocean: 25 };
const BAND = { "2-8": 1.35, "15-25": 1.15, "-20": 1.6, "-70": 2.2 };
const PRIORITY = { Standard: 1, Express: 1.4, "AOG / Critical": 2.5 };
const MIN_CHARGE = 4500, HANDLING = 1800, FUEL = 0.12, GST = 0.18;

function quote({ lane, mode, temp_band, weight_kg, priority }) {
  const w = Number(weight_kg);
  if (!RATE_PER_KG[lane]) throw new Error("Unknown lane");
  if (!TRANSIT[mode]) throw new Error("Unknown mode");
  if (!BAND[temp_band]) throw new Error("Unknown temperature band");
  if (!PRIORITY[priority]) throw new Error("Unknown priority");
  if (!Number.isFinite(w) || w <= 0 || w > 20000) throw new Error("Weight must be between 1 and 20,000 kg");
  const rate = RATE_PER_KG[lane][mode];
  if (rate == null) throw new Error(mode + " is not available on this lane. Choose Air or Ocean.");

  const freight = Math.max(MIN_CHARGE, w * rate);
  const coldChain = freight * (BAND[temp_band] - 1) + (temp_band === "-70" ? 350 * Math.ceil(w / 25) : 0); // dry ice top-ups
  const priorityFee = (freight + coldChain) * (PRIORITY[priority] - 1);
  const fuel = (freight + coldChain + priorityFee) * FUEL;
  const subtotal = freight + coldChain + priorityFee + fuel + HANDLING;
  const gst = subtotal * GST;
  const days = priority === "AOG / Critical" ? 1 : priority === "Express" ? Math.max(1, Math.ceil(TRANSIT[mode] / 2)) : TRANSIT[mode];

  const r = (n) => Math.round(n);
  return {
    currency: "INR",
    transit_days: days,
    breakdown: [
      { label: "Base freight", amount: r(freight) },
      { label: "Cold-chain packaging and monitoring", amount: r(coldChain) },
      ...(priorityFee ? [{ label: priority + " handling", amount: r(priorityFee) }] : []),
      { label: "Fuel surcharge (12%)", amount: r(fuel) },
      { label: "Documentation and handling", amount: HANDLING },
      { label: "GST (18%)", amount: r(gst) }
    ],
    total: r(subtotal + gst)
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST" }); }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    return res.status(200).json(quote(body));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
module.exports.quote = quote;

