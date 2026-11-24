// BedJet Atom — stage 3.0 custom page (Nov 24, 2026).
//
// Replaces the stock ESPHome table page with a minimalist
// single-purpose UI — not a weather-app look-alike, but borrowing
// a weather app's minimalism: giant set-temperature, status word, mode pill
// (Off / Heat / Cool / Turbo), stat cards, and everything else in an
// Advanced Settings sheet. Talks to the device's own plumbing —
// the /events state stream and the web REST API
// (POST /climate/BedJet/set?mode=...&target_temperature=... etc.).
// All temperatures are °F on screen; the wire stays °C.
//
// Escape hatch: open /?stock=1 to get the stock ESPHome page —
// this script then only does the home-screen dressing below.
//
// (Stages 2.2–2.3.3 dressed the stock page and rewrote its °C text
// nodes into °F; that layer retired with the custom UI. The last
// stock-dressing build is kept as bedjet-app-2.3-final.js.)

// Part of the BedJet Atom build — see README.md in this kit, which
// links back to the full Atom firmware build (ESPHome bedjet control
// for a BedJet 3 on an M5Stack Atom Lite) that this page runs on.

/* ============ Part A — home-screen dressing (from stage 2.2) == */
(function () {
  function addMeta(name, content) {
    if (document.querySelector('meta[name="' + name + '"]')) return;
    var m = document.createElement("meta");
    m.setAttribute("name", name);
    m.setAttribute("content", content);
    document.head.appendChild(m);
  }
  addMeta("apple-mobile-web-app-capable", "yes");
  addMeta("mobile-web-app-capable", "yes");
  addMeta("apple-mobile-web-app-status-bar-style", "black-translucent");
  addMeta("apple-mobile-web-app-title", "BedJet");
  addMeta("theme-color", "#101216");
  addMeta("viewport",
    "width=device-width, initial-scale=1, viewport-fit=cover");

  try {
    var c = document.createElement("canvas");
    c.width = 180; c.height = 180;
    var g = c.getContext("2d");
    var grad = g.createLinearGradient(0, 0, 0, 180);
    grad.addColorStop(0, "#ff8a3d"); grad.addColorStop(1, "#f25c05");
    g.fillStyle = grad;
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, 180, 180, 40); else g.rect(0, 0, 180, 180);
    g.fill();
    g.fillStyle = "#ffffff";
    g.font = "600 104px -apple-system, Helvetica, Arial, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("B", 90, 98);
    var url = c.toDataURL("image/png");
    var link = document.createElement("link");
    link.setAttribute("rel", "apple-touch-icon");
    link.setAttribute("href", url);
    document.head.appendChild(link);
    var fav = document.createElement("link");
    fav.setAttribute("rel", "icon");
    fav.setAttribute("href", url);
    document.head.appendChild(fav);
  } catch (e) { /* icon is decoration only */ }
})();

/* ============ Part B — the custom page ========================= */
(function () {
  "use strict";
  if (/[?&]stock(=|&|$)/.test(window.location.search)) {
    // Stock page: leave it untouched except for a way home — the
    // home-screen app has no address bar, so without this pill
    // there is no path back to the custom page (stage 3.0.1).
    var back = document.createElement("a");
    back.href = "/";
    back.textContent = "‹ BedJet App";
    back.setAttribute("style",
      "position:fixed;right:16px;" +
      "bottom:calc(env(safe-area-inset-bottom, 0px) + 16px);" +
      "z-index:2147483647;background:rgba(20,22,26,0.85);color:#fff;" +
      "font:600 15px -apple-system,system-ui,sans-serif;" +
      "padding:11px 18px;border-radius:999px;text-decoration:none;" +
      "border:1px solid rgba(255,255,255,0.35);" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.35);" +
      "-webkit-backdrop-filter:blur(20px) saturate(180%);" +
      "backdrop-filter:blur(20px) saturate(180%);");
    document.body.appendChild(back);
    return;
  }

  var CLIMATE = "/climate/" + encodeURIComponent("BedJet");
  var FAN = "/fan/" + encodeURIComponent("BedJet Fan");
  var LED = "/light/" + encodeURIComponent("Atom Status LED");
  var CONN = "/switch/" + encodeURIComponent("Enable BedJet Connection");

  var S = { climate: null, fan: null, amb: null, out: null,
            led: null, conn: null, live: false };
  var stagedF = null;      // user's chosen °F while interacting
  var stagedAt = 0;        // ms timestamp of last interaction
  var stagedTimer = null;  // re-render when the staged window ends
  var dragging = {};       // sliders currently being dragged, by key
  var lastInput = {};      // last value from each slider's input event
  var els = {};

  function toF(c) {
    var n = parseFloat(c);
    return isFinite(n) ? Math.round(n * 9 / 5 + 32) : null;
  }
  function toC(f) {
    // The BedJet's setpoint step is 0.5 C: quantise to it, so a
    // 1 F step always lands on a real device step instead of
    // rounding back to the current value — a no-op POST that left
    // the display showing a temperature the device never took.
    return Math.round((f - 32) * 5 / 9 * 2) / 2;
  }
  function numOrNull(v) {
    // Strict numeric read: null/undefined/"" are NOT 0 (the global
    // isFinite(null) is true, which once let a null brightness
    // render as a real 0%).
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function post(url) {
    // body:"" is load-bearing: the ESPHome web server answers
    // bodyless POSTs with 411 Length Required (curl api-probe,
    // stage 3.0.1); an explicit empty body sends Content-Length: 0.
    return fetch(url, { method: "POST", body: "" })
      .catch(function () {});
  }
  function setClimate(params) {
    var q = Object.keys(params).map(function (k) {
      return k + "=" + encodeURIComponent(params[k]);
    }).join("&");
    return post(CLIMATE + "/set?" + q);
  }
  function minF() {
    var f = S.climate ? toF(S.climate.min_temp) : null;
    // Sanitise device-reported bounds: anything outside a sane
    // room-heating span, or missing, falls back to the BedJet's
    // documented 66–109 F range.
    return f !== null ? clamp(f, 32, 130) : 66;
  }
  function maxF() {
    var f = S.climate ? toF(S.climate.max_temp) : null;
    return f !== null ? clamp(f, 32, 130) : 109;
  }
  function boundsF() {
    var lo = minF(), hi = maxF();
    if (!(lo < hi)) { lo = 66; hi = 109; }  // inverted/degenerate report
    return [lo, hi];
  }
  function deviceTargetF() {
    // Null until the device actually reports a setpoint. This used
    // to fall back to a fabricated 79 F, which the page rendered as
    // the real target and the +/− buttons POSTed — silently
    // overwriting the BedJet's actual setpoint before any state
    // had arrived. Unknown must look unknown.
    return S.climate ? toF(S.climate.target_temperature) : null;
  }
  function displayTargetF() {
    if (stagedF !== null && Date.now() - stagedAt < 4000) return stagedF;
    return deviceTargetF();
  }
  function armStagedTimer() {
    // displayTargetF() masks the device value for 4 s after an
    // interaction; without a timer, a page that receives no
    // further /events packet would show the staged value forever.
    // While the user is still holding the temp slider, re-arm
    // instead of rendering — expiring mid-drag would snap the
    // hero readout back to the device value under their thumb.
    if (stagedTimer) clearTimeout(stagedTimer);
    stagedTimer = setTimeout(function () {
      if (dragging.temp) armStagedTimer(); else render();
    }, 4200);
  }
  function setTargetF(f) {
    if (!isFinite(f)) return;
    // A known device setpoint is the permission to send — a
    // staged value left over from an earlier interaction is not.
    if (deviceTargetF() === null) return;
    var b = boundsF();
    stagedF = clamp(Math.round(f), b[0], b[1]);
    stagedAt = Date.now();
    armStagedTimer();
    render();
    setClimate({ target_temperature: toC(stagedF) });
  }

  /* ---------- DOM ---------- */
  var HTML =
    '<div id="bj-bg"></div>' +
    '<main id="bj-main">' +
      '<header id="bj-head"><div id="bj-conn"></div>' +
        '<h1>BedJet</h1><div id="bj-status">Connecting…</div></header>' +
      '<div id="bj-hero"><span id="bj-target">--</span>' +
        '<span class="deg">°F</span></div>' +
      '<div id="bj-sub">Room — · Unit —</div>' +
      '<section id="bj-tempctl">' +
        '<button class="step glass" id="bj-minus" aria-label="Temperature down">−</button>' +
        '<input class="bj-slider" id="bj-slider" type="range" min="66" max="109" step="1" value="79">' +
        '<button class="step glass" id="bj-plus" aria-label="Temperature up">+</button>' +
      '</section>' +
      '<nav id="bj-modes" class="glass">' +
        '<button data-m="OFF">Off</button>' +
        '<button data-m="HEAT">Heat</button>' +
        '<button data-m="FAN_ONLY">Cool</button>' +
        '<button data-m="BOOST">Turbo</button>' +
      '</nav>' +
      '<section id="bj-stats">' +
        '<div class="stat glass"><label>Room</label><span id="bj-st-room">—</span></div>' +
        '<div class="stat glass"><label>Unit</label><span id="bj-st-out">—</span></div>' +
        '<div class="stat glass"><label>Fan</label><span id="bj-st-fan">—</span></div>' +
      '</section>' +
      '<button id="bj-adv-btn" class="glass">Advanced Settings</button>' +
    '</main>' +
    '<div id="bj-backdrop"></div>' +
    '<section id="bj-sheet" aria-hidden="true">' +
      '<div id="bj-grab"></div>' +
      '<h2>Advanced Settings <button id="bj-done">Done</button></h2>' +
      '<div class="gtitle">More Modes</div>' +
      '<div class="group">' +
        '<div class="row"><span>Dry</span><button class="act" id="bj-dry">Start</button></div>' +
        '<div class="row"><span>Fan Only</span><button class="act" id="bj-fanonly">Start</button></div>' +
      '</div>' +
      '<div class="gtitle">Fan Speed</div>' +
      '<div class="group"><div class="row">' +
        '<input class="bj-slider" id="bj-fanslider" type="range" min="0" max="100" step="5" value="0">' +
        '<span class="slider-val" id="bj-fanval">0%</span>' +
      '</div></div>' +
      '<p class="hint">Direct fan control, same as the stock page. While heating, the BedJet mostly runs the fan at its own chosen speed.</p>' +
      '<div class="gtitle">Presets</div>' +
      '<div class="group">' +
        '<div class="row"><span>Extended Heat</span><button class="act" data-preset="EXT HT">Start</button></div>' +
        '<div class="row"><span>Memory 1</span><button class="act" data-preset="M1">Start</button></div>' +
        '<div class="row"><span>Memory 2</span><button class="act" data-preset="M2">Start</button></div>' +
        '<div class="row"><span>Memory 3</span><button class="act" data-preset="M3">Start</button></div>' +
      '</div>' +
      '<p class="hint">Presets are the BedJet\u2019s own stored programs (set them up in the BedJet app or with the remote).</p>' +
      '<div class="gtitle">Atom</div>' +
      '<div class="group">' +
        '<div class="row"><span>BedJet Connection</span><button class="tgl" id="bj-conn-tgl" role="switch" aria-checked="false" aria-label="BedJet connection"></button></div>' +
        '<div class="row"><span>Status LED</span><button class="tgl" id="bj-led-tgl" role="switch" aria-checked="false" aria-label="Status LED"></button></div>' +
        '<div class="row"><span>LED Brightness</span><input class="bj-slider" id="bj-ledslider" type="range" min="0" max="255" step="1" value="255"><span class="slider-val" id="bj-ledval">100%</span></div>' +
      '</div>' +
      '<div class="gtitle">Page</div>' +
      '<div class="group">' +
        '<div class="row"><span>Reload Page</span><button class="act" id="bj-reload">Reload</button></div>' +
        '<div class="row"><span>Stock Controls</span><a href="/?stock=1">Open ›</a></div>' +
      '</div>' +
      '<p id="bj-foot">BedJet Atom · bedjet-atom.local · Stage 3.0.2<br>' +
      'The stock page stays available at ?stock=1.</p>' +
    '</section>';

  function build() {
    document.title = "BedJet";
    var app = document.createElement("div");
    app.id = "bj-app";
    app.innerHTML = HTML;
    document.body.appendChild(app);
    // Sweep the stock UI out (its scripts have already run).
    Array.prototype.slice.call(document.body.children).forEach(function (el) {
      if (el !== app && el.tagName !== "SCRIPT") el.remove();
    });
    ["conn", "status", "target", "sub", "slider", "minus", "plus",
     "st-room", "st-out", "st-fan", "adv-btn", "backdrop", "sheet",
     "done", "dry", "fanonly", "fanslider", "fanval", "conn-tgl",
     "led-tgl", "ledslider", "ledval", "reload"].forEach(function (id) {
      els[id] = document.getElementById("bj-" + id);
    });
    els.modes = document.querySelectorAll("#bj-modes button");
    els.presets = document.querySelectorAll("[data-preset]");
    wire();
    try { if (window.source) window.source.close(); } catch (e) {}
    connect();
    render();
  }

  function trackDrag(el, key) {
    // Render must not fight a thumb the user is holding — but
    // mere focus is not holding: a slider that keeps focus after
    // a drag would otherwise never re-sync with the device.
    el.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging[key] = true;
    });
    ["pointerup", "blur"].forEach(function (ev) {
      el.addEventListener(ev, function () { dragging[key] = false; });
    });
    el.addEventListener("pointercancel", function () {
      // A cancelled drag (e.g. the sheet scroll steals the
      // gesture) sends nothing: drop any staged temp value and
      // re-sync every slider from the device state, or the
      // unsent thumb position would sit there looking real.
      dragging[key] = false;
      delete lastInput[key];
      if (key === "temp") stagedF = null;
      render();
    });
  }
  // Backstop: a release outside the slider might not deliver
  // pointerup to it (the change handler also clears the flag, and
  // range inputs fire change on release — this is the third net).
  ["pointerup", "pointercancel"].forEach(function (ev) {
    window.addEventListener(ev, function () {
      dragging.temp = dragging.fan = dragging.led = false;
    });
  });
  function wire() {
    trackDrag(els.slider, "temp");
    trackDrag(els.fanslider, "fan");
    trackDrag(els.ledslider, "led");
    els.minus.addEventListener("click", function () {
      var t = displayTargetF();
      if (t === null) return;
      setTargetF(t - 1);
    });
    els.plus.addEventListener("click", function () {
      var t = displayTargetF();
      if (t === null) return;
      setTargetF(t + 1);
    });
    els.slider.addEventListener("input", function () {
      var v = parseInt(els.slider.value, 10);
      if (!isFinite(v)) return;
      if (deviceTargetF() === null) return;
      var b = boundsF();
      stagedF = clamp(v, b[0], b[1]);
      stagedAt = Date.now();
      lastInput.temp = stagedF;
      armStagedTimer();
      render();
    });
    els.slider.addEventListener("change", function () {
      dragging.temp = false;
      // Prefer the value captured on input: a state packet
      // landing between pointerup and change could otherwise
      // re-render the slider back to the device value first, and
      // the change would post that instead of the user's choice.
      var v = lastInput.temp !== undefined
        ? lastInput.temp : parseInt(els.slider.value, 10);
      delete lastInput.temp;
      setTargetF(v);
    });
    Array.prototype.forEach.call(els.modes, function (b) {
      b.addEventListener("click", function () {
        var m = b.getAttribute("data-m");
        if (m === "BOOST") setClimate({ preset: "BOOST" });
        else setClimate({ mode: m });
      });
    });
    els["adv-btn"].addEventListener("click", function () { sheet(true); });
    els.done.addEventListener("click", function () { sheet(false); });
    els.backdrop.addEventListener("click", function () { sheet(false); });
    els.dry.addEventListener("click", function () {
      setClimate({ mode: "DRY" });
    });
    els.fanonly.addEventListener("click", function () {
      setClimate({ mode: "FAN_ONLY" });
    });
    Array.prototype.forEach.call(els.presets, function (b) {
      b.addEventListener("click", function () {
        setClimate({ preset: b.getAttribute("data-preset") });
      });
    });
    els.fanslider.addEventListener("input", function () {
      els.fanval.textContent = els.fanslider.value + "%";
      lastInput.fan = parseInt(els.fanslider.value, 10);
    });
    els.fanslider.addEventListener("change", function () {
      dragging.fan = false;
      var pct = lastInput.fan !== undefined
        ? lastInput.fan : parseInt(els.fanslider.value, 10);
      delete lastInput.fan;
      var level = Math.round(pct / 5);
      if (level <= 0) post(FAN + "/turn_off");
      else post(FAN + "/turn_on?speed_level=" + level);
    });
    els["conn-tgl"].addEventListener("click", function () {
      var on = els["conn-tgl"].getAttribute("aria-checked") === "true";
      post(CONN + (on ? "/turn_off" : "/turn_on"));
    });
    els["led-tgl"].addEventListener("click", function () {
      var on = els["led-tgl"].getAttribute("aria-checked") === "true";
      post(LED + (on ? "/turn_off" : "/turn_on"));
    });
    els.ledslider.addEventListener("input", function () {
      els.ledval.textContent =
        Math.round(parseInt(els.ledslider.value, 10) / 255 * 100) + "%";
      lastInput.led = parseInt(els.ledslider.value, 10);
    });
    els.ledslider.addEventListener("change", function () {
      dragging.led = false;
      var v = lastInput.led !== undefined
        ? lastInput.led : parseInt(els.ledslider.value, 10);
      delete lastInput.led;
      if (v <= 0) post(LED + "/turn_off");
      else post(LED + "/turn_on?brightness=" + v);
    });
    els.reload.addEventListener("click", function () {
      window.location.reload();
    });
  }

  function sheet(open) {
    els.sheet.classList.toggle("open", open);
    els.backdrop.classList.toggle("open", open);
    els.sheet.setAttribute("aria-hidden", open ? "false" : "true");
  }

  /* ---------- Live state ---------- */
  function connect() {
    var es = new EventSource("/events");
    es.addEventListener("state", function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || !d.id) return;
      var key = {
        "climate/BedJet": "climate",
        "fan/BedJet Fan": "fan",
        "sensor/BedJet Ambient Temperature": "amb",
        "sensor/BedJet Outlet Temperature": "out",
        "light/Atom Status LED": "led",
        "switch/Enable BedJet Connection": "conn"
      }[d.id];
      if (!key) return;
      var merged = {};
      var prev = S[key] || {};
      Object.keys(prev).forEach(function (k) { merged[k] = prev[k]; });
      Object.keys(d).forEach(function (k) { merged[k] = d[k]; });
      if (key === "climate" && d.mode && !("preset" in d)) {
        // A climate packet is a full snapshot of the climate
        // entity, and ESPHome omits "preset" from it when no
        // preset is active — so an omitted preset means NO preset,
        // whatever the previous packet said. The shallow merge
        // above would otherwise keep a stale BOOST alive and
        // render "Turbo" over a bed that has left it: first seen
        // when a mode change cleared the preset, but a preset can
        // also end while the mode stays the same (BOOST expiring
        // in HEAT, or Heat re-selected while Turbo is running).
        // Preset is display-only here — it is never used to build
        // a control POST — so clearing on omission cannot send
        // anything; it can only stop showing a state the device
        // no longer reports.
        merged.preset = undefined;
      }
      S[key] = merged;
      render();
    });
    es.onopen = function () { S.live = true; render(); };
    es.onerror = function () { S.live = false; render(); };
  }

  /* ---------- Render ---------- */
  function sliderFill(input) {
    var min = parseFloat(input.min), max = parseFloat(input.max);
    var p = (parseFloat(input.value) - min) / (max - min) * 100;
    if (!isFinite(p)) p = 0;
    p = clamp(p, 0, 100);
    input.style.background =
      "linear-gradient(90deg, rgba(255,255,255,0.92) " + p +
      "%, rgba(255,255,255,0.25) " + p + "%)";
  }
  function statusWord(c) {
    if (!c || !c.mode) return "Connecting…";
    if (c.preset === "BOOST" && c.mode === "HEAT") return "Turbo Heat";
    switch (c.mode) {
      case "OFF": return "Off";
      case "HEAT": return c.action === "HEATING" ? "Heating" : "Heat";
      case "FAN_ONLY": return "Cooling";
      case "DRY": return c.action === "DRYING" ? "Drying" : "Dry";
      default: return c.mode;
    }
  }
  function render() {
    if (!els.status) return;
    var c = S.climate;
    var mode = c && c.mode ? c.mode : null;
    var turbo = !!(c && c.preset === "BOOST" && mode === "HEAT");
    document.body.setAttribute("data-mode",
      !mode || mode === "OFF" ? "off" :
      turbo ? "turbo" :
      mode === "HEAT" ? "heat" :
      mode === "FAN_ONLY" ? "cool" :
      mode === "DRY" ? "dry" : "off");
    els.conn.className = S.live ? "live" : "";
    els.status.textContent = S.live ? statusWord(c)
      : "Reconnecting…";
    var t = displayTargetF();
    els.target.textContent = t === null ? "--" : t;
    var room = (S.amb && S.amb.value !== undefined)
      ? toF(S.amb.value) : null;
    var out = (S.out && S.out.value !== undefined)
      ? toF(S.out.value) : null;
    var cur = c ? toF(c.current_temperature) : room;
    if (cur === null) cur = room;
    els.sub.textContent =
      "Room " + (cur !== null ? cur + "°" : "—") +
      " · Unit " + (out !== null ? out + "°" : "—");
    els["st-room"].textContent = room !== null ? room + "°" : "—";
    els["st-out"].textContent = out !== null ? out + "°" : "—";
    var fanTxt = "—";
    if (S.fan) {
      var lvl = numOrNull(S.fan.speed_level);
      var cnt = numOrNull(S.fan.speed_count) || 20;
      fanTxt = S.fan.value
        ? (lvl !== null ? Math.round(lvl * 100 / cnt) + "%" : "—")
        : "Off";
    }
    els["st-fan"].textContent = fanTxt;
    var b = boundsF();
    els.slider.min = b[0];
    els.slider.max = b[1];
    // While the setpoint is unknown the slider must not sit at a
    // plausible-looking value: the HTML default (79) would paint
    // the thumb and fill at a temperature the device never
    // reported. Park it at the minimum with an empty fill and
    // disable it until the first climate packet arrives.
    // Disabled tracks the DEVICE value, not the staged display
    // mask: if the device setpoint becomes unknown, the control
    // is out of service immediately, staged window or not.
    els.slider.disabled = (deviceTargetF() === null);
    if (t === null) {
      if (!dragging.temp) els.slider.value = b[0];
    } else if (!dragging.temp) {
      els.slider.value = t;
    }
    sliderFill(els.slider);
    Array.prototype.forEach.call(els.modes, function (b) {
      var m = b.getAttribute("data-m");
      var on = (m === "BOOST") ? turbo : (mode === m);
      b.classList.toggle("on", !!on);
    });
    // Advanced sheet state
    els.dry.textContent = mode === "DRY" ? "On" : "Start";
    els.dry.classList.toggle("on", mode === "DRY");
    els.fanonly.textContent = mode === "FAN_ONLY" ? "On" : "Start";
    els.fanonly.classList.toggle("on", mode === "FAN_ONLY");
    if (S.fan && !dragging.fan) {
      var flvl = numOrNull(S.fan.speed_level);
      var fcnt = numOrNull(S.fan.speed_count) || 20;
      var pct = S.fan.value && flvl !== null
        ? Math.round(flvl * 100 / fcnt) : 0;
      els.fanslider.value = pct;
      els.fanval.textContent = pct + "%";
      sliderFill(els.fanslider);
    }
    if (S.conn) {
      els["conn-tgl"].setAttribute("aria-checked",
        S.conn.value ? "true" : "false");
    }
    els.ledslider.disabled = !S.led;
    if (S.led) {
      var ledOn = S.led.state === "ON" || S.led.value === "ON";
      els["led-tgl"].setAttribute("aria-checked",
        ledOn ? "true" : "false");
      var bright = numOrNull(S.led.brightness);
      if (!dragging.led) {
        if (bright !== null) {
          els.ledslider.value = bright;
          els.ledval.textContent =
            Math.round(bright / 255 * 100) + "%";
        } else {
          // Brightness not reported (e.g. LED off): unknown must
          // look unknown — not the HTML default 255 / "100%".
          els.ledslider.value = 0;
          els.ledval.textContent = "—";
        }
        sliderFill(els.ledslider);
      }
    } else if (!dragging.led) {
      els.ledslider.value = 0;
      els.ledval.textContent = "—";
      sliderFill(els.ledslider);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
