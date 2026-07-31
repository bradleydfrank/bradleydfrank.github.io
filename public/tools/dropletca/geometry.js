/*
 * geometry.js — Janus / snowman droplet measurement math.
 *
 * Ported from the MATLAB App Designer app (matlabCA.mlapp, 2021) and
 * MatlabContactAngleVolumeRatio.m. Every formula here mirrors the MATLAB
 * source; deviations are marked with a NOTE and explained in README.md.
 *
 * Pure functions only — no DOM, no globals besides the exported namespace.
 * Loaded as a plain script (no ES modules) so the page also works over file://.
 *
 * Coordinate convention: image pixel space, x right, y DOWN (same as MATLAB
 * imshow and HTML canvas). "Below" therefore means larger y.
 */
(function (root) {
  'use strict';

  var DEG = 180 / Math.PI;

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /*
   * Circle through three points (circumcircle).
   *
   * NOTE (deviation from MATLAB): the original intersected two perpendicular
   * bisectors written in slope form,
   *     L = (y2-y1)/(x2-x1),  R = (y3-y2)/(x3-x2)
   *     cy = -1/L * (cx - (x1+x2)/2) + (y1+y2)/2
   * which is algebraically correct but divides by zero when the first two
   * points share a y (L = 0) or share an x (L = Inf). Clicking the left and
   * right edge of a droplet lands on the same pixel row often enough to matter,
   * and MATLAB returned a badly wrong centre and radius without warning.
   * The determinant form below is exact for the same inputs and only degenerates
   * when the three points are genuinely collinear.
   */
  function fitCircle3(p1, p2, p3) {
    var ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
    var det = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    // Scale-aware collinearity test, so it behaves the same for 10 px and 1000 px circles.
    var spread = Math.max(
      Math.abs(ax - bx), Math.abs(ay - by),
      Math.abs(bx - cx), Math.abs(by - cy),
      Math.abs(ax - cx), Math.abs(ay - cy)
    );
    if (!(Math.abs(det) > 1e-9 * Math.max(1, spread * spread))) return null;

    var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / det;
    var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / det;
    var r = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
    if (!isFinite(r) || r <= 0) return null;
    return { x: ux, y: uy, r: r };
  }

  function sphereVolume(r) {
    return (4 / 3) * Math.PI * r * r * r;
  }

  /* Spherical cap of height h on a base circle of radius a: V = pi*h*(3a^2 + h^2)/6.
   * Exact for any h, including h > R (more than a hemisphere). */
  function capVolume(h, a) {
    return (Math.PI * h * (3 * a * a + h * h)) / 6;
  }

  /* Zone (curved surface) of a spherical cap of height h on a sphere of radius R. */
  function capZoneArea(R, h) {
    return 2 * Math.PI * R * h;
  }

  /*
   * The two intersection points of circles (outer, inner), returned as
   * [p1, p2] ordered exactly like MATLAB's int_1 / int_2. Null when the
   * circles do not intersect.
   */
  function circleIntersections(outer, inner, d) {
    var cosAlpha = (outer.r * outer.r + d * d - inner.r * inner.r) / (2 * outer.r * d);
    if (!(Math.abs(cosAlpha) <= 1)) return null;
    var ux = (inner.x - outer.x) / d, uy = (inner.y - outer.y) / d;
    var px = uy, py = -ux;                       // perpendicular, MATLAB's pu_AB
    var s = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));
    var bx = outer.x + ux * (outer.r * cosAlpha);
    var by = outer.y + uy * (outer.r * cosAlpha);
    return [
      { x: bx + px * outer.r * s, y: by + py * outer.r * s },
      { x: bx - px * outer.r * s, y: by - py * outer.r * s }
    ];
  }

  /*
   * Shared two-circle geometry, independent of droplet type.
   *   dTripOuter — signed distance from the outer centre to the plane of the
   *                three-phase contact line, measured along the centre line.
   *   dTripInner — same distance measured back from the inner centre.
   *   rContact   — radius of the contact circle (the "neck").
   */
  function twoCircleGeometry(outer, inner) {
    var dx = inner.x - outer.x, dy = inner.y - outer.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var Rd = outer.r, Ri = inner.r;
    var dTripOuter = (d * d - Ri * Ri + Rd * Rd) / (2 * d);
    var dTripInner = d - dTripOuter;
    return {
      d: d,
      Rd: Rd,
      Ri: Ri,
      dTripOuter: dTripOuter,
      dTripInner: dTripInner,
      hCapOuter: Rd - dTripOuter,
      rContact: Math.sqrt(Math.max(0, Rd * Rd - dTripOuter * dTripOuter)),
      intersects: d < Rd + Ri && d > Math.abs(Rd - Ri) && d > 0
    };
  }

  /*
   * Janus (spherical) droplet.
   *
   * opts: { outer, inner, nUpper, nLower, nCont, riCorrection: 'legacy'|'consistent' }
   *
   * Refractive-index correction, as in the MATLAB app: the apparent inner
   * interface is distorted by refraction through the continuous phase, so Ri
   * and d are scaled by cor = n_cont / n_phase before the law of cosines.
   * Which phase depends on which side the inner centre falls on.
   */
  function measureJanus(opts) {
    var outer = opts.outer, inner = opts.inner;
    var g = twoCircleGeometry(outer, inner);
    var Rd = g.Rd, Ri = g.Ri, d = g.d;
    var warnings = [];

    // MATLAB: if loc_inner(2) > loc_outer(2)  (inner centre lower on screen)
    var innerBelow = inner.y > outer.y;

    var nUpper = num(opts.nUpper, 1.33), nLower = num(opts.nLower, 1.33), nCont = num(opts.nCont, 1.33);
    var cor = innerBelow ? nCont / nUpper : nCont / nLower;

    /*
     * NOTE: MATLAB scaled Ri and d by `cor` in the numerator but left the
     * denominator as 2*Ri*Rd (uncorrected). That is inconsistent — with
     * cor != 1 it is not the law of cosines for any triangle, and it can push
     * the argument outside [-1, 1]. 'legacy' reproduces it bit-for-bit so old
     * measurements stay comparable; 'consistent' corrects the denominator too.
     * The two are identical whenever cor == 1, i.e. whenever the three
     * refractive indices used are equal (the default 1.33 everywhere).
     */
    var numer = (Ri * cor) * (Ri * cor) + Rd * Rd - (d * cor) * (d * cor);
    var denom = (opts.riCorrection === 'consistent') ? 2 * Ri * cor * Rd : 2 * Ri * Rd;
    var cosCA = numer / denom;
    if (Math.abs(cosCA) > 1) {
      warnings.push('Contact-angle cosine was ' + cosCA.toFixed(4) +
        ', outside [-1, 1], and has been clamped. The two circles are not a valid lens — recheck the points' +
        (cor !== 1 ? ' or the refractive indices.' : '.'));
    }
    var theta = Math.acos(clamp(cosCA, -1, 1)) * DEG;
    var contactAngle = innerBelow ? 180 - theta : theta;

    // Tilt of the centre-to-centre axis away from vertical (MATLAB's tilt_angle).
    var v1x = 0, v1y = inner.y - outer.y;                     // outer -> (outer.x, inner.y)
    var v2x = inner.x - outer.x, v2y = inner.y - outer.y;     // outer -> inner
    var tiltAngle = Math.atan2(Math.abs(v1x * v2y - v1y * v2x), v1x * v2x + v1y * v2y) * DEG;

    var rContact = g.rContact;
    var hCapOuter = g.hCapOuter;
    var vDrop = sphereVolume(Rd);
    var vCapOuter = capVolume(hCapOuter, rContact);

    // Volume bounded by the inner interface, on the same side as the outer cap.
    var hInner, vCapInner;
    if (g.dTripInner <= 0) {
      // Contact plane lies beyond the inner centre: the inner interface bulges back.
      hInner = Ri + g.dTripInner;
      vCapInner = sphereVolume(Ri) - capVolume(hInner, rContact);
    } else {
      hInner = Ri - g.dTripInner;
      vCapInner = capVolume(hInner, rContact);
    }

    var sDrop = 4 * Math.PI * Rd * Rd;
    var vUpper, vLower, sUpper, sLower;
    if (innerBelow) {
      vLower = vCapOuter + vCapInner;
      vUpper = vDrop - vLower;
      sLower = capZoneArea(Rd, hCapOuter);
      sUpper = sDrop - sLower;
    } else {
      vUpper = vCapOuter + vCapInner;
      vLower = vDrop - vUpper;
      sUpper = capZoneArea(Rd, hCapOuter);
      sLower = sDrop - sUpper;
    }

    if (!g.intersects) {
      warnings.push(d >= Rd + Ri
        ? 'The two circles do not overlap (d ≥ R_drop + R_inner), so there is no three-phase contact line.'
        : 'One circle lies entirely inside the other (d ≤ |R_drop − R_inner|), so there is no three-phase contact line.');
    }
    if (Ri > Rd * 8) {
      warnings.push('The inner radius is more than 8× the droplet radius — the inner interface is nearly flat, so results are very sensitive to point placement.');
    }
    /* Upper and lower are told apart purely by which centre sits lower in the
       image, which assumes the droplet axis is aligned with gravity.
       Once the centre axis approaches horizontal that test is decided by a few
       pixels, and the two phases can swap on a small change of point placement. */
    if (tiltAngle > 60) {
      warnings.push('The centre-to-centre axis is ' + tiltAngle.toFixed(1) +
        '° off vertical, so the upper/lower assignment rests on a very small height difference. Rotate the image so the interface is roughly horizontal.');
    }

    return {
      mode: 'janus',
      valid: g.intersects && isFinite(contactAngle),
      warnings: warnings,
      innerBelow: innerBelow,
      cor: cor,
      // lengths (px)
      Rd: Rd, Ri: Ri, d: d,
      dTripOuter: g.dTripOuter, dTripInner: g.dTripInner,
      rContact: rContact, hCapOuter: hCapOuter, hCapInner: hInner,
      // angles (deg)
      contactAngle: contactAngle, tiltAngle: tiltAngle,
      // volumes (px^3)
      vDrop: vDrop, vUpper: vUpper, vLower: vLower, vRatio: vUpper / vLower,
      // areas (px^2)
      sDrop: sDrop, sUpper: sUpper, sLower: sLower, janusRatio: sUpper / sLower,
      intersections: circleIntersections(outer, inner, d),
      outer: outer, inner: inner
    };
  }

  /*
   * Snowman (two partially fused spheres). Circle 1 is the first-clicked
   * ("outer") circle, circle 2 the second ("inner"); for a snowman they are
   * simply the two lobes. No refractive-index correction, matching MATLAB.
   */
  function measureSnowman(opts) {
    var outer = opts.outer, inner = opts.inner;
    var g = twoCircleGeometry(outer, inner);
    var Rd = g.Rd, Ri = g.Ri, d = g.d;
    var warnings = [];
    var ints = circleIntersections(outer, inner, d);

    /*
     * Angle at the neck. MATLAB built unit vectors from the first intersection
     * point to each centre, took the perpendicular of each (the tangent to each
     * circle at that point), and reported 180 - angle between them.
     */
    var thetaDeg = NaN;
    if (ints) {
      var p = ints[0];
      var uiX = (inner.x - p.x) / Ri, uiY = (inner.y - p.y) / Ri;
      var uoX = (outer.x - p.x) / Rd, uoY = (outer.y - p.y) / Rd;
      var piX = uiY, piY = -uiX;
      var poX = uoY, poY = -uoX;
      var ni = Math.sqrt(piX * piX + piY * piY), no = Math.sqrt(poX * poX + poY * poY);
      var cosT = clamp((piX * poX + piY * poY) / (ni * no), -1, 1);
      thetaDeg = 180 - Math.acos(cosT) * DEG;
    } else {
      warnings.push(d >= Rd + Ri
        ? 'The two lobes do not touch (d ≥ R₁ + R₂) — there is no neck to measure.'
        : 'One lobe lies entirely inside the other (d ≤ |R₁ − R₂|) — there is no neck to measure.');
    }

    var hCap1 = g.hCapOuter;              // cap of lobe 1 cut off by the contact plane
    var hCap2 = Ri - g.dTripInner;        // cap of lobe 2 cut off by the same plane
    var capZone1 = capZoneArea(Rd, hCap1);
    var capZone2 = capZoneArea(Ri, hCap2);
    var area1 = 4 * Math.PI * Rd * Rd - capZone1;   // exposed area of lobe 1
    var area2 = 4 * Math.PI * Ri * Ri - capZone2;

    // Volumes of the fused body: each sphere minus the cap past the contact plane.
    var vLobe1 = sphereVolume(Rd) - capVolume(hCap1, g.rContact);
    var vLobe2 = sphereVolume(Ri) - capVolume(hCap2, g.rContact);

    /*
     * Lobes 1 and 2 are whichever the user clicked first and second, so they
     * cannot be reported as "upper" and "lower" directly. Assign those by
     * position instead — smaller y is higher in the image — which makes the
     * reported ratios independent of click order. Assumes, as everywhere here,
     * that the droplet axis is aligned with gravity.
     */
    var upperIsFirst = outer.y <= inner.y;
    var RUpper = upperIsFirst ? Rd : Ri;
    var RLower = upperIsFirst ? Ri : Rd;
    var areaUpper = upperIsFirst ? area1 : area2;
    var areaLower = upperIsFirst ? area2 : area1;
    var vUpper = upperIsFirst ? vLobe1 : vLobe2;
    var vLower = upperIsFirst ? vLobe2 : vLobe1;

    return {
      mode: 'snowman',
      valid: !!ints,
      warnings: warnings,
      Rd: Rd, Ri: Ri, d: d,
      dTripOuter: g.dTripOuter, dTripInner: g.dTripInner,
      rContact: g.rContact,
      hCapOuter: hCap1, hCapInner: hCap2,
      snowmanAngle: thetaDeg,
      // Click-order fields, kept because the MATLAB regression is keyed on them.
      area1: area1, area2: area2, areaTotal: area1 + area2,
      vLobe1: vLobe1, vLobe2: vLobe2, vTotal: vLobe1 + vLobe2,
      // Position-based fields, which is what gets reported.
      upperIsFirst: upperIsFirst,
      RUpper: RUpper, RLower: RLower,
      areaUpper: areaUpper, areaLower: areaLower,
      vUpper: vUpper, vLower: vLower,
      areaRatio: areaUpper / areaLower,
      vRatio: vUpper / vLower,
      // 1 = just touching, 0 = fully merged. A scale-free measure of fusion.
      fusion: d / (Rd + Ri),
      intersections: ints,
      outer: outer, inner: inner
    };
  }

  function measure(opts) {
    if (!opts.outer || !opts.inner) return null;
    return opts.mode === 'snowman' ? measureSnowman(opts) : measureJanus(opts);
  }

  function num(v, dflt) {
    v = parseFloat(v);
    return isFinite(v) && v > 0 ? v : dflt;
  }

  /* Sample standard deviation (N-1), matching MATLAB's std(). NaN for n < 2. */
  function stdev(xs) {
    var vals = xs.filter(function (v) { return isFinite(v); });
    var n = vals.length;
    if (n < 2) return NaN;
    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
    var ss = vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0);
    return Math.sqrt(ss / (n - 1));
  }

  function mean(xs) {
    var vals = xs.filter(function (v) { return isFinite(v); });
    if (!vals.length) return NaN;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }

  root.Geom = {
    fitCircle3: fitCircle3,
    circleIntersections: circleIntersections,
    twoCircleGeometry: twoCircleGeometry,
    sphereVolume: sphereVolume,
    capVolume: capVolume,
    capZoneArea: capZoneArea,
    measure: measure,
    measureJanus: measureJanus,
    measureSnowman: measureSnowman,
    mean: mean,
    stdev: stdev,
    clamp: clamp
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
