// Shadow Scanner — phone app for BIS badges (ADR 0014). No library: Supabase is called with fetch, QR codes are read
// by the browser's own BarcodeDetector (Chrome on Android). The lists are kept on the phone, so a scan is matched
// at once, even offline; scans wait in a queue and are uploaded in the background. Only whitelisted accounts can
// sign in (Supabase sends them a 6-digit code) and the database refuses everyone else.
"use strict";
(() => {
  const CFG = window.SCANNER_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  };
  const COOLDOWN = 60 * 1000;          // the same badge again within 1 minute is not counted twice (director, 2026-10-25)
  const HOLD = 2500;                   // a badge still in front of the camera is not read again for this long
  const PAGE = 1000;

  let session = store.get("session", null);
  let roster = store.get("roster", { people: {}, badges: {}, at: 0 });
  let queue = store.get("queue", []);
  let recent = store.get("recent", {});
  let refreshing = null, flushing = false, lastSeen = { value: "", at: 0 }, detector = null, running = false;

  // --- Supabase ---------------------------------------------------------------------------
  async function api(path, { method = "GET", body, auth = true, prefer } = {}) {
    const headers = { apikey: CFG.key, "Content-Type": "application/json" };
    if (auth) headers.Authorization = `Bearer ${await token()}`;
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(CFG.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && (data.msg || data.message || data.error_description)) || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function keep(data) {
    session = { access: data.access_token, refresh: data.refresh_token, until: Date.now() + (data.expires_in || 3600) * 1000,
                email: (data.user && data.user.email) || (session && session.email) || "" };
    store.set("session", session);
  }

  async function token() {
    if (!session) throw Object.assign(new Error("Not signed in"), { status: 401 });
    if (Date.now() < session.until - 60000) return session.access;
    refreshing = refreshing || api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: session.refresh }, auth: false })
      .then(keep)
      .catch((err) => { if (err.status === 400 || err.status === 401 || err.status === 403) signOut("Please sign in again."); throw err; })
      .finally(() => { refreshing = null; });
    await refreshing;
    return session.access;
  }

  async function getAll(path) {
    let rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const batch = await api(`${path}&limit=${PAGE}&offset=${offset}`);
      rows = rows.concat(batch || []);
      if (!batch || batch.length < PAGE) return rows;
    }
  }

  async function loadRoster() {
    const [people, badges] = await Promise.all([
      getAll("/rest/v1/people?select=code,school,kind,name,grp&active=is.true&order=code"),
      getAll("/rest/v1/badges?select=value,code&order=value"),
    ]);
    roster = { people: Object.fromEntries(people.map((p) => [p.code, p])), badges: Object.fromEntries(badges.map((b) => [b.value, b.code])), at: Date.now() };
    store.set("roster", roster);
    if (!people.length) message("This account is not allowed to scan yet. Ask the director to add it in Shadow.");
    return people.length;
  }

  async function flush() {
    if (flushing || !queue.length || !session || !navigator.onLine) return showPending();
    flushing = true;
    const batch = queue.slice(0, 200);
    try {
      await api("/rest/v1/scans?on_conflict=client_id", { method: "POST", body: batch, prefer: "resolution=ignore-duplicates,return=minimal" });
      const sent = new Set(batch.map((s) => s.client_id));
      queue = queue.filter((s) => !sent.has(s.client_id));
      store.set("queue", queue);
    } catch (err) {
      if (err.status === 401 || err.status === 403) message("Uploads refused: this account may have been removed.");
    } finally {
      flushing = false;
      showPending();
    }
    if (queue.length && batch.length === 200) flush();
  }

  // --- Feedback -----------------------------------------------------------------------------
  let audio = null;
  function beep(kind) {
    try {
      audio = audio || new AudioContext();
      const notes = { ok: [[1320, 0, 0.09]], again: [[520, 0, 0.08], [520, 0.13, 0.08]], bad: [[260, 0, 0.3]] }[kind];
      for (const [freq, start, length] of notes) {
        const osc = audio.createOscillator(), gain = audio.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.18;
        osc.connect(gain).connect(audio.destination);
        osc.start(audio.currentTime + start);
        osc.stop(audio.currentTime + start + length);
      }
    } catch { /* sound is optional */ }
    if (navigator.vibrate) navigator.vibrate({ ok: 60, again: [40, 60, 40], bad: 350 }[kind]);
  }

  let resetTimer = null;
  function show(kind, title, line) {
    const box = $("result");
    box.className = `result ${kind}`;
    $("r-name").textContent = title;
    $("r-line").textContent = line;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { box.className = "result"; $("r-name").textContent = "Ready"; $("r-line").textContent = "Show a badge to the camera"; }, 2600);
  }

  const time = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const schoolName = (code) => ({ "bis-oran": "BIS-Oran", "bis-algiers": "BIS-Algiers" }[code] || code);

  function countToday() {
    const today = new Date().toDateString(), t = store.get("today", { day: "", n: 0 });
    const next = { day: today, n: (t.day === today ? t.n : 0) + 1 };
    store.set("today", next);
    $("today").textContent = `${next.n} today`;
  }

  function showPending() {
    $("pending").hidden = !queue.length;
    $("pending").textContent = `${queue.length} to upload`;
  }

  function message(text) { $("cam-msg").textContent = text || ""; }

  // --- A scan -------------------------------------------------------------------------------
  function handle(raw, typed = false) {
    const value = (raw || "").trim();
    if (!value) return;
    const code = roster.badges[value] || (typed ? value.toUpperCase() : "");
    const person = roster.people[code];
    const now = Date.now(), key = person ? code : `?${value}`;
    if (recent[key] && now - recent[key] < COOLDOWN) {
      beep("again");
      return show("again", person ? person.name : "Unknown badge", `Already scanned at ${time(new Date(recent[key]))}`);
    }
    if (!person && typed) {
      beep("bad");
      return show("bad", "Code not found", `${value} is not in the lists (reload the lists from the menu?)`);
    }
    recent = Object.fromEntries(Object.entries(recent).filter(([, at]) => now - at < COOLDOWN));
    recent[key] = now;
    store.set("recent", recent);
    queue.push({ client_id: crypto.randomUUID(), value: roster.badges[value] ? value : (typed ? "" : value), code: person ? code : "",
                 device: store.get("device", ""), scanned_at: new Date(now).toISOString() });
    store.set("queue", queue);
    showPending();
    flush();
    if (!person) {
      beep("bad");
      return show("bad", "Unknown badge", "Saved: the director can link it in Shadow");
    }
    beep("ok");
    countToday();
    const group = person.kind === "staff" ? (person.grp || "Staff") : (person.grp ? `Class ${person.grp}` : "Student");
    show("ok", person.name, `${group} · ${person.code} · ${schoolName(person.school)} · ${time(new Date(now))}`);
  }

  // --- Camera -------------------------------------------------------------------------------
  let facing = "user";                      // the front camera at every opening; the swap button changes it until the app closes

  async function startCamera() {
    if (!("BarcodeDetector" in window)) {
      return message("This browser cannot read QR codes. Open the app in Chrome, or type codes from the menu.");
    }
    try {
      detector = detector || new BarcodeDetector({ formats: ["qr_code"] });
      const video = $("video");
      video.classList.toggle("mirror", facing === "user");
      video.srcObject = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      await video.play();
      running = true;
      message("");
      loop();
      if ("wakeLock" in navigator) navigator.wakeLock.request("screen").catch(() => {});
    } catch {
      message("The camera could not start. Allow the camera for this app, then reopen it.");
    }
  }

  function stopCamera() {
    running = false;
    const stream = $("video").srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    $("video").srcObject = null;
  }

  $("swap").addEventListener("click", () => {
    facing = facing === "user" ? "environment" : "user";
    stopCamera();
    startCamera();
  });

  async function loop() {
    if (!running) return;
    const video = $("video");
    if (video.readyState >= 2) {
      try {
        const found = await detector.detect(video);
        const value = found.length ? found[0].rawValue : "";
        const now = Date.now();
        if (value && !(value === lastSeen.value && now - lastSeen.at < HOLD)) handle(value);
        if (value) lastSeen = { value, at: now };
      } catch { /* a frame that cannot be read */ }
    }
    requestAnimationFrame(loop);
  }

  // USB / Bluetooth scanners type the code followed by Enter.
  let typedBuffer = "", typedAt = 0;
  document.addEventListener("keydown", (e) => {
    if ($("scan").hidden || document.activeElement?.tagName === "INPUT") return;
    const now = Date.now();
    if (now - typedAt > 120) typedBuffer = "";
    typedAt = now;
    if (e.key === "Enter") { handle(typedBuffer, true); typedBuffer = ""; }
    else if (e.key.length === 1) typedBuffer += e.key;
  });

  // --- Screens --------------------------------------------------------------------------------
  function signOut(text) {
    session = null;
    localStorage.removeItem("session");
    stopCamera();
    openLogin(text);
  }

  function openLogin(text = "") {
    $("scan").hidden = true;
    $("login").hidden = false;
    $("login-msg").textContent = text;
  }

  async function openScanner() {
    $("login").hidden = true;
    $("scan").hidden = false;
    $("device").textContent = store.get("device", "") || "Name this phone in the menu";
    $("today").textContent = `${(store.get("today", {}).day === new Date().toDateString() ? store.get("today", {}).n : 0)} today`;
    showPending();
    startCamera();
    if (Date.now() - roster.at > 10 * 60 * 1000) loadRoster().catch(() => {});
    flush();
  }

  let pendingEmail = "";
  $("email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    pendingEmail = $("email").value.trim().toLowerCase();
    $("login-msg").textContent = "Sending…";
    try {
      await api("/auth/v1/otp", { method: "POST", body: { email: pendingEmail, create_user: false }, auth: false });
      $("email-form").hidden = true;
      $("code-form").hidden = false;
      $("login-msg").textContent = "";
      $("code").focus();
    } catch (err) {
      $("login-msg").textContent = err.status === 422 || /signup|not allowed|not found/i.test(err.message)
        ? "This email is not allowed. Ask the director to add it in Shadow." : `Could not send the code: ${err.message}`;
    }
  });

  $("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-msg").textContent = "Checking…";
    try {
      keep(await api("/auth/v1/verify", { method: "POST", body: { type: "email", email: pendingEmail, token: $("code").value.trim() }, auth: false }));
      session.email = session.email || pendingEmail;
      store.set("session", session);
      await loadRoster();
      openScanner();
    } catch (err) {
      $("login-msg").textContent = `That code did not work (${err.message}). Try again or ask for a new one.`;
    }
  });

  $("back").addEventListener("click", () => { $("code-form").hidden = true; $("email-form").hidden = false; });

  $("menu-btn").addEventListener("click", () => {
    $("who").textContent = session ? `Signed in as ${session.email}` : "";
    $("device-name").value = store.get("device", "");
    $("roster-info").textContent = `${Object.keys(roster.people).length} people, ${Object.keys(roster.badges).length} badges` +
      (roster.at ? `, lists from ${new Date(roster.at).toLocaleString()}` : "");
    $("menu").showModal();
  });

  $("menu").addEventListener("close", async () => {
    const choice = $("menu").returnValue;
    if (choice === "manual") { handle($("manual").value, true); $("manual").value = ""; }
    if (choice === "device") { store.set("device", $("device-name").value.trim()); $("device").textContent = store.get("device", "") || "Name this phone in the menu"; }
    if (choice === "refresh") loadRoster().then((n) => show("ok", "Lists reloaded", `${n} people`)).catch((err) => show("bad", "Could not reload", err.message));
    if (choice === "signout" && window.confirm("Sign out of this phone?")) signOut("");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
    else if (!$("scan").hidden) { startCamera(); flush(); }
  });
  window.addEventListener("online", flush);
  setInterval(flush, 15000);
  setInterval(() => { if (session && navigator.onLine) loadRoster().catch(() => {}); }, 10 * 60 * 1000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!CFG.url || !CFG.key) openLogin("This app is not set up: config.js is missing.");
  else if (session) openScanner();
  else openLogin();
})();
