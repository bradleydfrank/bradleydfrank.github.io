/*
 * viewer.js — image canvas with zoom, pan, rotation and flipping.
 *
 * Owns the mapping between screen (CSS pixel) coordinates and image pixel
 * coordinates. The image is drawn with the view transform applied; the overlay
 * is drawn afterwards in screen space via the onOverlay callback, so annotation
 * strokes keep a constant width at any zoom level.
 *
 * Rotation and flipping are baked into an offscreen working canvas rather than
 * being kept as a render transform, so that "which centre is lower" — which
 * decides the HC/FC assignment — always refers to what the user sees.
 */
(function (root) {
  'use strict';

  function Viewer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.source = null;       // the working image: HTMLImageElement or canvas
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.minScale = 0.02;
    this.maxScale = 60;
    this.onOverlay = null;
    this.onViewChange = null;
    this._dpr = 1;
  }

  Viewer.prototype.hasImage = function () {
    return !!this.source;
  };

  Viewer.prototype.imageSize = function () {
    if (!this.source) return { w: 0, h: 0 };
    return {
      w: this.source.naturalWidth || this.source.width,
      h: this.source.naturalHeight || this.source.height
    };
  };

  Viewer.prototype.setImage = function (img) {
    this.source = img;
    this.resize();
    this.fit();
  };

  /* Match the backing store to the CSS size and device pixel ratio. */
  Viewer.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = root.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    this._dpr = dpr;
    this.cssWidth = w;
    this.cssHeight = h;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.render();
  };

  Viewer.prototype.fit = function () {
    if (!this.source) return;
    var s = this.imageSize();
    var pad = 24;
    var sx = (this.cssWidth - pad) / s.w;
    var sy = (this.cssHeight - pad) / s.h;
    this.scale = Math.min(sx, sy);
    if (!isFinite(this.scale) || this.scale <= 0) this.scale = 1;
    this.tx = (this.cssWidth - s.w * this.scale) / 2;
    this.ty = (this.cssHeight - s.h * this.scale) / 2;
    this.render();
    this._changed();
  };

  Viewer.prototype.setScale = function (next, anchorScreen) {
    if (!this.source) return;
    next = Math.max(this.minScale, Math.min(this.maxScale, next));
    var a = anchorScreen || { x: this.cssWidth / 2, y: this.cssHeight / 2 };
    var before = this.toImage(a);
    this.scale = next;
    // Keep the anchor point pinned to the same image pixel.
    this.tx = a.x - before.x * this.scale;
    this.ty = a.y - before.y * this.scale;
    this.render();
    this._changed();
  };

  Viewer.prototype.zoomBy = function (factor, anchorScreen) {
    this.setScale(this.scale * factor, anchorScreen);
  };

  Viewer.prototype.panBy = function (dx, dy) {
    this.tx += dx;
    this.ty += dy;
    this.render();
    this._changed();
  };

  /* True when an image-space point is comfortably inside the visible area. */
  Viewer.prototype.isOnScreen = function (p, margin) {
    var sp = this.toScreen(p);
    margin = margin || 0;
    return sp.x >= margin && sp.y >= margin &&
      sp.x <= this.cssWidth - margin && sp.y <= this.cssHeight - margin;
  };

  /* Slide the view so an image-space point sits in the middle of the canvas. */
  Viewer.prototype.centerOn = function (p) {
    if (!this.source) return;
    this.tx = this.cssWidth / 2 - p.x * this.scale;
    this.ty = this.cssHeight / 2 - p.y * this.scale;
    this.render();
    this._changed();
  };

  Viewer.prototype.toImage = function (p) {
    return { x: (p.x - this.tx) / this.scale, y: (p.y - this.ty) / this.scale };
  };

  Viewer.prototype.toScreen = function (p) {
    return { x: p.x * this.scale + this.tx, y: p.y * this.scale + this.ty };
  };

  /* Screen position of a pointer/mouse event, in CSS pixels within the canvas. */
  Viewer.prototype.eventPos = function (ev) {
    var rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  /*
   * Bake a transform into a new working canvas.
   *   'cw' | 'ccw'  — rotate 90 degrees
   *   'flipV'       — mirror vertically
   *   'flipH'       — mirror horizontally
   * Returns a function remapping old image coordinates to new ones, so any
   * already-placed points follow the pixels they were put on.
   */
  Viewer.prototype.transformImage = function (kind) {
    if (!this.source) return function (p) { return p; };
    var s = this.imageSize();
    var W = s.w, H = s.h;
    var out = document.createElement('canvas');
    var c = out.getContext('2d');
    var remap;

    if (kind === 'cw') {
      out.width = H; out.height = W;
      c.translate(H, 0);
      c.rotate(Math.PI / 2);
      remap = function (p) { return { x: H - p.y, y: p.x }; };
    } else if (kind === 'ccw') {
      out.width = H; out.height = W;
      c.translate(0, W);
      c.rotate(-Math.PI / 2);
      remap = function (p) { return { x: p.y, y: W - p.x }; };
    } else if (kind === 'flipH') {
      out.width = W; out.height = H;
      c.translate(W, 0);
      c.scale(-1, 1);
      remap = function (p) { return { x: W - p.x, y: p.y }; };
    } else { // flipV
      out.width = W; out.height = H;
      c.translate(0, H);
      c.scale(1, -1);
      remap = function (p) { return { x: p.x, y: H - p.y }; };
    }

    c.drawImage(this.source, 0, 0);
    this.source = out;
    this.fit();
    return remap;
  };

  Viewer.prototype.render = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth || 0, this.cssHeight || 0);

    if (this.source) {
      // Smooth when zoomed out, nearest-neighbour when magnified past 1:1 so
      // the user can see and target individual pixels of the droplet edge.
      var smooth = this.scale < 1.5;
      ctx.imageSmoothingEnabled = smooth;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.translate(this.tx, this.ty);
      ctx.scale(this.scale, this.scale);
      try {
        ctx.drawImage(this.source, 0, 0);
      } catch (e) { /* image not decodable yet */ }
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }

    if (this.onOverlay) this.onOverlay(ctx, this);
    ctx.restore();
  };

  /* Render at full image resolution for PNG export, overlay included. */
  Viewer.prototype.exportCanvas = function (drawOverlay) {
    var s = this.imageSize();
    var out = document.createElement('canvas');
    out.width = s.w;
    out.height = s.h;
    var c = out.getContext('2d');
    c.drawImage(this.source, 0, 0);
    if (drawOverlay) {
      // Present a 1:1 identity view so the overlay lands on image pixels.
      var saved = { scale: this.scale, tx: this.tx, ty: this.ty, dpr: this._dpr,
        w: this.cssWidth, h: this.cssHeight };
      this.scale = 1; this.tx = 0; this.ty = 0; this._dpr = 1;
      this.cssWidth = s.w; this.cssHeight = s.h;
      try {
        drawOverlay(c, this);
      } finally {
        this.scale = saved.scale; this.tx = saved.tx; this.ty = saved.ty;
        this._dpr = saved.dpr; this.cssWidth = saved.w; this.cssHeight = saved.h;
      }
    }
    return out;
  };

  Viewer.prototype._changed = function () {
    if (this.onViewChange) this.onViewChange(this);
  };

  root.Viewer = Viewer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
