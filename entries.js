// Shadow forgot-badge page (ADR 0021): the head management team types the arrival or leaving of one of their own
// school's students who came without the badge. Same sign-in as the gate app (emailed 6-digit code) but its own
// session, and kept apart from app.js so the gate app is untouched. Supabase lets these accounts read only their
// school's current students and add entries only for them, today, never later than now; Shadow files each entry into
// Attendance and writes back its result, shown under "Today's entries". No offline queue: an entry is saved or not.
"use strict";
(() => {
  const CFG = window.SCANNER_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const KEY = "entries-session";              // the gate app on the same address keeps its own "session"
  let session = null, students = [], refreshing = null, pendingEmail = "";
  try { session = JSON.parse(localStorage.getItem(KEY)); } catch { session = null; }

  async function api(path, { method = "GET", body, auth = true, prefer } = {}) {
    const headers = { apikey: CFG.key, "Content-Type": "application/json" };
    if (auth) headers.Authorization = `Bearer ${await token()}`;
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(CFG.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw Object.assign(new Error((data && (data.msg || data.message || data.error_description)) || `Error ${res.status}`), { status: res.status });
    return data;
  }

  function keep(data) {
    session = { access: data.access_token, refresh: data.refresh_token, until: Date.now() + (data.expires_in || 3600) * 1000,
                email: (data.user && data.user.email) || (session && session.email) || pendingEmail };
    localStorage.setItem(KEY, JSON.stringify(session));
  }

  async function token() {
    if (!session) throw Object.assign(new Error("Not signed in"), { status: 401 });
    if (Date.now() < session.until - 60000) return session.access;
    refreshing = refreshing || api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: session.refresh }, auth: false })
      .then(keep)
      .catch((err) => { if ([400, 401, 403].includes(err.status)) signOut("Please sign in again."); throw err; })
      .finally(() => { refreshing = null; });
    await refreshing;
    return session.access;
  }

  // --- Helpers -------------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const now = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const plain = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();      // é = e
  const schoolName = (code) => ({ "bis-oran": "BIS-Oran", "bis-algiers": "BIS-Algiers" }[code] || code);
  const say = (text, kind = "") => { $("msg").textContent = text; $("msg").className = `msg ${kind}`; };
  const option = (value, label) => Object.assign(document.createElement("option"), { value, textContent: label });
  const resetTime = () => { $("hhmm").value = now(); $("hhmm").max = now(); };

  // --- Students --------------------------------------------------------------------------------
  function stopped(text) {
    $("stopped").textContent = text;
    $("stopped").hidden = false;
    $("entry").hidden = true;
  }

  async function loadStudents() {
    students = await api("/rest/v1/people?select=code,school,name,grp&kind=eq.students&active=is.true&order=name&limit=2000") || [];
    if (!students.length) return stopped("This account has no access now. Ask the director (it may have been stopped).");
    if (new Set(students.map((p) => p.school)).size > 1) return stopped("This is a gate phone account, not a forgot-badge account.");
    $("stopped").hidden = true;
    $("entry").hidden = false;
    $("school").textContent = schoolName(students[0].school);
    const chosen = $("klass").value, classes = [...new Set(students.map((p) => p.grp).filter(Boolean))].sort();
    $("klass").replaceChildren(option("", "All classes"), ...classes.map((c) => option(c, c)));
    $("klass").value = classes.includes(chosen) ? chosen : "";
    fill();
  }

  // The drop-down shows the chosen class and the names matching every word typed; one match is picked at once.
  function fill() {
    const klass = $("klass").value, words = plain($("find").value).split(/\s+/).filter(Boolean), was = $("student").value;
    const shown = students.filter((p) => (!klass || p.grp === klass) && words.every((w) => plain(p.name).includes(w)));
    $("student").replaceChildren(option("", shown.length ? `Choose a student (${shown.length})` : "Nobody matches"),
      ...shown.map((p) => option(p.code, p.grp ? `${p.name} · ${p.grp}` : p.name)));
    $("student").value = shown.length === 1 ? shown[0].code : shown.some((p) => p.code === was) ? was : "";
  }
  $("klass").addEventListener("change", fill);
  $("find").addEventListener("input", fill);

  // --- Today's entries, with Shadow's result --------------------------------------------------
  async function loadToday() {
    const rows = await api(`/rest/v1/entries?select=code,direction,hhmm,note,result&day=eq.${today()}&order=id.desc&limit=200`) || [];
    const names = Object.fromEntries(students.map((p) => [p.code, p.name]));
    $("today").replaceChildren(...(rows.length ? rows.map((r) => {
      const li = document.createElement("li"), b = document.createElement("b"), line = document.createElement("span");
      b.textContent = `${names[r.code] || r.code} · ${r.direction === "arrival" ? "Arrival" : "Leaving"} ${r.hhmm}`;
      line.textContent = (r.result || "Waiting for Shadow") + (r.note ? ` · ${r.note}` : "");
      li.className = !r.result ? "wait" : r.result.startsWith("Saved") ? "ok" : "bad";
      li.append(b, line);
      return li;
    }) : [Object.assign(document.createElement("li"), { className: "muted", textContent: "None yet." })]));
  }

  $("entry").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("student").value, hhmm = $("hhmm").value, direction = document.querySelector("input[name=direction]:checked").value;
    const person = students.find((p) => p.code === code);
    if (!person) return say("Choose a student.", "bad");
    if (!hhmm || hhmm > now()) return say("The time cannot be later than now.", "bad");
    if (!navigator.onLine) return say("No internet: not saved. Try again when connected.", "bad");
    $("save").disabled = true;
    say("Saving…");
    try {
      await api("/rest/v1/entries", { method: "POST", prefer: "return=minimal",
        body: [{ client_id: crypto.randomUUID(), code, direction, day: today(), hhmm, note: $("note").value.trim().slice(0, 200) }] });
      say(`Saved: ${person.name}, ${direction} ${hhmm}. It reaches Attendance within a few minutes.`, "ok");
      $("note").value = $("find").value = "";
      fill();
      resetTime();
      loadToday().catch(() => {});
    } catch (err) {
      say(err.status === 401 ? "Please sign in again." : [403, 400].includes(err.status) || /security|policy|violat/i.test(err.message)
        ? "Not saved: only your school's students, today, and not later than now. If it keeps failing, your access may have been stopped."
        : `Not saved: ${err.message}`, "bad");
    } finally {
      $("save").disabled = false;
    }
  });

  // --- Screens ---------------------------------------------------------------------------------
  function signOut(text = "") {
    session = null;
    localStorage.removeItem(KEY);
    $("main").hidden = true;
    $("login").hidden = false;
    $("login-msg").textContent = text;
  }

  async function openMain() {
    $("login").hidden = true;
    $("main").hidden = false;
    $("who").textContent = session.email ? `· ${session.email}` : "";
    resetTime();
    try {
      await loadStudents();
      await loadToday();
    } catch (err) {
      stopped(err.status === 401 ? "Please sign in again." : `Could not reach Supabase (${err.message}). Check the internet and reload.`);
    }
  }

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
      openMain();
    } catch (err) {
      $("login-msg").textContent = `That code did not work (${err.message}). Try again or ask for a new one.`;
    }
  });

  $("back").addEventListener("click", () => { $("code-form").hidden = true; $("email-form").hidden = false; });
  $("signout").addEventListener("click", () => { if (window.confirm("Sign out?")) signOut(); });
  setInterval(() => { if (session && !$("main").hidden && navigator.onLine) loadToday().catch(() => {}); }, 60 * 1000);
  setInterval(() => { if (session && !$("main").hidden && navigator.onLine) loadStudents().catch(() => {}); }, 10 * 60 * 1000);
  setInterval(() => { if (!$("main").hidden && document.activeElement !== $("hhmm")) $("hhmm").max = now(); }, 30 * 1000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!CFG.url || !CFG.key) signOut("This page is not set up: config.js is missing.");
  else if (session) openMain();
  else signOut();
})();
