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
    // The account's school comes from Supabase: an email that is also a gate phone can read every school's list.
    const school = await api("/rest/v1/rpc/manager_school", { method: "POST", body: {} });
    if (!school) return stopped("This account has no access now. Ask the director (it may have been stopped).");
    students = await api(`/rest/v1/people?select=code,school,name,grp&kind=eq.students&active=is.true&school=eq.${encodeURIComponent(school)}&order=name&limit=2000`) || [];
    if (!students.length) return stopped("No students found for this school yet. Ask the director.");
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

  // --- Today's attendance as an Excel file -------------------------------------------------------
  // Shadow mirrors today's attendance of this school's students to Supabase at each sync (no notes). The .xlsx is
  // written here with no library: a few XML files in a zip stored without compression. Absent red, late yellow.
  const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  const crc32 = (bytes) => { let c = -1; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

  function zip(files) {
    const enc = new TextEncoder(), local = [], central = [];
    let offset = 0;
    for (const [path, text] of files) {
      const name = enc.encode(path), data = enc.encode(text), crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30)), dir = new DataView(new ArrayBuffer(46));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [12, 33, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2]]
        .forEach(([at, v, size]) => (size === 4 ? head.setUint32(at, v, true) : head.setUint16(at, v, true)));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [14, 33, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [42, offset, 4]]
        .forEach(([at, v, size]) => (size === 4 ? dir.setUint32(at, v, true) : dir.setUint16(at, v, true)));
      local.push(head, name, data);
      central.push(dir, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((n, part) => n + part.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4]]
      .forEach(([at, v, s]) => (s === 4 ? end.setUint32(at, v, true) : end.setUint16(at, v, true)));
    return new Blob([...local, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function xlsx(rows) {          // rows: [[text, style]…] — style 1 bold, 2 red, 3 yellow
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const cells = rows.map((row, r) => `<row r="${r + 1}">${row.map(([text, style], c) =>
      `<c r="${"ABCDE"[c]}${r + 1}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t>${esc(text)}</t></is></c>`).join("")}</row>`).join("");
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const fill = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
    return zip([
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="Attendance" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${ns}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill("FFFCA5A5")}${fill("FFFDE68A")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/></cellXfs></styleSheet>`],
      ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${ns}><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="4" width="11" customWidth="1"/><col min="5" max="5" width="22" customWidth="1"/></cols><sheetData>${cells}</sheetData></worksheet>`],
    ]);
  }

  $("download").addEventListener("click", async () => {
    const out = $("download-msg");
    out.className = "msg";
    out.textContent = "Preparing…";
    try {
      const rows = await api("/rest/v1/today_attendance?select=school,day,name,grp,arrival,leaving,status,updated_at&order=grp.asc,name.asc&limit=2000") || [];
      if (!rows.length) {
        out.className = "msg bad";
        out.textContent = "No attendance for today yet: Shadow sends it every few minutes while it is running.";
        return;
      }
      const at = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), ""), time = at ? new Date(at).toTimeString().slice(0, 5) : "";
      const style = (s) => (s.startsWith("Absent") ? 2 : s.includes("Late") ? 3 : 0);
      const blob = xlsx([
        [[`${schoolName(rows[0].school)} · students' attendance · ${rows[0].day}${time ? ` · Shadow's figures as of ${time}` : ""}`, 1]],
        ["Name", "Class", "Arrival", "Leaving", "Status"].map((h) => [h, 1]),
        ...rows.map((r) => [[r.name], [r.grp], [r.arrival], [r.leaving], [r.status, style(r.status)]]),
      ]);
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `attendance-${rows[0].school}-${rows[0].day}.xlsx` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      out.className = "msg ok";
      out.textContent = `Downloaded: ${rows.length} students${time ? `, Shadow's figures as of ${time}` : ""}.`;
    } catch (err) {
      out.className = "msg bad";
      out.textContent = err.status === 401 ? "Please sign in again." : `Could not download (${err.message}).`;
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
