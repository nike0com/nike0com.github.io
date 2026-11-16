/*
 * Virtualized list: only as many row elements as fit on screen exist.
 * Rows are recycled by (index % poolSize), so moving one step re-renders a single row
 * and just repositions the others with a GPU transform. ES5.
 */
function VList(el, opts) {
  this.el = el;
  this.rowH = opts.rowH;
  this.renderRow = opts.render;  // function (rowEl, index)
  this.onSelect = opts.onSelect || null; // function (index), after the selection changes
  this.count = 0;
  this.sel = 0;
  this.top = 0;
  this.thumb = el.querySelector('.thumb');
  this.vis = Math.max(1, Math.floor(el.clientHeight / this.rowH));
  this.rows = [];
  for (var i = 0; i < this.vis; i++) {
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
  this.sel = Math.max(0, Math.min(sel || 0, n - 1));
  this.top = 0;
  this.ensureVisible(true);
  this.invalidate();
  if (this.onSelect) this.onSelect(this.sel);
};

VList.prototype.ensureVisible = function (center) {
  var vis = this.vis, sel = this.sel;
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
  this.ensureVisible(center);
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
  var vis = this.vis, top = this.top, rowH = this.rowH;
  for (var k = 0; k < vis; k++) {
    var idx = top + k;
    var r = this.rows[idx % vis];
    if (idx >= this.count) {
      if (!r._hidden) { r.style.display = 'none'; r._hidden = true; }
      r._idx = -1;
      continue;
    }
    if (r._hidden) { r.style.display = ''; r._hidden = false; }
    if (r._idx !== idx) {
      this.renderRow(r, idx);
      r._idx = idx;
    }
    r.style.transform = 'translate3d(0,' + (k * rowH) + 'px,0)';
    r.style.webkitTransform = r.style.transform;
    if (idx === this.sel) r.classList.add('sel'); else r.classList.remove('sel');
  }
  this.drawThumb();
};

VList.prototype.drawThumb = function () {
  if (!this.thumb) return;
  if (this.count <= this.vis) { this.thumb.style.display = 'none'; return; }
  var h = this.vis * this.rowH;
  var th = Math.max(40, Math.round(h * this.vis / this.count));
  var y = Math.round((h - th) * this.top / (this.count - this.vis));
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
  this.onSelect = opts.onSelect || null;
  this.count = 0;
  this.sel = 0;
  this.topRow = 0;
  this.thumb = el.querySelector('.thumb');
  this.height = opts.height;
  this.pad = opts.pad || 0;   // room around tiles so the enlarged selected poster is not clipped
  this.fullRows = Math.max(1, Math.floor((this.height - this.pad) / this.rowH));
  this.poolRows = this.fullRows + 1;
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
  this.sel = Math.max(0, Math.min(sel || 0, n - 1));
  this.topRow = 0;
  this.ensureVisible();
  this.invalidate();
  if (this.onSelect) this.onSelect(this.sel);
};

VGrid.prototype.lastRow = function () { return Math.max(0, Math.ceil(this.count / this.cols) - 1); };

VGrid.prototype.ensureVisible = function () {
  var r = Math.floor(this.sel / this.cols);
  if (r < this.topRow) this.topRow = r;
  else if (r > this.topRow + this.fullRows - 1) this.topRow = r - this.fullRows + 1;
  this.topRow = Math.max(0, Math.min(this.topRow, this.lastRow() - this.fullRows + 1));
};

VGrid.prototype.select = function (i) {
  if (!this.count) return;
  this.sel = Math.max(0, Math.min(i, this.count - 1));
  this.ensureVisible();
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
      t.style.transform = 'translate3d(' + (this.pad + c * stepX) + 'px,' + (this.pad + k * this.rowH) + 'px,0)';
      t.style.webkitTransform = t.style.transform;
      if (idx === this.sel) t.classList.add('sel'); else t.classList.remove('sel');
    }
  }
  this.drawThumb();
};

VGrid.prototype.drawThumb = function () {
  if (!this.thumb) return;
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
