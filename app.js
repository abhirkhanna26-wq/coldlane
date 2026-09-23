/* ColdLane front end: hash router, Supabase auth and data, dashboard. */
(function () {
  "use strict";

  const STATUSES = ["Booked", "Picked up", "In transit", "Customs", "Out for delivery", "Delivered", "Exception"];
  const BANDS = { "2-8": "2 to 8 °C", "15-25": "15 to 25 °C", "-20": "Frozen, -20 °C", "-70": "Deep frozen, -70 °C" };
  const BAND_LIMITS = { "2-8": [2, 8], "15-25": [15, 25], "-20": [-25, -15], "-70": [-80, -60] };
  const LANES = { domestic: "Within India", gulf: "India to Middle East", asia: "India to Asia-Pacific", europe: "India to Europe / UK", americas: "India to Americas" };

  const cfg = window.COLDLANE_CONFIG || {};
  const LIVE = !!(cfg.SUPABASE_URL && !/YOUR_/.test(cfg.SUPABASE_URL) && window.supabase);
  const sb = LIVE ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–";
  const fmtTime = (d) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3200);
  }

  function statusPill(s) {
    const cls = s === "Delivered" ? "ok" : s === "Exception" ? "bad" : s === "Customs" ? "warn" : s === "Booked" ? "grey" : "";
    return `<span class="pill ${cls}">${esc(s)}</span>`;
  }

  /* ---------------- Data layer ---------------- */
  // Live mode talks to Supabase. Demo mode (no config) mirrors the same rules in memory so the UI can be tried locally.
  const demo = { user: null, shipments: [], events: [] };
  function demoCode() { return "CL-" + Math.random().toString(16).slice(2, 10).toUpperCase().padEnd(8, "0"); }

  const api = {
    async session() {
      if (!LIVE) return demo.user;
      const { data } = await sb.auth.getSession();
      return data.session ? data.session.user : null;
    },
    async signUp(email, password, full_name, company) {
      if (!LIVE) { demo.user = { id: "demo", email, user_metadata: { full_name, company } }; return { user: demo.user, needsConfirm: false }; }
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name, company }, emailRedirectTo: location.origin + "/#/app" } });
      if (error) throw error;
      return { user: data.user, needsConfirm: !data.session };
    },
    async signIn(email, password) {
      if (!LIVE) { demo.user = demo.user && demo.user.email === email ? demo.user : { id: "demo", email, user_metadata: { full_name: email.split("@")[0] } }; return demo.user; }
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    },
    async signOut() { if (!LIVE) { demo.user = null; return; } await sb.auth.signOut(); },
    async resetPassword(email) {
      if (!LIVE) return;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/#/login" });
      if (error) throw error;
    },
    async listShipments() {
      if (!LIVE) return [...demo.shipments].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const { data, error } = await sb.from("shipments").select("*").order("created_at", { ascending: false });
      if (error) throw error; return data;
    },
    async getShipment(id) {
      if (!LIVE) {
        const s = demo.shipments.find((x) => x.id === id);
        return s ? { ...s, events: demo.events.filter((e) => e.shipment_id === id) } : null;
      }
      const { data, error } = await sb.from("shipments").select("*, events:shipment_events(*)").eq("id", id).maybeSingle();
      if (error) throw error;
      if (data) data.events.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return data;
    },
    async createShipment(p) {
      if (!LIVE) {
        const [mn, mx] = BAND_LIMITS[p.temp_band];
        const days = p.priority === "AOG / Critical" ? 1 : p.priority === "Express" ? 2 : { Air: 4, Road: 6, Ocean: 25 }[p.mode];
        const s = { ...p, id: crypto.randomUUID(), tracking_code: demoCode(), temp_min: mn, temp_max: mx, status: "Booked", excursions: 0, last_temp: null,
          eta: new Date(Date.now() + days * 864e5).toISOString().slice(0, 10), created_at: new Date().toISOString() };
        demo.shipments.push(s);
        demo.events.push({ id: crypto.randomUUID(), shipment_id: s.id, status: "Booked", location: s.origin, temperature: null, is_excursion: false,
          note: "Shipment booked. Tracking code " + s.tracking_code + ".", created_at: new Date().toISOString() });
        return s;
      }
      const { data, error } = await sb.from("shipments").insert(p).select().single();
      if (error) throw error; return data;
    },
    async addEvent(shipment, e) {
      if (!LIVE) {
        if (shipment.status === "Delivered" && e.status !== "Delivered") throw new Error("Shipment " + shipment.tracking_code + " is already delivered");
        const t = e.temperature;
        const exc = t != null && (t < shipment.temp_min || t > shipment.temp_max);
        demo.events.push({ ...e, id: crypto.randomUUID(), shipment_id: shipment.id, is_excursion: exc, created_at: new Date().toISOString() });
        const s = demo.shipments.find((x) => x.id === shipment.id);
        s.status = exc && e.status !== "Delivered" ? "Exception" : e.status;
        if (t != null) s.last_temp = t;
        if (exc) s.excursions++;
        return;
      }
      const { error } = await sb.from("shipment_events").insert({ shipment_id: shipment.id, ...e });
      if (error) throw error;
    },
    async deleteShipment(id) {
      if (!LIVE) { demo.shipments = demo.shipments.filter((s) => s.id !== id); demo.events = demo.events.filter((e) => e.shipment_id !== id); return; }
      const { error } = await sb.from("shipments").delete().eq("id", id);
      if (error) throw error;
    },
    async track(code) {
      // Backend function: /api/track proxies the public tracking lookup.
      if (!LIVE) {
        const s = demo.shipments.find((x) => x.tracking_code === code.trim().toUpperCase());
        return s ? { ...s, events: demo.events.filter((e) => e.shipment_id === s.id) } : null;
      }
      const r = await fetch("/api/track?code=" + encodeURIComponent(code));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("Tracking service unavailable");
      return r.json();
    },
    async quote(q) {
      // Backend function: /api/quote prices the shipment server side.
      const r = await fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Quote service unavailable");
      return j;
    }
  };

  let user = null;

  /* ---------------- Nav ---------------- */
  function renderNav() {
    const n = $("#navLinks");
    if (user) {
      const name = (user.user_metadata && user.user_metadata.full_name) || user.email;
      n.innerHTML = `<a class="link hide-sm" href="#/track">Track</a><a class="link" href="#/app">Dashboard</a>
        <span class="nav-user hide-sm">${esc(name)}</span><button class="btn btn-ghost btn-sm" id="logout">Sign out</button>`;
      $("#logout").onclick = async () => { await api.signOut(); user = null; toast("Signed out"); location.hash = "#/"; };
    } else {
      n.innerHTML = `<a class="link hide-sm" href="#/" data-scroll="features">Features</a><a class="link hide-sm" href="#/" data-scroll="quote">Get a quote</a>
        <a class="link hide-sm" href="#/track">Track</a><a class="link" href="#/login">Log in</a><a class="btn btn-primary btn-sm" href="#/signup">Start free</a>`;
    }
    n.querySelectorAll("[data-scroll]").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault(); const id = a.dataset.scroll;
      if (!/^#\/?$/.test(location.hash) && location.hash !== "") { location.hash = "#/"; setTimeout(() => scrollToId(id), 60); } else scrollToId(id);
    }));
  }
  function scrollToId(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth" }); }

  /* ---------------- Views ---------------- */
  const icons = {
    thermo: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0Z"/></svg>',
    map: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    bell: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/></svg>',
    doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
    plane: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2l-1.3 1.3L10 11l-3 3H4l-1 1 3 2 2 3 1-1v-3l3-3 3.5 6.5Z"/></svg>',
    lock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
  };

  function laneOptions(sel) { return Object.entries(LANES).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v}</option>`).join(""); }
  function bandOptions(sel) { return Object.entries(BANDS).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v}</option>`).join(""); }
  function opt(list, sel) { return list.map((v) => `<option ${v === sel ? "selected" : ""}>${v}</option>`).join(""); }

  function viewHome() {
    view.innerHTML = `
    <section class="hero">
      <div class="wrap hero-grid">
        <div>
          <span class="eyebrow">Cold-chain freight platform</span>
          <h1>Every vial, every degree, <em>always visible.</em></h1>
          <p class="lead">ColdLane books, tracks and monitors temperature-controlled freight for pharma, life sciences and aircraft-on-ground parts. Catch an excursion while it is still fixable, not after the audit.</p>
          <div class="hero-cta">
            <a class="btn btn-primary btn-lg" href="#/signup">Create free account</a>
            <a class="btn btn-ghost btn-lg" href="#/" id="heroQuote">Get an instant quote</a>
          </div>
          <div class="hero-stats">
            <div><b>4</b><span>temperature bands</span></div>
            <div><b>&lt; 1 min</b><span>to book a shipment</span></div>
            <div><b>24×7</b><span>excursion alerts</span></div>
          </div>
        </div>
        <div class="track-card">
          <h3>Track a shipment</h3>
          <p>Enter a ColdLane tracking code, for example CL-3F9A21BC. No login needed.</p>
          <form class="track-row" id="heroTrack">
            <input name="code" placeholder="CL-XXXXXXXX" aria-label="Tracking code" required />
            <button class="btn btn-primary">Track</button>
          </form>
          <div class="mini-ship" aria-hidden="true">
            <div class="row"><span class="code">CL-3F9A21BC</span>${statusPill("In transit")}</div>
            <div class="row" style="margin-top:10px"><strong>Mumbai</strong><span class="muted">→</span><strong>Frankfurt</strong></div>
            <svg viewBox="0 0 300 70" class="chart" style="margin-top:10px">
              <rect x="0" y="16" width="300" height="34" fill="#e3f7f1"/>
              <polyline fill="none" stroke="#1590e0" stroke-width="2.5" points="0,40 40,36 80,38 120,30 160,33 200,28 240,34 300,31"/>
            </svg>
            <div class="row small muted"><span>Last reading 4.6 °C</span><span>Band 2 to 8 °C</span></div>
          </div>
        </div>
      </div>
    </section>

    <section class="block" id="features">
      <div class="wrap">
        <div class="section-head"><h2>Built for freight that cannot get warm</h2><p class="muted">One workspace for the shipper, the forwarder and the QA team, instead of email threads and data-logger PDFs.</p></div>
        <div class="features">
          <div class="card feature"><div class="ic">${icons.thermo}</div><h3>Automatic excursion detection</h3><p>Each shipment carries its band limits. Log a reading outside them and the shipment flips to Exception instantly.</p></div>
          <div class="card feature"><div class="ic">${icons.map}</div><h3>Milestone timeline</h3><p>Booked, picked up, in transit, customs, delivered. Every update is time-stamped with location and temperature.</p></div>
          <div class="card feature"><div class="ic">${icons.bell}</div><h3>Exception-first dashboard</h3><p>See at a glance which lanes are at risk, how many excursions you have had and what is due today.</p></div>
          <div class="card feature"><div class="ic">${icons.plane}</div><h3>AOG and critical priority</h3><p>Next-flight-out handling for aircraft-on-ground parts and critical medicines, with ETAs set automatically.</p></div>
          <div class="card feature"><div class="ic">${icons.doc}</div><h3>Shareable tracking link</h3><p>Send customers a public tracking code. They see status and temperature history, never your internal data.</p></div>
          <div class="card feature"><div class="ic">${icons.lock}</div><h3>Private by design</h3><p>Secure login, and database-level row security so each account only ever sees its own shipments.</p></div>
        </div>
      </div>
    </section>

    <section class="block" style="background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
      <div class="wrap">
        <div class="section-head"><h2>How it works</h2></div>
        <div class="steps">
          <div class="card step"><h3>Quote</h3><p>Pick lane, mode, temperature band and weight. Get an all-in price in seconds.</p></div>
          <div class="card step"><h3>Book</h3><p>Create the shipment. ColdLane issues a tracking code and sets the ETA and band limits.</p></div>
          <div class="card step"><h3>Monitor</h3><p>Log milestones and temperature readings. Excursions raise an exception immediately.</p></div>
          <div class="card step"><h3>Deliver</h3><p>Close the shipment with a full, time-stamped chain-of-custody record.</p></div>
        </div>
      </div>
    </section>
    <section class="block" id="quote">
      <div class="wrap">
        <div class="section-head"><h2>Instant quote</h2><p class="muted">Priced live by our rating engine. Indicative rates in Indian rupees, including fuel surcharge and GST.</p></div>
        <div class="quote-wrap">
          <form class="card pad" id="quoteForm">
            <div class="field"><label for="q_lane">Lane</label><select id="q_lane" name="lane">${laneOptions("europe")}</select></div>
            <div class="grid-2">
              <div class="field"><label for="q_mode">Mode</label><select id="q_mode" name="mode">${opt(["Air", "Road", "Ocean"], "Air")}</select></div>
              <div class="field"><label for="q_band">Temperature band</label><select id="q_band" name="temp_band">${bandOptions("2-8")}</select></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="q_weight">Weight (kg)</label><input id="q_weight" name="weight_kg" type="number" min="1" max="20000" value="120" required /></div>
              <div class="field"><label for="q_pri">Priority</label><select id="q_pri" name="priority">${opt(["Standard", "Express", "AOG / Critical"], "Standard")}</select></div>
            </div>
            <div class="error" id="quoteErr"></div>
            <button class="btn btn-dark" style="width:100%">Calculate price</button>
          </form>
          <div class="quote-result" id="quoteResult"><p style="color:#a9bccf;margin:0">Your price breakdown will appear here.</p></div>
        </div>
      </div>
    </section>

    <section class="block" style="padding-top:0">
      <div class="wrap">
        <div class="section-head"><h2>Simple plans</h2><p class="muted">Freight is billed per shipment. The platform fee covers users, tracking and alerts.</p></div>
        <div class="pricing">
          <div class="card plan"><h3>Starter</h3><div class="price">Free</div><div class="muted small">For trying ColdLane</div>
            <ul><li>Up to 20 shipments a month</li><li>Public tracking links</li><li>Excursion detection</li></ul><a class="btn btn-ghost" href="#/signup">Start free</a></div>
          <div class="card plan featured"><h3>Growth</h3><div class="price">₹4,999<span class="small muted"> / month</span></div><div class="muted small">For regular shippers</div>
            <ul><li>Unlimited shipments</li><li>Up to 10 team members</li><li>Priority AOG desk</li><li>Monthly lane report</li></ul><a class="btn btn-primary" href="#/signup">Choose Growth</a></div>
          <div class="card plan"><h3>Enterprise</h3><div class="price">Custom</div><div class="muted small">For manufacturers and airlines</div>
            <ul><li>Dedicated account team</li><li>GDP audit support</li><li>Data-logger integrations</li><li>SLA-backed response</li></ul><a class="btn btn-ghost" href="#/signup">Talk to us</a></div>
        </div>
      </div>
    </section>

    <section class="block faq" style="padding-top:0">
      <div class="wrap" style="max-width:820px">
        <div class="section-head"><h2>Questions</h2></div>
        <details><summary>What counts as a temperature excursion?</summary><p>Any reading outside the shipment's band: 2 to 8 °C, 15 to 25 °C, -25 to -15 °C for frozen, or -80 to -60 °C for deep frozen. The shipment is flagged as an exception automatically.</p></details>
        <details><summary>Can my customer track without an account?</summary><p>Yes. Share the tracking code. The public page shows status, route, ETA and the temperature history, and nothing else.</p></details>
        <details><summary>Is my data private?</summary><p>Every table is protected by row level security in the database, so an account can only read and change its own shipments.</p></details>
        <details><summary>Do you handle AOG parts?</summary><p>Yes. Choose the AOG / Critical priority for next-flight-out handling with a one-day ETA.</p></details>
      </div>
    </section>

    <section class="block" style="padding-top:0">
      <div class="wrap"><div class="cta-band"><h2>Ship your next consignment on ColdLane.</h2><a class="btn btn-primary btn-lg" href="#/signup">Create free account</a></div></div>
    </section>`;

    $("#heroQuote").onclick = (e) => { e.preventDefault(); scrollToId("quote"); };
    $("#heroTrack").onsubmit = (e) => { e.preventDefault(); location.hash = "#/track/" + encodeURIComponent(e.target.code.value.trim().toUpperCase()); };
    $("#quoteForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target)); f.weight_kg = Number(f.weight_kg);
      const btn = e.target.querySelector("button"); btn.disabled = true; $("#quoteErr").textContent = "";
      try {
        const q = await api.quote(f);
        $("#quoteResult").innerHTML = `
          <div class="small" style="color:#a9bccf">Estimated total</div>
          <div class="total" id="quoteTotal">${inr(q.total)}</div>
          <div style="color:#a9bccf" class="small">${esc(LANES[f.lane])} · ${esc(f.mode)} · ${esc(BANDS[f.temp_band])} · transit about ${q.transit_days} day${q.transit_days > 1 ? "s" : ""}</div>
          <table>${q.breakdown.map((b) => `<tr><td>${esc(b.label)}</td><td>${inr(b.amount)}</td></tr>`).join("")}</table>
          <a class="btn btn-primary" style="margin-top:18px;width:100%" href="#/${user ? "app" : "signup"}">${user ? "Book it from your dashboard" : "Create an account to book"}</a>`;
      } catch (err) { $("#quoteErr").textContent = err.message; }
      btn.disabled = false;
    };
  }
  function viewAuth(mode) {
    const signup = mode === "signup";
    view.innerHTML = `
    <div class="auth"><div class="card pad">
      <h1>${signup ? "Create your account" : "Welcome back"}</h1>
      <p class="muted">${signup ? "Start tracking cold-chain shipments in under a minute." : "Log in to your ColdLane dashboard."}</p>
      <form id="authForm" novalidate>
        ${signup ? `<div class="grid-2"><div class="field"><label for="a_name">Full name</label><input id="a_name" name="name" required autocomplete="name" /></div>
        <div class="field"><label for="a_co">Company</label><input id="a_co" name="company" autocomplete="organization" /></div></div>` : ""}
        <div class="field"><label for="a_email">Work email</label><input id="a_email" name="email" type="email" required autocomplete="email" /></div>
        <div class="field"><label for="a_pw">Password</label><input id="a_pw" name="password" type="password" minlength="6" required autocomplete="${signup ? "new-password" : "current-password"}" /></div>
        <div class="error" id="authErr"></div>
        <button class="btn btn-primary" style="width:100%">${signup ? "Create account" : "Log in"}</button>
      </form>
      ${signup ? "" : `<div class="switch"><a href="#" id="forgot">Forgot password?</a></div>`}
      <div class="switch">${signup ? `Already have an account? <a href="#/login">Log in</a>` : `New to ColdLane? <a href="#/signup">Create an account</a>`}</div>
    </div></div>`;

    $("#authForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const err = $("#authErr"); err.textContent = "";
      if (signup && !f.name.trim()) return (err.textContent = "Please enter your name.");
      if (!/^\S+@\S+\.\S+$/.test(f.email)) return (err.textContent = "Please enter a valid email.");
      if ((f.password || "").length < 6) return (err.textContent = "Password must be at least 6 characters.");
      const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Please wait…";
      try {
        if (signup) {
          const r = await api.signUp(f.email.trim(), f.password, f.name.trim(), (f.company || "").trim());
          if (r.needsConfirm) {
            view.innerHTML = `<div class="auth"><div class="card pad"><h1>Check your inbox</h1><p class="muted">We sent a confirmation link to <strong>${esc(f.email)}</strong>. Click it to activate your account, then log in.</p><a class="btn btn-primary" href="#/login">Go to log in</a></div></div>`;
            return;
          }
          user = r.user; toast("Account created. Welcome to ColdLane!");
        } else {
          user = await api.signIn(f.email.trim(), f.password); toast("Logged in");
        }
        location.hash = "#/app";
      } catch (ex) {
        err.textContent = ex.message || "Something went wrong."; btn.disabled = false; btn.textContent = signup ? "Create account" : "Log in";
      }
    };
    const fg = $("#forgot");
    if (fg) fg.onclick = async (e) => {
      e.preventDefault(); const email = $("#a_email").value.trim();
      if (!email) return ($("#authErr").textContent = "Enter your email above first.");
      try { await api.resetPassword(email); toast("Password reset email sent"); } catch (ex) { $("#authErr").textContent = ex.message; }
    };
  }

  async function viewDashboard() {
    view.innerHTML = `<div class="dash"><div class="wrap"><p class="muted">Loading shipments…</p></div></div>`;
    let rows;
    try { rows = await api.listShipments(); } catch (ex) { view.innerHTML = `<div class="dash"><div class="wrap"><p class="error">${esc(ex.message)}</p></div></div>`; return; }
    const name = (user.user_metadata && user.user_metadata.full_name) || user.email;
    const active = rows.filter((r) => r.status !== "Delivered").length;
    const moving = rows.filter((r) => ["Picked up", "In transit", "Customs", "Out for delivery"].includes(r.status)).length;
    const exc = rows.filter((r) => r.status === "Exception").length;
    const deliv = rows.filter((r) => r.status === "Delivered").length;

    view.innerHTML = `
    <div class="dash"><div class="wrap">
      <div class="dash-head">
        <div><div class="muted small">Dashboard</div><h1>Hello, ${esc(String(name).split(" ")[0])}</h1></div>
        <button class="btn btn-primary" id="newBtn">+ New shipment</button>
      </div>
      <div class="kpis">
        <div class="card kpi"><div class="v" id="kActive">${active}</div><div class="l">Active shipments</div></div>
        <div class="card kpi"><div class="v">${moving}</div><div class="l">On the move</div></div>
        <div class="card kpi ${exc ? "bad" : ""}"><div class="v" id="kExc">${exc}</div><div class="l">Exceptions</div></div>
        <div class="card kpi"><div class="v">${deliv}</div><div class="l">Delivered</div></div>
      </div>
      <div class="card">
        <div class="toolbar">
          <input id="search" placeholder="Search code, product or city" aria-label="Search shipments" />
          <select id="filter" aria-label="Filter by status"><option value="">All statuses</option>${opt(STATUSES, "")}</select>
        </div>
        <div class="table-wrap"><table class="list"><thead><tr><th>Tracking code</th><th>Product</th><th>Route</th><th>Band</th><th>Status</th><th>ETA</th></tr></thead><tbody id="rows"></tbody></table></div>
      </div>
    </div></div>`;

    const draw = () => {
      const q = $("#search").value.toLowerCase(), st = $("#filter").value;
      const list = rows.filter((r) => (!st || r.status === st) && (!q || [r.tracking_code, r.product, r.origin, r.destination].join(" ").toLowerCase().includes(q)));
      $("#rows").innerHTML = list.length ? list.map((r) => `
        <tr data-id="${r.id}"><td class="code">${esc(r.tracking_code)}</td><td>${esc(r.product)}</td>
        <td>${esc(r.origin)} → ${esc(r.destination)}</td><td>${esc(BANDS[r.temp_band] || r.temp_band)}</td>
        <td>${statusPill(r.status)}${r.excursions ? ` <span class="small muted">${r.excursions} exc.</span>` : ""}</td><td>${fmtDate(r.eta)}</td></tr>`).join("")
        : `<tr><td colspan="6" class="empty">${rows.length ? "No shipments match your search." : "No shipments yet. Click <strong>+ New shipment</strong> to book your first one."}</td></tr>`;
      $("#rows").querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => (location.hash = "#/app/s/" + tr.dataset.id)));
    };
    $("#search").oninput = draw; $("#filter").onchange = draw; draw();
    $("#newBtn").onclick = openNewShipment;
  }
  function openNewShipment() {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
    <div class="card pad modal" role="dialog" aria-modal="true" aria-labelledby="nsTitle">
      <div class="modal-head"><h2 id="nsTitle">New shipment</h2><button class="x" aria-label="Close">×</button></div>
      <form id="nsForm">
        <div class="field"><label for="n_prod">Product</label><input id="n_prod" name="product" placeholder="e.g. Insulin vials, 40 cartons" required /></div>
        <div class="grid-2">
          <div class="field"><label for="n_from">Origin</label><input id="n_from" name="origin" placeholder="Mumbai" required /></div>
          <div class="field"><label for="n_to">Destination</label><input id="n_to" name="destination" placeholder="Frankfurt" required /></div>
        </div>
        <div class="grid-3">
          <div class="field"><label for="n_lane">Lane</label><select id="n_lane" name="lane">${laneOptions("europe")}</select></div>
          <div class="field"><label for="n_mode">Mode</label><select id="n_mode" name="mode">${opt(["Air", "Road", "Ocean"], "Air")}</select></div>
          <div class="field"><label for="n_band">Temperature</label><select id="n_band" name="temp_band">${bandOptions("2-8")}</select></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="n_w">Weight (kg)</label><input id="n_w" name="weight_kg" type="number" min="1" value="100" required /></div>
          <div class="field"><label for="n_pri">Priority</label><select id="n_pri" name="priority">${opt(["Standard", "Express", "AOG / Critical"], "Standard")}</select></div>
        </div>
        <div class="quote-inline" id="nsQuote"><span class="muted">Calculating price…</span></div>
        <div class="error" id="nsErr"></div>
        <button class="btn btn-primary" style="width:100%">Book shipment</button>
      </form>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector(".x").onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };
    const form = $("#nsForm", back);
    $("#n_prod", back).focus();

    const reprice = async () => {
      const f = Object.fromEntries(new FormData(form)); f.weight_kg = Number(f.weight_kg) || 0;
      if (f.weight_kg <= 0) { $("#nsQuote", back).innerHTML = `<span class="muted">Enter a weight to see a price.</span>`; return; }
      try { const q = await api.quote(f); $("#nsQuote", back).innerHTML = `<span>Estimated price <strong>${inr(q.total)}</strong></span><span class="muted">Transit about ${q.transit_days} day${q.transit_days > 1 ? "s" : ""}</span>`; }
      catch { $("#nsQuote", back).innerHTML = `<span class="muted">Price unavailable right now.</span>`; }
    };
    form.addEventListener("change", reprice); reprice();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const btn = form.querySelector("button[class*=primary]"); btn.disabled = true;
      try {
        const s = await api.createShipment({ product: f.product.trim(), origin: f.origin.trim(), destination: f.destination.trim(), mode: f.mode, temp_band: f.temp_band, weight_kg: Number(f.weight_kg), priority: f.priority });
        close(); toast("Booked " + s.tracking_code); location.hash = "#/app/s/" + s.id;
      } catch (ex) { $("#nsErr", back).textContent = ex.message; btn.disabled = false; }
    };
    document.addEventListener("keydown", function onKey(ev) { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
  }

  function tempChart(s, events) {
    const pts = events.filter((e) => e.temperature != null);
    const [mn, mx] = [Number(s.temp_min), Number(s.temp_max)];
    if (!pts.length) return `<p class="muted small">No temperature readings yet. Add one with a status update.</p>`;
    const temps = pts.map((p) => Number(p.temperature));
    const lo = Math.min(mn, ...temps) - 2, hi = Math.max(mx, ...temps) + 2;
    const W = 520, H = 180, P = 28;
    const y = (t) => P + (hi - t) / (hi - lo) * (H - 2 * P);
    const x = (i) => pts.length === 1 ? W / 2 : P + i * (W - 2 * P) / (pts.length - 1);
    const line = pts.map((p, i) => `${x(i)},${y(Number(p.temperature))}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Temperature readings against the allowed band">
      <rect x="${P}" y="${y(mx)}" width="${W - 2 * P}" height="${y(mn) - y(mx)}" fill="#e3f7f1"/>
      <text x="${W - P}" y="${y(mx) - 5}" text-anchor="end" font-size="11" fill="#12a37f">${mx} °C</text>
      <text x="${W - P}" y="${y(mn) + 14}" text-anchor="end" font-size="11" fill="#12a37f">${mn} °C</text>
      <polyline fill="none" stroke="#1590e0" stroke-width="2.5" points="${line}"/>
      ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(Number(p.temperature))}" r="5" fill="${p.is_excursion ? "#d64545" : "#1590e0"}" stroke="#fff" stroke-width="2"><title>${esc(p.temperature)} °C · ${esc(p.location || "")}</title></circle>`).join("")}
    </svg><div class="small muted">Green band is the allowed range. Red points are excursions.</div>`;
  }

  function timeline(events) {
    return `<ul class="timeline">${[...events].reverse().map((e) => `
      <li><span class="dot ${e.is_excursion || e.status === "Exception" ? "bad" : e.status === "Delivered" ? "ok" : ""}"></span>
        <div class="t">${esc(e.status)}${e.is_excursion ? ' <span class="pill bad">Excursion</span>' : ""}</div>
        <div class="m">${fmtTime(e.created_at)}${e.location ? " · " + esc(e.location) : ""}${e.temperature != null ? " · " + esc(e.temperature) + " °C" : ""}</div>
        ${e.note ? `<div class="small">${esc(e.note)}</div>` : ""}</li>`).join("")}</ul>`;
  }
  function shipmentHeader(s) {
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="code" style="font-size:1rem">${esc(s.tracking_code)}</span>${statusPill(s.status)}
      </div>
      <div class="route"><span>${esc(s.origin)}</span><span class="arrow">→</span><span>${esc(s.destination)}</span></div>
      <div class="facts">
        <div><div class="k">Product</div><div class="v">${esc(s.product)}</div></div>
        <div><div class="k">Mode</div><div class="v">${esc(s.mode)}</div></div>
        <div><div class="k">Band</div><div class="v">${esc(BANDS[s.temp_band] || s.temp_band)}</div></div>
        <div><div class="k">ETA</div><div class="v">${fmtDate(s.eta)}</div></div>
        <div><div class="k">Last reading</div><div class="v">${s.last_temp != null ? esc(s.last_temp) + " °C" : "–"}</div></div>
        <div><div class="k">Excursions</div><div class="v" style="color:${s.excursions ? "var(--bad)" : "inherit"}">${esc(s.excursions)}</div></div>
      </div>`;
  }

  async function viewShipment(id) {
    view.innerHTML = `<div class="dash"><div class="wrap"><p class="muted">Loading…</p></div></div>`;
    let s;
    try { s = await api.getShipment(id); } catch (ex) { view.innerHTML = `<div class="dash"><div class="wrap"><p class="error">${esc(ex.message)}</p></div></div>`; return; }
    if (!s) { view.innerHTML = `<div class="dash"><div class="wrap"><a class="back" href="#/app">← Back to dashboard</a><p>Shipment not found.</p></div></div>`; return; }
    if (s.temp_min == null) [s.temp_min, s.temp_max] = BAND_LIMITS[s.temp_band];
    const done = s.status === "Delivered";
    const nextIdx = Math.min(STATUSES.indexOf(s.status === "Exception" ? "In transit" : s.status) + 1, 5);

    view.innerHTML = `
    <div class="dash"><div class="wrap">
      <a class="back" href="#/app">← Back to dashboard</a>
      <div class="detail-grid">
        <div>
          <div class="card pad" style="margin-bottom:20px">${shipmentHeader(s)}</div>
          <div class="card pad" style="margin-bottom:20px"><h3 class="section-title">Temperature</h3>${tempChart(s, s.events)}</div>
          <div class="card pad"><h3 class="section-title">Timeline</h3>${timeline(s.events)}</div>
        </div>
        <div>
          <div class="card pad" style="margin-bottom:20px">
            <h3 class="section-title">Log an update</h3>
            ${done ? `<p class="muted">This shipment has been delivered and is closed.</p>` : `
            <form id="evForm">
              <div class="field"><label for="e_st">Status</label><select id="e_st" name="status">${STATUSES.filter((x) => x !== "Booked").map((x, i) => `<option ${i + 1 === nextIdx ? "selected" : ""}>${x}</option>`).join("")}</select></div>
              <div class="grid-2">
                <div class="field"><label for="e_loc">Location</label><input id="e_loc" name="location" placeholder="e.g. Dubai hub" /></div>
                <div class="field"><label for="e_t">Temperature (°C)</label><input id="e_t" name="temperature" type="number" step="0.1" placeholder="e.g. 5.2" /></div>
              </div>
              <div class="field"><label for="e_note">Note</label><textarea id="e_note" name="note" rows="2" placeholder="Optional"></textarea></div>
              <div class="error" id="evErr"></div>
              <button class="btn btn-primary" style="width:100%">Save update</button>
            </form>`}
          </div>
          <div class="card pad" style="margin-bottom:20px">
            <h3 class="section-title">Share with your customer</h3>
            <p class="small muted">Anyone with this link can see status and temperature history without logging in.</p>
            <div class="track-row"><input readonly id="shareUrl" value="${esc(location.origin + location.pathname + "#/track/" + s.tracking_code)}" /><button class="btn btn-ghost" id="copyBtn">Copy</button></div>
          </div>
          <button class="btn btn-danger" id="delBtn" style="width:100%">Delete shipment</button>
        </div>
      </div>
    </div></div>`;

    const ev = $("#evForm");
    if (ev) ev.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(ev));
      const payload = { status: f.status, location: f.location.trim() || null, note: f.note.trim() || null, temperature: f.temperature === "" ? null : Number(f.temperature) };
      const btn = ev.querySelector("button"); btn.disabled = true;
      try {
        await api.addEvent(s, payload);
        const exc = payload.temperature != null && (payload.temperature < s.temp_min || payload.temperature > s.temp_max);
        toast(exc ? "Excursion recorded. Shipment flagged as Exception." : "Update saved");
        viewShipment(id);
      } catch (ex) { $("#evErr").textContent = ex.message; btn.disabled = false; }
    };
    $("#copyBtn").onclick = async () => { try { await navigator.clipboard.writeText($("#shareUrl").value); toast("Link copied"); } catch { $("#shareUrl").select(); } };
    $("#delBtn").onclick = async (ev) => {
      const b = ev.currentTarget;
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to delete " + s.tracking_code; setTimeout(() => { delete b.dataset.armed; b.textContent = "Delete shipment"; }, 4000); return; }
      try { await api.deleteShipment(s.id); toast("Shipment deleted"); location.hash = "#/app"; } catch (ex) { toast(ex.message); }
    };
  }
  async function viewTrack(code) {
    view.innerHTML = `
    <div class="track-page"><div class="wrap" style="max-width:860px">
      <h1>Track a shipment</h1>
      <form class="track-row card pad" id="trackForm" style="margin-bottom:22px">
        <input name="code" placeholder="CL-XXXXXXXX" value="${esc(code || "")}" aria-label="Tracking code" required />
        <button class="btn btn-primary">Track</button>
      </form>
      <div id="trackOut"></div>
    </div></div>`;
    $("#trackForm").onsubmit = (e) => { e.preventDefault(); location.hash = "#/track/" + encodeURIComponent(e.target.code.value.trim().toUpperCase()); };
    if (!code) { $("#trackOut").innerHTML = `<p class="muted">Enter the tracking code your shipper gave you.</p>`; return; }
    $("#trackOut").innerHTML = `<p class="muted">Looking up ${esc(code)}…</p>`;
    try {
      const s = await api.track(code);
      if (!s) { $("#trackOut").innerHTML = `<div class="card pad"><strong>No shipment found for ${esc(code)}.</strong><p class="muted" style="margin:6px 0 0">Check the code and try again.</p></div>`; return; }
      [s.temp_min, s.temp_max] = BAND_LIMITS[s.temp_band];
      $("#trackOut").innerHTML = `
        <div class="card pad" style="margin-bottom:20px">${shipmentHeader(s)}</div>
        <div class="card pad" style="margin-bottom:20px"><h3 class="section-title">Temperature</h3>${tempChart(s, s.events)}</div>
        <div class="card pad"><h3 class="section-title">Timeline</h3>${timeline(s.events)}</div>`;
    } catch (ex) { $("#trackOut").innerHTML = `<p class="error">${esc(ex.message)}</p>`; }
  }

  /* ---------------- Router ---------------- */
  async function route() {
    const h = location.hash.replace(/^#/, "") || "/";
    // Supabase email-confirmation links land with tokens in the hash; let the client consume them.
    if (/access_token=|error_description=/.test(h)) { setTimeout(() => (location.hash = "#/app"), 400); return; }
    const parts = h.split("/").filter(Boolean);
    renderNav();
    window.scrollTo(0, 0);
    if (parts[0] === "login" || parts[0] === "signup") { if (user) return (location.hash = "#/app"); return viewAuth(parts[0]); }
    if (parts[0] === "track") return viewTrack(parts[1] ? decodeURIComponent(parts[1]) : "");
    if (parts[0] === "app") {
      if (!user) { toast("Please log in first"); return (location.hash = "#/login"); }
      if (parts[1] === "s" && parts[2]) return viewShipment(parts[2]);
      return viewDashboard();
    }
    return viewHome();
  }

  async function init() {
    user = await api.session();
    if (LIVE) sb.auth.onAuthStateChange((_evt, session) => {
      const was = !!user; user = session ? session.user : null;
      if (was !== !!user) renderNav();
    });
    window.addEventListener("hashchange", route);
    route();
  }
  init();
})();
