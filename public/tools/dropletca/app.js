/*
 * app.js — UI for DropletCA.
 *
 * Wires the canvas viewer to the geometry module. The working model is a list
 * of committed droplets plus at most one droplet being placed:
 *
 *   state.droplets  measurements already accepted, each with its own points,
 *                   fitted circles, results and the settings they were taken
 *                   under. Drawn persistently on the image.
 *   state.points    the droplet currently being placed (0-6 points).
 *   state.selected  index into state.droplets, or -1.
 *
 * Enter accepts the droplet under construction and clears the way for the next
 * one, so a field of droplets can be worked through without leaving the image.
 * Exactly one droplet shows its readout at a time: the one being placed,
 * otherwise the selected one.
 *
 * Plain script, no modules, no dependencies.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants

  var MAX_POINTS = 6;
  var HANDLE_HIT = 11;        // CSS px within which a click grabs a handle
  var MARKER_HIT = 11;        // CSS px within which a click selects a droplet
  var CLICK_SLOP = 5;         // CSS px of movement still treated as a click
  var STORE_KEY = 'dropletca.settings.v2';
  var EXAMPLE_NAME = 'janus-droplets.jpg (example)';

  /* Where the bundled example lives. Relative by default, so the standalone
     page works from any directory including file://. A host page that serves
     the assets from elsewhere can override it with data-example-url on the
     app root. */
  function exampleURL() {
    var root = document.querySelector('[data-example-url]');
    return (root && root.getAttribute('data-example-url')) ||
      'example/janus-droplets.jpg';
  }

  /* Internal mode ids are kept short ('janus' / 'snowman') because the geometry
     module and its regression tests are keyed on them. Everything the user sees
     or exports goes through these labels instead. */
  var MODE_LABEL = {
    janus: 'Spherical Janus',
    snowman: 'Non-spherical Janus'
  };
  var MODE_SLUG = {
    janus: 'spherical-janus',
    snowman: 'non-spherical-janus'
  };

  var COLOR = {
    outerPt: '#ffc94a',
    innerPt: '#6fe3f5',
    circle: '#ffffff',
    halo: 'rgba(0,0,0,.72)',
    hc: '#d98ae8',
    fc: '#3fc0d0',
    contact: '#ff7a59',
    axis: 'rgba(255,255,255,.55)',
    scale: '#8ef58e',
    done: 'rgba(255,255,255,.5)',       // accepted, unselected
    doneInterface: '#ff9d7a',
    selected: '#ffd54a'                 // accepted, selected
  };

  // -------------------------------------------------------------------- state

  var state = {
    mode: 'janus',
    points: [],               // droplet being placed: first 3 outer, next 3 inner
    droplets: [],             // accepted measurements
    selected: -1,             // index into droplets, -1 for none
    nUpper: 1.33, nLower: 1.33, nCont: 1.33,
    riConsistent: false,
    umPerPx: null,
    imageName: '',
    tool: 'points',           // 'points' | 'pan' | 'scale'
    showLabels: true,
    scaleLine: null,          // {a, b} in image coords, while calibrating
    result: null,             // result for the droplet being placed
    nextId: 1
  };

  var el = {};
  var viewer;
  var globalsBound = false;   // window/document listeners are attached once
  var stageObserver = null;

  // ------------------------------------------------------------------ helpers

  function $(id) { return document.getElementById(id); }

  function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

  function ang(c, p) { return Math.atan2(p.y - c.y, p.x - c.x); }

  function normAngle(a) { a = a % (2 * Math.PI); return a < 0 ? a + 2 * Math.PI : a; }

  function num3(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e6 || a < 1e-3) return v.toExponential(2).replace('e+', 'e');
    if (a >= 100) return v.toFixed(1);
    if (a >= 10) return v.toFixed(2);
    return v.toFixed(3);
  }

  function fmtAng(v) { return isFinite(v) ? v.toFixed(2) : '—'; }

  function fmtRatio(v) {
    if (!isFinite(v)) return '—';
    return Math.abs(v) < 1000 ? v.toFixed(4) : num3(v);
  }

  var s = state; // shorthand used by the formatters below

  function lenUnit() { return s.umPerPx ? 'µm' : 'px'; }
  function areaUnit() { return s.umPerPx ? 'µm²' : 'px²'; }
  function volUnit() { return s.umPerPx ? 'pL' : 'px³'; }

  function lenVal(px) { return s.umPerPx ? px * s.umPerPx : px; }
  function areaVal(px2) { return s.umPerPx ? px2 * s.umPerPx * s.umPerPx : px2; }
  /* 1 µm³ = 1 fL, so µm³ / 1000 = picolitres — the natural unit for these droplets. */
  function volVal(px3) { return s.umPerPx ? (px3 * Math.pow(s.umPerPx, 3)) / 1000 : px3; }

  function fmtLen(px) { return num3(lenVal(px)); }
  function fmtArea(px2) { return num3(areaVal(px2)); }
  function fmtVol(px3) { return num3(volVal(px3)); }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function announce(msg) {
    if (el.srStatus) el.srStatus.textContent = msg;
  }

  // -------------------------------------------------------------- persistence

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode: s.mode, nUpper: s.nUpper, nLower: s.nLower, nCont: s.nCont,
        riConsistent: s.riConsistent, umPerPx: s.umPerPx, showLabels: s.showLabels
      }));
    } catch (e) { /* private browsing — settings simply do not persist */ }
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (v.mode === 'snowman' || v.mode === 'janus') s.mode = v.mode;
      ['nUpper', 'nLower', 'nCont'].forEach(function (k) {
        if (isFinite(v[k]) && v[k] > 0) s[k] = v[k];
      });
      s.riConsistent = !!v.riConsistent;
      if (isFinite(v.umPerPx) && v.umPerPx > 0) s.umPerPx = v.umPerPx;
      if (typeof v.showLabels === 'boolean') s.showLabels = v.showLabels;
    } catch (e) { /* ignore malformed storage */ }
  }

  // ------------------------------------------------------------ circle fitting

  function fitPoints(points) {
    if (points.length < MAX_POINTS) return null;
    var outer = Geom.fitCircle3(points[0], points[1], points[2]);
    var inner = Geom.fitCircle3(points[3], points[4], points[5]);
    if (!outer || !inner) return { outer: outer, inner: inner, collinear: true };
    return { outer: outer, inner: inner, collinear: false };
  }

  function measureFrom(points, opts) {
    var f = fitPoints(points);
    if (!f) return null;
    if (f.collinear) return { collinear: true, missing: !f.outer ? 'outer' : 'inner' };
    return Geom.measure({
      outer: f.outer, inner: f.inner, mode: opts.mode,
      nUpper: opts.nUpper, nLower: opts.nLower, nCont: opts.nCont,
      riCorrection: opts.riConsistent ? 'consistent' : 'legacy'
    });
  }

  function recompute() {
    s.result = measureFrom(s.points, s);
    renderResults();
    updateControls();
    viewer.render();
  }

  function copyNumbers(result, target) {
    Object.keys(result).forEach(function (k) {
      if (typeof result[k] === 'number') target[k] = result[k];
    });
    // Where the droplet sits on the image, so a row can be traced back to it.
    target.outerCx = result.outer.x;
    target.outerCy = result.outer.y;
    target.innerCx = result.inner.x;
    target.innerCy = result.inner.y;
  }

  /* Re-fit an accepted droplet from its (possibly transformed) points. Used
     after a rotate or flip, which moves every point and can change the
     upper/lower assignment, since that depends on which centre ends up lower. */
  function refitDroplet(d) {
    var r = measureFrom(d.points, {
      mode: d.mode, nUpper: d.nUpper, nLower: d.nLower, nCont: d.nCont,
      riConsistent: d.riCorrection === 'consistent'
    });
    if (r && !r.collinear) {
      d.result = r;
      copyNumbers(r, d);
    }
  }

  // ----------------------------------------------------------- image handling

  function applyImage(img, name, revokeUrl) {
    viewer.setImage(img);
    s.imageName = name || '';
    s.points = [];
    s.scaleLine = null;
    s.result = null;
    s.selected = -1;
    setTool('points');
    el.dropzone.classList.add('hidden');
    el.toolbar.classList.remove('hidden');
    el.statusbar.classList.remove('hidden');
    el.canvas.classList.remove('is-empty');
    el.imageName.textContent = s.imageName + ' · ' +
      viewer.imageSize().w + '×' + viewer.imageSize().h;
    recompute();
    renderTable();
    announce('Image loaded. Click three points on the outer droplet edge.');
    if (revokeUrl) setTimeout(function () { URL.revokeObjectURL(revokeUrl); }, 2000);
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      alert('That does not look like an image file.\n\n' +
        (/\.tiff?$/i.test(file.name)
          ? 'Browsers cannot decode TIFF files. Export it to PNG or JPEG first — in ImageJ/Fiji, File → Save As → PNG.'
          : 'Use PNG, JPEG, WebP, GIF or BMP.'));
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { applyImage(img, file.name || '', url); };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      alert('This browser could not decode that image. Try exporting it as PNG or JPEG.');
    };
    img.src = url;
  }

  /* Load a bundled image by URL. Uses an <img> rather than fetch() so the
     example still works when the page is opened straight off disk. */
  function loadURL(url, name) {
    var img = new Image();
    img.onload = function () { applyImage(img, name, null); };
    img.onerror = function () { alert('Could not load the example image (' + url + ').'); };
    img.src = url;
  }

  function pickFile() { el.fileInput.click(); }

  // ---------------------------------------------------------- droplet helpers

  /* Accepted droplets of the current mode, in table order. */
  function dropletsForMode() {
    return s.droplets.filter(function (d) { return d.mode === s.mode; });
  }

  /* Those also belonging to the image on screen — the ones we can draw. */
  function dropletsOnImage() {
    return dropletsForMode().filter(function (d) { return d.image === s.imageName; });
  }

  function selectedDroplet() {
    var d = s.droplets[s.selected];
    return (d && d.mode === s.mode) ? d : null;
  }

  function selectDroplet(idx, reveal) {
    s.selected = idx;
    var d = selectedDroplet();
    if (reveal && d && d.image === s.imageName && d.result && d.result.outer) {
      // Bring it into view if it is off-screen, so the row always points at
      // something the user can actually see.
      if (!viewer.isOnScreen(d.result.outer, 40)) viewer.centerOn(d.result.outer);
    }
    renderResults();
    renderTable();
    updateControls();
    viewer.render();
    if (d) {
      var list = dropletsForMode();
      announce('Droplet ' + (list.indexOf(d) + 1) + ' of ' + list.length + ' selected.');
    }
  }

  function stepSelection(delta) {
    var list = dropletsForMode();
    if (!list.length) return;
    var cur = list.indexOf(selectedDroplet());
    var next = cur < 0 ? (delta > 0 ? 0 : list.length - 1)
      : Math.min(list.length - 1, Math.max(0, cur + delta));
    selectDroplet(s.droplets.indexOf(list[next]), true);
  }

  // ------------------------------------------------------------ overlay paint

  /* Stroke a path twice — dark halo underneath, bright line on top — so the
     annotation stays readable over both dark and bright-field images. */
  function strokeHalo(ctx, build, color, width, dash) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = COLOR.halo;
    ctx.lineWidth = width + 2.4;
    build();
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    build();
    ctx.stroke();
    ctx.restore();
  }

  /* Append the arc of (c, r) between the two angles whose midpoint passes
     `test`, so region boundaries pick the correct side without special cases. */
  function arcPick(ctx, c, r, a1, a2, test) {
    for (var i = 0; i < 2; i++) {
      var ccw = i === 1;
      var sweep = ccw ? normAngle(a1 - a2) : normAngle(a2 - a1);
      var mid = ccw ? a1 - sweep / 2 : a1 + sweep / 2;
      if (test({ x: c.x + r * Math.cos(mid), y: c.y + r * Math.sin(mid) })) {
        ctx.arc(c.x, c.y, r, a1, a2, ccw);
        return;
      }
    }
    ctx.arc(c.x, c.y, r, a1, a2, false);
  }

  function lensPath(ctx, so, Ro, si, Ri, i1, i2) {
    ctx.moveTo(i1.x, i1.y);
    arcPick(ctx, so, Ro, ang(so, i1), ang(so, i2), function (p) { return dist(p, si) < Ri; });
    arcPick(ctx, si, Ri, ang(si, i2), ang(si, i1), function (p) { return dist(p, so) < Ro; });
    ctx.closePath();
  }

  /* Just the physical interface: the arc of the inner circle lying inside the
     droplet. This is all an accepted droplet keeps — the rest of the inner
     circle is construction geometry, only useful while placing points. */
  function interfaceArc(ctx, so, Ro, si, Ri, i1, i2) {
    ctx.moveTo(i1.x, i1.y);
    arcPick(ctx, si, Ri, ang(si, i1), ang(si, i2), function (p) { return dist(p, so) < Ro; });
  }

  /* Screen-space geometry for a result, or null if it cannot be drawn. */
  function screenGeom(vw, r) {
    if (!r || r.collinear || !r.outer || !r.inner) return null;
    return {
      so: vw.toScreen(r.outer),
      si: vw.toScreen(r.inner),
      Ro: r.outer.r * vw.scale,
      Ri: r.inner.r * vw.scale,
      i1: r.intersections ? vw.toScreen(r.intersections[0]) : null,
      i2: r.intersections ? vw.toScreen(r.intersections[1]) : null
    };
  }

  function drawPhaseTints(ctx, r, g) {
    if (!g.i1 || !r.valid) return;
    var lensColor, restColor;
    if (r.mode === 'janus') {
      // The lens (drop ∩ inner ball) is the lower side when the inner centre
      // sits lower in the image, and the upper side otherwise.
      lensColor = r.innerBelow ? COLOR.fc : COLOR.hc;
      restColor = r.innerBelow ? COLOR.hc : COLOR.fc;
    } else {
      lensColor = COLOR.fc;
      restColor = COLOR.hc;
    }
    ctx.globalAlpha = 0.20;
    ctx.beginPath();
    ctx.arc(g.so.x, g.so.y, g.Ro, 0, 2 * Math.PI);
    lensPath(ctx, g.so, g.Ro, g.si, g.Ri, g.i1, g.i2);
    ctx.fillStyle = restColor;
    ctx.fill('evenodd');            // remainder = disc minus lens
    ctx.beginPath();
    lensPath(ctx, g.so, g.Ro, g.si, g.Ri, g.i1, g.i2);
    ctx.fillStyle = lensColor;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawContactLine(ctx, g, k, color) {
    if (!g.i1) return;
    strokeHalo(ctx, function () {
      ctx.beginPath();
      ctx.moveTo(g.i1.x, g.i1.y);
      ctx.lineTo(g.i2.x, g.i2.y);
    }, color, 1.6 * k);
    [g.i1, g.i2].forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2 * k, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.strokeStyle = COLOR.halo;
      ctx.lineWidth = 1.2 * k;
      ctx.fill();
      ctx.stroke();
    });
  }

  /* An accepted droplet: outer boundary, the interface line, and its number.
     Tints, contact line and readout are reserved for the selected one. */
  function drawAccepted(ctx, vw, d, number, isSelected, k) {
    var r = d.result;
    var g = screenGeom(vw, r);
    if (!g) return;

    // Skip anything well outside the viewport — keeps large fields cheap to draw.
    if (g.so.x + g.Ro < -40 || g.so.x - g.Ro > vw.cssWidth + 40 ||
        g.so.y + g.Ro < -40 || g.so.y - g.Ro > vw.cssHeight + 40) return;

    if (isSelected) drawPhaseTints(ctx, r, g);

    strokeHalo(ctx, function () {
      ctx.beginPath();
      ctx.arc(g.so.x, g.so.y, g.Ro, 0, 2 * Math.PI);
    }, isSelected ? COLOR.selected : COLOR.done, (isSelected ? 2.1 : 1.3) * k);

    if (g.i1) {
      strokeHalo(ctx, function () {
        ctx.beginPath();
        interfaceArc(ctx, g.so, g.Ro, g.si, g.Ri, g.i1, g.i2);
      }, isSelected ? COLOR.contact : COLOR.doneInterface, (isSelected ? 2.1 : 1.4) * k);
    }

    if (isSelected) drawContactLine(ctx, g, k, COLOR.contact);

    // Number badge at the droplet centre, matching the # column in the table.
    var rad = (isSelected ? 9 : 7.5) * k;
    ctx.beginPath();
    ctx.arc(g.so.x, g.so.y, rad, 0, 2 * Math.PI);
    ctx.fillStyle = isSelected ? COLOR.selected : 'rgba(0,0,0,.62)';
    ctx.strokeStyle = isSelected ? COLOR.halo : 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1.3 * k;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isSelected ? '#151515' : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + ((isSelected ? 11 : 9.5) * k).toFixed(1) + 'px system-ui, sans-serif';
    ctx.fillText(String(number), g.so.x, g.so.y + 0.5 * k);
  }

  /* The droplet being placed: full construction circles, handles, tints. */
  function drawActive(ctx, vw, r, k) {
    var g = screenGeom(vw, r);
    if (g) {
      drawPhaseTints(ctx, r, g);

      strokeHalo(ctx, function () {
        ctx.beginPath();
        ctx.moveTo(g.so.x, g.so.y);
        ctx.lineTo(g.si.x, g.si.y);
      }, COLOR.axis, 1 * k, [5 * k, 4 * k]);

      if (r.mode === 'janus' && isFinite(r.tiltAngle) && r.tiltAngle > 0.5) {
        strokeHalo(ctx, function () {
          ctx.beginPath();
          ctx.moveTo(g.so.x, g.so.y);
          ctx.lineTo(g.so.x, g.si.y);
        }, COLOR.axis, 1 * k, [2 * k, 4 * k]);
      }

      strokeHalo(ctx, function () {
        ctx.beginPath();
        ctx.arc(g.so.x, g.so.y, g.Ro, 0, 2 * Math.PI);
      }, COLOR.circle, 1.6 * k);

      // The full inner circle stays visible only while placing, as a guide.
      strokeHalo(ctx, function () {
        ctx.beginPath();
        ctx.arc(g.si.x, g.si.y, g.Ri, 0, 2 * Math.PI);
      }, COLOR.circle, 1.6 * k, r.mode === 'janus' ? [7 * k, 5 * k] : null);

      drawContactLine(ctx, g, k, COLOR.contact);

      [g.so, g.si].forEach(function (c) {
        strokeHalo(ctx, function () {
          ctx.beginPath();
          ctx.moveTo(c.x - 5 * k, c.y); ctx.lineTo(c.x + 5 * k, c.y);
          ctx.moveTo(c.x, c.y - 5 * k); ctx.lineTo(c.x, c.y + 5 * k);
        }, COLOR.circle, 1.3 * k);
      });
    }

    s.points.forEach(function (p, i) {
      var sp = vw.toScreen(p);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 5.5 * k, 0, 2 * Math.PI);
      ctx.fillStyle = i < 3 ? COLOR.outerPt : COLOR.innerPt;
      ctx.strokeStyle = COLOR.halo;
      ctx.lineWidth = 1.6 * k;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + (9 * k).toFixed(1) + 'px system-ui, sans-serif';
      ctx.fillText(String(i + 1), sp.x, sp.y + 0.5 * k);
    });
  }

  function drawOverlay(ctx, vw, exportMode) {
    if (!vw.hasImage()) return;
    var k = exportMode ? Math.max(1, vw.imageSize().w / 1100) : 1;  // line-width scale

    ctx.save();

    // 1. accepted droplets on this image, the selected one last so it wins.
    var list = dropletsForMode();
    var sel = selectedDroplet();
    dropletsOnImage().forEach(function (d) {
      if (d !== sel) drawAccepted(ctx, vw, d, list.indexOf(d) + 1, false, k);
    });
    if (sel && sel.image === s.imageName) {
      drawAccepted(ctx, vw, sel, list.indexOf(sel) + 1, true, k);
    }

    // 2. the droplet under construction.
    var active = (s.result && !s.result.collinear) ? s.result : null;
    if (active || s.points.length) drawActive(ctx, vw, active, k);

    // 3. exactly one readout: the droplet being placed, else the selected one.
    if (s.showLabels) {
      var labelFor = active;
      var labelNum = null;
      if (!labelFor && sel && sel.image === s.imageName) {
        labelFor = sel.result;
        labelNum = list.indexOf(sel) + 1;
      }
      if (labelFor) {
        var lg = screenGeom(vw, labelFor);
        if (lg) drawLabels(ctx, vw, labelFor, lg.so, lg.Ro, k, labelNum);
      }
    }

    // 4. calibration line and scale bar.
    if (s.scaleLine) {
      var a = vw.toScreen(s.scaleLine.a), b = vw.toScreen(s.scaleLine.b);
      strokeHalo(ctx, function () {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        [a, b].forEach(function (p) {
          var dx = b.x - a.x, dy = b.y - a.y, L = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
          var nx = -dy / L * 6 * k, ny = dx / L * 6 * k;
          ctx.moveTo(p.x - nx, p.y - ny); ctx.lineTo(p.x + nx, p.y + ny);
        });
      }, COLOR.scale, 1.6 * k);
      badge(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2 - 14 * k,
        dist(s.scaleLine.a, s.scaleLine.b).toFixed(1) + ' px', k);
    }

    if (s.umPerPx) drawScaleBar(ctx, vw, k);
    ctx.restore();
  }

  function badge(ctx, x, y, text, k) {
    ctx.save();
    ctx.font = (11 * k).toFixed(1) + 'px ui-monospace, Menlo, Consolas, monospace';
    var w = ctx.measureText(text).width + 10 * k;
    var h = 16 * k;
    ctx.fillStyle = 'rgba(0,0,0,.72)';
    ctx.beginPath();
    ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawLabels(ctx, vw, r, so, Ro, k, number) {
    var lines = [];
    if (r.mode === 'janus') {
      lines.push(['CA', fmtAng(r.contactAngle) + '°']);
      lines.push(['V_up/V_low', fmtRatio(r.vRatio)]);
      lines.push(['Janus', fmtRatio(r.janusRatio)]);
      lines.push(['R_drop', fmtLen(r.Rd) + ' ' + lenUnit()]);
      lines.push(['R_inner', fmtLen(r.Ri) + ' ' + lenUnit()]);
      lines.push(['d', fmtLen(r.d) + ' ' + lenUnit()]);
      lines.push(['tilt', fmtAng(r.tiltAngle) + '°']);
    } else {
      lines.push(['theta', fmtAng(r.snowmanAngle) + '°']);
      lines.push(['R_upper', fmtLen(r.RUpper) + ' ' + lenUnit()]);
      lines.push(['R_lower', fmtLen(r.RLower) + ' ' + lenUnit()]);
      lines.push(['d', fmtLen(r.d) + ' ' + lenUnit()]);
      lines.push(['A_up/A_low', fmtRatio(r.areaRatio)]);
      lines.push(['V_up/V_low', fmtRatio(r.vRatio)]);
      lines.push(['neck r', fmtLen(r.rContact) + ' ' + lenUnit()]);
    }

    ctx.save();
    var title = number ? ('Droplet ' + number) : null;
    var titleH = title ? 16 * k : 0;

    ctx.font = (11 * k).toFixed(1) + 'px ui-monospace, Menlo, Consolas, monospace';
    var keyW = 0, valW = 0;
    lines.forEach(function (l) {
      keyW = Math.max(keyW, ctx.measureText(l[0]).width);
      valW = Math.max(valW, ctx.measureText(l[1]).width);
    });
    var padX = 8 * k, padY = 6 * k, gap = 10 * k, lh = 14 * k;
    var w = keyW + gap + valW + padX * 2;
    if (title) {
      ctx.font = '700 ' + (11 * k).toFixed(1) + 'px system-ui, sans-serif';
      w = Math.max(w, ctx.measureText(title).width + padX * 2);
    }
    var h = lines.length * lh + padY * 2 + titleH;

    // Prefer the right of the droplet; fall back to the left, then clamp.
    var x = so.x + Ro + 12 * k;
    var y = so.y - Ro;
    if (x + w > vw.cssWidth - 4) x = so.x - Ro - 12 * k - w;
    x = Math.max(4, Math.min(x, vw.cssWidth - w - 4));
    y = Math.max(4, Math.min(y, vw.cssHeight - h - 4));

    ctx.fillStyle = 'rgba(0,0,0,.76)';
    ctx.strokeStyle = title ? COLOR.selected : 'rgba(255,255,255,.18)';
    ctx.lineWidth = (title ? 1.5 : 1) * k;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();

    ctx.textBaseline = 'middle';
    if (title) {
      ctx.font = '700 ' + (11 * k).toFixed(1) + 'px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = COLOR.selected;
      ctx.fillText(title, x + padX, y + padY + titleH / 2 - 1 * k);
    }
    ctx.font = (11 * k).toFixed(1) + 'px ui-monospace, Menlo, Consolas, monospace';
    lines.forEach(function (l, i) {
      var cy = y + padY + titleH + lh * i + lh / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.62)';
      ctx.fillText(l[0], x + padX, cy);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fff';
      ctx.fillText(l[1], x + w - padX, cy);
    });
    ctx.restore();
  }

  function drawScaleBar(ctx, vw, k) {
    // Choose a round physical length that occupies roughly a fifth of the view.
    var targetPx = (vw.cssWidth || 400) * 0.2;
    var targetUm = targetPx / vw.scale * s.umPerPx;
    var pow = Math.pow(10, Math.floor(Math.log(Math.max(1e-9, targetUm)) / Math.LN10));
    var nice = [1, 2, 5, 10].map(function (m) { return m * pow; });
    var chosen = nice[0];
    for (var i = 0; i < nice.length; i++) if (nice[i] <= targetUm) chosen = nice[i];
    var lenPx = chosen / s.umPerPx * vw.scale;
    if (!isFinite(lenPx) || lenPx < 8) return;

    var x2 = (vw.cssWidth || 400) - 16 * k, y = (vw.cssHeight || 300) - 20 * k;
    var x1 = x2 - lenPx;
    strokeHalo(ctx, function () {
      ctx.beginPath();
      ctx.moveTo(x1, y); ctx.lineTo(x2, y);
      ctx.moveTo(x1, y - 4 * k); ctx.lineTo(x1, y + 4 * k);
      ctx.moveTo(x2, y - 4 * k); ctx.lineTo(x2, y + 4 * k);
    }, '#fff', 2 * k);
    ctx.save();
    ctx.font = (11 * k).toFixed(1) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    var label = (chosen >= 1000 ? (chosen / 1000) + ' mm' : chosen + ' µm');
    ctx.strokeStyle = COLOR.halo;
    ctx.lineWidth = 3 * k;
    ctx.strokeText(label, (x1 + x2) / 2, y - 6 * k);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, (x1 + x2) / 2, y - 6 * k);
    ctx.restore();
  }

  // ---------------------------------------------------------- results panel

  function row(dt, dd, unit) {
    return '<dt>' + dt + '</dt><dd>' + dd +
      (unit ? '<span class="unit">' + unit + '</span>' : '') + '</dd>';
  }

  function renderResults() {
    var host = el.results;

    if (!viewer.hasImage()) {
      host.innerHTML = '<p class="placeholder">Load an image to begin.</p>';
      return;
    }

    // The droplet being placed takes precedence; otherwise show the selected one.
    var r = s.result;
    var heading = '';
    if (!r) {
      var sel = selectedDroplet();
      if (sel) {
        r = sel.result;
        var n = dropletsForMode().indexOf(sel) + 1;
        heading = '<p class="hint-text" style="margin:0 0 10px">Showing <strong>droplet ' + n +
          '</strong>' +
          (sel.image !== s.imageName ? ', measured on ' + esc(sel.image) : '') +
          '. Click the image to start the next one.</p>';
      }
    }

    if (!r) {
      host.innerHTML = '<p class="placeholder">' +
        (s.points.length < 3
          ? 'Click <strong>3 points along the outer droplet edge</strong> — ' +
            (3 - s.points.length) + ' to go.'
          : 'Now click <strong>3 points along the inner interface</strong> — ' +
            (MAX_POINTS - s.points.length) + ' to go.') +
        '</p>';
      return;
    }
    if (r.collinear) {
      host.innerHTML = '<div class="warning">The three ' + r.missing +
        ' points are collinear, so no circle passes through them. ' +
        'Drag one of them off the line.</div>';
      return;
    }

    var html = heading;

    if (r.mode === 'janus') {
      html += '<div class="headline">' +
        '<div class="big"><div class="k">Contact angle</div><div class="v">' +
          fmtAng(r.contactAngle) + '<span class="unit">°</span></div></div>' +
        '<div class="big"><div class="k">V<sub>upper</sub> / V<sub>lower</sub></div><div class="v">' +
          fmtRatio(r.vRatio) + '</div></div>' +
        '</div>';

      html += '<div class="metrics">';

      html += '<div class="metric-group"><h4>Angles</h4><dl>' +
        row('Contact angle', fmtAng(r.contactAngle), '°') +
        row('Tilt of centre axis', fmtAng(r.tiltAngle), '°') +
        '</dl></div>';

      html += '<div class="metric-group"><h4>Geometry</h4><dl>' +
        row('R<sub>drop</sub> (outer)', fmtLen(r.Rd), lenUnit()) +
        row('R<sub>inner</sub> (interface)', fmtLen(r.Ri), lenUnit()) +
        row('Centre distance d', fmtLen(r.d), lenUnit()) +
        row('Contact-line radius', fmtLen(r.rContact), lenUnit()) +
        row('d<sub>trip</sub> from outer centre', fmtLen(r.dTripOuter), lenUnit()) +
        row('d<sub>trip</sub> from inner centre', fmtLen(r.dTripInner), lenUnit()) +
        row('Outer cap height', fmtLen(r.hCapOuter), lenUnit()) +
        row('Position on image (x, y)',
            num3(lenVal(r.outer.x)) + ', ' + num3(lenVal(r.outer.y)), lenUnit()) +
        '</dl></div>';

      html += '<div class="metric-group"><h4>Volumes</h4><dl>' +
        row('V<sub>drop</sub>', fmtVol(r.vDrop), volUnit()) +
        row('<span class="swatch hc"></span>V<sub>upper</sub>', fmtVol(r.vUpper), volUnit()) +
        row('<span class="swatch fc"></span>V<sub>lower</sub>', fmtVol(r.vLower), volUnit()) +
        row('V<sub>upper</sub> / V<sub>lower</sub>', fmtRatio(r.vRatio)) +
        '</dl></div>';

      html += '<div class="metric-group"><h4>Surface areas</h4><dl>' +
        row('A<sub>drop</sub>', fmtArea(r.sDrop), areaUnit()) +
        row('<span class="swatch hc"></span>A<sub>upper</sub>', fmtArea(r.sUpper), areaUnit()) +
        row('<span class="swatch fc"></span>A<sub>lower</sub>', fmtArea(r.sLower), areaUnit()) +
        row('Janus ratio A<sub>upper</sub>/A<sub>lower</sub>', fmtRatio(r.janusRatio)) +
        '</dl></div>';

      html += '</div>';

      var phase = r.innerBelow ? 'below' : 'above';
      var nUsed = r.innerBelow ? 'n<sub>cont</sub>/n<sub>upper</sub>' : 'n<sub>cont</sub>/n<sub>lower</sub>';
      html += '<p class="hint-text">Assuming the droplet is aligned with gravity. ' +
        'The inner centre is <strong>' + phase + '</strong> the outer centre, so the ' +
        'correction factor used is ' + nUsed + ' = ' + r.cor.toFixed(4) +
        '. Flip the image if that is the wrong way round.</p>';

    } else {
      html += '<div class="headline">' +
        '<div class="big"><div class="k">Neck angle θ</div><div class="v">' +
          fmtAng(r.snowmanAngle) + '<span class="unit">°</span></div></div>' +
        '<div class="big"><div class="k">A<sub>upper</sub> / A<sub>lower</sub></div><div class="v">' +
          fmtRatio(r.areaRatio) + '</div></div>' +
        '</div>';

      html += '<div class="metrics">';
      html += '<div class="metric-group"><h4>Geometry</h4><dl>' +
        row('<span class="swatch hc"></span>R<sub>upper</sub>', fmtLen(r.RUpper), lenUnit()) +
        row('<span class="swatch fc"></span>R<sub>lower</sub>', fmtLen(r.RLower), lenUnit()) +
        row('Centre distance d', fmtLen(r.d), lenUnit()) +
        row('Neck radius', fmtLen(r.rContact), lenUnit()) +
        row('Fusion d/(R<sub>upper</sub>+R<sub>lower</sub>)', fmtRatio(r.fusion)) +
        row('Position on image (x, y)',
            num3(lenVal(r.outer.x)) + ', ' + num3(lenVal(r.outer.y)), lenUnit()) +
        '</dl></div>';

      html += '<div class="metric-group"><h4>Exposed surface areas</h4><dl>' +
        row('<span class="swatch hc"></span>A<sub>upper</sub>', fmtArea(r.areaUpper), areaUnit()) +
        row('<span class="swatch fc"></span>A<sub>lower</sub>', fmtArea(r.areaLower), areaUnit()) +
        row('A<sub>total</sub>', fmtArea(r.areaTotal), areaUnit()) +
        row('A<sub>upper</sub> / A<sub>lower</sub>', fmtRatio(r.areaRatio)) +
        '</dl></div>';

      html += '<div class="metric-group"><h4>Volumes</h4><dl>' +
        row('<span class="swatch hc"></span>V<sub>upper</sub>', fmtVol(r.vUpper), volUnit()) +
        row('<span class="swatch fc"></span>V<sub>lower</sub>', fmtVol(r.vLower), volUnit()) +
        row('V<sub>total</sub>', fmtVol(r.vTotal), volUnit()) +
        row('V<sub>upper</sub> / V<sub>lower</sub>', fmtRatio(r.vRatio)) +
        '</dl></div>';
      html += '</div>';
      html += '<p class="hint-text">Upper and lower are assigned by position in the ' +
        'image, assuming the droplet is aligned with gravity — not by the order you ' +
        'clicked the lobes.</p>';
    }

    if (r.warnings && r.warnings.length) {
      html += '<div class="warnings">' + r.warnings.map(function (w) {
        return '<div class="warning">' + esc(w) + '</div>';
      }).join('') + '</div>';
    }

    host.innerHTML = html;
  }

  // ------------------------------------------------------- measurement table

  var SCHEMA = {
    janus: [
      { key: 'Rd', label: 'R_drop', fmt: fmtLen, unit: lenUnit },
      { key: 'Ri', label: 'R_inner', fmt: fmtLen, unit: lenUnit },
      { key: 'd', label: 'd', fmt: fmtLen, unit: lenUnit },
      { key: 'contactAngle', label: 'CA°', fmt: fmtAng, unit: function () { return 'deg'; } },
      { key: 'vRatio', label: 'V up/low', fmt: fmtRatio, unit: function () { return ''; } },
      { key: 'janusRatio', label: 'Janus', fmt: fmtRatio, unit: function () { return ''; } },
      { key: 'tiltAngle', label: 'tilt°', fmt: fmtAng, unit: function () { return 'deg'; } },
      { key: 'outerCx', label: 'x', fmt: fmtLen, unit: lenUnit, noStats: true },
      { key: 'outerCy', label: 'y', fmt: fmtLen, unit: lenUnit, noStats: true }
    ],
    snowman: [
      { key: 'RUpper', label: 'R_up', fmt: fmtLen, unit: lenUnit },
      { key: 'RLower', label: 'R_low', fmt: fmtLen, unit: lenUnit },
      { key: 'd', label: 'd', fmt: fmtLen, unit: lenUnit },
      { key: 'snowmanAngle', label: 'θ°', fmt: fmtAng, unit: function () { return 'deg'; } },
      { key: 'rContact', label: 'neck', fmt: fmtLen, unit: lenUnit },
      { key: 'areaRatio', label: 'A up/low', fmt: fmtRatio, unit: function () { return ''; } },
      { key: 'vRatio', label: 'V up/low', fmt: fmtRatio, unit: function () { return ''; } },
      { key: 'outerCx', label: 'x', fmt: fmtLen, unit: lenUnit, noStats: true },
      { key: 'outerCy', label: 'y', fmt: fmtLen, unit: lenUnit, noStats: true }
    ]
  };

  function renderTable() {
    var rows = dropletsForMode();
    var cols = SCHEMA[s.mode];
    var sel = selectedDroplet();

    if (!rows.length) {
      el.tableArea.innerHTML = '<p class="placeholder">' +
        'Place six points, then press <strong>Enter</strong> to accept the droplet and ' +
        'move straight on to the next. Accepted droplets stay marked on the image — ' +
        'click a row here to find one again.</p>';
      return;
    }

    var html = '<div class="table-wrap"><table class="runs"><thead><tr><th>#</th>';
    cols.forEach(function (c) { html += '<th>' + c.label + '</th>'; });
    html += '<th></th></tr></thead><tbody>';

    rows.forEach(function (r, i) {
      var isSel = r === sel;
      html += '<tr class="run' + (isSel ? ' selected' : '') + '" data-idx="' +
        s.droplets.indexOf(r) + '" tabindex="0" aria-pressed="' + isSel +
        '" title="Show droplet ' + (i + 1) + ' on the image"><td>' + (i + 1) + '</td>';
      cols.forEach(function (c) { html += '<td>' + c.fmt(r[c.key]) + '</td>'; });
      html += '<td><button class="del" data-del="' + s.droplets.indexOf(r) +
        '" title="Remove droplet ' + (i + 1) +
        '" aria-label="Remove droplet ' + (i + 1) + '">×</button></td></tr>';
    });

    if (rows.length > 1) {
      ['mean', 'SD'].forEach(function (which) {
        html += '<tr class="summary"><td>' + which + '</td>';
        cols.forEach(function (c) {
          if (c.noStats) { html += '<td>—</td>'; return; }
          var vals = rows.map(function (r) { return r[c.key]; });
          html += '<td>' + c.fmt(which === 'mean' ? Geom.mean(vals) : Geom.stdev(vals)) + '</td>';
        });
        html += '<td></td></tr>';
      });
    }

    html += '</tbody></table></div>';
    el.tableArea.innerHTML = html;

    Array.prototype.forEach.call(el.tableArea.querySelectorAll('tr.run'), function (tr) {
      function choose() { selectDroplet(parseInt(tr.getAttribute('data-idx'), 10), true); }
      tr.addEventListener('click', function (ev) {
        if (ev.target.classList.contains('del')) return;
        choose();
      });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); choose(); }
      });
    });

    Array.prototype.forEach.call(el.tableArea.querySelectorAll('.del'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var idx = parseInt(b.getAttribute('data-del'), 10);
        s.droplets.splice(idx, 1);
        if (s.selected === idx) s.selected = -1;
        else if (s.selected > idx) s.selected--;
        renderResults();
        renderTable();
        updateControls();
        viewer.render();
      });
    });
  }

  /* Accept the droplet being placed and clear the way for the next one. */
  function recordMeasurement() {
    var r = s.result;
    if (!r || r.collinear || !r.valid) return;

    var d = {
      id: s.nextId++,
      mode: r.mode,
      image: s.imageName,
      points: s.points.map(function (p) { return { x: p.x, y: p.y }; }),
      result: r,
      umPerPx: s.umPerPx,
      nUpper: s.nUpper, nLower: s.nLower, nCont: s.nCont,
      riCorrection: s.riConsistent ? 'consistent' : 'legacy'
    };
    copyNumbers(r, d);
    s.droplets.push(d);

    // Clear the way for the next droplet, leaving this one selected so its
    // numbers stay on screen until the next droplet is under way.
    s.points = [];
    s.result = null;
    s.selected = s.droplets.length - 1;

    renderResults();
    renderTable();
    updateControls();
    viewer.render();
    announce('Droplet ' + dropletsForMode().length + ' accepted. Click to start the next.');
    flash(el.recordBtn, 'Accepted ✓');
  }

  // ------------------------------------------------------------------ exports

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var str = String(v);
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  /* CSV column descriptors. `kind` drives both the unit suffix and the optional
     calibrated companion column, so nothing is mislabelled. The centre
     coordinates come first: they locate each row on the image. */
  var CSV_COLUMNS = {
    janus: [
      ['outerCx', 'len'], ['outerCy', 'len'], ['innerCx', 'len'], ['innerCy', 'len'],
      ['Rd', 'len'], ['Ri', 'len'], ['d', 'len'], ['rContact', 'len'],
      ['dTripOuter', 'len'], ['dTripInner', 'len'], ['hCapOuter', 'len'], ['hCapInner', 'len'],
      ['contactAngle', 'ang'], ['tiltAngle', 'ang'],
      ['vDrop', 'vol'], ['vUpper', 'vol'], ['vLower', 'vol'], ['vRatio', 'ratio'],
      ['sDrop', 'area'], ['sUpper', 'area'], ['sLower', 'area'], ['janusRatio', 'ratio']
    ],
    snowman: [
      ['outerCx', 'len'], ['outerCy', 'len'], ['innerCx', 'len'], ['innerCy', 'len'],
      ['RUpper', 'len'], ['RLower', 'len'], ['d', 'len'], ['rContact', 'len'],
      ['snowmanAngle', 'ang'],
      ['areaUpper', 'area'], ['areaLower', 'area'], ['areaTotal', 'area'],
      ['areaRatio', 'ratio'],
      ['vUpper', 'vol'], ['vLower', 'vol'], ['vTotal', 'vol'], ['vRatio', 'ratio'],
      ['fusion', 'ratio']
    ]
  };

  var RAW_SUFFIX = { len: '_px', ang: '_deg', vol: '_px3', area: '_px2', ratio: '' };
  var CAL_SUFFIX = { len: '_um', vol: '_pL', area: '_um2' };

  function baseName() {
    return (s.imageName || 'droplet')
      .replace(/\s*\(example\)\s*$/, '')
      .replace(/\.[^.]+$/, '');
  }

  function exportCSV() {
    var rows = dropletsForMode();
    if (!rows.length) return;
    var cols = CSV_COLUMNS[s.mode];
    // Only add calibrated columns if at least one row actually carries a scale.
    var anyScale = rows.some(function (r) { return r.umPerPx != null; });

    var head = ['droplet', 'image', 'mode', 'um_per_px', 'n_upper', 'n_lower', 'n_cont', 'ri_correction'];
    cols.forEach(function (c) { head.push(c[0] + RAW_SUFFIX[c[1]]); });
    if (anyScale) {
      cols.forEach(function (c) {
        if (CAL_SUFFIX[c[1]]) head.push(c[0] + CAL_SUFFIX[c[1]]);
      });
    }

    var lines = [head.map(csvCell).join(',')];
    rows.forEach(function (r, i) {
      var out = [i + 1, r.image, MODE_SLUG[r.mode] || r.mode,
        r.umPerPx == null ? '' : r.umPerPx,
        r.nUpper, r.nLower, r.nCont, r.riCorrection];
      cols.forEach(function (c) { out.push(isFinite(r[c[0]]) ? r[c[0]] : ''); });
      if (anyScale) {
        cols.forEach(function (c) {
          if (!CAL_SUFFIX[c[1]]) return;
          var u = r.umPerPx, v = r[c[0]];
          if (u == null || !isFinite(v)) { out.push(''); return; }
          if (c[1] === 'len') out.push(v * u);
          else if (c[1] === 'area') out.push(v * u * u);
          else out.push(v * u * u * u / 1000);   // µm³ -> pL
        });
      }
      lines.push(out.map(csvCell).join(','));
    });

    download(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }),
      baseName() + '-' + MODE_SLUG[s.mode] + '.csv');
  }

  function exportPNG() {
    if (!viewer.hasImage()) return;
    var out = viewer.exportCanvas(function (ctx, vw) { drawOverlay(ctx, vw, true); });
    if (out.toBlob) {
      out.toBlob(function (blob) { download(blob, baseName() + '-measured.png'); }, 'image/png');
    } else {
      var a = document.createElement('a');
      a.href = out.toDataURL('image/png');
      a.download = baseName() + '-measured.png';
      a.click();
    }
  }

  function copySummary() {
    var rows = dropletsForMode();
    if (!rows.length) return;
    var cols = SCHEMA[s.mode];
    var lines = [];
    lines.push(['#'].concat(cols.map(function (c) {
      var u = c.unit();
      return c.label + (u ? ' (' + u + ')' : '');
    })).join('\t'));
    rows.forEach(function (r, i) {
      lines.push([i + 1].concat(cols.map(function (c) { return c.fmt(r[c.key]); })).join('\t'));
    });
    if (rows.length > 1) {
      ['mean', 'SD'].forEach(function (which) {
        lines.push([which].concat(cols.map(function (c) {
          if (c.noStats) return '';
          var vals = rows.map(function (x) { return x[c.key]; });
          return c.fmt(which === 'mean' ? Geom.mean(vals) : Geom.stdev(vals));
        })).join('\t'));
      });
    }
    var text = lines.join('\n');

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
      document.body.removeChild(ta);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flash(el.copyBtn, 'Copied');
      }, function () { fallback(); flash(el.copyBtn, 'Copied'); });
    } else {
      fallback();
      flash(el.copyBtn, 'Copied');
    }
  }

  function flash(btn, msg) {
    if (btn._restore) clearTimeout(btn._restore);
    if (btn._label === undefined) btn._label = btn.textContent;
    btn.textContent = msg;
    btn._restore = setTimeout(function () {
      btn.textContent = btn._label;
      btn._restore = null;
    }, 1100);
  }

  // -------------------------------------------------------------- interaction

  var drag = null;            // {kind, idx, start, last, moved}
  var pointers = {};          // active pointers, for pinch
  var pinch = null;
  var spaceHeld = false;

  function hitHandle(screenPt) {
    for (var i = s.points.length - 1; i >= 0; i--) {
      if (dist(viewer.toScreen(s.points[i]), screenPt) <= HANDLE_HIT) return i;
    }
    return -1;
  }

  /* An accepted droplet whose marker was clicked, so one can be picked straight
     off the image as well as from the table. */
  function hitAccepted(screenPt) {
    var list = dropletsOnImage();
    for (var i = list.length - 1; i >= 0; i--) {
      var r = list[i].result;
      if (!r || !r.outer) continue;
      if (dist(viewer.toScreen(r.outer), screenPt) <= MARKER_HIT) {
        return s.droplets.indexOf(list[i]);
      }
    }
    return -1;
  }

  function clampToImage(p) {
    var sz = viewer.imageSize();
    return { x: Geom.clamp(p.x, 0, sz.w), y: Geom.clamp(p.y, 0, sz.h) };
  }

  function onPointerDown(ev) {
    if (!viewer.hasImage()) return;
    // Capture keeps a drag alive when the pointer leaves the canvas. Some
    // browsers reject unknown pointer ids, and it is not essential.
    try {
      if (el.canvas.setPointerCapture) el.canvas.setPointerCapture(ev.pointerId);
    } catch (e) { /* proceed without capture */ }
    pointers[ev.pointerId] = viewer.eventPos(ev);

    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      pinch = { dist: Math.max(1, dist(a, b)), scale: viewer.scale };
      drag = null;
      return;
    }

    var p = viewer.eventPos(ev);
    var wantPan = ev.button === 1 || ev.button === 2 || spaceHeld || s.tool === 'pan';

    if (s.tool === 'scale' && ev.button === 0 && !spaceHeld) {
      var ip = clampToImage(viewer.toImage(p));
      s.scaleLine = { a: ip, b: ip };
      drag = { kind: 'scale', start: p, last: p, moved: false };
      viewer.render();
      return;
    }

    var hit = wantPan ? -1 : hitHandle(p);
    if (hit >= 0) {
      // Remember the original position so a click that never moved leaves it alone.
      drag = { kind: 'handle', idx: hit, start: p, last: p, moved: false,
        origin: { x: s.points[hit].x, y: s.points[hit].y } };
      el.canvas.classList.add('is-panning');
      return;
    }

    drag = { kind: wantPan ? 'pan' : 'maybe-click', start: p, last: p, moved: false };
    if (drag.kind === 'pan') el.canvas.classList.add('is-panning');
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!viewer.hasImage()) return;
    if (!(ev.pointerId in pointers) && !drag) return;
    var p = viewer.eventPos(ev);
    if (ev.pointerId in pointers) pointers[ev.pointerId] = p;

    if (pinch) {
      var ids = Object.keys(pointers);
      if (ids.length >= 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var dNow = Math.max(1, dist(a, b));
        viewer.setScale(pinch.scale * (dNow / pinch.dist),
          { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
      return;
    }

    if (!drag) {
      // Hover feedback over draggable handles and selectable droplet markers.
      var over = hitHandle(p) >= 0 || (!s.points.length && hitAccepted(p) >= 0);
      el.canvas.classList.toggle('is-pan-ready', over || spaceHeld || s.tool === 'pan');
      return;
    }

    if (dist(p, drag.start) > CLICK_SLOP) drag.moved = true;

    if (drag.kind === 'handle') {
      // Only move once past the click threshold, so sub-pixel jitter on a click
      // cannot silently nudge a point the user meant to leave alone.
      if (drag.moved) {
        s.points[drag.idx] = clampToImage(viewer.toImage(p));
        recompute();
      }
    } else if (drag.kind === 'scale') {
      s.scaleLine.b = clampToImage(viewer.toImage(p));
      viewer.render();
    } else if (drag.kind === 'pan' || (drag.kind === 'maybe-click' && drag.moved)) {
      viewer.panBy(p.x - drag.last.x, p.y - drag.last.y);
      el.canvas.classList.add('is-panning');
    }
    drag.last = p;
  }

  function onPointerUp(ev) {
    delete pointers[ev.pointerId];
    if (Object.keys(pointers).length < 2) pinch = null;
    el.canvas.classList.remove('is-panning');
    if (!drag) return;

    var d = drag;
    drag = null;

    // A click that landed on an existing handle without dragging still counts as
    // a placement while points remain — the inner interface often runs close to
    // an outer edge point, and the click should not simply vanish.
    if (d.kind === 'handle' && !d.moved) {
      if (s.points.length < MAX_POINTS) d.kind = 'maybe-click';
      else { updateControls(); return; }
    }

    if (d.kind === 'maybe-click' && !d.moved) {
      // Clicking an accepted droplet's marker selects it, but only while no
      // droplet is part-way through being placed.
      if (!s.points.length) {
        var pick = hitAccepted(d.start);
        if (pick >= 0) { selectDroplet(pick, false); return; }
      }
      if (s.points.length < MAX_POINTS) {
        s.points.push(clampToImage(viewer.toImage(d.start)));
        recompute();
        announce(s.points.length < 3
          ? 'Outer point ' + s.points.length + ' of 3.'
          : (s.points.length < MAX_POINTS
            ? 'Inner point ' + (s.points.length - 3) + ' of 3.'
            : 'Six points placed. Press Enter to accept.'));
      }
    } else if (d.kind === 'scale') {
      finishScaleLine();
    }
    updateControls();
  }

  function finishScaleLine() {
    if (!s.scaleLine) return;
    var px = dist(s.scaleLine.a, s.scaleLine.b);
    if (px < 3) { s.scaleLine = null; viewer.render(); return; }
    var answer = prompt('That line is ' + px.toFixed(2) +
      ' pixels long.\n\nHow long is it in micrometres?', '100');
    if (answer !== null) {
      var um = parseFloat(answer);
      if (isFinite(um) && um > 0) {
        s.umPerPx = um / px;
        el.umPerPx.value = parseFloat(s.umPerPx.toPrecision(6));
        saveSettings();
      } else if (answer.trim() !== '') {
        alert('Please enter a positive number of micrometres.');
      }
    }
    s.scaleLine = null;
    setTool('points');
    renderResults();
    renderTable();
    viewer.render();
  }

  function onWheel(ev) {
    if (!viewer.hasImage()) return;
    ev.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel; both gestures zoom here.
    var unit = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 100 : 1);
    viewer.zoomBy(Math.pow(0.9988, ev.deltaY * unit), viewer.eventPos(ev));
  }

  // ------------------------------------------------------------------ actions

  function undoPoint() {
    if (!s.points.length) return;
    s.points.pop();
    recompute();
  }

  function clearPoints() {
    if (!s.points.length) return;
    s.points = [];
    recompute();
    announce('Points cleared.');
  }

  function setMode(mode) {
    s.mode = mode;
    el.modeJanus.setAttribute('aria-pressed', String(mode === 'janus'));
    el.modeSnowman.setAttribute('aria-pressed', String(mode === 'snowman'));
    el.opticsSection.style.display = mode === 'janus' ? '' : 'none';
    if (!selectedDroplet()) s.selected = -1;
    saveSettings();
    recompute();
    renderTable();
  }

  function setTool(tool) {
    s.tool = tool;
    el.panTool.setAttribute('aria-pressed', String(tool === 'pan'));
    el.scaleTool.setAttribute('aria-pressed', String(tool === 'scale'));
    el.canvas.classList.toggle('is-pan-ready', tool === 'pan');
    el.canvas.classList.toggle('is-scaling', tool === 'scale');
    if (tool !== 'scale') s.scaleLine = null;
    if (viewer.hasImage()) viewer.render();
    updateHint();
  }

  function transformImage(kind) {
    if (!viewer.hasImage()) return;
    var remap = viewer.transformImage(kind);
    s.points = s.points.map(remap);
    // Accepted droplets on this image move with their pixels, and are re-fitted
    // because the upper/lower assignment depends on which centre ends up lower.
    s.droplets.forEach(function (d) {
      if (d.image !== s.imageName) return;
      d.points = d.points.map(remap);
      refitDroplet(d);
    });
    if (s.scaleLine) s.scaleLine = { a: remap(s.scaleLine.a), b: remap(s.scaleLine.b) };
    recompute();
    renderTable();
  }

  function updateHint() {
    if (!viewer.hasImage()) return;
    var txt;
    var done = dropletsForMode().length;
    var prefix = done ? '<strong>' + done + '</strong> accepted · ' : '';
    if (s.tool === 'scale') {
      txt = 'Drag a line across a <strong>known distance</strong>, then type its length';
    } else if (s.tool === 'pan') {
      txt = 'Drag to pan — switch off <strong>Pan</strong> to place points again';
    } else if (s.points.length < 3) {
      txt = prefix + 'Outer droplet edge: point <strong>' + (s.points.length + 1) + ' of 3</strong>';
    } else if (s.points.length < MAX_POINTS) {
      txt = prefix + 'Inner interface: point <strong>' + (s.points.length - 2) + ' of 3</strong>';
    } else {
      txt = 'Drag to refine · <strong>Enter</strong> to accept and start the next';
    }
    el.hint.innerHTML = txt;
    el.zoomPill.textContent = Math.round(viewer.scale * 100) + '%';
  }

  function updateControls() {
    var ready = !!(s.result && !s.result.collinear && s.result.valid);
    var rows = dropletsForMode().length;
    el.recordBtn.disabled = !ready;
    el.csvBtn.disabled = rows === 0;
    el.copyBtn.disabled = rows === 0;
    el.clearRunsBtn.disabled = rows === 0;
    el.pngBtn.disabled = !viewer.hasImage();
    el.undoBtn.disabled = s.points.length === 0;
    el.clearBtn.disabled = s.points.length === 0;
    updateHint();
  }

  // ------------------------------------------------------------------- wiring

  /*
   * Listeners that live on window or document rather than on the app's own
   * elements. They close over `el` and `viewer`, both of which are re-pointed
   * by init(), so they keep working after the host page swaps the DOM — but
   * they must only ever be attached once.
   */
  function bindGlobals() {
    if (globalsBound) return;
    globalsBound = true;

    // Dropping anywhere outside the stage should not navigate away from the app.
    window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    window.addEventListener('drop', function (ev) { ev.preventDefault(); });

    window.addEventListener('paste', function (ev) {
      if (!viewer) return;
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) { loadFile(f); ev.preventDefault(); return; }
        }
      }
    });

    window.addEventListener('keydown', function (ev) {
      if (!viewer || !el.canvas) return;
      var t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      if (ev.code === 'Space' && !spaceHeld) {
        spaceHeld = true;
        el.canvas.classList.add('is-pan-ready');
        ev.preventDefault();
        return;
      }
      if (ev.key === 'Enter') { recordMeasurement(); ev.preventDefault(); return; }
      if (ev.key === 'Escape') {
        if (s.tool !== 'points') setTool('points');
        else if (s.points.length) clearPoints();
        else if (s.selected >= 0) selectDroplet(-1, false);
        return;
      }
      if (ev.key === 'ArrowDown') { stepSelection(1); ev.preventDefault(); return; }
      if (ev.key === 'ArrowUp') { stepSelection(-1); ev.preventDefault(); return; }
      if (ev.key === '+' || ev.key === '=') { viewer.zoomBy(1.3); return; }
      if (ev.key === '-' || ev.key === '_') { viewer.zoomBy(1 / 1.3); return; }

      switch (ev.key.toLowerCase()) {
        case 'z': undoPoint(); ev.preventDefault(); break;
        case 'f': viewer.fit(); break;
        case 'r': transformImage('cw'); break;
        case 'v': transformImage('flipV'); break;
        case 'm': setMode(s.mode === 'janus' ? 'snowman' : 'janus'); break;
        case 'p': setTool(s.tool === 'pan' ? 'points' : 'pan'); break;
        case 'l': el.labelsBtn.click(); break;
      }
    });

    window.addEventListener('keyup', function (ev) {
      if (ev.code === 'Space' && el.canvas) {
        spaceHeld = false;
        el.canvas.classList.toggle('is-pan-ready', s.tool === 'pan');
      }
    });

    window.addEventListener('resize', function () {
      if (viewer) viewer.resize();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () {
        if (viewer) { viewer.resize(); viewer.fit(); }
      }, 200);
    });
  }

  function bindNumber(input, key) {
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      if (isFinite(v) && v > 0) {
        s[key] = v;
        saveSettings();
        recompute();
      }
    });
  }

  function init() {
    ['canvas', 'stage', 'dropzone', 'toolbar', 'statusbar', 'hint', 'zoomPill', 'results',
     'imageName', 'fileInput', 'browseBtn', 'exampleBtn', 'newImageBtn', 'panTool', 'scaleTool',
     'zoomInBtn', 'zoomOutBtn', 'fitBtn', 'rotBtn', 'flipBtn', 'undoBtn', 'clearBtn',
     'labelsBtn', 'modeJanus', 'modeSnowman', 'nUpper', 'nLower', 'nCont', 'riConsistent',
     'umPerPx', 'scaleBtn', 'tableArea', 'recordBtn', 'csvBtn', 'pngBtn', 'copyBtn',
     'clearRunsBtn', 'opticsSection', 'srStatus'].forEach(function (id) {
      el[id] = $(id);
    });

    viewer = new Viewer(el.canvas);
    viewer.onOverlay = function (ctx, vw) { drawOverlay(ctx, vw, false); };
    viewer.onViewChange = updateHint;

    loadSettings();
    el.nUpper.value = s.nUpper;
    el.nLower.value = s.nLower;
    el.nCont.value = s.nCont;
    el.riConsistent.checked = s.riConsistent;
    if (s.umPerPx) el.umPerPx.value = parseFloat(s.umPerPx.toPrecision(6));
    el.labelsBtn.setAttribute('aria-pressed', String(s.showLabels));
    setMode(s.mode);

    // --- file input, drag & drop, paste ---
    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files[0]) loadFile(el.fileInput.files[0]);
      el.fileInput.value = '';
    });
    el.browseBtn.addEventListener('click', pickFile);
    el.newImageBtn.addEventListener('click', pickFile);
    el.exampleBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      loadURL(exampleURL(), EXAMPLE_NAME);
    });
    el.dropzone.addEventListener('click', function (ev) {
      if (ev.target === el.dropzone || ev.target.classList.contains('frame')) pickFile();
    });

    ['dragenter', 'dragover'].forEach(function (t) {
      el.stage.addEventListener(t, function (ev) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        el.stage.classList.add('drag-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (t) {
      el.stage.addEventListener(t, function () { el.stage.classList.remove('drag-over'); });
    });
    el.stage.addEventListener('drop', function (ev) {
      ev.preventDefault();
      el.stage.classList.remove('drag-over');
      var dt = ev.dataTransfer;
      if (dt && dt.files && dt.files.length) loadFile(dt.files[0]);
    });
    bindGlobals();

    // --- canvas interaction ---
    el.canvas.addEventListener('pointerdown', onPointerDown);
    el.canvas.addEventListener('pointermove', onPointerMove);
    el.canvas.addEventListener('pointerup', onPointerUp);
    el.canvas.addEventListener('pointercancel', onPointerUp);
    el.canvas.addEventListener('pointerleave', function () {
      el.canvas.classList.remove('is-pan-ready');
    });
    el.canvas.addEventListener('wheel', onWheel, { passive: false });
    el.canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    el.canvas.addEventListener('dblclick', function (ev) {
      viewer.zoomBy(1.6, viewer.eventPos(ev));
    });

    // --- toolbar ---
    el.panTool.addEventListener('click', function () {
      setTool(s.tool === 'pan' ? 'points' : 'pan');
    });
    el.scaleTool.addEventListener('click', function () {
      setTool(s.tool === 'scale' ? 'points' : 'scale');
    });
    el.scaleBtn.addEventListener('click', function () {
      if (!viewer.hasImage()) { alert('Load an image first.'); return; }
      setTool('scale');
    });
    el.zoomInBtn.addEventListener('click', function () { viewer.zoomBy(1.3); });
    el.zoomOutBtn.addEventListener('click', function () { viewer.zoomBy(1 / 1.3); });
    el.fitBtn.addEventListener('click', function () { viewer.fit(); });
    el.rotBtn.addEventListener('click', function () { transformImage('cw'); });
    el.flipBtn.addEventListener('click', function () { transformImage('flipV'); });
    el.undoBtn.addEventListener('click', undoPoint);
    el.clearBtn.addEventListener('click', clearPoints);
    el.labelsBtn.addEventListener('click', function () {
      s.showLabels = !s.showLabels;
      el.labelsBtn.setAttribute('aria-pressed', String(s.showLabels));
      saveSettings();
      viewer.render();
    });

    // --- mode + settings ---
    el.modeJanus.addEventListener('click', function () { setMode('janus'); });
    el.modeSnowman.addEventListener('click', function () { setMode('snowman'); });
    bindNumber(el.nUpper, 'nUpper');
    bindNumber(el.nLower, 'nLower');
    bindNumber(el.nCont, 'nCont');
    el.riConsistent.addEventListener('change', function () {
      s.riConsistent = el.riConsistent.checked;
      saveSettings();
      recompute();
    });
    el.umPerPx.addEventListener('input', function () {
      var v = parseFloat(el.umPerPx.value);
      s.umPerPx = (isFinite(v) && v > 0) ? v : null;
      saveSettings();
      renderResults();
      renderTable();
      viewer.render();
    });

    // --- table actions ---
    el.recordBtn.addEventListener('click', recordMeasurement);
    el.csvBtn.addEventListener('click', exportCSV);
    el.pngBtn.addEventListener('click', exportPNG);
    el.copyBtn.addEventListener('click', copySummary);
    el.clearRunsBtn.addEventListener('click', function () {
      var n = dropletsForMode().length;
      if (n > 1 && !confirm('Remove all ' + n + ' accepted droplets?')) return;
      s.droplets = s.droplets.filter(function (d) { return d.mode !== s.mode; });
      s.selected = -1;
      renderResults();
      renderTable();
      updateControls();
      viewer.render();
    });

    // --- stage resize ---
    // Re-created per init because the stage element itself is replaced when the
    // host page swaps the DOM; the previous observer is dropped first.
    if (typeof ResizeObserver !== 'undefined') {
      if (stageObserver) stageObserver.disconnect();
      stageObserver = new ResizeObserver(function () { viewer.resize(); });
      stageObserver.observe(el.stage);
    }

    var riLink = $('riNoteLink');
    if (riLink) {
      riLink.addEventListener('click', function (ev) {
        ev.preventDefault();
        var d = document.querySelector('details.help');
        if (d) { d.open = true; $('riNote').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
    }

    viewer.resize();
    renderResults();
    renderTable();
    updateControls();
  }

  /*
   * Start up, or start up again against fresh markup. Safe to call repeatedly:
   * element listeners are rebound to the current DOM, window listeners are
   * attached only once, and measurements are reset with the markup.
   */
  function start() {
    if (!document.getElementById('canvas')) return;   // not on a page with the app
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Astro's client-side router swaps the DOM without reloading the page, so the
  // script is not re-executed and DOMContentLoaded never fires again.
  document.addEventListener('astro:page-load', start);

  window.DropletCA = { start: start };
})();
