/* Needle Drop — hear ten seconds of a record, guess when and where it was made.
   Data: data/songs.js (window.NEEDLE_SONGS), data/world.js (window.NEEDLE_WORLD, TopoJSON). */
(function () {
  "use strict";

  // ---------- constants ----------
  const Y0 = 1930, Y1 = 2026;
  const RECORDS = 10;
  const MAX_PART = 500;              // per record: 500 for when + 500 for where; a round tops out at 10,000
  const FULL_YEARS = 5, YEAR_FALLOFF = 15;
  const FULL_KM = 80.47, KM_FALLOFF = 2000;   // 50 miles
  const CLIP = 10;                   // seconds
  const STORE_KEY = "needledrop.v1";
  const REGIONS = ["usa", "uk", "weur", "seur", "carib", "sam", "mena", "wafr", "esafr", "sasia", "easia", "seaoc"];
  const RANKS = [[0.85, "Station Manager"], [0.7, "Program Director"], [0.55, "Night DJ"],
                 [0.4, "Crate Digger"], [0.25, "Studio Intern"], [0, "Caller on Line 2"]];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SONGS = window.NEEDLE_SONGS || [];
  const byRegion = {};
  for (const s of SONGS) (byRegion[s.r] = byRegion[s.r] || []).push(s);

  // ---------- storage (per browser) ----------
  function blankStore() { return { v: 1, seen: [], rounds: [], perfect: [] }; }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.v === 1) return Object.assign(blankStore(), s);
    } catch (e) { /* storage unavailable */ }
    return blankStore();
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }
  const store = load();

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const decade = (y) => Math.floor(y / 10) * 10;

  function haversineKm(a, b) {
    const r = Math.PI / 180;
    const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function placeScore(km) { return km <= FULL_KM ? MAX_PART : Math.round(MAX_PART * Math.exp(-(km - FULL_KM) / KM_FALLOFF)); }
  function yearScore(gap) { return gap <= FULL_YEARS ? MAX_PART : Math.round(MAX_PART * Math.exp(-(gap - FULL_YEARS) / YEAR_FALLOFF)); }
  function distText(km) {
    const mi = km / 1.609344;
    if (mi < 1) return "right on it";
    return `${fmt(mi)} mi (${fmt(km)} km) away`;
  }
  function gapText(g) { return g === 0 ? "exact year" : g === 1 ? "1 year off" : `${g} years off`; }

  // ---------- round selection ----------
  // One record per region (10 of the 12, shuffled), and no decade twice in a round when avoidable.
  function pickRound() {
    const seen = new Set(store.seen);
    const regions = shuffle(REGIONS.filter((r) => byRegion[r] && byRegion[r].length)).slice(0, RECORDS);
    const used = {};
    const picks = [];
    for (const r of regions) {
      let pool = byRegion[r].filter((s) => !seen.has(s.id));
      if (!pool.length) { // region exhausted: forget what was heard there and start over
        store.seen = store.seen.filter((id) => !byRegion[r].some((s) => s.id === id));
        pool = byRegion[r].slice();
      }
      const min = Math.min(...pool.map((s) => used[decade(s.y)] || 0));
      const best = pool.filter((s) => (used[decade(s.y)] || 0) === min);
      const s = best[Math.floor(Math.random() * best.length)];
      used[decade(s.y)] = (used[decade(s.y)] || 0) + 1;
      picks.push(s);
    }
    // a region left out of the shuffle can still fill a gap if the pool is small
    while (picks.length < RECORDS) {
      const rest = SONGS.filter((s) => !picks.includes(s));
      if (!rest.length) break;
      picks.push(rest[Math.floor(Math.random() * rest.length)]);
    }
    return picks;
  }

  // ---------- state ----------
  let game = null;   // { records, i, results, phase }
  let guess = { ll: null, year: null };

  // ---------- turntable ----------
  function buildGrooves() {
    const g = $("grooves");
    let html = "";
    for (let r = 62; r < 158; r += 2.2) {
      const o = 0.05 + (Math.sin(r * 0.9) + 1) * 0.03;
      html += `<circle cx="190" cy="190" r="${r.toFixed(1)}" fill="none" stroke="#fff" stroke-opacity="${o.toFixed(3)}" stroke-width=".6"/>`;
    }
    html += `<circle cx="190" cy="190" r="60" fill="none" stroke="#000" stroke-width="5" stroke-opacity=".7"/>`;
    g.innerHTML = html;
  }
  function setLabel(rec, n) {
    const art = $("labelArt");
    if (rec) {
      art.setAttribute("href", rec.art);
      art.setAttribute("visibility", "visible");
      $("labelText").setAttribute("visibility", "hidden");
    } else {
      art.removeAttribute("href");
      art.setAttribute("visibility", "hidden");
      $("labelText").setAttribute("visibility", "visible");
      $("matrix").textContent = `ND – ${String(n).padStart(2, "0")}`;
    }
  }

  // ---------- VU meters ----------
  const vu = { L: null, R: null, levels: [0, 0], shown: [0, 0] };
  function buildVU(svg) {
    const cx = 60, cy = 66, r = 50;
    const ang = (d) => (-50 + d * 100) * Math.PI / 180;
    let marks = "";
    for (let i = 0; i <= 10; i++) {
      const a = ang(i / 10), r2 = i % 5 === 0 ? r - 9 : r - 5;
      marks += `M${cx + Math.sin(a) * r2},${cy - Math.cos(a) * r2}L${cx + Math.sin(a) * r},${cy - Math.cos(a) * r}`;
    }
    const arc = (d0, d1, rr) => {
      const a0 = ang(d0), a1 = ang(d1);
      return `M${cx + Math.sin(a0) * rr},${cy - Math.cos(a0) * rr}A${rr},${rr} 0 0 1 ${cx + Math.sin(a1) * rr},${cy - Math.cos(a1) * rr}`;
    };
    svg.innerHTML =
      `<rect class="face" x="1" y="1" width="118" height="70" rx="5"/>` +
      `<path class="scale" d="${arc(0, 1, r)}${marks}"/>` +
      `<path class="hot" d="${arc(0.72, 1, r + 2)}"/>` +
      `<text x="60" y="44" text-anchor="middle">VU</text>` +
      `<line class="ndl" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r - 2}"/>` +
      `<rect x="0" y="62" width="120" height="10" fill="#2b211b"/>`;
    return svg.querySelector(".ndl");
  }
  function setNeedle(el, v) { el.setAttribute("transform", `rotate(${-50 + v * 100} 60 66)`); }

  // ---------- audio ----------
  const audio = new Audio();
  audio.crossOrigin = "anonymous";   // Apple's preview host sends CORS headers, so levels can be read
  audio.preload = "auto";
  let actx = null, analysers = null, gain = null, playing = false, stopTimer = null, clockTimer = null, rafId = 0;
  // iPhone: treat this as media playback so the ring/silent switch doesn't mute it once it runs through Web Audio
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* older browsers */ }

  function setupAnalyser() {
    if (actx || !window.AudioContext) return;
    try {
      actx = new AudioContext();
      const src = actx.createMediaElementSource(audio);
      const split = actx.createChannelSplitter(2);
      const a = [actx.createAnalyser(), actx.createAnalyser()];
      a.forEach((n) => { n.fftSize = 1024; });
      gain = actx.createGain();
      src.connect(gain);
      gain.connect(actx.destination);
      src.connect(split);
      split.connect(a[0], 0);
      split.connect(a[1], 1);
      analysers = a;
    } catch (e) { analysers = null; }
  }
  const buf = new Float32Array(1024);
  function meterLoop() {
    for (let c = 0; c < 2; c++) {
      let level = 0;
      if (playing && analysers) {
        analysers[c].getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(rms + 1e-6);         // about -60 … 0
        level = Math.max(0, Math.min(1, (db + 32) / 32));
      } else if (playing) {
        level = 0.45 + Math.random() * 0.35;            // no level data: a plausible wobble
      }
      // VU ballistics: quick rise, slower fall
      const k = level > vu.shown[c] ? 0.35 : 0.12;
      vu.shown[c] += (level - vu.shown[c]) * k;
    }
    setNeedle(vu.L, vu.shown[0]);
    setNeedle(vu.R, vu.shown[1]);
    if (playing || vu.shown[0] > 0.005 || vu.shown[1] > 0.005) rafId = requestAnimationFrame(meterLoop);
    else rafId = 0;
  }

  function setOnAir(on) {
    $("onair").classList.toggle("lit", on);
    $("disc").classList.toggle("spin", on);
    $("arm").classList.toggle("down", on);
    $("pilot").setAttribute("fill", on ? "#e5483a" : "#3a2a20");
    const b = $("play");
    b.classList.toggle("on", on);
    b.innerHTML = on ? "Lift the<br>needle" : "Drop the<br>needle";
  }
  function updateClock(t) {
    const left = Math.max(0, Math.ceil(CLIP - t));
    $("clock").textContent = `0:${String(left).padStart(2, "0")}`;
  }
  function stopClip() {
    clearTimeout(stopTimer); clearInterval(clockTimer);
    if (!playing) return;
    playing = false;
    audio.pause();
    setOnAir(false);
    updateClock(0);
  }
  async function playClip() {
    if (playing) { stopClip(); return; }
    setupAnalyser();
    // start playback inside the tap itself (phones refuse audio started after an await)
    audio.currentTime = 0;
    audio.volume = 1;
    if (gain) gain.gain.value = 1;
    const started = audio.play();
    if (actx && actx.state === "suspended") actx.resume().catch(() => {});
    try {
      await started;
    } catch (e) {
      if (e && e.name === "NotAllowedError") return;   // the browser blocked it; the next tap will work
      showLoadError();
      return;
    }
    playing = true;
    game.played = true;
    setOnAir(true);
    updateClock(0);
    clockTimer = setInterval(() => updateClock(audio.currentTime), 200);
    stopTimer = setTimeout(fadeOut, (CLIP - 0.6) * 1000);
    if (!rafId) rafId = requestAnimationFrame(meterLoop);
  }
  function fadeOut() {
    const start = performance.now();
    const step = (now) => {
      const f = Math.min(1, (now - start) / 600);
      if (gain) gain.gain.value = 1 - f; else audio.volume = 1 - f;
      if (f < 1 && playing) requestAnimationFrame(step);
      else stopClip();
    };
    requestAnimationFrame(step);
  }
  function showLoadError() {
    const r = game.records[game.i];
    $("peekNote").innerHTML = `This record won’t play right now. <button class="ghost" id="swap" type="button">Swap in another record</button>`;
    $("swap").onclick = () => {
      const pool = (byRegion[r.r] || SONGS).filter((s) => s.id !== r.id && !game.records.includes(s));
      if (!pool.length) return;
      game.records[game.i] = pool[Math.floor(Math.random() * pool.length)];
      startRecord();
    };
  }

  // ---------- map ----------
  let svg, gZoom, gPins, proj, geoPath, zoom, T = d3.zoomIdentity;
  const world = window.NEEDLE_WORLD;
  const pins = { guess: null, truth: null };

  function buildMap() {
    svg = d3.select("#map");
    gZoom = svg.append("g");
    for (const c of ["sphere", "grat", "land", "borders", "arc"]) gZoom.append("path").attr("class", c);
    gPins = svg.append("g");
    zoom = d3.zoom().scaleExtent([1, 60]).on("zoom", (e) => { T = e.transform; gZoom.attr("transform", T); placePins(); });
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", onMapClick);
    $("zin").onclick = () => svg.transition().duration(reduced ? 0 : 250).call(zoom.scaleBy, 1.8);
    $("zout").onclick = () => svg.transition().duration(reduced ? 0 : 250).call(zoom.scaleBy, 1 / 1.8);
    $("zfit").onclick = () => svg.transition().duration(reduced ? 0 : 400).call(zoom.transform, d3.zoomIdentity);
    layoutMap();
    new ResizeObserver(() => layoutMap()).observe($("map"));
  }
  let lastSize = "";
  function layoutMap() {
    const r = $("map").getBoundingClientRect();
    const w = Math.max(200, r.width), h = Math.max(160, r.height);
    const key = `${Math.round(w)}x${Math.round(h)}`;
    if (key === lastSize) return;
    lastSize = key;
    proj = d3.geoNaturalEarth1().fitExtent([[4, 4], [w - 4, h - 4]], { type: "Sphere" });
    geoPath = d3.geoPath(proj);
    const land = topojson.feature(world, world.objects.land || world.objects.countries);
    const borders = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
    gZoom.select(".sphere").attr("d", geoPath({ type: "Sphere" }));
    gZoom.select(".grat").attr("d", geoPath(d3.geoGraticule10()));
    gZoom.select(".land").attr("d", geoPath(land));
    gZoom.select(".borders").attr("d", geoPath(borders));
    zoom.extent([[0, 0], [w, h]]).translateExtent([[0, 0], [w, h]]);
    drawArc();
    placePins();
  }
  function onMapClick(e) {
    if (!game || game.phase !== "guess") return;
    const [x, y] = d3.pointer(e, svg.node());
    const p = T.invert([x, y]);
    const ll = proj.invert(p);
    if (!ll || !isFinite(ll[0])) return;
    const back = proj(ll);
    if (!back || Math.hypot(back[0] - p[0], back[1] - p[1]) > 1) return; // outside the globe outline
    guess.ll = ll;
    setPin("guess", ll);
    const w = $("whereRead");
    w.textContent = `${Math.abs(ll[1]).toFixed(1)}°${ll[1] >= 0 ? "N" : "S"}  ${Math.abs(ll[0]).toFixed(1)}°${ll[0] >= 0 ? "E" : "W"}`;
    w.classList.remove("idle");
    $("maphint").hidden = true;
    updateSubmit();
  }
  function setPin(kind, ll) {
    if (pins[kind]) pins[kind].g.remove();
    pins[kind] = null;
    if (!ll) return;
    const g = gPins.append("g").attr("class", kind === "guess" ? "pin-guess" : "pin-true");
    if (kind === "guess") {
      g.append("path").attr("d", "M0,0 C-2,-8 -9,-12 -9,-19 A9,9 0 1 1 9,-19 C9,-12 2,-8 0,0Z");
      g.append("circle").attr("cy", -19).attr("r", 3.2);
    } else {
      g.append("circle").attr("class", "halo").attr("r", 16);
      g.append("circle").attr("class", "dot").attr("r", 6.5);
    }
    pins[kind] = { g, ll };
    placePins();
  }
  function placePins() {
    for (const k of ["truth", "guess"]) {
      const p = pins[k];
      if (!p) continue;
      const xy = T.apply(proj(p.ll));
      p.g.attr("transform", `translate(${xy[0]},${xy[1]})`);
    }
  }
  function drawArc() {
    const arc = gZoom.select(".arc");
    if (pins.guess && pins.truth) arc.attr("d", geoPath({ type: "LineString", coordinates: [pins.guess.ll, pins.truth.ll] }));
    else arc.attr("d", null);
  }
  function fitPoints(lls) {
    const r = $("map").getBoundingClientRect();
    const pts = lls.map((ll) => proj(ll));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 60;
    const k = Math.max(1, Math.min(6, Math.min((r.width - pad * 2) / Math.max(1, x1 - x0), (r.height - pad * 2) / Math.max(1, y1 - y0))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const t = d3.zoomIdentity.translate(r.width / 2 - cx * k, r.height / 2 - cy * k).scale(k);
    svg.transition().duration(reduced ? 0 : 750).call(zoom.transform, t);
  }

  // ---------- year tuner ----------
  const pct = (y) => ((y - Y0) / (Y1 - Y0)) * 100;
  function buildDial() {
    const sc = $("scale");
    let html = "";
    for (let y = Y0; y <= Y1; y++) {
      const cls = y % 10 === 0 ? "major" : y % 5 === 0 ? "mid" : "";
      html += `<div class="tick ${cls}" style="left:${pct(y)}%"></div>`;
      if (y % 10 === 0) {
        const minor = y % 20 !== 0 ? " minor-lab" : "";
        html += `<div class="tlab${minor}" style="left:${pct(y)}%">${y}</div>`;
      }
    }
    sc.insertAdjacentHTML("afterbegin", html);
    const dial = $("dial");
    let dragging = false;
    const fromX = (clientX) => {
      const r = sc.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return Math.round(Y0 + f * (Y1 - Y0));
    };
    dial.addEventListener("pointerdown", (e) => {
      if (!game || game.phase !== "guess") return;
      dragging = true;
      dial.setPointerCapture(e.pointerId);
      setYear(fromX(e.clientX));
    });
    dial.addEventListener("pointermove", (e) => { if (dragging) setYear(fromX(e.clientX)); });
    const end = () => { dragging = false; };
    dial.addEventListener("pointerup", end);
    dial.addEventListener("pointercancel", end);
    dial.addEventListener("keydown", (e) => {
      if (!game || game.phase !== "guess") return;
      const base = guess.year == null ? 1978 : guess.year;
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
      if (step) { e.preventDefault(); setYear(base + (guess.year == null ? 0 : step)); }
      else if (e.key === "Home") { e.preventDefault(); setYear(Y0); }
      else if (e.key === "End") { e.preventDefault(); setYear(Y1); }
    });
    $("yMinus").onclick = () => { if (game && game.phase === "guess") setYear((guess.year == null ? 1979 : guess.year) - 1); };
    $("yPlus").onclick = () => { if (game && game.phase === "guess") setYear((guess.year == null ? 1977 : guess.year) + 1); };
  }
  function setYear(y) {
    y = Math.max(Y0, Math.min(Y1, y));
    guess.year = y;
    const n = $("needle");
    n.hidden = false;
    n.style.left = pct(y) + "%";
    const r = $("whenRead");
    r.textContent = String(y);
    r.classList.remove("idle");
    $("dial").setAttribute("aria-valuenow", y);
    updateSubmit();
  }

  // ---------- flow ----------
  function updateSubmit() {
    const b = $("submit");
    const ready = guess.ll && guess.year != null;
    b.disabled = !ready;
    b.textContent = ready ? "Log it" : !guess.ll && guess.year == null ? "Set a pin and a year" : !guess.ll ? "Set a pin on the map" : "Tune the dial to a year";
  }

  function newGame() {
    stopClip();
    game = { records: pickRound(), i: 0, results: [], phase: "guess" };
    startRecord();
  }

  function startRecord() {
    stopClip();
    const rec = game.records[game.i];
    game.phase = "guess";
    game.played = false;
    game.peeked = false;
    guess = { ll: null, year: null };
    setPin("guess", null); setPin("truth", null); drawArc();
    if (svg) svg.transition().duration(reduced ? 0 : 400).call(zoom.transform, d3.zoomIdentity);
    $("needle").hidden = true; $("band").hidden = true; $("truthTick").hidden = true;
    const wr = $("whereRead"); wr.textContent = "Tap the map to set a pin"; wr.classList.add("idle");
    const yr = $("whenRead"); yr.textContent = "Drag the dial to a year"; yr.classList.add("idle");
    $("dial").removeAttribute("aria-valuenow");
    $("maphint").hidden = false;
    $("result").hidden = true;
    $("submit").hidden = false;
    $("nextBtn").disabled = true;
    $("nextBtn").textContent = "Next record";
    $("yMinus").disabled = false; $("yPlus").disabled = false;
    updateSubmit();
    setLabel(null, game.i + 1);
    $("mRec").textContent = `${game.i + 1} / ${game.records.length}`;
    $("mScore").textContent = fmt(game.results.reduce((a, r) => a + r.total, 0));
    // the Apple Music link sits beside the preview at all times; opening it forfeits the record
    $("peekIdle").hidden = false; $("peekConfirm").hidden = true; $("peekedTag").hidden = true;
    $("peekNote").textContent = "Opening the full song shows its name, so this record will score 0.";
    $("peekLink").href = rec.url;
    $("peekBtn").href = rec.url;
    $("play").disabled = false;
    updateClock(0);
    setOnAir(false);
    audio.src = rec.pv;
    audio.load();
  }

  function submit() {
    if (!game || game.phase !== "guess" || !guess.ll || guess.year == null) return;
    stopClip();
    const rec = game.records[game.i];
    game.phase = "result";
    const km = haversineKm(guess.ll, rec.ll);
    const gap = Math.abs(guess.year - rec.y);
    let when = yearScore(gap), where = placeScore(km);
    if (game.peeked) { when = 0; where = 0; }
    const res = { id: rec.id, km, gap, when, where, total: when + where, peeked: game.peeked, guessYear: guess.year };
    game.results.push(res);
    if (!store.seen.includes(rec.id)) store.seen.push(rec.id);
    if (!game.peeked && when === MAX_PART && where === MAX_PART && !store.perfect.includes(rec.id)) store.perfect.push(rec.id);
    save();

    // reveal on map and dial
    setPin("truth", rec.ll);
    drawArc();
    fitPoints([guess.ll, rec.ll]);
    const band = $("band");
    band.style.left = pct(Math.max(Y0, rec.y - FULL_YEARS)) + "%";
    band.style.width = (pct(Math.min(Y1, rec.y + FULL_YEARS)) - pct(Math.max(Y0, rec.y - FULL_YEARS))) + "%";
    band.hidden = false;
    const tt = $("truthTick"); tt.style.left = pct(rec.y) + "%"; tt.hidden = false;
    $("yMinus").disabled = true; $("yPlus").disabled = true;
    setLabel(rec);
    $("mScore").textContent = fmt(game.results.reduce((a, r) => a + r.total, 0));

    const last = game.i === game.records.length - 1;
    const el = $("result");
    el.innerHTML = `
      <div class="eyebrow">Station log · record ${game.i + 1} of ${game.records.length}</div>
      <h3>${esc(rec.t)}</h3>
      <p class="by">${esc(rec.a)}</p>
      <p class="facts">${rec.y} · ${esc(rec.p)} · ${esc(rec.s)}</p>
      <div class="rows">
        <div class="row"><b>When</b><span>You said ${res.guessYear} · ${gapText(gap)}</span><span class="pts">+${when}</span></div>
        <div class="row"><b>Where</b><span>${distText(km)}</span><span class="pts">+${where}</span></div>
        <div class="row total"><b>Total</b><span>${res.peeked ? '<span class="stamp">Peeked at Apple Music: no score</span>' : when + where === 1000 ? '<span class="stamp">Perfect</span>' : ""}</span><span class="pts">${res.total} / 1,000</span></div>
      </div>
      <div class="acts">
        <a class="badge-link" href="${esc(rec.url)}" target="_blank" rel="noopener"><img src="img/listen-on-apple-music.svg" alt="Listen on Apple Music" width="137" height="40"></a>
      </div>`;
    el.hidden = false;
    $("submit").hidden = true;
    $("peekIdle").hidden = true; $("peekConfirm").hidden = true;
    $("peekNote").textContent = "The full song is free to open now.";
    const nb = $("nextBtn");
    nb.disabled = false;
    nb.textContent = last ? "See the crate" : "Next record";
    nb.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }

  function rankFor(frac) { return RANKS.find(([t]) => frac >= t)[1]; }

  function finishGame() {
    stopClip();
    game.phase = "done";
    const total = game.results.reduce((a, r) => a + r.total, 0);
    const max = game.records.length * MAX_PART * 2;
    store.rounds.push({ date: new Date().toISOString().slice(0, 10), score: total, max });
    save();
    const best = Math.max(...store.rounds.map((r) => r.score));
    const rows = game.records.map((rec, i) => {
      const r = game.results[i];
      return `<div class="crate-row">
        <img src="${esc(rec.art)}" alt="" loading="lazy">
        <div class="ct"><b>${esc(rec.t)}</b><span>${esc(rec.a)} · ${rec.y} · ${esc(rec.p)}</span>
          <a href="${esc(rec.url)}" target="_blank" rel="noopener">Listen on Apple Music</a>${r && r.peeked ? "<em>peeked</em>" : ""}</div>
        <div class="cp">${r ? fmt(r.total) : "–"}</div>
      </div>`;
    }).join("");
    openSheet(`
      <span class="lbl">The crate · tonight’s ten records</span>
      <div class="final"><strong>${fmt(total)}</strong><span>of ${fmt(max)}</span></div>
      <p class="rank">${rankFor(total / max)}</p>
      <div class="crate">${rows}</div>
      <div class="sheet-acts">
        <button class="logit" id="againBtn" type="button">Spin ten more</button>
        <span class="stats">Best round ${fmt(best)} · ${store.rounds.length} round${store.rounds.length === 1 ? "" : "s"} played</span>
      </div>`);
    $("againBtn").onclick = () => { closeSheet(); newGame(); };
    $("againBtn").focus();
  }

  function introHTML(midGame) {
    const best = store.rounds.length ? Math.max(...store.rounds.map((r) => r.score)) : null;
    return `
      <h1 class="logo">Needle Drop</h1>
      <p class="tag">Discover the world’s music, one record at a time.</p>
      <blockquote class="epi">
        <q lang="es">La literatura toda es contemporánea para el lector que sabe leer.</q>
        <p class="tr">All literature is contemporary to the reader who knows how to read.</p>
        <cite>Nicolás Gómez Dávila, Escolios a un texto implícito</cite>
      </blockquote>
      <ul class="how">
        <li><b>Listen</b><span>Drop the needle for ten seconds of a record, from anywhere, 1930 to now. Replay it as often as you like.</span></li>
        <li><b>Where</b><span>Pin the city the artist was working from. Within 50 miles scores the full 500.</span></li>
        <li><b>When</b><span>Tune the dial to the release year. Within 5 years scores the full 500.</span></li>
        <li><b>Peek</b><span>Every record links to Apple Music. Open it before you log your guess and that record scores 0.</span></li>
      </ul>
      <div class="sheet-acts">
        <button class="logit" id="goBtn" type="button">${midGame ? "Back to the record" : "Start the show"}</button>
        <span class="stats">${SONGS.length} records in the library${best != null ? ` · best round ${fmt(best)} of 10,000` : ""}</span>
      </div>`;
  }
  function openSheet(html) { $("sheetBody").innerHTML = html; $("sheet").hidden = false; }
  function closeSheet() { $("sheet").hidden = true; }

  // ---------- wiring ----------
  function wire() {
    $("play").onclick = playClip;
    $("submit").onclick = submit;
    $("nextBtn").onclick = () => {
      if (!game || game.phase !== "result") return;
      if (game.i === game.records.length - 1) { $("nextBtn").disabled = true; finishGame(); }
      else { game.i++; startRecord(); window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }); }
    };
    // the badge is a real Apple Music link; while guessing, the first click asks before it costs the record
    $("peekBtn").onclick = (e) => {
      if (!game || game.phase !== "guess") return;
      e.preventDefault();
      $("peekIdle").hidden = true; $("peekConfirm").hidden = false; $("peekLink").focus();
    };
    $("peekCancel").onclick = () => { $("peekIdle").hidden = false; $("peekConfirm").hidden = true; };
    $("peekLink").addEventListener("click", () => {
      if (!game || game.phase !== "guess") return;
      game.peeked = true;
      stopClip();
      $("peekConfirm").hidden = true;
      $("peekedTag").hidden = false;
      $("peekNote").textContent = "You can still log a guess to see the answer.";
    });
    audio.addEventListener("ended", stopClip);
    audio.addEventListener("error", () => { if (game && game.phase === "guess" && audio.src) showLoadError(); });
    $("howBtn").onclick = () => {
      openSheet(introHTML(true));
      $("goBtn").onclick = closeSheet;
    };
    $("sheet").addEventListener("keydown", (e) => {
      if (e.key === "Escape" && game && game.phase !== "done") closeSheet();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== " " || !$("sheet").hidden) return;
      const t = e.target;
      if (t && (t.tagName === "BUTTON" || t.tagName === "A" || t.id === "dial")) return;
      if (game && game.phase !== "done") { e.preventDefault(); playClip(); }
    });
  }

  function start() {
    if (!SONGS.length || !world) {
      document.querySelector(".stage").innerHTML = `<p>The record library didn’t load. Keep index.html next to its <code>data</code> and <code>lib</code> folders.</p>`;
      return;
    }
    buildGrooves();
    vu.L = buildVU($("vuL"));
    vu.R = buildVU($("vuR"));
    setNeedle(vu.L, 0); setNeedle(vu.R, 0);
    buildMap();
    buildDial();
    wire();
    newGame();
    openSheet(introHTML(false));
    $("goBtn").onclick = () => { closeSheet(); $("play").focus(); };
  }
  start();
})();
