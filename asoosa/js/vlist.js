/*
 * Virtualized list: only as many row elements as fit on screen exist.
 * Rows are recycled by (index % poolSize), so moving one step re-renders a single row
 * and just repositions the others with a GPU transform. ES5.
 */
function VList(el, opts) {
  this.el = el;
  this.rowH = opts.rowH;
  this.renderRow = opts.render;  // function (rowEl, index)
  this.prefetch = opts.prefetch || null;   // phone: function (index) — load a row's picture before it shows
  this.onSelect = opts.onSelect || null; // function (index), after the selection changes
  this.count = 0;
  this.sel = 0;
  this.top = 0;
  this.thumb = el.querySelector('.thumb');
  this.vis = Math.max(1, Math.floor(el.clientHeight / this.rowH));
  this.offset = 0;                       // pixels the top row is scrolled up (touch dragging)
  this.rows = [];
  // Phone (VList.native): the browser scrolls the list itself (smooth, with momentum);
  // a spacer gives the full height and the pooled rows are placed where they belong.
  this.native = !!VList.native;
  if (this.native) {
    el.style.overflowY = 'auto';
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:0;pointer-events:none';
    el.appendChild(this.spacer);
    var self = this, queued = false;
    el.onscroll = function () {           // at most one redraw per frame
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; self.draw(); });
    };
  }
  // phone: half a screen of rows ready above and below, filled in before they come into view
  this.ahead = this.native ? Math.max(3, Math.ceil(this.vis / 2)) : 0;
  for (var i = 0; i < this.vis + (this.native ? 2 * this.ahead + 2 : 2); i++) {   // spare rows: partly visible ones while scrolling
    var r = opts.create();
    r.className = (r.className ? r.className + ' ' : '') + 'row';
    r.style.position = 'absolute';
    r.style.height = this.rowH + 'px';
    r._idx = -1;
    el.appendChild(r);
    this.rows.push(r);
  }
}

VList.prototype.setCount = function (n, sel) {
  this.count = n;
  if (this.native) this.spacer.style.height = (n * this.rowH) + 'px';   // before scrolling to the selection
  this.sel = Math.max(0, Math.min(sel || 0, n - 1));
  this.top = 0;
  this.ensureVisible(true);
  this.invalidate();
  if (this.onSelect) this.onSelect(this.sel);
};

VList.prototype.ensureVisible = function (center) {
  var vis = this.vis, sel = this.sel;
  if (this.native) {
    var el = this.el, y = sel * this.rowH, h = el.clientHeight;
    if (center) el.scrollTop = Math.max(0, y - Math.floor((h - this.rowH) / 2));
    else if (y < el.scrollTop) el.scrollTop = y;
    else if (y + this.rowH > el.scrollTop + h) el.scrollTop = y + this.rowH - h;
    return;
  }
  if (center) {
    this.top = sel - Math.floor(vis / 2);
  } else {
    var m = vis > 6 ? 2 : 0;
    if (sel < this.top + m) this.top = sel - m;
    else if (sel > this.top + vis - 1 - m) this.top = sel - vis + 1 + m;
  }
  this.top = Math.max(0, Math.min(this.top, this.count - vis));
};

VList.prototype.select = function (i, center) {
  if (!this.count) return;
  this.sel = Math.max(0, Math.min(i, this.count - 1));
  // A tapped row that is already on screen: keep the list where the finger left it.
  var onScreen = !this.native && this.offset && this.sel > this.top && this.sel < this.top + this.vis;
  if (!onScreen) { this.offset = 0; this.ensureVisible(center); }
  this.draw();
  if (this.onSelect) this.onSelect(this.sel);
};

/** Single steps wrap around at the ends; page jumps clamp. */
VList.prototype.move = function (d) {
  if (!this.count) return;
  var s = this.sel + d;
  if (d === 1 && s >= this.count) s = 0;
  else if (d === -1 && s < 0) s = this.count - 1;
  this.select(s);
};

VList.prototype.page = function (dir) { this.move(dir * (this.vis - 1)); };

VList.prototype.invalidate = function () {
  for (var i = 0; i < this.rows.length; i++) this.rows[i]._idx = -1;
  this.draw();
};

VList.prototype.draw = function () {
  if (this.native) return this.drawNative();
  var pool = this.rows.length, top = this.top, rowH = this.rowH, off = this.offset;
  var shown = off ? this.vis + 2 : this.vis;          // the spare rows only while scrolled between rows
  for (var k = 0; k < pool; k++) {
    var idx = top + k;
    var r = this.rows[idx % pool];
    if (k >= shown || idx >= this.count) {
      if (!r._hidden) { r.style.display = 'none'; r._hidden = true; }
      r._idx = -1;
      continue;
    }
    if (r._hidden) { r.style.display = ''; r._hidden = false; }
    if (r._idx !== idx) {
      this.renderRow(r, idx);
      r._idx = idx;
    }
    r.style.transform = 'translate3d(0,' + (k * rowH - off) + 'px,0)';
    r.style.webkitTransform = r.style.transform;
    if (idx === this.sel) r.classList.add('sel'); else r.classList.remove('sel');
  }
  this.drawThumb();
};

/** Phone: rows at their real position inside the scrolled area; only rows near the view exist. */
VList.prototype.drawNative = function () {
  var pool = this.rows.length, rowH = this.rowH;
  this.spacer.style.height = (this.count * rowH) + 'px';
  var top = Math.max(0, Math.floor(this.el.scrollTop / rowH) - this.ahead);
  this.top = top;
  for (var k = 0; k < pool; k++) {
    var idx = top + k, r = this.rows[idx % pool];
    if (idx >= this.count) {
      if (!r._hidden) { r.style.display = 'none'; r._hidden = true; }
      r._idx = -1;
      continue;
    }
    if (r._hidden) { r.style.display = ''; r._hidden = false; }
    if (r._idx !== idx) { this.renderRow(r, idx); r._idx = idx; }
    r.style.transform = 'translate3d(0,' + (idx * rowH) + 'px,0)';
    if (idx === this.sel) r.classList.add('sel'); else r.classList.remove('sel');
  }
  if (this.thumb) this.thumb.style.display = 'none';
  // pictures of the next screen (and the one before) start loading now
  if (this.prefetch) for (var p = Math.max(0, top - this.vis); p < Math.min(this.count, top + pool + this.vis); p++) this.prefetch(p);
};

/** Touch: scroll by pixels (positive = further down the list). Returns false at either end. */
VList.prototype.scrollBy = function (px) {
  var max = Math.max(0, (this.count - this.vis) * this.rowH);
  var pos = this.top * this.rowH + this.offset, next = Math.max(0, Math.min(max, pos + px));
  if (next === pos) return false;
  this.top = Math.floor(next / this.rowH);
  this.offset = next - this.top * this.rowH;
  this.draw();
  return true;
};

VList.prototype.drawThumb = function () {
  if (!this.thumb) return;
  if (this.count <= this.vis) { this.thumb.style.display = 'none'; return; }
  var h = this.vis * this.rowH;
  var th = Math.max(40, Math.round(h * this.vis / this.count));
  var y = Math.round((h - th) * (this.top + this.offset / this.rowH) / (this.count - this.vis));
  this.thumb.style.display = 'block';
  this.thumb.style.height = th + 'px';
  this.thumb.style.transform = 'translateY(' + y + 'px)';
  this.thumb.style.webkitTransform = this.thumb.style.transform;
};

VList.prototype.setActive = function (on) {
  if (on) this.el.classList.add('active'); else this.el.classList.remove('active');
};

/*
 * Virtualized poster grid. Only (visible rows + 1) x cols tiles exist; a whole row is recycled
 * by (row % poolRows), so moving down one row re-renders one row of tiles.
 * opts: { cols, tileW, rowH, gap, height, create, render, onSelect }
 */
function VGrid(el, opts) {
  this.el = el;
  this.cols = opts.cols;
  this.tileW = opts.tileW;
  this.rowH = opts.rowH;
  this.gap = opts.gap;
  this.renderTile = opts.render;
  this.prefetch = opts.prefetch || null;
  this.onSelect = opts.onSelect || null;
  this.count = 0;
  this.sel = 0;
  this.topRow = 0;
  this.thumb = el.querySelector('.thumb');
  this.height = opts.height;
  this.pad = opts.pad || 0;   // room around tiles so the enlarged selected poster is not clipped
  this.fullRows = Math.max(1, Math.floor((this.height - this.pad) / this.rowH));
  this.native = !!VList.native;
  this.poolRows = this.fullRows + (this.native ? 6 : 2);   // phone: 2 rows ready above and 3 below the screen
  this.offset = 0;
  if (this.native) {
    el.style.overflowY = 'auto';
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:0;pointer-events:none';
    el.appendChild(this.spacer);
    var self = this, queued = false;
    el.onscroll = function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; self.draw(); });
    };
  }
  this.tiles = [];
  for (var i = 0; i < this.poolRows * this.cols; i++) {
    var t = opts.create();
    t.className = (t.className ? t.className + ' ' : '') + 'tile';
    t.style.position = 'absolute';
    t.style.width = this.tileW + 'px';
    t._idx = -1;
    el.appendChild(t);
    this.tiles.push(t);
  }
}

VGrid.prototype.setCount = function (n, sel) {
  this.count = n;
  if (this.native) this.spacer.style.height = (2 * this.pad + Math.ceil(n / this.cols) * this.rowH) + 'px';
  this.sel = Math.max(0, Math.min(sel || 0, n - 1));
  this.topRow = 0;
  this.ensureVisible();
  this.invalidate();
  if (this.onSelect) this.onSelect(this.sel);
};

VGrid.prototype.lastRow = function () { return Math.max(0, Math.ceil(this.count / this.cols) - 1); };

VGrid.prototype.ensureVisible = function () {
  var r = Math.floor(this.sel / this.cols);
  if (this.native) {
    var el = this.el, y = this.pad + r * this.rowH, h = el.clientHeight || this.height;
    if (y - this.pad < el.scrollTop) el.scrollTop = y - this.pad;
    else if (y + this.rowH > el.scrollTop + h) el.scrollTop = y + this.rowH - h + this.pad;
    return;
  }
  if (r < this.topRow) this.topRow = r;
  else if (r > this.topRow + this.fullRows - 1) this.topRow = r - this.fullRows + 1;
  this.topRow = Math.max(0, Math.min(this.topRow, this.lastRow() - this.fullRows + 1));
};

VGrid.prototype.select = function (i) {
  if (!this.count) return;
  this.sel = Math.max(0, Math.min(i, this.count - 1));
  var r = Math.floor(this.sel / this.cols);
  var onScreen = !this.native && this.offset && r > this.topRow && r < this.topRow + this.fullRows;
  if (!onScreen) { this.offset = 0; this.ensureVisible(); }
  this.draw();
  if (this.onSelect) this.onSelect(this.sel);
};

/** Left/right inside the row. Returns false at the row edge (so the caller can move focus out). */
VGrid.prototype.moveH = function (d) {
  if (!this.count) return false;
  var c = this.sel % this.cols;
  if (d < 0 && c === 0) return false;
  if (d > 0 && (c === this.cols - 1 || this.sel + 1 >= this.count)) return false;
  this.select(this.sel + d);
  return true;
};

/** Up/down one row. Returns false at the top (so the caller can move focus to the header). */
VGrid.prototype.moveV = function (d) {
  if (!this.count) return false;
  var s = this.sel + d * this.cols;
  if (s < 0) return false;
  if (s >= this.count) {
    if (Math.floor(this.sel / this.cols) >= this.lastRow()) return false;
    s = this.count - 1;
  }
  this.select(s);
  return true;
};

/** Same interface as VList: +1/-1 = next/previous tile, used by generic code. */
VGrid.prototype.move = function (d) { this.select(this.sel + d); };
VGrid.prototype.page = function (dir) {
  var s = this.sel + dir * this.fullRows * this.cols;
  this.select(Math.max(0, Math.min(s, this.count - 1)));
};

VGrid.prototype.invalidate = function () {
  for (var i = 0; i < this.tiles.length; i++) this.tiles[i]._idx = -1;
  this.draw();
};

VGrid.prototype.draw = function () {
  var cols = this.cols, stepX = this.tileW + this.gap;
  if (this.native) {
    // phone: the grid scrolls itself; place pooled rows at their real height
    this.spacer.style.height = (2 * this.pad + (this.lastRow() + 1) * this.rowH) + 'px';
    this.topRow = Math.max(0, Math.floor((this.el.scrollTop - this.pad) / this.rowH) - 2);
    this.offset = 0;
  }
  var base = this.native ? this.topRow * this.rowH : 0;
  for (var k = 0; k < this.poolRows; k++) {
    var row = this.topRow + k, slot = row % this.poolRows;
    for (var c = 0; c < cols; c++) {
      var idx = row * cols + c, t = this.tiles[slot * cols + c];
      if (idx >= this.count) {
        if (!t._hidden) { t.style.display = 'none'; t._hidden = true; }
        t._idx = -1;
        continue;
      }
      if (t._hidden) { t.style.display = ''; t._hidden = false; }
      if (t._idx !== idx) { this.renderTile(t, idx); t._idx = idx; }
      t.style.transform = 'translate3d(' + (this.pad + c * stepX) + 'px,' + (base + this.pad + k * this.rowH - this.offset) + 'px,0)';
      t.style.webkitTransform = t.style.transform;
      if (idx === this.sel) t.classList.add('sel'); else t.classList.remove('sel');
    }
  }
  if (this.native && this.prefetch) {
    // posters of the next 4 rows below (and 2 above) start loading before they scroll in
    var from = Math.max(0, (this.topRow - 2) * cols), to = Math.min(this.count, (this.topRow + this.poolRows + 4) * cols);
    for (var p = from; p < to; p++) this.prefetch(p);
  }
  this.drawThumb();
};

/** Touch: scroll by pixels. Returns false at either end. */
VGrid.prototype.scrollBy = function (px) {
  var max = Math.max(0, (this.lastRow() + 1 - this.fullRows) * this.rowH);
  var pos = this.topRow * this.rowH + this.offset, next = Math.max(0, Math.min(max, pos + px));
  if (next === pos) return false;
  this.topRow = Math.floor(next / this.rowH);
  this.offset = next - this.topRow * this.rowH;
  this.draw();
  return true;
};

VGrid.prototype.drawThumb = function () {
  if (!this.thumb) return;
  if (this.native) { this.thumb.style.display = 'none'; return; }
  var rows = this.lastRow() + 1;
  if (rows <= this.fullRows) { this.thumb.style.display = 'none'; return; }
  var h = this.height, th = Math.max(40, Math.round(h * this.fullRows / rows));
  var y = Math.round((h - th) * this.topRow / (rows - this.fullRows));
  this.thumb.style.display = 'block';
  this.thumb.style.height = th + 'px';
  this.thumb.style.transform = 'translateY(' + y + 'px)';
  this.thumb.style.webkitTransform = this.thumb.style.transform;
};

VGrid.prototype.setActive = VList.prototype.setActive;
