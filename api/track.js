// GET /api/track?code=CL-XXXXXXXX  ->  public tracking lookup (Vercel serverless function)
// Calls the track_shipment() database function, which only returns non-sensitive fields.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://bqvkbqlnacjvjgulinsm.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_DFnklLmrIwRp6rn0oIh8IA_-4IJ55V7";

module.exports = async (req, res) => {
  const code = String((req.query && req.query.code) || "").trim().toUpperCase();
  if (!/^CL-[A-Z0-9]{4,12}$/.test(code)) return res.status(400).json({ error: "Invalid tracking code" });
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/track_shipment", {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!r.ok) return res.status(502).json({ error: "Tracking service unavailable" });
    const data = await r.json();
    if (!data) return res.status(404).json({ error: "Not found" });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: "Tracking service unavailable" });
  }
};

