/* IPTV Player - app logic and remote navigation. ES5 for old Tizen engines. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var ROW_H = 76;          // channel / episode / recording rows
  var GROUP_ROW_H = 62;    // category rows
  var GRID = { cols: 6, tileW: 180, gap: 26, rowH: 324, height: 660, pad: 12 };  // movies / series posters
  var ZAP_DELAY = 280;      // ms to wait while zapping quickly before opening the stream
  var BANNER_MS = 4000;
  var SECTIONS = ['home', 'live', 'movies', 'series', 'rec', 'settings'];

  var S = {
    cfg: null, acc: null,            // config + Xtream account (null = plain M3U mode)
    section: 'live',
    live: { channels: [], groups: [], groupLists: [], lname: [], allIdx: [], keyIndex: {}, qual: [], alts: {}, repOf: {}, num: {} },
    favs: Store.lsGet('favs') || {},
    favItems: { movies: Store.lsGet('favMovies') || [], series: Store.lsGet('favSeries') || [] },
    groupItems: [], groupSel: 0,
    groupMem: Store.lsGet('ui') || {},  // remembered group per section
    cats: { movies: null, series: null },
    items: {},                       // 'movies:<catId>' / 'series:<catId>' -> list
    episodes: null,                  // { series, list, backSel } while a series is open
    recFiles: null,
    view: [], viewKind: 'live', query: '',
    zap: { kind: 'live', list: [] }, zapCtx: 'all',
    playing: null, prev: null,
    panel: false, focus: 'list',
    loading: false, status: '', statusErr: false,
    subs: { tracks: [], opts: [], cur: null, slots: {}, order: [], embKey: null, online: {}, info: {}, rawEvents: 0, delays: {}, token: 0 },
    seekBase: -1, seekDelta: 0
  };

  var chList, grList;
  var listW, gridW, curW;   // content area: row list (live, episodes, recordings) or poster grid (movies, series)

  /** chList forwards to whichever content widget is showing, so the rest of the code needs no change. */
  function makeContentProxy() {
    return {
      get sel() { return curW.sel; },
      get count() { return curW.count; },
      get rows() { return listW.rows; },
      setCount: function (n, s) { curW.setCount(n, s); },
      select: function (i, c) { curW.select(i, c); },
      move: function (d) { curW.move(d); },
      page: function (d) { curW.page(d); },
      invalidate: function () { curW.invalidate(); },
      setActive: function (on) { curW.setActive(on); },
      draw: function () { curW.draw(); }
    };
  }

  function gridOn() { return curW === gridW; }

  /** Switch between the row list and the poster grid (movies/series use the whole screen). */
  function useGrid(on) {
    var next = on ? gridW : listW;
    $('panel').classList[on ? 'add' : 'remove']('wide');
    if (next === curW) return;
    var active = curW.el.classList.contains('active');
    curW.setActive(false);
    curW = next;
    curW.setActive(active);
  }
  var timers = {};

  /* ---------------- helpers ---------------- */

  function later(name, ms, fn) { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms); }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(timers.toast);
    if (ms !== 0) timers.toast = setTimeout(function () { t.classList.add('hidden'); }, ms || 3500);
  }

  function listMsg(msg) { $('list-msg').textContent = msg || ''; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s % 60);
  }
  function fmtBytes(b) { return b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : Math.round(b / 1048576) + ' MB'; }

  /** "|AR| أفلام عربية" -> { tag: 'AR', name: 'أفلام عربية' } so mixed-direction labels render cleanly. */
  function splitLabel(label) {
    var m = /^\s*\|?\s*([A-Za-z]{2,5})\s*\|\s*(.+)$/.exec(label || '');
    return m ? { tag: m[1].toUpperCase(), name: m[2] } : { tag: '', name: label || '' };
  }

  function logosOn() { return !S.cfg || S.cfg.showLogos !== false; }

  function cacheSig(kind) {
    var acc = S.acc ? S.acc.server + '|' + S.acc.user : (S.cfg ? S.cfg.playlistUrl : '');
    // v5: movie/series lists carry "added" and category (live channels keep their v4 cache)
    return (kind === 'movies' || kind === 'series' ? 'v5|' : 'v4|') + acc + '|' + JSON.stringify(S.cfg ? S.cfg[kind] : []);
  }

  function cacheValid(entry, kind) {
    if (!entry || entry.sig !== cacheSig(kind)) return false;
    if (entry.savedAt < (Store.lsGet('refreshedAt') || 0)) return false;
    var maxAge = (S.cfg.autoRefreshHours || 0) * 3600000;
    return !maxAge || Date.now() - entry.savedAt < maxAge;
  }

  /* ---------------- channel quality ---------------- */

  // Providers write quality in small superscript letters ("ᴴᴰ", "ᵁᴴᴰ", "ʰᵉᵛᶜ"); map them to plain text.
  var SUP = {
    'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E', 'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I',
    'ᴶ': 'J', 'ᴷ': 'K', 'ᴸ': 'L', 'ᴹ': 'M', 'ᴺ': 'N', 'ᴼ': 'O', 'ᴾ': 'P',
    'ᴿ': 'R', 'ᵀ': 'T', 'ᵁ': 'U', 'ⱽ': 'V', 'ᵂ': 'W', 'ʰ': 'H', 'ᵉ': 'E',
    'ᵛ': 'V', 'ᶜ': 'C', 'ᵃ': 'A', 'ᵈ': 'D', 'ᶠ': 'F', 'ᵖ': 'P', 'ˢ': 'S',
    'ᵗ': 'T', 'ᵘ': 'U', 'ᵒ': 'O', 'ᵐ': 'M', 'ⁱ': 'I', 'ᶦ': 'I', 'ʳ': 'R',
    'ᵇ': 'B', 'ʸ': 'Y', '²': '2', '⁴': '4', '⁷': '7', '⁶': '6', '⁰': '0'
  };
  function plain(s) {
    return String(s).replace(/[²ʰ-˿ᴀ-ᶿ⁰-₟ⱽ]/g, function (ch) { return SUP[ch] || ' '; }).toUpperCase();
  }

  /** 6 = 8K, 5 = 4K/UHD, 4 = FHD, 3 = HD/HEVC, 2 = unknown, 1 = SD/low. */
  function quality(name) {
    var p = ' ' + plain(name).replace(/[^A-Z0-9]+/g, ' ') + ' ';
    if (/ 8K /.test(p)) return 6;
    if (/ (4K|UHD|2160P?|3840P?) /.test(p)) return 5;
    if (/ (FHD|1080P) /.test(p)) return 4;
    if (/ (HD|720P|HEVC|H265) /.test(p)) return 3;
    if (/ (SD|LOW|LQ|480P|360P) /.test(p)) return 1;
    return 2;
  }
  var QLABEL = { 6: '8K', 5: '4K', 4: 'FHD', 3: 'HD', 1: 'SD' };

  /** Channel name without country prefix and quality words: "AR| MBC 1 FHD" -> "MBC 1". */
  function baseName(name) {
    return plain(name)
      .replace(/^\s*\|?\s*[A-Z]{2,5}\s*[|:]\s*/, '')
      .replace(/\b(8K|4K|UHD|FHD|HD|SD|HEVC|H265|H264|RAW|LOW|LQ|HQ|VIP|GOLD|60FPS|50FPS|FPS|\d{3,4}P|2160|3840)\b/g, ' ')
      .replace(/[^A-Z0-9؀-ۿ]+/g, ' ')
      .trim();
  }

  /* ---------------- live channels ---------------- */

  function chKey(c) { return S.live.groups[c.g] + '|' + c.n; }

  function liveUrl(c) { return S.acc ? Xtream.liveUrl(S.acc, c.id) : c.u; }

  function favList() {
    var out = [], ki = S.live.keyIndex;
    var L = S.live, seen = {};
    for (var k in S.favs) {
      if (!S.favs.hasOwnProperty(k) || ki[k] === undefined) continue;
      var rep = L.repOf[ki[k]];
      if (rep === undefined) rep = ki[k];
      if (!seen[rep]) { seen[rep] = 1; out.push(rep); }
    }
    out.sort(function (a, b) { return (L.num[a] || 0) - (L.num[b] || 0); });
    return out;
  }

  function setLive(pl) {
    var L = S.live, ch = pl.channels, n = ch.length;
    var gl = [], lname = new Array(n), all = new Array(n), keyIndex = {};
    for (var g = 0; g < pl.groups.length; g++) gl.push([]);
    L.channels = ch; L.groups = pl.groups;
    L.repOf = {}; L.num = {};
    for (var i = 0; i < n; i++) {
      var c = ch[i];
      gl[c.g].push(i);
      lname[i] = c.n.toLowerCase();
      var k = chKey(c);
      if (keyIndex[k] === undefined) keyIndex[k] = i;
    }

    // Best quality: inside each group, show one row per channel and play its best version.
    // The other versions (FHD, HD, SD...) are kept as automatic fallbacks.
    var qual = new Array(n), alts = {}, repOf = {}, gq = [];
    for (g = 0; g < pl.groups.length; g++) gq.push(quality(pl.groups[g]));
    for (i = 0; i < n; i++) { qual[i] = quality(ch[i].n); if (qual[i] === 2) qual[i] = gq[ch[i].g]; }
    if (S.cfg.bestQuality !== false) {
      for (g = 0; g < gl.length; g++) {
        var byBase = {}, variants = [];
        for (var j = 0; j < gl[g].length; j++) {
          var idx = gl[g][j], b = baseName(ch[idx].n) || ('#' + idx);
          if (byBase[b] === undefined) { byBase[b] = variants.length; variants.push([idx]); }
          else variants[byBase[b]].push(idx);
        }
        gl[g] = variants.map(function (v) {
          v.sort(function (a, b2) { return qual[b2] - qual[a] || a - b2; });
          if (v.length > 1) { alts[v[0]] = v.slice(1); for (var q = 1; q < v.length; q++) repOf[v[q]] = v[0]; }
          return v[0];
        });
      }
    }
    var num = {}, pos = 0;
    for (g = 0; g < gl.length; g++) for (j = 0; j < gl[g].length; j++) { all[pos++] = gl[g][j]; num[gl[g][j]] = pos; }
    all.length = pos;
    L.groupLists = gl; L.lname = lname; L.allIdx = all; L.keyIndex = keyIndex;
    L.qual = qual; L.alts = alts; L.repOf = repOf; L.num = num;

    // Re-link the live channel that was auto-played from the saved URL.
    var p = S.playing;
    if (p && p.kind === 'live') {
      var idx = keyIndex[p.key];
      if (idx !== undefined && repOf[idx] !== undefined) idx = repOf[idx];
      p.idx = idx === undefined ? -1 : idx;
      if (idx !== undefined) { p.num = num[idx]; p.id = ch[idx].id; p.alts = (alts[idx] || []).slice(); p.q = qual[idx]; }
      if (idx !== undefined && liveUrl(ch[idx]) !== p.url) playLive(idx); // best version changed or URL changed
      else if (idx !== undefined && S.statusErr) tryNextVersion();      // saved version failed before the list was ready
    }
    S.zap = { kind: 'live', list: liveListFor(S.zapCtx) };
    if (S.section === 'live') rebuildGroups(true);
  }

  function liveListFor(ctx) {
    if (ctx === 'fav') return favList();
    if (ctx && ctx.indexOf('g:') === 0) {
      var gi = S.live.groups.indexOf(ctx.substring(2));
      if (gi >= 0) return S.live.groupLists[gi];
    }
    return S.live.allIdx;
  }

  /** M3U mode: keep only groups that match the "live" prefixes. */
  function filterM3U(pl) {
    var pref = S.cfg.live;
    if (!pref.length) return pl;
    var map = {}, groups = [], channels = [];
    for (var g = 0; g < pl.groups.length; g++) {
      if (Xtream.matches(pl.groups[g], pref)) { map[g] = groups.length; groups.push(pl.groups[g]); }
    }
    for (var i = 0; i < pl.channels.length; i++) {
      var c = pl.channels[i];
      if (map[c.g] !== undefined) channels.push({ n: c.n, u: c.u, g: map[c.g], l: c.l });
    }
    return { groups: groups, channels: channels };
  }

  function loadLive(force, done) {
    done = done || function () {};
    function fresh() {
      if (!S.live.channels.length) listMsg('Loading channels…');
      toast('Loading channels…', 0);
      function got(err, pl) {
        if (err) {
          toast('Channel update failed: ' + err, 6000);
          if (!S.live.channels.length && S.section === 'live') listMsg('Could not load channels:\n' + err + '\n\nPress Refresh to retry.');
          return done(err);
        }
        pl.sig = cacheSig('live');
        pl.savedAt = Date.now();
        Store.put('live', pl);
        setLive(pl);
        toast(pl.channels.length + ' channels loaded' + (pl.failed ? ' (' + pl.failed + ' groups failed)' : ''));
        done(null);
      }
      if (S.acc) {
        Xtream.loadLive(S.acc, S.cfg.live, function (d, t) { toast('Loading channels ' + d + '/' + t + '…', 0); }, got);
      } else {
        Store.downloadPlaylist(S.cfg.playlistUrl, function (err, pl) {
          if (err) return got(err);
          pl = filterM3U(pl);
          if (!pl.channels.length) return got('no groups match the "live" filter in config.json');
          got(null, pl);
        });
      }
    }
    if (force) return fresh();
    Store.get('live', function (pl) {
      if (pl && pl.channels && pl.channels.length && cacheValid(pl, 'live')) { setLive(pl); done(null); }
      else fresh();
    });
  }

  /* ---------------- movies / series ---------------- */

  function loadCats(kind, force) {
    if (!S.acc) return;
    function apply(cats) {
      S.cats[kind] = cats;
      if (S.section === kind) rebuildGroups(false);
    }
    function fresh() {
      Xtream.categories(S.acc, kind, S.cfg[kind], function (err, cats) {
        if (err) { if (S.section === kind) listMsg('Could not load categories:\n' + err); return; }
        Store.put('cats:' + kind, { sig: cacheSig(kind), savedAt: Date.now(), cats: cats });
        apply(cats);
      });
    }
    if (force) return fresh();
    Store.get('cats:' + kind, function (e) {
      if (e && cacheValid(e, kind)) apply(e.cats); else fresh();
    });
  }

  /** One category's movies/series: memory, then IndexedDB cache, then the server. */
  function fetchItems(kind, catId, cb) {
    var key = kind + ':' + catId;
    if (S.items[key]) return cb(null, S.items[key]);
    Store.get(key, function (e) {
      if (e && cacheValid(e, kind)) { S.items[key] = e.items; return cb(null, e.items); }
      (kind === 'movies' ? Xtream.movies : Xtream.series)(S.acc, catId, function (err, list) {
        if (err) return cb(err);
        Store.put(key, { sig: cacheSig(kind), savedAt: Date.now(), items: list });
        S.items[key] = list;
        cb(null, list);
      });
    });
  }

  var catLoading = {};
  function loadItems(kind, catId) {
    var key = kind + ':' + catId;
    if (S.items[key] || catLoading[key]) return;
    catLoading[key] = true;
    fetchItems(kind, catId, function (err) {
      delete catLoading[key];
      if (err) { if (S.section === kind) listMsg('Could not load this category:\n' + err); return; }
      var gi = S.groupItems[S.groupSel];
      if (S.section === kind && !S.episodes && !S.query && gi && gi.catId === catId) { applyView(false); grList.invalidate(); }
    });
  }

  /** Loads every category of a section so search can look everywhere. */
  var allLoading = {};
  function ensureAll(kind) {
    var cats = S.cats[kind];
    if (!cats || allLoading[kind]) return;
    var todo = cats.filter(function (c) { return !S.items[kind + ':' + c.id]; });
    if (!todo.length) return;
    allLoading[kind] = true;
    var next = 0, done = 0;
    function step() {
      if (next >= todo.length) return;
      var c = todo[next++];
      fetchItems(kind, c.id, function () {
        done++;
        var finished = done === todo.length;
        if (finished) allLoading[kind] = false;
        if (S.section === kind && S.query && !S.episodes && (finished || done % 8 === 0)) applyView(false);
        // New / Top rated / For you: redraw when everything is in (or now and then while you haven't moved yet)
        var gi = S.groupItems[S.groupSel];
        if (S.section === kind && !S.query && !S.episodes && gi && SPECIAL[gi.id] && (finished || (done % 8 === 0 && chList.sel === 0))) applyView(false);
        if (!finished) step();
      });
    }
    for (var k = 0; k < 4; k++) step();
  }

  /** All loaded items of a section (deduplicated) and how many categories are still missing. */
  function allItems(kind) {
    var cats = S.cats[kind] || [], out = [], seen = {}, missing = 0;
    for (var i = 0; i < cats.length; i++) {
      var list = S.items[kind + ':' + cats[i].id];
      if (!list) { missing++; continue; }
      for (var j = 0; j < list.length; j++) {
        if (!seen[list[j].id]) { seen[list[j].id] = 1; out.push(list[j]); }
      }
    }
    return { list: out, missing: missing, total: cats.length };
  }

  /* ---- New / Top rated / For you, watch later, watched ---- */

  var SPECIAL = { 'new': 1, top: 1, foryou: 1 };
  S.later = { movies: Store.lsGet('laterMovies') || [], series: Store.lsGet('laterSeries') || [] };
  S.watched = Store.lsGet('watched') || {};          // posKey ('m12' / 'e34') -> finished at (ms)

  function watchedKey(sec, it) { return (sec === 'movies' ? 'm' : 'e') + it.id; }
  function isWatched(key) { return !!S.watched[key]; }
  function markWatched(key, on) {
    if (!key) return;
    if (on) S.watched[key] = Date.now(); else delete S.watched[key];
    var keys = Object.keys(S.watched);
    if (keys.length > 3000) delete S.watched[keys[0]];
    Store.lsSet('watched', S.watched);
  }

  var specialCache = {};
  function specialList(sec, id, list) {
    var ck = sec + '|' + id + '|' + list.length + '|' + S.favItems[sec].length + '|' + Object.keys(S.watched).length;
    if (specialCache[sec + id] && specialCache[sec + id].k === ck) return specialCache[sec + id].v;
    var out;
    if (id === 'new') {
      out = list.slice().sort(function (a, b) { return (b.a || 0) - (a.a || 0) || b.id - a.id; }).slice(0, 300);
    } else if (id === 'top') {
      out = list.filter(function (x) { return x.r > 0 && x.r <= 10; })
        .sort(function (a, b) { return b.r - a.r || (b.a || 0) - (a.a || 0); }).slice(0, 300);
    } else out = forYou(sec, list);
    specialCache[sec + id] = { k: ck, v: out };
    return out;
  }

  /**
   * Suggestions: titles from the categories (and, for series, genres) of your favorites, watch-later
   * and what you watched, best rated first; things you already have or watched are left out.
   */
  function forYou(sec, list) {
    var byId = {}, catW = {}, genreW = {}, mine = {}, seeds = 0;
    list.forEach(function (x) { byId[x.id] = x; });
    function seed(it, w) {
      var x = byId[it.id] || it;
      mine[it.id] = 1; seeds++;
      if (x.c) catW[x.c] = (catW[x.c] || 0) + w;
      String(x.gn || '').split(/\s*[,\/]\s*/).forEach(function (g) { if (g) genreW[g.toLowerCase()] = (genreW[g.toLowerCase()] || 0) + w; });
    }
    S.favItems[sec].forEach(function (it) { seed(it, 3); });
    S.later[sec].forEach(function (it) { seed(it, 2); });
    cw.forEach(function (c) {
      if (sec === 'movies' && c.kind === 'movie') seed(c.item, 2);
      if (sec === 'series' && c.kind === 'episode' && c.series) seed(c.series, 2);
    });
    if (sec === 'movies') for (var k in S.watched) if (k.charAt(0) === 'm' && byId[k.substring(1)]) seed(byId[k.substring(1)], 1);
    if (!seeds) return [];
    var scored = [];
    list.forEach(function (x) {
      if (mine[x.id] || (sec === 'movies' && isWatched('m' + x.id))) return;
      var s = (catW[x.c] || 0) * 2;
      String(x.gn || '').split(/\s*[,\/]\s*/).forEach(function (g) { if (g) s += genreW[g.toLowerCase()] || 0; });
      if (!s) return;
      scored.push({ x: x, s: s + (x.r || 0) * 0.6 + ((x.a || 0) > Date.now() / 1000 - 180 * 86400 ? 1 : 0) });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, 200).map(function (o) { return o.x; });
  }

  function isLater(sec, id) {
    var l = S.later[sec];
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return true;
    return false;
  }
  function toggleLater(sec, it, quiet) {
    if (!it) return;
    var l = S.later[sec], pos = -1;
    for (var i = 0; i < l.length; i++) if (l[i].id === it.id) pos = i;
    if (pos >= 0) { l.splice(pos, 1); if (!quiet) toast('Removed from watch later: ' + it.n); }
    else { l.unshift(it); if (!quiet) toast('Added to watch later: ' + it.n); }
    Store.lsSet(sec === 'movies' ? 'laterMovies' : 'laterSeries', l);
    var gi = S.groupItems[S.groupSel];
    if (S.section === sec && !S.query && !S.episodes && gi && gi.id === 'later') {
      var sel = chList.sel;
      applyView(false);
      chList.select(Math.min(sel, S.view.length - 1));
    } else chList.invalidate();
    grList.invalidate();
  }

  function openSeries(item) {
    toast('Loading episodes…', 0);
    Xtream.episodes(S.acc, item.id, function (err, list) {
      if (err) return toast('Could not load episodes: ' + err, 5000);
      if (!list.length) return toast('No episodes for ' + item.n);
      toast(item.n + ' · ' + list.length + ' episodes', 2000);
      if (list.tmdb) item.tmdb = list.tmdb;
      S.episodes = { series: item, list: list, backSel: chList.sel };
      S.query = ''; S.queryLabel = ''; $('search').value = '';
      applyView(true);
      setFocus('list');
    });
  }

  function closeSeries() {
    var back = S.episodes ? S.episodes.backSel : 0;
    S.episodes = null;
    applyView(false);
    chList.select(back, true);
  }

  /* ---------------- recordings list ---------------- */

  function loadRecordings() {
    listMsg('Looking for recordings…');
    Recorder.list(function (err, files) {
      S.recFiles = err ? [] : files;
      if (S.section === 'rec') { applyView(false); if (err) listMsg(err); }
    });
  }

  /* ---------------- sections & views ---------------- */

  function rebuildGroups(selectPlaying) {
    var items = [], sec = S.section;
    if (sec === 'live') {
      if (S.live.channels.length) {
        items.push({ id: 'all', label: 'All channels', count: S.live.allIdx.length });
        items.push({ id: 'fav', label: '★ Favorites', count: favList().length });
        for (var i = 0; i < S.live.groups.length; i++) {
          items.push({ id: 'g:' + S.live.groups[i], label: S.live.groups[i], count: S.live.groupLists[i].length });
        }
      }
    } else if (sec === 'movies' || sec === 'series') {
      var cats = S.cats[sec] || [];
      if (S.cats[sec]) {
        items.push({ id: 'fav', label: '★ Favorites' });
        items.push({ id: 'later', label: '+ Watch later' });
        items.push({ id: 'new', label: 'New' });
        items.push({ id: 'top', label: '★ Top rated' });
        items.push({ id: 'foryou', label: '♥ For you' });
      }
      for (var j = 0; j < cats.length; j++) items.push({ id: 'c:' + cats[j].id, label: cats[j].name, catId: cats[j].id });
    } else {
      items.push({ id: 'rec', label: 'USB recordings' });
    }
    S.groupItems = items;
    var want = S.groupMem[sec], sel = 0;
    // Movies/series open on the first real category, not the (maybe empty) favorites, unless you chose it before.
    if (!want && sec !== 'live') for (var f = 0; f < items.length; f++) if (items[f].catId !== undefined) { sel = f; break; }
    for (var k = 0; k < items.length; k++) if (items[k].id === want) { sel = k; break; }
    S.groupSel = sel;
    grList.setCount(items.length, sel);
    applyView(selectPlaying);
  }

  function switchSection(sec) {
    if (sec === S.section) return;
    S.section = sec;
    S.query = ''; S.queryLabel = ''; $('search').value = '';
    S.episodes = null;
    renderTabs();
    updateHints();
    $('panel').classList.remove('home');
    $('panel').classList.remove('settings');
    if (sec === 'home' || sec === 'settings') {
      hidePreview();
      $('panel').classList.add(sec);
      $('panel').classList.add('wide');
      if (sec === 'home') renderHome(); else { SET.mode = 'main'; renderSettings(); }
      return;
    }
    if (sec === 'movies' || sec === 'series') {
      if (!S.acc) { S.groupItems = []; grList.setCount(0, 0); S.view = []; chList.setCount(0, 0); $('ch-title').textContent = ''; listMsg('Movies and series need an Xtream account.\nUse a get.php playlist URL in config.json.'); return; }
      if (!S.cats[sec]) loadCats(sec, false);
    }
    if (sec === 'rec' && !S.recFiles) loadRecordings();
    rebuildGroups(true);
  }

  /** True if `term` occurs in `n` at the start of a word ("on" matches "ON SPORT", not "LEBANON"). */
  function hasWordStart(n, term) {
    var from = 0, i;
    while ((i = n.indexOf(term, from)) !== -1) {
      if (i === 0 || !/[a-z0-9؀-ۿ]/.test(n.charAt(i - 1))) return true;
      from = i + 1;
    }
    return false;
  }

  /**
   * Words match at word starts in any order; "a phrase in quotes" must appear as written;
   * alternatives separated by " | " match if any of them does: "seria" | "shahid event".
   */
  function searchIn(list, nameOf, q) {
    var alts = String(q).split(/\s+\|\s+/).map(function (a) {
      var phrase = /^\s*"(.+)"\s*$/.exec(a);
      return phrase ? [phrase[1].toLowerCase()] : a.toLowerCase().split(/\s+/).filter(function (t) { return t; });
    }).filter(function (terms) { return terms.length; });
    var res = [];
    for (var i = 0; i < list.length; i++) {
      var n = nameOf(list[i], i);
      for (var a = 0; a < alts.length; a++) {
        var ok = true;
        for (var t = 0; t < alts[a].length && ok; t++) if (!hasWordStart(n, alts[a][t])) ok = false;
        if (ok) { res.push(list[i]); break; }
      }
    }
    return res;
  }
  function lowerName(it) { return it.n.toLowerCase(); }

  function applyView(selectPlaying) {
    var sec = S.section, view = [], kind = sec, title = '', msg = '';
    var gi = S.groupItems[S.groupSel];

    if (sec === 'live') {
      kind = 'live';
      if (!S.live.channels.length) msg = S.loading ? 'Loading channels…' : '';
      else if (S.query) {
        var ln = S.live.lname;
        view = searchIn(S.live.allIdx, function (idx) { return ln[idx]; }, S.query);
        title = (S.queryLabel || 'Search “' + S.query + '”') + ' · ' + view.length;
      } else if (gi) {
        view = gi.id === 'fav' ? favList() : liveListFor(gi.id);
        title = splitLabel(gi.label).name + ' · ' + view.length;
        if (!view.length) msg = gi.id === 'fav' ? 'No favorites yet.\nPress GREEN on a channel.' : 'Empty';
      }
    } else if (sec === 'movies' || sec === 'series') {
      if (sec === 'series' && S.episodes) {
        kind = 'episode';
        view = S.query ? searchIn(S.episodes.list, lowerName, S.query) : S.episodes.list;
        title = S.episodes.series.n + ' · ' + view.length + ' episodes';
      } else {
        kind = sec === 'movies' ? 'movie' : 'series';
        if (!S.cats[sec]) msg = 'Loading categories…';
        else if (S.query) {
          // Search looks in every category of the section, not only the selected one.
          var all = allItems(sec);
          view = searchIn(all.list, lowerName, S.query);
          title = 'Search “' + S.query + '” · ' + view.length +
            (all.missing ? '  (searching ' + (all.total - all.missing) + '/' + all.total + ' categories…)' : '  in all categories');
          if (all.missing) ensureAll(sec);
          if (!view.length) msg = all.missing ? 'Searching all categories…' : 'No matches';
        }
        else if (!gi) msg = 'No categories match the "' + sec + '" filter in config.json';
        else if (gi.id === 'fav') {
          view = S.favItems[sec];
          title = '★ Favorites · ' + view.length;
          if (!view.length) msg = 'No favorites yet.\nSelect a ' + (sec === 'movies' ? 'movie' : 'series') + ' and press GREEN.';
        }
        else if (gi.id === 'later') {
          view = S.later[sec];
          title = 'Watch later · ' + view.length;
          if (!view.length) msg = 'Nothing here yet.\nHold OK on a ' + (sec === 'movies' ? 'movie' : 'series') + ' and choose "Watch later".';
        }
        else if (SPECIAL[gi.id]) {
          // New / Top rated / For you look at every category of the section.
          var everything = allItems(sec);
          if (everything.missing) ensureAll(sec);
          view = specialList(sec, gi.id, everything.list);
          title = splitLabel(gi.label).name + ' · ' + view.length +
            (everything.missing ? '  (loading ' + (everything.total - everything.missing) + '/' + everything.total + ' categories…)' : '');
          if (!view.length) msg = everything.missing ? 'Loading all categories…'
            : gi.id === 'foryou' ? 'Add favorites or watch a few ' + (sec === 'movies' ? 'movies' : 'series') + '\nto get suggestions here.' : 'Nothing found';
        }
        else {
          var items = S.items[sec + ':' + gi.catId];
          title = splitLabel(gi.label).name;
          if (!items) { msg = 'Loading…'; later('cat', 350, function () { loadItems(sec, gi.catId); }); }
          else {
            view = items;
            title += ' · ' + view.length;
            if (!view.length) msg = 'Empty';
          }
        }
      }
    } else {
      kind = 'rec';
      if (S.recFiles) {
        view = S.query ? searchIn(S.recFiles, lowerName, S.query) : S.recFiles;
        title = 'Recordings · ' + view.length;
        if (!view.length) msg = Recorder.supported() ? 'No recordings yet.\nPlay something and press ● Rec.' : 'Recording needs a 2019 or newer Samsung TV.';
      }
    }
    if (S.query && !view.length && !msg) msg = 'No matches';

    S.view = view;
    S.viewKind = kind;
    $('ch-title').textContent = title;
    useGrid(kind === 'movie' || kind === 'series');
    if (!view.length && gridOn()) $('hero').style.visibility = 'hidden';
    var sel = 0;
    if (selectPlaying) { var p = playingPos(); if (p >= 0) sel = p; }
    chList.setCount(view.length, sel);
    listMsg(msg);
  }

  function playingPos() {
    var p = S.playing;
    if (!p || !S.view.length) return -1;
    if (S.viewKind === 'live') return p.kind === 'live' && p.idx >= 0 ? S.view.indexOf(p.idx) : -1;
    if (p.kind !== S.viewKind) return -1;
    for (var i = 0; i < S.view.length; i++) {
      var it = S.view[i];
      if ((it.id !== undefined && it.id === p.id) || (it.path && it.path === p.id)) return i;
    }
    return -1;
  }

  function isPlayingRow(i) {
    var p = S.playing;
    if (!p) return false;
    if (S.viewKind === 'live') return p.kind === 'live' && S.view[i] === p.idx;
    var it = S.view[i];
    return p.kind === S.viewKind && (it.id !== undefined ? it.id === p.id : it.path === p.id);
  }

  function selectGroup(i) {
    S.groupSel = i;
    S.query = ''; S.queryLabel = ''; $('search').value = '';
    S.episodes = null;
    grList.select(i);
    applyView(true);
    S.groupMem[S.section] = S.groupItems[i] ? S.groupItems[i].id : '';
    Store.lsSet('ui', S.groupMem);
  }

  /* ---------------- rendering ---------------- */

  function createChRow() {
    var r = document.createElement('div');
    r.innerHTML = '<span class="num"></span><img class="logo" alt=""><span class="name"></span><span class="tag q"></span><span class="fav"></span>';
    r._num = r.childNodes[0]; r._logo = r.childNodes[1]; r._name = r.childNodes[2]; r._q = r.childNodes[3]; r._fav = r.childNodes[4];
    r._logo.onerror = function () { this.style.visibility = 'hidden'; };
    return r;
  }

  function setLogo(img, src) {
    if (!logosOn()) { img.style.display = 'none'; return; }
    img.style.display = '';
    if (src) {
      if (img.getAttribute('src') !== src) { img.style.visibility = 'visible'; img.src = src; }
    } else { img.removeAttribute('src'); img.style.visibility = 'hidden'; }
  }

  function renderChRow(r, i) {
    var kind = S.viewKind, it = S.view[i];
    if (kind === 'live') {
      var c = S.live.channels[it], ql = QLABEL[S.live.qual[it]];
      r._num.textContent = S.live.num[it] || '';
      r._name.textContent = c.n;
      r._fav.textContent = S.favs[chKey(c)] ? '★' : '';
      r._q.textContent = ql || '';
      r._q.style.display = ql ? '' : 'none';
      setLogo(r._logo, c.l);
    } else {
      r._q.style.display = 'none';
      r._num.textContent = i + 1;
      r._name.textContent = it.n;
      var favSec = kind === 'movie' ? 'movies' : kind === 'series' ? 'series' : '';
      r._fav.textContent = favSec && isFavItem(favSec, it.id) ? '★' : kind === 'series' ? '›' : kind === 'episode' && isWatched('e' + it.id) ? '✓' : '';
      if (kind === 'movie' || kind === 'series') setLogo(r._logo, it.l);
      else r._logo.style.display = 'none';      // episodes / recordings have no logo: no empty box
    }
    if (isPlayingRow(i)) r.classList.add('playing'); else r.classList.remove('playing');
  }

  /* ---------------- big poster preview (movies / series) ---------------- */

  var movieDetails = {};   // movie id -> details from get_vod_info (fetched on demand)

  function hidePreview() { $('preview').classList.add('hidden'); }

  function cleanTitle(n) { return String(n || '').replace(/^\s*[A-Z0-9-]{2,6}\s+-\s+/, ''); }
  function yearOf(it) { var m = /\((\d{4})\)/.exec(it.n || ''); return it.y || (m ? m[1] : ''); }

  function onListSelect(i) {
    var kind = S.viewKind;
    if (kind === 'movie' || kind === 'series') {
      hidePreview();
      var g = S.view[i];
      if (!g) { $('hero').style.visibility = 'hidden'; return; }
      renderHero(g);
    } else if (kind === 'episode') {
      renderPreview(S.episodes.series, S.view[i]);
    } else return hidePreview();
    var it = kind === 'episode' ? null : S.view[i];
    // Movie details need one extra request: only ask once the selection rests for a moment.
    if (it && kind === 'movie' && S.acc && !movieDetails[it.id]) {
      later('pvinfo', 450, function () {
        Xtream.movieInfo(S.acc, it.id, function (err, d) {
          if (err) return;
          movieDetails[it.id] = d;
          if (S.view[chList.sel] === it) renderHero(it);
        });
      });
    }
  }

  /** Details strip above the poster grid: title, chips (year, rating, length, genre), plot. */
  function renderHero(it) {
    var d = movieDetails[it.id] || {};
    $('hero').style.visibility = '';
    $('hero-title').textContent = cleanTitle(it.n).replace(/\s*\(\d{4}\)\s*$/, '');
    var meta = $('hero-meta'), chips = [], y = d.y || yearOf(it), r = d.r || it.r;
    if (y) chips.push(['', y]);
    if (r) chips.push(['star', '★ ' + r]);
    if (d.d) chips.push(['', d.d]);
    if (d.gn || it.gn) chips.push(['', d.gn || it.gn]);
    if (isFavItem(S.section, it.id)) chips.push(['star', '★ Favorite']);
    if (isLater(S.section, it.id)) chips.push(['', '+ Watch later']);
    if (S.section === 'movies' && isWatched('m' + it.id)) chips.push(['', '✓ Watched']);
    meta.innerHTML = '';
    for (var i = 0; i < chips.length; i++) {
      var s = document.createElement('span');
      if (chips[i][0]) s.className = chips[i][0];
      s.textContent = chips[i][1];
      meta.appendChild(s);
    }
    $('hero-plot').textContent = d.p || it.p || '';
  }

  /* Poster tiles for the movies / series grid */
  function createTile() {
    var t = document.createElement('div');
    t.innerHTML = '<div class="pf"><div class="pph"></div><img class="pimg" alt=""><span class="pfav"></span></div><div class="pt"></div><div class="pm"></div>';
    t._pf = t.firstChild; t._ph = t._pf.childNodes[0]; t._img = t._pf.childNodes[1]; t._fav = t._pf.childNodes[2];
    t._t = t.childNodes[1]; t._m = t.childNodes[2];
    t._img.onerror = function () { this.style.visibility = 'hidden'; };
    t._img.onload = function () { this.style.visibility = 'visible'; };
    return t;
  }

  function renderTile(t, i) {
    var it = S.view[i], title = cleanTitle(it.n).replace(/\s*\(\d{4}\)\s*$/, '');
    t._ph.textContent = title;
    t._t.textContent = title;
    var y = yearOf(it), meta = [];
    if (y) meta.push(y);
    if (it.r) meta.push('★ ' + it.r);
    t._m.textContent = meta.join('  ·  ');
    t._fav.textContent = (isFavItem(S.section, it.id) ? '★' : '') + (S.section === 'movies' && isWatched('m' + it.id) ? '✓' : '') +
      (isLater(S.section, it.id) ? '+' : '');
    if (S.section === 'movies' && isWatched('m' + it.id)) t.classList.add('seen'); else t.classList.remove('seen');
    if (it.l && logosOn()) {
      if (t._img.getAttribute('src') !== it.l) { t._img.style.visibility = 'hidden'; t._img.src = it.l; }
    } else { t._img.removeAttribute('src'); t._img.style.visibility = 'hidden'; }
  }

  function renderPreview(it, ep) {
    var d = movieDetails[it.id] || {};
    var img = $('pv-img'), src = d.cover || it.l;
    if (src) {
      if (img.getAttribute('src') !== src) { img.style.visibility = 'hidden'; img.src = src; }
      $('pv-none').style.display = 'none';
    } else {
      img.removeAttribute('src'); img.style.visibility = 'hidden';
      $('pv-none').style.display = '';
    }
    $('pv-title').textContent = ep ? ep.n : it.n.replace(/^\s*[A-Z0-9-]{2,6}\s+-\s+/, '');
    var meta = [], y = d.y || it.y, r = d.r || it.r;
    if (ep) meta.push(it.n.replace(/^\s*[A-Z0-9-]{2,6}\s+-\s+/, ''));
    if (y) meta.push(y);
    if (r) meta.push('★ ' + r);
    if (d.d) meta.push(d.d);
    if (d.gn || it.gn) meta.push(d.gn || it.gn);
    $('pv-meta').textContent = meta.join('  ·  ');
    $('pv-plot').textContent = d.p || it.p || '';
    $('preview').classList.remove('hidden');
  }

  function createGrRow() {
    var r = document.createElement('div');
    r.innerHTML = '<span class="tag"></span><span class="name"></span><span class="cnt"></span>';
    r._tag = r.childNodes[0]; r._name = r.childNodes[1]; r._cnt = r.childNodes[2];
    return r;
  }

  function renderGrRow(r, i) {
    var g = S.groupItems[i], sl = splitLabel(g.label);
    r._tag.textContent = sl.tag;
    r._tag.style.display = sl.tag ? '' : 'none';
    r._name.textContent = sl.name;
    if (g.id === 'fav') r._cnt.textContent = S.section === 'live' ? favList().length : (S.favItems[S.section] || []).length;
    else if (g.id === 'later') r._cnt.textContent = (S.later[S.section] || []).length;
    else if (g.count !== undefined) r._cnt.textContent = g.count;
    else if (g.catId !== undefined && S.items[S.section + ':' + g.catId]) r._cnt.textContent = S.items[S.section + ':' + g.catId].length;
    else r._cnt.textContent = '';
  }

  /** Side menu: highlight the current section; outline it while the menu has focus. */
  function renderTabs() {
    var items = document.querySelectorAll('#nav .nav-item');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-sec') === S.section;
      items[i].className = 'nav-item' + (on ? ' on' : '') + (on && S.focus === 'tabs' ? ' focus' : '');
    }
  }

  function renderRecButton() {
    var rec = Recorder.current();
    $('rec-btn').innerHTML = rec ? '■ Stop rec' : '<span class="dot"></span>Rec';
  }

  function updateHints() {
    var h = S.section === 'rec'
      ? '<span>OK Play</span><span>Hold OK: Options</span><span><span class="key red"></span>Delete</span><span><span class="key yellow"></span>Search</span>'
      : '<span>OK Play</span><span>Hold OK: Options</span><span><span class="key red"></span>Refresh</span>' +
        '<span><span class="key green"></span>Favorite</span>' +
        '<span><span class="key yellow"></span>Search</span><span><span class="key blue"></span>Groups</span><span>CH &#177; Page</span>';
    $('hints').innerHTML = h;
  }

  var HEAD = ['search', 'record', 'refresh'];

  function setFocus(f) {
    S.focus = f;
    grList.setActive(f === 'groups');
    chList.setActive(f === 'list');
    $('search-box').className = 'btn' + (f === 'search' || f === 'typing' ? ' focus' : '');
    $('rec-btn').className = 'btn' + (f === 'record' ? ' focus' : '');    $('refresh-btn').className = 'btn' + (f === 'refresh' ? ' focus' : '');
    renderTabs();
    if (S.section === 'home') renderHomeFocus();
    if (S.section === 'settings') renderSettings();
  }

  function openPanel(focus) {
    if (!S.panel) {
      S.panel = true;
      $('panel').classList.remove('hidden');
      hideBanner();
      var p = S.playing;
      if (p) {
        var want = p.kind === 'live' ? 'live' : p.kind === 'movie' ? 'movies' : p.kind === 'rec' ? 'rec' : 'series';
        if (want !== S.section) switchSection(want);
      }
      if (S.section === 'live' && p && p.kind === 'live' && p.idx >= 0 && !S.query && S.groupItems.length) {
        var pos = S.view.indexOf(p.idx);
        if (pos < 0) {
          // Playing channel is not in the selected group: switch to the group it was played from.
          var gi = 0;
          for (var k = 0; k < S.groupItems.length; k++) if (S.groupItems[k].id === S.zapCtx) gi = k;
          selectGroup(gi);
          pos = S.view.indexOf(p.idx);
          if (pos < 0) { selectGroup(0); pos = S.view.indexOf(p.idx); }
        }
        if (pos >= 0) chList.select(pos, true);
      } else {
        var pp = playingPos();
        if (pp >= 0) chList.select(pp, true);
      }
      chList.invalidate();
    }
    setFocus(focus || 'list');
  }

  function closePanel() {
    if (S.focus === 'typing') $('search').blur();
    S.panel = false;
    $('panel').classList.add('hidden');
  }

  /* ---------------- banner ---------------- */

  function isVod() { return S.playing && S.playing.kind !== 'live'; }

  function renderBanner() {
    var p = S.playing;
    if (!p) return;
    $('b-num').textContent = p.num || '';
    $('b-num').style.display = p.num ? '' : 'none';
    $('b-name').textContent = p.title;
    $('b-group').textContent = p.sub || '';
    var logo = $('b-logo');
    if (p.logo && logosOn()) { logo.style.display = ''; logo.src = p.logo; } else logo.style.display = 'none';
    var st = $('b-status');
    st.textContent = S.status;
    st.className = S.statusErr ? 'err' : '';
    var d = new Date();
    $('b-clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var prog = $('b-progress');
    if (isVod()) {
      var dur = Player.duration(), t = S.seekBase >= 0 ? S.seekBase + S.seekDelta : Player.time();
      t = Math.max(0, dur ? Math.min(t, dur) : t);
      prog.style.display = '';
      $('b-bar').style.width = dur ? (100 * t / dur).toFixed(1) + '%' : '0';
      $('b-time').textContent = fmtTime(t) + (dur ? ' / ' + fmtTime(dur) : '');
    } else prog.style.display = 'none';
    $('b-subs').textContent = isVod() ? subsStatus() : '';
  }

  /** "Arabic: file #3, 12 lines · German: online, 1432 lines (0:41-1:52:10)" for the info bar. */
  function subsStatus() {
    var info = S.subs.info || {}, parts = [];
    for (var lang in info) {
      if (!info.hasOwnProperty(lang)) continue;
      var x = info[lang], s = langLabel(lang) + ': ';
      if (x.src === 'file') s += 'file #' + x.track + ', ' + (x.n || 0) + ' lines received';
      else if (x.state === 'ok') s += 'online, ' + x.n + ' lines (' + fmtTime(x.first) + '–' + fmtTime(x.last) + ')';
      else s += 'online, ' + x.state;
      parts.push(s);
    }
    if (!parts.length) return S.subs.cur ? 'Subtitles: ' + (S.subs.cur.type === 'off' ? 'off' : S.subs.cur.type) : '';
    var shift = '', dl = S.subs.delays || {};
    for (var l2 in dl) if (dl.hasOwnProperty(l2) && dl[l2]) shift += '  ·  ' + langLabel(l2) + ' ' + (dl[l2] > 0 ? '+' : '') + (dl[l2] / 1000).toFixed(1) + ' s';
    return 'Subtitles  —  ' + parts.join('  ·  ') + shift + '  ·  TV events: ' + (S.subs.rawEvents || 0);
  }

  function showBanner(sticky) {
    if (S.panel || !S.playing) return;
    renderBanner();
    $('banner').classList.remove('hidden');
    clearTimeout(timers.banner);
    if (!sticky) timers.banner = setTimeout(hideBanner, BANNER_MS);
  }

  function hideBanner() { clearTimeout(timers.banner); $('banner').classList.add('hidden'); }
  function bannerVisible() { return !$('banner').classList.contains('hidden'); }

  /* ---------------- subtitles (embedded tracks in movies / episodes) ---------------- */

  var LANGS = {
    ar: 'ar', ara: 'ar', arabic: 'ar', de: 'de', ger: 'de', deu: 'de', german: 'de', deutsch: 'de',
    en: 'en', eng: 'en', english: 'en', fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr', tr: 'tr', tur: 'tr', turkish: 'tr',
    es: 'es', spa: 'es', spanish: 'es', it: 'it', ita: 'it', nl: 'nl', dut: 'nl', nld: 'nl', pt: 'pt', por: 'pt',
    pl: 'pl', pol: 'pl', ru: 'ru', rus: 'ru', sv: 'sv', swe: 'sv', da: 'da', dan: 'da', no: 'no', nor: 'no', nob: 'no',
    fi: 'fi', fin: 'fi', el: 'el', gre: 'el', ell: 'el', fa: 'fa', per: 'fa', fas: 'fa', he: 'he', heb: 'he',
    hi: 'hi', hin: 'hi', ja: 'ja', jpn: 'ja', ko: 'ko', kor: 'ko', zh: 'zh', chi: 'zh', zho: 'zh',
    ro: 'ro', rum: 'ro', ron: 'ro', hu: 'hu', hun: 'hu', cs: 'cs', cze: 'cs', ces: 'cs', bg: 'bg', bul: 'bg'
  };
  var LANG_NAME = {
    ar: 'Arabic', de: 'German', en: 'English', fr: 'French', tr: 'Turkish', es: 'Spanish', it: 'Italian',
    nl: 'Dutch', pt: 'Portuguese', pl: 'Polish', ru: 'Russian', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
    fi: 'Finnish', el: 'Greek', fa: 'Persian', he: 'Hebrew', hi: 'Hindi', ja: 'Japanese', ko: 'Korean',
    zh: 'Chinese', ro: 'Romanian', hu: 'Hungarian', cs: 'Czech', bg: 'Bulgarian'
  };
  function langCode(raw) {
    var l = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    return LANGS[l] || LANGS[l.substring(0, 3)] || LANGS[l.substring(0, 2)] || l;
  }
  /** "German", "English (SDH)", "French (Forced)" — from the MKV header when we have it. */
  function trackLabel(t, pos) {
    var base = LANG_NAME[t.code] || (t.code && t.code !== 'und' ? t.code.toUpperCase() : 'Track ' + (pos + 1));
    var extra = t.name && t.name.toLowerCase() !== base.toLowerCase() ? t.name : '';
    if (t.forced && !/forced/i.test(extra)) extra = extra ? extra + ', Forced' : 'Forced';
    return base + (extra ? ' (' + extra + ')' : '');
  }

  /*
   * Subtitle modes, cycled with DOWN: "dual" (two languages at once), each embedded track, Off.
   * The TV decodes one embedded track and hands us its text; a second language comes from
   * OpenSubtitles as an SRT file that we draw ourselves by playback time.
   */
  var DUAL_DEFAULT = ['ar', 'de'];

  function dualPair() {
    var p = S.cfg && S.cfg.dualSubtitles;
    return p instanceof Array && p.length === 2 ? [langCode(p[0]), langCode(p[1])] : DUAL_DEFAULT;
  }

  function freshSubs() {
    return { tracks: [], opts: [], cur: null, slots: {}, order: [], embKey: null, online: {}, info: {}, rawEvents: 0, delays: {}, token: 0 };
  }

  function hideSub() { $('subs').classList.add('hidden'); }

  function cleanText(t) {
    return String(t || '').replace(/\\N/g, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
  }

  /** One block per language (in pair order), one dark box per line; smaller text when there is a lot. */
  function renderSubs() {
    var box = $('subs'), order = S.subs.order, chars = 0, lines = 0;
    box.innerHTML = '';
    for (var k = 0; k < order.length; k++) {
      var text = S.subs.slots[order[k]];
      if (!text) continue;
      var blk = document.createElement('div');
      blk.className = 'blk';
      var parts = text.split(/\s*\n\s*/);
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var span = document.createElement('span');
        span.textContent = parts[i];
        blk.appendChild(span);
        chars += parts[i].length; lines++;
      }
      box.appendChild(blk);
    }
    if (!lines) return hideSub();
    // Size from Settings, a bit smaller when there is a lot of text; colour and background too.
    var f = lines > 4 || chars > 200 ? 0.7 : lines > 2 || chars > 110 ? 0.82 : 1;
    box.style.fontSize = Math.round(SUB_SIZES[subStyle.size || 0].px * f) + 'px';
    box.className = 'c-' + SUB_COLORS[subStyle.color || 0].id + ' bg-' + SUB_BGS[subStyle.bg || 0].id;
  }

  function setSlot(key, text) {
    if ((S.subs.slots[key] || '') === text) return;
    S.subs.slots[key] = text;
    renderSubs();
  }

  /** Text from the TV's decoder (the embedded track). */
  function onEmbeddedSub(d) {
    var key = S.subs.embKey;
    var inf = key && S.subs.info[key.replace(/^l:/, '')];
    if (inf) inf.n = (inf.n || 0) + 1;                       // lines received from the TV's decoder
    S.subs.rawEvents = (S.subs.rawEvents || 0) + 1;
    if (!key) return;
    setSlot(key, cleanText(d.text));
    later('subs', Math.min(Math.max(d.ms, 800), 10000), function () { setSlot(key, ''); });
  }

  /** Online subtitles: called 4x per second. */
  function tickOnline() {
    var on = S.subs.online, any = false;
    for (var lang in on) {
      if (!on.hasOwnProperty(lang)) continue;
      any = true;
      setSlot('l:' + lang, OpenSubs.cueAt(on[lang], Player.time() - (S.subs.delays[lang] || 0)));
    }
    return any;
  }

  /** First full (not "forced") embedded track in a language, else a forced one, else -1. */
  function findTrack(lang) {
    var t = S.subs.tracks, forced = -1;
    for (var i = 0; i < t.length; i++) {
      if (t[i].code !== lang) continue;
      if (!t[i].forced) return i;
      if (forced < 0) forced = i;
    }
    return forced;
  }

  function langLabel(code) { return LANG_NAME[code] || String(code).toUpperCase(); }

  /** What OpenSubtitles needs to find this exact movie or episode. */
  function subInfo(p, cb) {
    var meta = subMeta[p.posKey] || {};
    var info = { hash: meta.hash || '', query: p.kind === 'episode' ? p.sub : p.title };
    info.query = String(info.query).replace(/^\s*[A-Z0-9-]{2,6}\s+-\s+/, '').replace(/\s*\(\d{4}\).*$/, '');
    if (p.kind === 'episode') {
      info.parentTmdb = p.seriesTmdb || '';
      info.season = p.s; info.episode = p.e;
      return cb(info);
    }
    var d = movieDetails[p.id];
    if (d) { info.tmdb = d.tmdb || ''; return cb(info); }
    Xtream.movieInfo(S.acc, p.id, function (err, det) {
      if (!err) { movieDetails[p.id] = det; info.tmdb = det.tmdb || ''; }
      cb(info);
    });
  }

  function loadOnline(lang) {
    var p = S.playing, tok = S.subs.token, key = 'srt:' + p.posKey + ':' + lang;
    function current() { return S.playing === p && S.subs.token === tok; }
    S.subs.info[lang] = { src: 'online', state: 'loading' };
    function use(entry) {
      if (!current()) return;
      S.subs.online[lang] = OpenSubs.parseSrt(entry.text);
      var cues = S.subs.online[lang];
      S.subs.info[lang] = { src: 'online', state: 'ok', n: cues.length, first: cues.length ? cues[0].s : 0, last: cues.length ? cues[cues.length - 1].e : 0 };
      tickOnline();
      var keys = S.subs.cur && S.subs.cur.type === 'dual' && dualPair()[0] === lang ? '4 / 6' : '1 / 3';
      toast(modeLabel() + '  ·  ' + langLabel(lang) + ' loaded online' + (entry.hashMatch ? '' : '  ·  out of sync? press ' + keys), 5000);
    }
    Store.get(key, function (cached) {
      if (cached && cached.text) return use(cached);
      subInfo(p, function (info) {
        if (!current()) return;
        toast(modeLabel() + '  ·  loading ' + langLabel(lang) + ' online…', 0);
        OpenSubs.fetchSubtitle(info, lang, function (err, r) {
          if (err) {
            if (!current()) return;
            S.subs.info[lang] = { src: 'online', state: 'failed: ' + err };
            toast(modeLabel() + '  ·  ' + langLabel(lang) + ' not available: ' +
              (/no .* found/.test(err) ? 'no ' + langLabel(lang) + ' subtitle exists online for this title' : err), 9000);
            return;
          }
          Store.put(key, { text: r.text, hashMatch: r.hashMatch, release: r.release });
          use(r);
        });
      });
    });
  }

  /*
   * Option kinds: { type: 'dual' } both languages of the pair, { type: 'lang', lang } one language
   * (from the file if it has it, else online), { type: 'emb', pos } any track in the file, { type: 'off' }.
   */
  function applyOpt(o, announce) {
    var t = S.subs.tracks, label, hint = '  ·  ▼ to change';
    S.subs.cur = o;
    S.subs.slots = {}; S.subs.order = []; S.subs.embKey = null; S.subs.online = {}; S.subs.info = {}; S.subs.rawEvents = 0;
    S.subs.token++;
    clearTimeout(timers.subs);
    hideSub();
    if (o.type === 'off') {
      Player.selectText(-1);
      label = 'Off';
    } else if (o.type === 'emb') {
      Player.selectText(t[o.pos].index);
      S.subs.embKey = 'emb'; S.subs.order = ['emb'];
      label = trackLabel(t[o.pos], o.pos) + '   ' + (o.pos + 1) + '/' + t.length;
      hint = '  ·  GREEN: next language';
    } else if (o.type === 'lang') {
      var p1 = findTrack(o.lang);
      if (p1 >= 0) { Player.selectText(t[p1].index); S.subs.embKey = 'l:' + o.lang; S.subs.info[o.lang] = { src: 'file', track: p1 + 1, n: 0 }; }
      else { Player.selectText(-1); loadOnline(o.lang); }
      S.subs.order = ['l:' + o.lang];
      label = langLabel(o.lang) + (p1 < 0 ? ' (online)' : '');
    } else {
      // Dual: the TV shows one language from the file (if it has one), the other comes online.
      var pair = dualPair(), embLang = null;
      for (var k = 0; k < pair.length && embLang === null; k++) {
        var pos = findTrack(pair[k]);
        if (pos >= 0) {
          Player.selectText(t[pos].index); embLang = pair[k]; S.subs.embKey = 'l:' + embLang;
          S.subs.info[embLang] = { src: 'file', track: pos + 1, n: 0 };
        }
      }
      if (embLang === null) Player.selectText(-1);
      S.subs.order = ['l:' + pair[0], 'l:' + pair[1]];
      for (k = 0; k < pair.length; k++) if (pair[k] !== embLang) loadOnline(pair[k]);
      label = langLabel(pair[0]) + ' + ' + langLabel(pair[1]);
    }
    applyEmbOffset();
    if (announce) toast('Subtitles: ' + label + hint, 3000);
  }

  /** "Subtitles: Arabic + German" for the current mode, used as the start of every subtitle message. */
  function modeLabel() {
    var o = S.subs.cur;
    if (!o) return 'Subtitles';
    if (o.type === 'dual') { var p = dualPair(); return 'Subtitles: ' + langLabel(p[0]) + ' + ' + langLabel(p[1]); }
    if (o.type === 'lang') return 'Subtitles: ' + langLabel(o.lang);
    if (o.type === 'emb') return 'Subtitles: ' + trackLabel(S.subs.tracks[o.pos], o.pos);
    return 'Subtitles: Off';
  }

  function optKey(o) {
    if (o.type === 'emb') return 'emb:' + S.subs.tracks[o.pos].code;
    return o.type === 'lang' ? 'lang:' + o.lang : o.type;
  }

  /** Called once a movie/episode starts: build the short DOWN list and restore the last choice. */
  function setupSubs() {
    var p = S.playing;
    var tracks = Player.textTracks();
    // The TV leaves the language empty: use what the MKV header says (same order as the TV's tracks).
    var meta = p && p.posKey && subMeta[p.posKey] ? subMeta[p.posKey].tracks : null;
    for (var i = 0; i < tracks.length; i++) {
      var m = meta && meta[i];
      tracks[i].code = langCode(m ? m.lang : tracks[i].lang);
      tracks[i].name = m ? m.name : '';
      tracks[i].forced = m ? m.forced : false;
    }
    var subs = freshSubs();
    subs.tracks = tracks;
    subs.delays = Store.lsGet('subDelay2:' + (p && p.posKey)) || {};
    S.subs = subs;

    // DOWN list: Arabic + German, then single languages (Arabic, German, English), then Off.
    var pair = dualPair(), online = OpenSubs.enabled() && p && (p.kind === 'movie' || p.kind === 'episode');
    var singles = pair.concat(((S.cfg && S.cfg.subtitleChoices) || ['ar', 'de', 'en']).map(langCode));
    if (online) subs.opts.push({ type: 'dual' });
    var seenLang = {};
    for (var k = 0; k < singles.length; k++) {
      var sl = singles[k];
      if (seenLang[sl]) continue;
      seenLang[sl] = 1;
      if (online || findTrack(sl) >= 0) subs.opts.push({ type: 'lang', lang: sl });
    }
    subs.opts.push({ type: 'off' });
    if (subs.opts.length === 1 && !tracks.length) return;

    var saved = Store.lsGet('subLang');
    if (typeof saved === 'string') {
      if (saved.indexOf('emb:') === 0) {
        var ep = findTrack(saved.substring(4));
        if (ep >= 0) return applyOpt({ type: 'emb', pos: ep }, true);
      } else {
        var want = /^[a-z]{2,3}$/.test(saved) ? 'lang:' + saved : saved;   // older saved values
        for (var j = 0; j < subs.opts.length; j++) if (optKey(subs.opts[j]) === want) return applyOpt(subs.opts[j], true);
      }
    }
    // First time: a pair language that is in the file, else any preferred language in the file.
    for (j = 0; j < subs.opts.length; j++) {
      if (subs.opts[j].type === 'lang' && findTrack(subs.opts[j].lang) >= 0) return applyOpt(subs.opts[j], true);
    }
    var prefs = (S.cfg && S.cfg.subtitleLanguages) || ['ar', 'de', 'en'];
    for (var q = 0; q < prefs.length; q++) {
      var pos = findTrack(langCode(prefs[q]));
      if (pos >= 0) return applyOpt({ type: 'emb', pos: pos }, true);
    }
    applyOpt({ type: 'off' }, false);
    if (subs.opts.length > 1 || tracks.length) toast('Subtitles available  ·  ▼ to choose', 3000);
  }

  /** DOWN: Arabic + German -> Arabic -> German -> Off. The choice is remembered for the next movie. */
  function cycleSubs() {
    var opts = S.subs.opts, idx = -1;
    if (opts.length <= 1) return toast(S.subs.tracks.length ? 'Press GREEN to choose a subtitle' : 'No subtitles for this title');
    for (var i = 0; i < opts.length; i++) if (opts[i] === S.subs.cur) idx = i;
    var o = opts[(idx + 1) % opts.length];
    applyOpt(o, true);
    Store.lsSet('subLang', optKey(o));
  }

  /** GREEN: step through every subtitle inside the file (French, English, ...). */
  function cycleEmbedded() {
    var t = S.subs.tracks;
    if (!t.length) return toast('No subtitles inside this file');
    var cur = S.subs.cur, pos = cur && cur.type === 'emb' ? cur.pos + 1 : 0;
    var o = { type: 'emb', pos: pos >= t.length ? 0 : pos };
    applyOpt(o, true);
    Store.lsSet('subLang', optKey(o));
  }

  /** Language currently drawn from the file (by the TV), or null. */
  function embLang() {
    var k = S.subs.embKey, o = S.subs.cur;
    if (!k) return null;
    return k === 'emb' ? S.subs.tracks[o.pos].code : k.substring(2);
  }

  /** Apply the saved timing of the file's subtitle to the TV's decoder. */
  function applyEmbOffset() {
    var l = embLang();
    if (l) Player.setTextOffset(S.subs.delays[l] || 0);
  }

  /**
   * Timing per language, saved per movie. which: 'bottom' (1 / 3, German) or 'top' (4 / 6, Arabic).
   * Online subtitles are shifted by the app; subtitles from the file are shifted by the TV's player.
   */
  function shiftLang(which, ms) {
    var o = S.subs.cur, lang;
    if (!o || o.type === 'off') return toast('Subtitles are off');
    if (o.type === 'dual') { var pr = dualPair(); lang = which === 'top' ? pr[0] : pr[1]; }
    else lang = o.type === 'lang' ? o.lang : embLang();
    if (!lang) return;
    var online = !!S.subs.online[lang], fromFile = embLang() === lang;
    if (!online && !fromFile) return toast(langLabel(lang) + ' subtitles are not showing');
    var d = (S.subs.delays[lang] || 0) + ms;
    if (fromFile && !Player.setTextOffset(d)) return toast('This TV cannot shift ' + langLabel(lang) + ' subtitles from the file');
    S.subs.delays[lang] = d;
    Store.lsSet('subDelay2:' + S.playing.posKey, S.subs.delays);
    if (online) tickOnline();
    toast(langLabel(lang) + ' subtitle timing: ' + (d > 0 ? '+' : '') + (d / 1000).toFixed(1) + ' s' +
      (d > 0 ? ' (later)' : d < 0 ? ' (earlier)' : ''), 2000);
  }

  /** Best version failed: try the next one (4K -> FHD -> HD ...) without bothering the user. */
  function tryNextVersion() {
    var p = S.playing;
    if (!p || p.kind !== 'live' || !p.alts || !p.alts.length) return false;
    var nxt = p.alts.shift(), c = S.live.channels[nxt];
    var from = QLABEL[p.q] || 'This version', to = QLABEL[S.live.qual[nxt]] || 'another version';
    p.url = liveUrl(c); p.id = c.id; p.q = S.live.qual[nxt]; p.title = c.n;
    toast(from + ' not available, switching to ' + to, 3000);
    Player.play(p.url, { live: true });
    return true;
  }

  /**
   * Movie/episode stopped early (server dropped the connection, or ended the stream before the
   * real end): reconnect and continue from the same second, a few times per title.
   */
  function recoverVod(reason) {
    var p = S.playing;
    if (!p || p.kind === 'live' || p.kind === 'rec') return false;
    var t = Math.max(Player.time(), p.lastTime || 0), d = Player.duration() || p.lastDur || 0;
    if (t < 5000 || (d && t > d - 60000)) return false;       // never really started, or it is the real end
    p.recoveries = (p.recoveries || 0) + 1;
    if (p.recoveries > 5) return false;
    toast('Connection dropped (' + reason + '), continuing at ' + fmtTime(t) + '…', 3000);
    S.status = 'Reconnecting…'; S.statusErr = false;
    // Subtitle mode and online subtitles come back by themselves (saved choice + cached file).
    setTimeout(function () { if (S.playing === p) Player.play(p.url, { live: false, startMs: t }); }, 1500);
    return true;
  }

  function onPlayerStatus(type, data) {
    if (type === 'error' && tryNextVersion()) return;
    if (type === 'error' && recoverVod('error')) return;
    if (type === 'playing' && S.playing && S.playing.kind !== 'live') {
      var pl = S.playing;
      setTimeout(function () { if (S.playing === pl && Player.time() > 60000) pl.recoveries = 0; }, 30000);
    }
    if (type === 'tracks') { setupSubs(); return; }
    if (type === 'subtitle') { onEmbeddedSub(data); return; }
    if (type === 'buffering') { S.status = data ? 'Buffering ' + data + '%' : 'Loading…'; S.statusErr = false; }
    else if (type === 'playing') { S.status = ''; S.statusErr = false; }
    else if (type === 'error') { S.status = 'Stream unavailable'; S.statusErr = true; }
    else if (type === 'ended') { onEnded(); return; }
    if (bannerVisible()) renderBanner();
    if (type === 'error') showBanner(true);
  }

  function onEnded() {
    var p = S.playing;
    if (recoverVod('stream ended early')) return;
    if (p) { clearPos(p.posKey); finishedTitle(p); }
    if (p && p.kind === 'episode' && S.zap.kind === 'episode') {
      var pos = indexById(S.zap.list, p.id);
      if (pos >= 0 && pos + 1 < S.zap.list.length) { toast('Next episode'); playEpisode(S.zap.list[pos + 1], S.zap.series); return; }
    }
    S.status = 'Finished'; S.statusErr = false;
    showBanner(true);
  }

  /* ---------------- resume positions (movies / episodes) ---------------- */

  var positions = Store.lsGet('pos') || {};
  function savePos() {
    var p = S.playing;
    if (!p || !p.posKey || S.statusErr) return;
    var t = Player.time(), d = Player.duration();
    if (t < 60000) return;
    if (d && t > d - 180000) { clearPos(p.posKey); finishedTitle(p); return; }
    delete positions[p.posKey];
    positions[p.posKey] = t;
    var keys = Object.keys(positions);
    if (keys.length > 300) delete positions[keys[0]];
    Store.lsSet('pos', positions);
    cwUpdate(p, t, d);
  }
  /** A movie / episode played to the end: tick it as watched; a movie leaves "Watch later". */
  function finishedTitle(p) {
    if (!p || (p.kind !== 'movie' && p.kind !== 'episode') || isWatched(p.posKey)) return;
    markWatched(p.posKey, true);
    if (p.kind === 'movie' && isLater('movies', p.id)) toggleLater('movies', { id: p.id, n: p.title }, true);
    chList.invalidate();
  }
  function clearPos(key) {
    if (key && positions[key] !== undefined) { delete positions[key]; Store.lsSet('pos', positions); }
    cwRemove(key);
  }

  /* "Continue watching" on the Home screen: the last 12 unfinished movies / episodes. */
  var cw = Store.lsGet('cw') || [];
  function cwUpdate(p, t, d) {
    if ((p.kind !== 'movie' && p.kind !== 'episode') || !p.item) return;
    cwRemove(p.posKey, true);
    cw.unshift({ key: p.posKey, kind: p.kind, item: p.item, series: p.series || null, t: t, d: d || 0 });
    if (cw.length > 12) cw.length = 12;
    Store.lsSet('cw', cw);
  }
  function cwRemove(key, noSave) {
    for (var i = cw.length - 1; i >= 0; i--) if (cw[i].key === key) cw.splice(i, 1);
    if (!noSave) Store.lsSet('cw', cw);
  }

  /* ---------------- playback ---------------- */

  var subMeta = {};   // posKey -> { tracks: [{ lang, name, forced }] from the MKV header, size, hash }

  function indexById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  function startPlaying(p, opts) {
    opts = opts || {};
    if (S.playing && S.playing.kind === 'live' && !(p.kind === 'live' && p.idx === S.playing.idx)) {
      S.prev = { idx: S.playing.idx, ctx: S.zapCtx };
    }
    savePos();
    S.playing = p;
    S.status = 'Loading…'; S.statusErr = false;
    S.seekBase = -1; S.seekDelta = 0;
    S.speed = 1;
    S.subs.token++;
    S.subs = freshSubs();
    hideSub();
    chList.invalidate();
    showBanner();
    var startMs = p.posKey && positions[p.posKey] ? positions[p.posKey] : 0;
    if (startMs) toast('Resuming at ' + fmtTime(startMs) + ' · ◄ to rewind', 3000);
    clearTimeout(timers.zap);
    var go = function () { Player.play(p.url, { live: p.kind === 'live', startMs: startMs }); };
    if (opts.debounce) { timers.zap = setTimeout(go, ZAP_DELAY); return; }
    var vod = p.kind === 'movie' || p.kind === 'episode';
    var wantProbe = vod && (/^mkv$/i.test(p.ext || '') || OpenSubs.enabled());
    if (!wantProbe || subMeta[p.posKey]) return go();
    // Before playback: read subtitle languages from the file header and its OpenSubtitles hash.
    // Done once per movie (saved). Stop the current stream first and leave the server a moment
    // between the check and playback: the subscription allows only one connection at a time.
    Player.stop();
    Store.get('probe:' + p.posKey, function (saved) {
      if (S.playing !== p) return;
      if (saved && saved.v === 2) { subMeta[p.posKey] = saved; return go(); }
      MKV.probe(p.url, 6000, function (res) {
        res.v = 2;
        subMeta[p.posKey] = res;
        if (res.tracks || res.hash) Store.put('probe:' + p.posKey, res);
        if (S.playing === p) setTimeout(function () { if (S.playing === p) go(); }, 800);
      });
    });
  }

  function playLive(idx, opts) {
    var c = S.live.channels[idx];
    if (!c) return;
    var L = S.live;
    var p = {
      kind: 'live', idx: idx, id: c.id, key: chKey(c), url: liveUrl(c), title: c.n, sub: L.groups[c.g], logo: c.l,
      num: L.num[idx] || '', ext: 'ts', q: L.qual[idx], alts: (L.alts[idx] || []).slice()
    };
    Store.lsSet('last', { p: { kind: 'live', key: p.key, url: p.url, title: p.title, sub: p.sub, logo: p.logo }, ctx: S.zapCtx });
    rememberChannel(c);
    startPlaying(p, opts);
  }

  function playMovie(m) {
    startPlaying({
      kind: 'movie', id: m.id, url: Xtream.movieUrl(S.acc, m.id, m.ext), title: m.n, sub: 'Movie', logo: m.l, ext: m.ext, posKey: 'm' + m.id,
      item: { n: m.n, id: m.id, l: m.l, ext: m.ext, r: m.r }
    });
  }

  function playEpisode(ep, series) {
    startPlaying({
      kind: 'episode', id: ep.id, url: Xtream.episodeUrl(S.acc, ep.id, ep.ext), title: ep.n, sub: series.n, logo: series.l,
      ext: ep.ext, posKey: 'e' + ep.id, s: ep.s, e: ep.e, seriesTmdb: series.tmdb || '',
      item: { n: ep.n, id: ep.id, ext: ep.ext, s: ep.s, e: ep.e },
      series: { n: series.n, id: series.id, l: series.l, tmdb: series.tmdb || '' }
    });
  }

  function playRecording(f) {
    startPlaying({ kind: 'rec', id: f.path, url: Recorder.uri(f.path), title: f.n, sub: 'Recording', posKey: 'r' + f.path });
  }

  function zap(dir) {
    var p = S.playing;
    if (p && p.kind === 'episode' && S.zap.kind === 'episode') {
      var pos = indexById(S.zap.list, p.id) + dir;
      if (pos < 0 || pos >= S.zap.list.length) return toast(dir > 0 ? 'Last episode' : 'First episode');
      return playEpisode(S.zap.list[pos], S.zap.series);
    }
    if (p && p.kind !== 'live') return;
    var list = S.zap.kind === 'live' && S.zap.list.length ? S.zap.list : S.live.allIdx;
    if (!list.length) return;
    var i = p ? list.indexOf(p.idx) : -1;
    if (i === -1) i = dir > 0 ? -1 : 0;
    i = (i + dir + list.length) % list.length;
    playLive(list[i], { debounce: true });
  }

  function playPrevious() {
    if (!S.prev || S.prev.idx < 0) return;
    var pv = S.prev;
    S.zapCtx = pv.ctx;
    S.zap = { kind: 'live', list: liveListFor(pv.ctx) };
    playLive(pv.idx);
  }

  function activateRow() {
    var it = S.view[chList.sel];
    if (it === undefined) return;
    var kind = S.viewKind;
    if (kind === 'series') return openSeries(it);
    if (isPlayingRow(chList.sel)) { closePanel(); showBanner(); return; }
    if (kind === 'live') {
      if (S.query) { S.zapCtx = 'all'; S.zap = { kind: 'live', list: S.view.slice() }; }
      else { S.zapCtx = S.groupItems[S.groupSel].id; S.zap = { kind: 'live', list: S.view }; }
      playLive(it);
    } else if (kind === 'movie') { openDetails(it); }
    else if (kind === 'episode') {
      S.zap = { kind: 'episode', list: S.episodes.list, series: S.episodes.series };
      playEpisode(it, S.episodes.series);
      closePanel();
    } else if (kind === 'rec') { playRecording(it); closePanel(); }  }

  function toggleFav(idx) {
    var c = S.live.channels[idx];
    if (!c) return;
    var k = chKey(c);
    if (S.favs[k]) { delete S.favs[k]; toast('Removed from favorites: ' + c.n); }
    else { S.favs[k] = 1; toast('Added to favorites: ' + c.n); }
    Store.lsSet('favs', S.favs);
    if (S.section === 'live') {
      var gi = S.groupItems[S.groupSel];
      if (!S.query && gi && gi.id === 'fav') {
        var sel = chList.sel;
        applyView(false);
        chList.select(Math.min(sel, S.view.length - 1));
      } else chList.invalidate();
      grList.invalidate();
    }
    if (S.zapCtx === 'fav') S.zap = { kind: 'live', list: favList() };
  }

  /* ---------------- movie / series favorites ---------------- */

  function isFavItem(sec, id) {
    var list = S.favItems[sec];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return true;
    return false;
  }

  /** Favorites keep a copy of the item, so the list works without loading any category. */
  function toggleFavItem(sec, it) {
    if (!it) return;
    var list = S.favItems[sec], pos = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === it.id) pos = i;
    if (pos >= 0) { list.splice(pos, 1); toast('Removed from favorites: ' + it.n); }
    else { list.unshift(it); toast('Added to favorites: ' + it.n); }
    Store.lsSet(sec === 'movies' ? 'favMovies' : 'favSeries', list);
    var gi = S.groupItems[S.groupSel];
    if (S.section === sec && !S.query && !S.episodes && gi && gi.id === 'fav') {
      var sel = chList.sel;
      applyView(false);
      chList.select(Math.min(sel, S.view.length - 1));
    } else chList.invalidate();
    grList.invalidate();
    if (gridOn() && S.view.length) onListSelect(chList.sel);   // refresh the "Favorite" chip
  }

  /* ---------------- seeking (movies / episodes / recordings) ---------------- */

  function seek(deltaMs) {
    if (!isVod()) return;
    if (S.seekBase < 0) { S.seekBase = Player.time(); S.seekDelta = 0; }
    S.seekDelta += deltaMs;
    showBanner();
    later('seek', 700, function () {
      Player.seekTo(S.seekBase + S.seekDelta);
      S.seekBase = -1; S.seekDelta = 0;
    });
  }

  /* ---------------- recording ---------------- */

  function toggleRecord() {
    if (Recorder.current()) { Recorder.stop(); return; }
    var p = S.playing;
    if (!p) return toast('Play something first, then press Rec');
    if (p.kind === 'rec') return toast('This is already a recording');
    toast('Starting recording…', 0);
    Recorder.start(p.url, p.title, p.ext || 'ts', function (err) {
      if (err) return toast('Recording failed: ' + err, 6000);
      toast('Recording ' + p.title + '. If the picture stops, your plan allows only one connection.', 6000);
    });
  }

  function onRecordChange(rec, err) {
    renderRecButton();
    var badge = $('rec-badge');
    if (Recorder.current()) { badge.classList.remove('hidden'); updateRecBadge(); }
    else {
      badge.classList.add('hidden');
      if (rec && rec.finished) {
        toast((err ? 'Recording stopped: ' + err : 'Recording saved') + ' · ' + fmtBytes(rec.bytes), 6000);
        S.recFiles = null;
        if (S.section === 'rec') loadRecordings();
      }
    }
  }

  function updateRecBadge() {
    var rec = Recorder.current();
    if (!rec) return;
    $('rec-text').textContent = 'REC  ' + rec.title + '  ' + fmtTime(Date.now() - rec.started) + '  ' + fmtBytes(rec.bytes);
  }

  var delArmed = null;
  function deleteRecording() {
    var f = S.view[chList.sel];
    if (!f || S.viewKind !== 'rec') return;
    if (delArmed !== f.path) { delArmed = f.path; toast('Press RED again to delete ' + f.n, 3000); return; }
    delArmed = null;
    Recorder.remove(f.path, function (err) {
      if (err) return toast('Delete failed: ' + err, 5000);
      toast('Deleted ' + f.n);
      clearPos('r' + f.path);
      loadRecordings();
    });
  }

  /* ---------------- refresh ---------------- */

  function refresh() {
    if (S.section === 'rec') return loadRecordings();
    if (S.loading || !S.cfg) return;
    S.loading = true;
    Store.lsSet('refreshedAt', Date.now());
    S.items = {}; catLoading = {};
    if (S.acc) { S.cats = { movies: null, series: null }; loadCats('movies', true); loadCats('series', true); }
    if (S.section === 'home') loadHomeData(true);
    else if (S.section !== 'live') rebuildGroups(false);
    loadLive(true, function () { S.loading = false; });
  }

  /* ---------------- digits ---------------- */

  var digitBuf = '';
  function digit(d) {
    if (digitBuf.length >= 5) digitBuf = '';
    digitBuf += d;
    var el = $('digits');
    el.textContent = digitBuf;
    el.classList.remove('hidden');
    later('digits', 1500, commitDigits);
  }
  function commitDigits() {
    clearTimeout(timers.digits);
    var n = parseInt(digitBuf, 10);
    digitBuf = '';
    $('digits').classList.add('hidden');
    if (n >= 1 && n <= S.live.allIdx.length) {
      S.zapCtx = 'all'; S.zap = { kind: 'live', list: S.live.allIdx };
      if (S.panel) closePanel();
      playLive(S.live.allIdx[n - 1]);
    } else if (n) toast('No channel ' + n);
  }

  /* ---------------- exit ---------------- */

  var backArmed = 0;
  function backToExit() {
    if (Date.now() - backArmed < 2500) {
      savePos();
      if (Recorder.current()) Recorder.stop();
      Player.stop();
      try { window.tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
      return;
    }
    backArmed = Date.now();
    toast(Recorder.current() ? 'Press BACK again to exit (recording will stop)' : 'Press BACK again to exit', 2500);
  }

  /* ---------------- key handling ---------------- */

  function onKey(e) {
    var k = Keys.name(e);
    if (!k) return;

    // A popup (match reminder, sleep timer) takes OK / BACK first.
    if (ALERT) {
      e.preventDefault();
      if (k === 'ENTER') closeAlert('ok');
      else if (k === 'BACK' || k === 'BKSP') closeAlert('back');
      return;
    }
    if (HOLD && Date.now() - HOLD.at > 4000) HOLD = null;          // missed key-up: forget the hold
    if (k === 'ENTER' && HOLD) { e.preventDefault(); return; }   // OK still held after the menu opened
    if (MENU) { e.preventDefault(); menuKey(k === 'BKSP' ? 'BACK' : k); return; }
    if (S.focus === 'trailer') { e.preventDefault(); if (k === 'BACK' || k === 'BKSP') closeTrailer(); return; }
    if (S.focus === 'details') { e.preventDefault(); detailsKey(k === 'BKSP' ? 'BACK' : k); return; }

    if (S.focus === 'typing' && S.panel) {
      if (k === 'ENTER' || k === 'DONE' || k === 'DOWN') { e.preventDefault(); $('search').blur(); setFocus(S.view.length ? 'list' : 'search'); }
      else if (k === 'BACK' || k === 'CANCEL' || k === 'UP') { e.preventDefault(); $('search').blur(); setFocus('search'); }
      return; // every other key belongs to the text field / IME
    }

    e.preventDefault();
    if (k === 'BKSP') k = 'BACK';
    if (k === 'RECORD') { toggleRecord(); return; }

    if (!S.panel && k === 'D0' && S.cfg && S.cfg.debug) { toggleOutlines(); return; }
    // 0 while watching (channel numbers never start with 0): sleep timer.
    if (!S.panel && k === 'D0' && !digitBuf) { cycleSleep(); return; }
    // Subtitle timing while a movie plays: 1 / 3 = bottom language (German), 4 / 6 = top language (Arabic).
    if (!S.panel && isVod() && (k === 'D1' || k === 'D3')) { shiftLang('bottom', k === 'D1' ? -500 : 500); return; }
    if (!S.panel && isVod() && (k === 'D4' || k === 'D6')) { shiftLang('top', k === 'D4' ? -500 : 500); return; }
    if (k.charAt(0) === 'D' && k.length === 2) { digit(k.charAt(1)); return; }
    if (digitBuf && k === 'ENTER') { commitDigits(); return; }

    // OK on a channel / poster: a short press opens it, holding it opens the options menu.
    if (k === 'ENTER' && S.panel && S.focus === 'list' && S.view.length) { okDown(function () { panelKey('ENTER'); }, openItemMenu); return; }
    // OK while watching: short = channel list, held = speed / subtitles / record / sleep timer.
    if (k === 'ENTER' && !S.panel && S.playing) { okDown(function () { watchKey('ENTER'); }, openWatchMenu); return; }

    if (S.panel) panelKey(k); else watchKey(k);
  }

  var HOLD = null;                                      // OK being held: { timer, fired, at, short }
  function okDown(shortFn, longFn) {
    if (HOLD && Date.now() - HOLD.at < 4000) return;    // key repeat while held
    HOLD = { fired: false, at: Date.now(), short: shortFn, timer: setTimeout(function () {
      if (!HOLD) return;
      HOLD.fired = true;
      longFn();
    }, 550) };
  }
  function onKeyUp(e) {
    if (Keys.name(e) !== 'ENTER' || !HOLD) return;
    var h = HOLD;
    HOLD = null;
    clearTimeout(h.timer);
    if (!h.fired && !MENU) h.short();
  }

  function watchKey(k) {
    var vod = isVod();
    switch (k) {
      case 'ENTER': case 'CH_LIST': openPanel('list'); break;
      case 'RIGHT': if (vod) seek(30000); else openPanel('list'); break;
      case 'LEFT': if (vod) seek(-15000); else openPanel('groups'); break;
      case 'FF': seek(60000); break;
      case 'RW': seek(-60000); break;
      case 'BLUE': openPanel('groups'); break;
      case 'YELLOW': openPanel('search'); startTyping(); break;
      // Movies/episodes: UP = info, DOWN = subtitles, CH +/- = next/previous episode.
      case 'UP': if (vod) showBanner(); else zap(1); break;
      case 'DOWN': if (vod) cycleSubs(); else zap(-1); break;
      case 'CH_UP': if (vod && S.playing.kind !== 'episode') showBanner(); else zap(1); break;
      case 'CH_DOWN': if (vod && S.playing.kind !== 'episode') showBanner(); else zap(-1); break;
      case 'PREV_CH': playPrevious(); break;
      case 'INFO': if (bannerVisible()) hideBanner(); else showBanner(); break;
      case 'GREEN':
        if (vod) cycleEmbedded();
        else if (S.playing && S.playing.kind === 'live' && S.playing.idx >= 0) toggleFav(S.playing.idx);
        break;
      case 'RED': refresh(); break;
      case 'PLAYPAUSE': case 'PLAY': case 'PAUSE':
        S.status = Player.togglePause() ? 'Paused' : ''; S.statusErr = false; showBanner(S.status !== ''); break;
      case 'STOP': savePos(); Player.stop(); S.status = 'Stopped'; showBanner(true); break;
      case 'BACK':
        if (bannerVisible()) hideBanner();
        else if (vod) leaveVod();          // movie / episode / recording: back to the Home screen
        else backToExit();
        break;
    }
  }

  function startTyping() {
    setFocus('typing');
    var inp = $('search');
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
  }

  function panelBack() {
    if (S.playing) closePanel(); else backToExit();
  }

  /** Stop a movie/episode (position is saved) and show the Home screen instead of exiting. */
  function leaveVod() {
    savePos();
    Player.stop();
    hideSub();
    S.subs.token++;
    S.subs = freshSubs();
    S.playing = null;
    S.status = '';
    hideBanner();
    switchSection('home');
    if (S.section === 'home') renderHome();
    openPanel('home');
  }

  function moveSection(dir) {
    var i = SECTIONS.indexOf(S.section) + dir;
    if (i < 0 || i >= SECTIONS.length) return;
    switchSection(SECTIONS[i]);
    setFocus('tabs');
  }

  function panelKey(k) {
    if (S.focus === 'reader') { if (k === 'BACK' || k === 'ENTER') closeReader(); return; }
    if (S.focus === 'settings') return settingsKey(k);
    if (S.focus === 'home') return homeKey(k);
    // Keys that work in every column
    switch (k) {
      case 'RED': if (S.section === 'rec' && S.focus === 'list') deleteRecording(); else refresh(); return;
      case 'YELLOW': setFocus('search'); startTyping(); return;
      case 'BLUE': setFocus(S.focus === 'groups' ? 'list' : 'groups'); return;
      // INFO on a channel / poster: options menu (handy in the grid, where RIGHT moves)
      case 'INFO': if (S.focus === 'list' && S.view.length) openItemMenu(); else panelBack(); return;
      case 'CH_LIST': panelBack(); return;
      case 'PREV_CH': playPrevious(); return;
    }

    switch (S.focus) {
      // Side menu (vertical): up/down switch section, right/OK go into the categories.
      case 'tabs':
        switch (k) {
          case 'UP': moveSection(-1); break;
          case 'DOWN': moveSection(1); break;
          case 'RIGHT': case 'ENTER':
            if (S.section === 'home') setFocus('home');
            else if (S.section === 'settings') setFocus('settings');
            else setFocus(S.groupItems.length > 1 ? 'groups' : 'list');
            break;
          case 'BACK': panelBack(); break;
        }
        break;

      case 'list':
        if (gridOn()) {
          // Poster grid: arrows move in 2D; leaving the left edge goes to categories, the top to the header.
          switch (k) {
            case 'UP': if (!gridW.moveV(-1)) setFocus('search'); return;
            case 'DOWN': gridW.moveV(1); return;
            case 'LEFT': if (!gridW.moveH(-1)) setFocus('groups'); return;
            case 'RIGHT': if (!gridW.moveH(1)) openItemMenu(); return;   // right edge: options
          }
        }
        switch (k) {
          case 'UP': if (chList.sel === 0 || !chList.count) setFocus('search'); else chList.move(-1); break;
          case 'DOWN': chList.move(1); break;
          case 'RIGHT': openItemMenu(); break;
          case 'LEFT': setFocus('groups'); break;
          case 'CH_UP': chList.page(-1); break;
          case 'CH_DOWN': chList.page(1); break;
          case 'ENTER': activateRow(); break;
          case 'GREEN':
            if (!S.view.length) break;
            if (S.viewKind === 'live') toggleFav(S.view[chList.sel]);
            else if (S.viewKind === 'movie') toggleFavItem('movies', S.view[chList.sel]);
            else if (S.viewKind === 'series') toggleFavItem('series', S.view[chList.sel]);
            else if (S.viewKind === 'episode') toggleFavItem('series', S.episodes.series);
            break;
          case 'BACK': if (S.episodes) closeSeries(); else panelBack(); break;
        }
        break;

      case 'groups':
        switch (k) {
          case 'UP': if (S.groupSel > 0) selectGroup(S.groupSel - 1); break;
          case 'DOWN': if (S.groupSel < S.groupItems.length - 1) selectGroup(S.groupSel + 1); break;
          case 'CH_UP': grList.page(-1); selectGroup(grList.sel); break;
          case 'CH_DOWN': grList.page(1); selectGroup(grList.sel); break;
          case 'LEFT': setFocus('tabs'); break;
          case 'RIGHT': case 'ENTER': setFocus('list'); break;
          case 'BACK': panelBack(); break;
        }
        break;

      case 'search': case 'record': case 'refresh':
        var hi = HEAD.indexOf(S.focus);
        switch (k) {
          case 'ENTER':
            if (S.focus === 'search') startTyping();
            else if (S.focus === 'record') toggleRecord();            else refresh();
            break;
          case 'RIGHT': if (hi < HEAD.length - 1) setFocus(HEAD[hi + 1]); break;
          case 'LEFT': if (hi > 0) setFocus(HEAD[hi - 1]); else setFocus('groups'); break;
          case 'UP': break;
          case 'DOWN': setFocus('list'); break;
          case 'BACK':
            if (S.focus === 'search' && S.query) { S.query = ''; S.queryLabel = ''; $('search').value = ''; applyView(true); }
            setFocus('list');
            break;
        }
        break;
    }
  }

  /* ---------------- Home screen ---------------- */

  var HOME = { rows: [], r: 0, c: {}, weather: null, weatherAt: 0, matches: null, matchesAt: 0, news: {}, newsAt: 0 };
  var WICON = {
    sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    partly: '<circle cx="8" cy="8" r="3.2"/><path d="M8 2.5v1.2M2.5 8h1.2M4.1 4.1l.9.9M11.9 4.1l-.9.9"/><path d="M8 19h9.5a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 8 19z"/>',
    cloud: '<path d="M6.5 19h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.7 1.4A3.4 3.4 0 0 0 6.5 19z"/>',
    fog: '<path d="M6.5 14h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.7 1.4A3.3 3.3 0 0 0 6.5 14z"/><path d="M4 18h16M6 21h12"/>',
    rain: '<path d="M6.5 15h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.7 1.4A3.3 3.3 0 0 0 6.5 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    snow: '<path d="M6.5 15h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.7 1.4A3.3 3.3 0 0 0 6.5 15z"/><path d="M8 19h.01M12 21h.01M16 19h.01M10 22h.01M14 22h.01"/>',
    storm: '<path d="M6.5 14h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.7 1.4A3.3 3.3 0 0 0 6.5 14z"/><path d="M12.5 15l-2.5 4h4l-2.5 4"/>'
  };
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function homeCfg() {
    var h = (S.cfg && S.cfg.home) || {};
    return {
      weather: h.weather || { name: 'Kloten', lat: 47.4515, lon: 8.5849 },
      leagues: h.leagues || ['eng.1', 'esp.1', 'ger.1', 'ita.1', 'uefa.champions', 'uefa.europa', 'caf.champions', 'caf.confed'],
      // National-team competitions: shown only when a favorite team (Egypt, Switzerland) plays.
      favLeagues: h.nationalLeagues || ['fifa.world', 'fifa.worldq.uefa', 'fifa.worldq.caf', 'uefa.nations', 'uefa.euro', 'uefa.euroq',
        'caf.nations', 'caf.nations_qual', 'fifa.friendly'],
      keep: function (m) { return isFavMatch(m); },
      // ESPN team ids whose upcoming games are fetched directly (Egypt 2620, Switzerland 475).
      teamIds: h.espnTeamIds || [2620, 475],
      egypt: h.egyptLeague !== false,
      sportsGroup: h.sportsGroup || 'BEIN',
      news: h.news || [
        { title: 'World news', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
        { title: 'Switzerland', source: '20 Minuten', url: 'https://partner-feeds.20min.ch/rss/20minuten/schweiz' }
      ],
      // Leagues without a TV guide: which channels to show (a search; " | " separates alternatives).
      leagueChannels: h.leagueChannels || {
        'ita.1': '"seria" | "shahid event"',
        'ger.1': '"shahid bundesliga"',
        'egypt': h.egyptChannels || '"ON SPORT"'
      },
      // Network shown on a match card when the exact channel is unknown (anything else: beIN Sports).
      leagueLabels: h.leagueLabels || { 'ita.1': 'AD Sport Seria', 'ger.1': 'Shahid Bundesliga', 'egypt': 'ON Sport' },
      // Prayer times (Aladhan; method 3 = Muslim World League) and a short notice at each adhan.
      prayer: h.prayer || { method: 3, notify: true },
      rates: h.rates || [['CHF', 'EGP'], ['EUR', 'EGP'], ['USD', 'EGP'], ['EUR', 'CHF'], ['USD', 'CHF']],
      tables: h.tables || ['egypt', 'eng.1', 'esp.1', 'ger.1', 'ita.1'],
      resultDays: h.resultDays || 3            // "Results" row: finished matches of the last days
    };
  }

  /* ---- Home extras: prayer times, exchange rates, league tables, results ---- */

  var PRAYERS = [['Fajr', 'الفجر'], ['Sunrise', 'الشروق'], ['Dhuhr', 'الظهر'], ['Asr', 'العصر'], ['Maghrib', 'المغرب'], ['Isha', 'العشاء']];
  HOME.prayer = Store.lsGet('prayer') || {};          // { 'Mon Nov 16 2026': { Fajr: '05:44', … } } today + tomorrow
  HOME.rates = Store.lsGet('rates') || null;
  HOME.tables = {};
  HOME.results = null;

  function prayerDate(day, hhmm) {
    var p = String(hhmm || '').split(':'), d = new Date(day);
    d.setHours(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, 0, 0);
    return d.getTime();
  }

  /** The six times of today, plus which one comes next (it may be tomorrow's Fajr). */
  function prayerCards() {
    var now = Date.now(), today = new Date().toDateString(), tm = new Date(Date.now() + 86400000).toDateString();
    var t = HOME.prayer[today];
    if (!t) return [];
    var cards = PRAYERS.map(function (p) { return { name: p[0], ar: p[1], time: t[p[0]], at: prayerDate(today, t[p[0]]) }; });
    var next = null;
    cards.forEach(function (c) { if (!next && c.name !== 'Sunrise' && c.at > now) next = c; });
    if (!next && HOME.prayer[tm]) {
      next = { name: 'Fajr', ar: 'الفجر', time: HOME.prayer[tm].Fajr, at: prayerDate(tm, HOME.prayer[tm].Fajr), tomorrow: true };
      cards.push(next);
    }
    if (next) next.next = true;
    return cards;
  }

  function loadPrayer(force) {
    if (!force && Date.now() - (HOME.prayerTry || 0) < 5 * 60000) return;   // offline: don't ask every few seconds
    HOME.prayerTry = Date.now();
    var cfg = homeCfg(), days = [new Date(), new Date(Date.now() + 86400000)], pending = 0;
    days.forEach(function (d) {
      var key = d.toDateString();
      if (HOME.prayer[key] && !force) return;
      pending++;
      HomeData.prayer(cfg.weather, cfg.prayer.method || 3, d, function (err, r) {
        if (!err) {
          var keep = {};
          keep[r.day] = r.times;
          days.forEach(function (x) { var k = x.toDateString(); if (HOME.prayer[k] && !keep[k]) keep[k] = HOME.prayer[k]; });
          HOME.prayer = keep;
          Store.lsSet('prayer', keep);
        }
        if (--pending === 0 && S.section === 'home') renderHomeRows();
      });
    });
  }

  /** A short banner at each adhan (once per prayer), wherever you are in the app. */
  var adhanShown = Store.lsGet('adhanShown') || '';
  function checkPrayer() {
    var cfg = homeCfg();
    if (!cfg.prayer.notify) return;
    var now = Date.now(), today = new Date().toDateString(), t = HOME.prayer[today];
    if (!t) return;
    PRAYERS.forEach(function (p) {
      if (p[0] === 'Sunrise') return;
      var at = prayerDate(today, t[p[0]]), key = today + '|' + p[0];
      if (now >= at && now - at < 3 * 60000 && adhanShown !== key) {
        adhanShown = key;
        Store.lsSet('adhanShown', key);
        showGoal('Adhan  ·  ' + p[0] + '  ' + p[1] + '  ·  ' + t[p[0]]);
      }
    });
  }

  function loadRates() {
    HomeData.rates(function (err, r) {
      if (err) return;
      HOME.rates = { at: Date.now(), r: r };
      Store.lsSet('rates', HOME.rates);
      if (S.section === 'home') renderHomeRows();
    });
  }
  function rateCards() {
    var R = HOME.rates && HOME.rates.r;
    if (!R) return [];
    return homeCfg().rates.filter(function (p) { return R[p[0]] && R[p[1]]; }).map(function (p) {
      var v = R[p[1]] / R[p[0]];
      return { from: p[0], to: p[1], value: v >= 10 ? v.toFixed(2) : v.toFixed(3) };
    });
  }

  function loadTables() {
    var cfg = homeCfg(), pending = cfg.tables.length;
    cfg.tables.forEach(function (lg) {
      (lg === 'egypt' ? HomeData.egyptTable : function (cb) { HomeData.standings(lg, cb); })(function (err, t) {
        if (!err) { t.code = lg; HOME.tables[lg] = t; }
        if (--pending === 0 && S.section === 'home') renderHomeRows();
      });
    });
  }
  function tableCards() {
    return homeCfg().tables.map(function (lg) { return HOME.tables[lg]; }).filter(function (t) { return t && t.rows.length; });
  }

  /**
   * Results: finished matches of the last days (ESPN per day), plus today's finished ones and
   * the Egyptian league's last results. Favorite teams first, then newest.
   */
  function loadResults() {
    var cfg = homeCfg();
    HomeData.results(cfg, cfg.resultDays, function (list) {
      HOME.resultsOld = list;
      if (S.section === 'home') renderHomeRows();
    });
  }
  function resultCards() {
    var seen = {}, out = [];
    (HOME.matches || []).concat(HOME.resultsOld || []).forEach(function (m) {
      if (m.state !== 'done') return;
      var id = m.id || matchId(m);
      if (seen[id]) return;
      seen[id] = 1;
      out.push(m);
    });
    out.sort(function (a, b) { var fa = isFavMatch(a), fb = isFavMatch(b); return fa !== fb ? (fa ? -1 : 1) : b.time - a.time; });
    return out.slice(0, 30);
  }

  /** Full league table in the reader: two columns of ten. */
  function openTable(t) {
    var html = '<div class="tbl">', half = Math.ceil(t.rows.length / 2);
    [t.rows.slice(0, half), t.rows.slice(half)].forEach(function (col) {
      html += '<div class="tbl-col"><div class="tbl-row tbl-head"><span>#</span><span class="tn">Team</span><span>P</span><span>GD</span><span>Pts</span></div>';
      col.forEach(function (r) {
        html += '<div class="tbl-row' + (teamIsFav(r.names) ? ' fav' : '') + '"><span>' + r.rank + '</span><span class="tn"><img src="' + esc(r.logo) + '">' +
          esc(r.team) + '</span><span>' + esc(r.gp) + '</span><span>' + esc(r.gd) + '</span><span><b>' + esc(r.pts) + '</b></span></div>';
      });
      html += '</div>';
    });
    $('rd-img').style.display = 'none';
    $('rd-title').textContent = t.name;
    $('rd-meta').textContent = t.partial ? 'League table · top ' + t.rows.length + ' only (free data source)' : 'League table';
    $('rd-text').innerHTML = html + '</div>';
    $('reader').classList.add('table');
    $('reader').classList.remove('hidden');
    S.focus = 'reader';
  }

  function wIcon(code, day) {
    var d = HomeData.describe(code, day);
    return '<svg viewBox="0 0 24 24">' + WICON[d.icon] + '</svg>';
  }

  function renderClock() {
    var d = new Date();
    $('h-time').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    $('h-date').textContent = FULL_DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  function renderWeather() {
    var w = HOME.weather, cfg = homeCfg();
    if (!w) { $('hw-icon').innerHTML = ''; $('hw-temp').textContent = '--°'; $('hw-text').textContent = cfg.weather.name; $('hw-days').innerHTML = ''; return; }
    var desc = HomeData.describe(w.code, w.day);
    $('hw-icon').innerHTML = wIcon(w.code, w.day);
    $('hw-temp').textContent = Math.round(w.temp) + '°';
    $('hw-text').textContent = cfg.weather.name + '  ·  ' + desc.text + '  ·  feels ' + Math.round(w.feels) + '°';
    var html = '';
    for (var i = 0; i < Math.min(4, w.days.length); i++) {
      var dd = w.days[i], dt = new Date(dd.date + 'T12:00:00');
      html += '<div class="hw-day">' + (i === 0 ? 'Today' : DAY_NAMES[dt.getDay()]) + '<br>' + wIcon(dd.code, true) +
        '<br><b>' + Math.round(dd.max) + '°</b> ' + Math.round(dd.min) + '°</div>';
    }
    $('hw-days').innerHTML = html;
  }

  /** Fetch weather (every 20 min) and matches (every 5 min, every minute while a match is live). */
  function loadHomeData(force) {
    var cfg = homeCfg(), now = Date.now();
    if (force || now - HOME.weatherAt > 20 * 60000) {
      HOME.weatherAt = now;
      HomeData.weather(cfg.weather, function (err, w) {
        if (!err) HOME.weather = w;
        if (S.section === 'home') renderWeather();
      });
    }
    if (force || now - HOME.newsAt > 15 * 60000) {
      HOME.newsAt = now;
      cfg.news.forEach(function (feed, i) {
        HomeData.news(feed.url, 12, function (err, list) {
          if (list) list.forEach(function (it) { if (!it.source) it.source = feed.source || ''; });
          HOME.news[i] = err ? { error: err, items: [] } : { items: list };
          if (S.section === 'home') renderHomeRows();
        });
      });
    }
    loadPrayer(false);                                                  // only when a day is missing
    if (force || !HOME.rates || now - HOME.rates.at > 6 * 3600000) { if (!HOME.ratesLoading) { HOME.ratesLoading = true; setTimeout(function () { HOME.ratesLoading = false; }, 60000); loadRates(); } }
    if (force || now - (HOME.tablesAt || 0) > 30 * 60000) { HOME.tablesAt = now; loadTables(); }
    if (force || now - (HOME.resultsAt || 0) > 30 * 60000) { HOME.resultsAt = now; loadResults(); }
    var anyLive = HOME.matches && HOME.matches.some(function (m) { return m.state === 'live'; });
    if (force || now - HOME.matchesAt > (anyLive ? 60000 : 5 * 60000)) {
      HOME.matchesAt = now;
      HomeData.matches(cfg, function (list) {
        onMatches(list);
        // Then find which channel shows each match and redraw with the channel names.
        loadSportsEpg(function () {
          linkMatches();
          if (S.section === 'home') renderHomeRows();
        });
      });
    }
  }

  /* ---- link matches to the channel that shows them (provider TV guide) ---- */

  var NOISE = { fc: 1, cf: 1, afc: 1, sc: 1, ac: 1, club: 1, the: 1, de: 1, cd: 1, sv: 1, vfb: 0 };
  function normName(s) {
    var t = String(s || '').toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return t.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (w) { return w && !NOISE[w]; }).join(' ');
  }
  function titleHas(title, names) {
    for (var i = 0; i < names.length; i++) {
      var n = normName(names[i]);
      if (n.length >= 3 && (' ' + title + ' ').indexOf(' ' + n + ' ') >= 0) return true;
    }
    return false;
  }

  /** Guide of every beIN channel that has one (one request per guide id), refreshed every 30 min. */
  function loadSportsEpg(cb) {
    if (!S.acc || !S.live.channels.length) return cb();
    if (HOME.epg && Date.now() - HOME.epg.at < 30 * 60000) return cb();
    var L = S.live, seen = {}, chans = [];
    for (var i = 0; i < L.channels.length; i++) {
      var c = L.channels[i];
      if (!c.e || !/bein/i.test(c.e) || seen[c.e]) continue;
      seen[c.e] = 1;
      chans.push(i);
    }
    var progs = [], next = 0, done = 0;
    if (!chans.length) { HOME.epg = { at: Date.now(), progs: [] }; return cb(); }
    function step() {
      if (next >= chans.length) return;
      var idx = chans[next++];
      Xtream.shortEpg(S.acc, L.channels[idx].id, 40, function (err, list) {
        if (!err) for (var j = 0; j < list.length; j++) progs.push({ t: normName(list[j].t), raw: list[j].t, s: list[j].s, e: list[j].e, idx: idx });
        if (++done === chans.length) { HOME.epg = { at: Date.now(), progs: progs }; cb(); } else step();
      });
    }
    for (var k = 0; k < 4; k++) step();
  }

  /** Sets m.ch (channel index to play) and m.chName on every match found in the guide. */
  function linkMatches() {
    var progs = (HOME.epg && HOME.epg.progs) || [], L = S.live;
    (HOME.matches || []).forEach(function (m) {
      m.ch = undefined; m.chName = '';
      if (!m.homeNames) return;
      var best = null;
      for (var i = 0; i < progs.length; i++) {
        var p = progs[i];
        if (/catch ?up|highlight|replay|review|magazine|preview|studio/i.test(p.raw)) continue;
        // The provider's guide runs in Qatar time (about +3 h) and starts ~30 min before kick-off,
        // so accept a programme from 1 h before to 5 h after the real kick-off; take the earliest.
        var near = p.s >= m.time - 60 * 60000 && p.s <= m.time + 5 * 3600000;
        if (!near || !titleHas(p.t, m.homeNames) || !titleHas(p.t, m.awayNames)) continue;
        if (!best || p.s < best.s) best = p;
      }
      if (best) {
        var idx = L.repOf[best.idx] !== undefined ? L.repOf[best.idx] : best.idx;
        m.ch = idx;
        m.chName = baseName(L.channels[idx].n).replace(/^BEIN SPORTS?\s*/, 'beIN ');
        return;
      }
      // No guide entry: event channels often carry the match in their name
      // ("Live | Sudan vs Senegal || Arabic", "SHAHID PPV 1 - AL QADSIAH FC VS. EASTERN").
      var hit = -1;
      for (var c = 0; c < L.channels.length; c++) {
        var nm = normName(L.channels[c].n);
        if (titleHas(nm, m.homeNames) && titleHas(nm, m.awayNames)) {
          hit = c;
          if (/^live\b/.test(nm)) break;        // prefer the channel that is live now
        }
      }
      if (hit >= 0) {
        m.ch = L.repOf[hit] !== undefined ? L.repOf[hit] : hit;
        m.chName = 'event channel';
      }
    });
  }

  function renderHome() {
    renderClock();
    renderWeather();
    renderHomeRows();
    loadHomeData(false);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function ago(t) {
    var m = Math.max(1, Math.round((Date.now() - t) / 60000));
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  /** Full-screen reader for a news item; BACK or OK closes it. */
  function openReader(it) {
    $('rd-img').style.display = it.image ? '' : 'none';
    if (it.image) $('rd-img').src = it.image;
    $('rd-title').textContent = it.title;
    $('rd-meta').textContent = [it.source, it.time ? ago(it.time) : ''].filter(function (x) { return x; }).join('  ·  ');
    $('rd-text').textContent = it.text || '';
    $('reader').classList.remove('hidden');
    S.focus = 'reader';
  }
  function closeReader() { $('reader').classList.add('hidden'); $('reader').classList.remove('table'); setFocus('home'); }

  function matchWhen(m) {
    if (m.state === 'live') return '<span class="m-live">LIVE ' + esc(m.detail) + '</span>';
    if (m.state === 'done') return 'FT';
    var d = new Date(m.time), today = new Date(), tomorrow = new Date(Date.now() + 86400000);
    var day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : DAY_NAMES[d.getDay()] + ' ' + d.getDate();
    return day + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** Builds the three rows from current data; keeps the focused card where it was. */
  function renderHomeRows() {
    var rows = [];
    var ms = HOME.matches;
    if (ms) {
      // Favorite teams' matches first (order inside each part unchanged).
      var fav = ms.filter(isFavMatch), rest = ms.filter(function (m) { return !isFavMatch(m); });
      ms = fav.concat(rest);
    }
    // Live and upcoming here; finished matches go to "Results" below.
    if (ms) ms = ms.filter(function (m) { return m.state !== 'done'; });
    rows.push({ id: 'matches', title: 'Matches', items: ms || [], empty: ms ? 'No matches in the next days' : 'Loading matches…' });
    var res = resultCards();
    rows.push({ id: 'results', title: 'Results', items: res, empty: HOME.resultsOld || HOME.matches ? 'No results in the last days' : 'Loading results…' });
    rows.push({ id: 'pray', title: 'Prayer times · ' + homeCfg().weather.name, items: prayerCards(), empty: 'Loading prayer times…' });
    rows.push({ id: 'table', title: 'League tables', items: tableCards(), empty: 'Loading tables…' });
    homeCfg().news.forEach(function (feed, i) {
      var n = HOME.news[i];
      rows.push({ id: 'news', title: feed.title, items: n ? n.items : [], empty: !n ? 'Loading news…' : n.error ? 'News unavailable (' + n.error + ')' : 'No news' });
    });
    rows.push({ id: 'rate', title: 'Exchange rates', items: rateCards(), empty: 'Loading rates…' });
    rows.push({ id: 'cw', title: 'Continue watching', items: cw.slice(), empty: '' });
    if (S.live.channels.length) rows.push({ id: 'favs', title: 'Recently watched', items: recentChannels(), empty: '' });
    var favs = S.live.channels.length ? favList().slice(0, 15) : [];
    rows.push({ id: 'favs', title: 'Favorite channels', items: favs, empty: S.live.channels.length ? 'Press GREEN on a channel to add it here' : 'Loading channels…' });
    rows = rows.filter(function (r) { return r.items.length || r.empty; });
    HOME.rows = rows;
    if (HOME.r >= rows.length) HOME.r = 0;

    var box = $('h-rows'), html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<div class="hrow" data-row="' + i + '"><div class="hrow-title">' + esc(r.title) + '</div><div class="hrow-view"><div class="hrow-track">';
      if (!r.items.length) html += '<div class="hrow-empty">' + esc(r.empty) + '</div>';
      for (var j = 0; j < r.items.length; j++) html += cardHtml(r.id, r.items[j]);
      html += '</div></div></div>';
    }
    box.innerHTML = html;
    var imgs = box.getElementsByTagName('img');
    for (var k = 0; k < imgs.length; k++) imgs[k].onerror = function () { this.style.visibility = 'hidden'; };
    renderHomeFocus();
  }

  /** Result card: league + day, both teams with their goals, the winner in bold. */
  function resultHtml(it) {
    var d = new Date(it.time), today = new Date(), yest = new Date(Date.now() - 86400000);
    var day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === yest.toDateString() ? 'Yesterday' : DAY_NAMES[d.getDay()] + ' ' + d.getDate();
    var hs = parseInt(it.hs, 10), as = parseInt(it.as, 10), known = !isNaN(hs) && !isNaN(as);
    function team(name, logo, g, win) {
      return '<div class="m-team' + (win ? ' win' : '') + '"><img src="' + esc(logo) + '"><span class="m-name">' + esc(name) + '</span>' +
        '<span class="m-score">' + (known ? g : '–') + '</span></div>';
    }
    return '<div class="hcard match result' + (isFavMatch(it) ? ' favteam' : '') + '">' +
      '<div class="m-top"><span>' + (isFavMatch(it) ? '<b class="m-star">★</b> ' : '') + esc(it.league) + '</span><span>' + esc(day) + '  ·  FT</span></div>' +
      team(it.home, it.homeLogo, hs, known && hs > as) + team(it.away, it.awayLogo, as, known && as > hs) + '</div>';
  }

  function cardHtml(type, it) {
    if (type === 'matches') {
      var score = it.state !== 'pre' && it.hs != null && it.hs !== '';
      var flags = (isFavMatch(it) ? '★' : '') + (reminderFor(it) && it.state === 'pre' ? ' Reminder' : '');
      return '<div class="hcard match' + (it.state === 'live' ? ' live' : '') + (isFavMatch(it) ? ' favteam' : '') + '">' +
        (flags ? '<span class="m-flags">' + esc(flags) + '</span>' : '') +
        '<div class="m-top"><span>' + esc(it.league) + '</span><span>' + matchWhen(it) + '</span></div>' +
        '<div class="m-team"><img src="' + esc(it.homeLogo) + '"><span class="m-name">' + esc(it.home) + '</span>' + (score ? '<span class="m-score">' + esc(it.hs) + '</span>' : '') + '</div>' +
        '<div class="m-team"><img src="' + esc(it.awayLogo) + '"><span class="m-name">' + esc(it.away) + '</span>' + (score ? '<span class="m-score">' + esc(it.as) + '</span>' : '') + '</div>' +
        // Exact channel from the guide (bright), or the network that carries the league (grey).
        (it.chName
          ? '<div class="m-chan exact">▶ ' + esc(it.chName) + '</div>'
          : '<div class="m-chan">' + esc(homeCfg().leagueLabels[it.code] || 'beIN Sports') + '</div>') +
        '</div>';
    }
    if (type === 'news') {
      return '<div class="hcard news' + (it.image ? ' pic' : '') + '">' + (it.image ? '<img class="n-img" src="' + esc(it.image) + '">' : '') +
        '<div class="n-body"><div class="n-title" dir="auto">' + esc(it.title) + '</div><div class="n-meta">' +
        esc([it.source, it.time ? ago(it.time) : ''].filter(function (x) { return x; }).join('  ·  ')) + '</div></div></div>';
    }
    if (type === 'pray') {
      var left = '';
      if (it.next) {
        var mins = Math.max(0, Math.round((it.at - Date.now()) / 60000));
        left = 'in ' + (mins >= 60 ? Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min' : mins + ' min');
      }
      return '<div class="hcard pray' + (it.next ? ' next' : '') + (it.name === 'Sunrise' ? ' sun' : '') + '"><div class="p-name">' + esc(it.name) +
        (it.tomorrow ? ' <small>tomorrow</small>' : '') + '</div><div class="p-ar">' + esc(it.ar) + '</div><div class="p-time">' + esc(it.time) +
        '</div><div class="p-left">' + esc(left) + '</div></div>';
    }
    if (type === 'rate') {
      return '<div class="hcard rate"><div class="r-from">1 ' + esc(it.from) + '</div><div class="r-val">' + esc(it.value) + ' <span>' + esc(it.to) + '</span></div></div>';
    }
    if (type === 'table') {
      var rowsH = '';
      it.rows.slice(0, 5).forEach(function (r) {
        rowsH += '<div class="t-row' + (teamIsFav(r.names) ? ' fav' : '') + '"><span class="t-rank">' + r.rank + '</span><img src="' + esc(r.logo) + '"><span class="t-name">' +
          esc(r.team) + '</span><span class="t-pts">' + esc(r.pts) + '</span></div>';
      });
      return '<div class="hcard table"><div class="t-title">' + esc(it.name) + '</div>' + rowsH + '</div>';
    }
    if (type === 'results') return resultHtml(it);
    if (type === 'cw') {
      var pic = it.kind === 'episode' ? it.series && it.series.l : it.item.l;
      var title = it.kind === 'episode' ? cleanTitle(it.series.n) + ' ' + (it.item.n.split(' · ')[0] || '') : cleanTitle(it.item.n);
      var pct = it.d ? Math.min(100, Math.round(100 * it.t / it.d)) : 30;
      return '<div class="hcard cw"><img class="cw-img" src="' + esc(pic || '') + '"><div class="cw-t">' + esc(title) +
        '</div><div class="cw-bar"><div style="width:' + pct + '%"></div></div></div>';
    }
    var c = S.live.channels[it];
    return '<div class="hcard fav"><img class="fav-logo" src="' + esc(c.l) + '"><div class="fav-n">' + esc(c.n) + '</div></div>';
  }

  function renderHomeFocus() {
    var rowsEl = $('h-rows').querySelectorAll('.hrow');
    for (var i = 0; i < rowsEl.length; i++) {
      var cards = rowsEl[i].querySelectorAll('.hcard'), col = HOME.c[i] || 0;
      if (col >= cards.length) col = HOME.c[i] = Math.max(0, cards.length - 1);
      for (var j = 0; j < cards.length; j++) {
        if (S.focus === 'home' && i === HOME.r && j === col) cards[j].classList.add('focus'); else cards[j].classList.remove('focus');
      }
      // Scroll the row so the focused card stays visible.
      var track = rowsEl[i].querySelector('.hrow-track'), card = cards[col], shift = 0;
      if (card) {
        var viewW = rowsEl[i].querySelector('.hrow-view').clientWidth, right = card.offsetLeft + card.offsetWidth + 40;
        if (right > viewW) shift = right - viewW;
      }
      track.style.transform = 'translateX(' + (-shift) + 'px)';
    }
    // Scroll the rows up/down so the focused row is fully visible.
    var focusRow = rowsEl[HOME.r], viewH = $('h-view').clientHeight, sc = HOME.scroll || 0;
    if (focusRow && viewH) {
      var top = focusRow.offsetTop, bottom = top + focusRow.offsetHeight + 20;
      if (bottom - sc > viewH) sc = bottom - viewH;
      if (top - 10 < sc) sc = Math.max(0, top - 10);
    }
    HOME.scroll = sc;
    $('h-rows').style.transform = 'translateY(' + (-sc) + 'px)';
  }

  function homeKey(k) {
    var rows = HOME.rows, r = HOME.r, row = rows[r], col = HOME.c[r] || 0;
    switch (k) {
      case 'UP': if (r > 0) { HOME.r = r - 1; renderHomeFocus(); } break;
      case 'DOWN': if (r < rows.length - 1) { HOME.r = r + 1; renderHomeFocus(); } break;
      case 'LEFT': if (col > 0) { HOME.c[r] = col - 1; renderHomeFocus(); } else setFocus('tabs'); break;
      case 'RIGHT': if (row && col < row.items.length - 1) { HOME.c[r] = col + 1; renderHomeFocus(); } break;
      case 'ENTER': if (row && row.items[col] !== undefined) openHomeItem(row.id, row.items[col]); break;
      case 'BACK': panelBack(); break;
    }
  }

  function openHomeItem(type, it) {
    if (type === 'news') { openReader(it); return; }
    if (type === 'table') { openTable(it); return; }
    if (type === 'pray' || type === 'rate' || type === 'results') return;
    if (type === 'favs') {
      S.zapCtx = 'fav'; S.zap = { kind: 'live', list: favList() };
      playLive(it);
      closePanel();
    } else if (type === 'cw') {
      if (it.kind === 'movie') { playMovie(it.item); closePanel(); return; }
      var series = it.series;
      playEpisode(it.item, series);
      closePanel();
      // Load the episode list in the background so "next episode" keeps working.
      Xtream.episodes(S.acc, series.id, function (err, list) {
        if (!err && list.length) S.zap = { kind: 'episode', list: list, series: series };
      });
    } else if (type === 'matches') {
      // Still far away: OK sets (or removes) a reminder; close to kick-off or live: watch.
      if (it.state === 'pre' && it.time - Date.now() > 10 * 60000) { toggleReminder(it); return; }
      playMatch(it);
    }
  }

  /** Play the channel of a match: exact channel from the guide, else the league network's first channel. */
  function playMatch(it) {
    {
      if (it.ch !== undefined) {
        // The guide says which channel shows this match: play it straight away.
        S.zapCtx = 'all'; S.zap = { kind: 'live', list: S.live.allIdx };
        playLive(it.ch);
        closePanel();
        toast(it.home + ' – ' + it.away + '  ·  ' + it.chName, 4000);
        return;
      }
      // Exact channel unknown: play the first channel of the league's network right away;
      // CH+/CH- (or Up/Down) then steps through that network's other channels.
      var cfgH = homeCfg();
      var q = cfgH.leagueChannels[it.code] || cfgH.leagueChannels['*'] || 'group:AR| BEIN SPORTS FHD';
      var fam = familyChannels(q);
      if (fam.length) {
        S.zapCtx = 'all';
        S.zap = { kind: 'live', list: fam };
        playLive(fam[0]);
        closePanel();
        toast(it.home + ' – ' + it.away + '  ·  ' + S.live.channels[fam[0]].n.replace(/^\s*[A-Z]{2,4}\|\s*/, '') +
          (fam.length > 1 ? '  ·  CH ▲▼ for the other ' + fam.length + ' channels' : ''), 6000);
        return;
      }
      // Nothing found: show the sports group to pick from.
      switchSection('live');
      var want = cfgH.sportsGroup.toUpperCase(), gi = -1;
      for (var i = 0; i < S.groupItems.length; i++) if (S.groupItems[i].label.toUpperCase().indexOf(want) >= 0) { gi = i; break; }
      if (gi >= 0) selectGroup(gi);
      setFocus('list');
      toast(it.home + ' – ' + it.away + '  ·  pick a sports channel', 4000);
    }
  }

  /**
   * Channels of a network for zapping: one per channel (best quality across groups),
   * numbered ones first in number order (beIN 1, 2, 3 ...), no "#####" header entries.
   */
  function familyChannels(q) {
    var L = S.live, ln = L.lname, best = {}, order = [], hits;
    var grp = /^group:\s*(.+)$/i.exec(q);
    if (grp) {
      // "group:AR| BEIN SPORTS FHD" = the channels of that category
      var gname = grp[1].replace(/\s+/g, '').toUpperCase();
      hits = [];
      for (var g = 0; g < L.groups.length; g++) {
        if (L.groups[g].replace(/\s+/g, '').toUpperCase() === gname) { hits = L.groupLists[g]; break; }
      }
    } else hits = searchIn(L.allIdx, function (idx) { return ln[idx]; }, q);
    for (var i = 0; i < hits.length; i++) {
      var idx = hits[i], c = L.channels[idx];
      if (/^\s*#/.test(c.n)) continue;
      var key = baseName(c.n);
      if (best[key] === undefined) { best[key] = idx; order.push(key); }
      else if (L.qual[idx] > L.qual[best[key]]) best[key] = idx;
    }
    function num(k) { var m = /\b(\d{1,2})\b/.exec(k); return m ? parseInt(m[1], 10) : 999; }
    function words(k) { return k.split(' ').length; }
    // In a whole category, the plain channels (BEIN SPORTS 1..9) come before their variants
    // (XTRA, ENGLISH, FRANCE); for a search, keep the number order.
    order.sort(function (a, b) { return grp ? (words(a) - words(b) || num(a) - num(b)) : num(a) - num(b); });
    return order.map(function (k) { return best[k]; });
  }

  /* ---------------- movie details page + trailer ---------------- */

  var DT = null;   // { it, btns: [{ id, label }], sel }

  /** OK on a movie: big poster, plot and buttons (Play / Resume, Trailer, Favorite). */
  function openDetails(it) {
    DT = { it: it, btns: [], sel: 0 };
    $('details').classList.remove('hidden');
    S.focus = 'details';
    renderDetails();
    if (!movieDetails[it.id] && S.acc) {
      Xtream.movieInfo(S.acc, it.id, function (err, d) {
        if (err) return;
        movieDetails[it.id] = d;
        if (DT && DT.it === it) renderDetails();
      });
    }
  }

  function renderDetails() {
    var it = DT.it, d = movieDetails[it.id] || {};
    var poster = d.cover || it.l;
    $('dt-poster').style.visibility = poster ? 'visible' : 'hidden';
    if (poster && $('dt-poster').getAttribute('src') !== poster) $('dt-poster').src = poster;
    $('dt-bg').style.backgroundImage = d.backdrop || poster ? 'url("' + String(d.backdrop || poster).replace(/"/g, '%22') + '")' : 'none';
    $('dt-title').textContent = cleanTitle(it.n).replace(/\s*\(\d{4}\)\s*$/, '');
    var chips = [], y = d.y || yearOf(it), r = d.r || it.r, html = '';
    if (y) chips.push(['', y]);
    if (r) chips.push(['star', '★ ' + r]);
    if (d.d) chips.push(['', d.d]);
    if (d.gn) chips.push(['', d.gn]);
    chips.forEach(function (c) { html += '<span' + (c[0] ? ' class="' + c[0] + '"' : '') + '>' + esc(c[1]) + '</span>'; });
    $('dt-meta').innerHTML = html;
    $('dt-plot').textContent = d.p || (movieDetails[it.id] ? '' : 'Loading…');

    var pos = positions['m' + it.id];
    DT.btns = [{ id: 'play', label: pos ? '▶  Resume ' + fmtTime(pos) : '▶  Play' }];
    if (pos) DT.btns.push({ id: 'start', label: 'From the start' });
    if (d.trailer) DT.btns.push({ id: 'trailer', label: 'Trailer' });
    DT.btns.push({ id: 'fav', label: isFavItem('movies', it.id) ? '★ Remove favorite' : '☆ Add to favorites' });
    DT.btns.push({ id: 'later', label: isLater('movies', it.id) ? '− Watch later' : '+ Watch later' });
    if (DT.sel >= DT.btns.length) DT.sel = 0;
    var b = '';
    DT.btns.forEach(function (x, i) { b += '<span class="dt-btn' + (i === DT.sel ? ' focus' : '') + '">' + esc(x.label) + '</span>'; });
    $('dt-btns').innerHTML = b;
  }

  function closeDetails() {
    DT = null;
    $('details').classList.add('hidden');
    setFocus('list');
  }

  function detailsKey(k) {
    switch (k) {
      case 'LEFT': if (DT.sel > 0) { DT.sel--; renderDetails(); } break;
      case 'RIGHT': if (DT.sel < DT.btns.length - 1) { DT.sel++; renderDetails(); } break;
      case 'BACK': closeDetails(); break;
      case 'GREEN': toggleFavItem('movies', DT.it); renderDetails(); break;
      case 'ENTER':
        var it = DT.it, b = DT.btns[DT.sel].id;
        if (b === 'play' || b === 'start') {
          if (b === 'start') clearPos('m' + it.id);
          closeDetails();
          playMovie(it);
          closePanel();
        } else if (b === 'trailer') playTrailer((movieDetails[it.id] || {}).trailer);
        else if (b === 'fav') { toggleFavItem('movies', it); renderDetails(); }
        else if (b === 'later') { toggleLater('movies', it); renderDetails(); }
        break;
    }
  }

  /**
   * Trailer inside the app. YouTube refuses to play in a player that has no web address (Error 153),
   * and a TV app has none, so the player is a small page on GitHub Pages (config "trailerPage").
   */
  function playTrailer(id) {
    if (!id) return;
    var box = $('trailer');
    if (S.playing) Player.stop();            // no sound from the channel behind the trailer
    var page = (S.cfg && S.cfg.trailerPage) || 'https://nike0com.github.io/trailer.html';
    var f = document.createElement('iframe');
    f.tabIndex = -1;                         // keep the remote keys (BACK) in the app, not in the video page
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    f.src = page + '?v=' + encodeURIComponent(id);
    box.appendChild(f);
    box.classList.remove('hidden');
    S.focusBeforeTrailer = S.focus;
    S.focus = 'trailer';
  }

  function closeTrailer() {
    var box = $('trailer'), f = box.getElementsByTagName('iframe')[0];
    if (f) box.removeChild(f);
    box.classList.add('hidden');
    S.focus = S.focusBeforeTrailer || 'details';
    if (S.playing) Player.play(S.playing.url, { live: S.playing.kind === 'live' });   // resume what was on
  }

  /* ---------------- favorite teams, match reminders, goal alerts ---------------- */

  var reminders = Store.lsGet('reminders') || [];       // [{ id, home, away, time, code, league, homeNames, awayNames, fired }]
  var remindersOff = Store.lsGet('remindersOff') || {}; // automatic reminders the user switched off
  var lastScores = {};                                  // match id -> "h-a|state" seen last time

  function favTeams() {
    var t = Store.lsGet('favTeams') || [];
    // Teams added to config.json later are merged in once (a team removed on the TV stays removed).
    var cfgTeams = (S.cfg && S.cfg.home && S.cfg.home.favoriteTeams) || [], seen = Store.lsGet('favTeamsCfg') || [], changed = false;
    cfgTeams.forEach(function (c) {
      if (seen.indexOf(c) >= 0) return;
      seen.push(c); changed = true;
      if (!t.some(function (x) { return sameTeam(x, c); })) t.push(c);
    });
    if (changed || !Store.lsGet('favTeams')) { Store.lsSet('favTeams', t); Store.lsSet('favTeamsCfg', seen); }
    return t;
  }
  /** Same team after dropping FC/SC/CF…: "Real Madrid CF" = "Real Madrid", but "Egypt" ≠ "National Bank of Egypt". */
  function sameTeam(a, b) { var x = normName(a); return x.length >= 3 && x === normName(b); }
  function teamIsFav(names) {
    var favs = favTeams();
    for (var i = 0; i < favs.length; i++)
      for (var j = 0; j < names.length; j++) if (sameTeam(favs[i], names[j])) return true;
    return false;
  }
  function isFavMatch(m) { return teamIsFav(m.homeNames || [m.home]) || teamIsFav(m.awayNames || [m.away]); }
  function matchId(m) { return (m.code || '') + '|' + m.home + '|' + m.away + '|' + m.time; }
  function reminderFor(m) {
    var id = matchId(m);
    for (var i = 0; i < reminders.length; i++) if (reminders[i].id === id) return reminders[i];
    return null;
  }
  function saveReminders() { Store.lsSet('reminders', reminders); Store.lsSet('remindersOff', remindersOff); }
  function addReminder(m) {
    if (reminderFor(m)) return;
    reminders.push({ id: matchId(m), home: m.home, away: m.away, time: m.time, code: m.code, league: m.league, homeNames: m.homeNames, awayNames: m.awayNames });
  }

  /** OK on a match that is still more than 10 minutes away. */
  function toggleReminder(m) {
    var r = reminderFor(m), id = matchId(m);
    if (r) {
      reminders.splice(reminders.indexOf(r), 1);
      remindersOff[id] = 1;
      toast('Reminder removed: ' + m.home + ' – ' + m.away);
    } else {
      addReminder(m);
      delete remindersOff[id];
      toast('Reminder set: ' + m.home + ' – ' + m.away + '  ·  ' + matchWhen(m) + '  ·  alert 5 min before kick-off', 5000);
    }
    saveReminders();
    if (S.section === 'home') renderHomeRows();
  }

  /** Favorite teams' matches get a reminder automatically (unless switched off). */
  function autoReminders() {
    var now = Date.now(), changed = false;
    (HOME.matches || []).forEach(function (m) {
      if (m.state === 'pre' && m.time - now > 6 * 60000 && isFavMatch(m) && !remindersOff[matchId(m)] && !reminderFor(m)) { addReminder(m); changed = true; }
    });
    var before = reminders.length;
    reminders = reminders.filter(function (r) { return now - r.time < 6 * 3600000; });   // drop old ones
    if (changed || reminders.length !== before) saveReminders();
  }

  /** Every 20 s: 5 minutes before kick-off, show the alert. */
  function checkReminders() {
    var now = Date.now();
    for (var i = 0; i < reminders.length; i++) {
      var r = reminders[i];
      if (r.fired || now < r.time - 5 * 60000 || now > r.time + 2 * 3600000) continue;
      r.fired = true;
      saveReminders();
      var mins = Math.max(0, Math.round((r.time - now) / 60000));
      var live = (HOME.matches || []).filter(function (m) { return matchId(m) === r.id; })[0] || r;
      showAlert(mins ? 'Kick-off in ' + mins + ' min' : 'Starting now', r.home + ' – ' + r.away + '<br><small>' + esc(r.league || '') + '</small>',
        'Watch', 'Dismiss', function () { playMatch(live); }, null, 90000, true);
      return;
    }
  }

  /** Goal / full-time alerts for favorite teams' live matches. */
  function checkGoals(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!isFavMatch(m) || m.state === 'pre') continue;
      var id = matchId(m), cur = m.hs + '-' + m.as, prev = lastScores[id];
      lastScores[id] = cur + '|' + m.state;
      if (prev === undefined) continue;
      var pScore = prev.split('|')[0], pState = prev.split('|')[1];
      var line = m.home + '  ' + m.hs + ' – ' + m.as + '  ' + m.away;
      if (m.state === 'live' && pScore !== cur) showGoal('GOAL!   ' + line + '   ' + (m.detail || ''));
      else if (m.state === 'done' && pState === 'live') showGoal('Full time:   ' + line);
    }
  }

  function showGoal(text) {
    var g = $('goal');
    g.textContent = text;
    g.classList.remove('hidden');
    later('goal', 10000, function () { g.classList.add('hidden'); });
  }

  /** Matches arrived (Home refresh or background poll): alerts, reminders, channel links, redraw. */
  function onMatches(list) {
    checkGoals(list);
    HOME.matches = list;
    HOME.matchesAt = Date.now();
    autoReminders();
    linkMatches();
    if (S.section === 'home') renderHomeRows();
  }

  /** Every minute in the background: follow live matches of favorite teams (and refresh the schedule every 10 min). */
  function pollMatches() {
    if (!S.cfg) return;
    var now = Date.now();
    var hot = (HOME.matches || []).some(function (m) {
      return isFavMatch(m) && (m.state === 'live' || (m.state === 'pre' && m.time - now < 15 * 60000));
    });
    if (!hot && now - HOME.matchesAt < 10 * 60000) return;
    HOME.matchesAt = now;
    HomeData.matches(homeCfg(), onMatches);
  }

  /* ---------------- popup alert (reminders, sleep timer) ---------------- */

  var ALERT = null;
  /* ---------------- options menu (RIGHT on a row) ---------------- */

  var MENU = null;                                      // { items: [{key, label, run}], sel }
  var MENU_KEYS = { RED: 'red', GREEN: 'green', YELLOW: 'yellow', BLUE: 'blue', ENTER: 'ok', '': 'none' };

  /** Actions for the focused channel / movie / series / episode / recording, each on a remote key. */
  function openItemMenu() {
    var sel = chList.sel, it = S.view[sel], kind = S.viewKind;
    if (it === undefined) return;
    var items = [], title = '';
    function add(key, label, run) { items.push({ key: key, label: label, run: run }); }
    if (kind === 'live') {
      var c = S.live.channels[it];
      if (!c) return;
      title = c.n;
      add('ENTER', '▶  Watch', activateRow);
      add('GREEN', S.favs[chKey(c)] ? '★  Remove from favorites' : '☆  Add to favorites', function () { toggleFav(it); });
      add('RED', Recorder.current() ? '■  Stop recording' : '●  Watch and record', function () {
        if (Recorder.current()) return Recorder.stop();
        if (!(S.playing && S.playing.kind === 'live' && S.playing.idx === it)) activateRow();
        if (S.playing && S.playing.idx === it) toggleRecord();
      });
    } else if (kind === 'movie') {
      title = cleanTitle(it.n);
      add('ENTER', '▶  Details and play', function () { openDetails(it); });
      add('GREEN', isFavItem('movies', it.id) ? '★  Remove from favorites' : '☆  Add to favorites', function () { toggleFavItem('movies', it); });
      add('RED', '▷  Trailer', function () { menuTrailer(it); });
      add('', isLater('movies', it.id) ? '−  Remove from watch later' : '+  Watch later', function () { toggleLater('movies', it); });
      add('', isWatched('m' + it.id) ? '✓  Mark as not watched' : '✓  Mark as watched', function () {
        markWatched('m' + it.id, !isWatched('m' + it.id)); chList.invalidate(); onListSelect(chList.sel);
      });
    } else if (kind === 'series') {
      title = cleanTitle(it.n);
      add('ENTER', '▶  Episodes', activateRow);
      add('GREEN', isFavItem('series', it.id) ? '★  Remove from favorites' : '☆  Add to favorites', function () { toggleFavItem('series', it); });
      add('', isLater('series', it.id) ? '−  Remove from watch later' : '+  Watch later', function () { toggleLater('series', it); });
    } else if (kind === 'episode') {
      var sr = S.episodes && S.episodes.series;
      title = it.n || '';
      add('ENTER', '▶  Play episode', activateRow);
      if (sr) add('GREEN', isFavItem('series', sr.id) ? '★  Remove series from favorites' : '☆  Add series to favorites', function () { toggleFavItem('series', sr); });
      add('', isWatched('e' + it.id) ? '✓  Mark as not watched' : '✓  Mark as watched', function () {
        markWatched('e' + it.id, !isWatched('e' + it.id)); chList.invalidate();
      });
      add('', '✓  Mark all episodes up to here as watched', function () {
        for (var i = 0; i <= sel; i++) markWatched('e' + S.view[i].id, true);
        chList.invalidate();
        toast('Marked ' + (sel + 1) + ' episodes as watched');
      });
    } else if (kind === 'rec') {
      title = it.n;
      add('ENTER', '▶  Play', activateRow);
      add('RED', '✕  Delete recording', function () {
        showAlert('Delete recording', esc(it.n), 'Delete', 'Cancel', function () {
          delArmed = it.path;
          if (S.view[chList.sel] === it) deleteRecording();
        });
      });
    }
    if (kind !== 'rec') add('YELLOW', '⌕  Search', function () { setFocus('search'); startTyping(); });
    add('BLUE', '☰  Categories', function () { setFocus('groups'); });
    showMenu(title, function () { return items; });
  }

  /** build() returns the rows; rows with stay: true run and redraw (speed, sizes…) instead of closing. */
  function showMenu(title, build) {
    MENU = { build: build, items: build(), sel: 0 };
    $('mn-title').textContent = title;
    renderMenu();
    $('menu').classList.remove('hidden');
  }

  /** Held OK while watching. */
  function openWatchMenu() {
    var p = S.playing;
    if (!p) return;
    showMenu(p.title, function () {
      var items = [], vod = isVod();
      function add(key, label, run, stay) { items.push({ key: key, label: label, run: run, stay: stay }); }
      add('ENTER', '☰  ' + (vod ? 'Back to the list' : 'Channel list'), function () { openPanel('list'); });
      if (vod && p.kind !== 'rec') {
        add('', '»  Speed: ' + (S.speed || 1) + 'x', cycleSpeed, true);
        add('', '▤  ' + modeLabel(), cycleSubs, true);
        if (S.subs.tracks.length) add('GREEN', '▤  Next subtitle in the file', cycleEmbedded, true);
      }
      if (!vod) {
        if (p.idx >= 0) {
          var c = S.live.channels[p.idx];
          add('GREEN', c && S.favs[chKey(c)] ? '★  Remove from favorites' : '☆  Add to favorites', function () { toggleFav(p.idx); }, true);
        }
        add('', '▤  Subtitles: ' + liveSubLabel(), liveSubs, true);
        add('RED', Recorder.current() ? '■  Stop recording' : '●  Record', toggleRecord);
      }
      add('', 'Aa  Subtitle size: ' + SUB_SIZES[subStyle.size].n, function () { cycleSubStyle('size'); }, true);
      add('', '◑  Sleep timer: ' + sleepLabel(), cycleSleep, true);
      return items;
    });
  }

  /* ---- playback speed (movies / episodes) ---- */

  function cycleSpeed() {
    var list = Player.speeds(), i = list.indexOf(S.speed || 1), next = list[(i + 1) % list.length];
    if (Player.setSpeed(next)) { S.speed = next; toast('Speed ' + next + 'x' + (next !== 1 ? '  ·  sound may be muted at this speed' : ''), 2500); }
    else toast('This file only plays at normal speed');
  }

  /* ---- subtitles on live channels (only some channels carry them) ---- */

  function liveSubLabel() {
    var o = S.subs.cur;
    return o && o.type === 'emb' && S.subs.tracks[o.pos] ? trackLabel(S.subs.tracks[o.pos], o.pos) : 'Off';
  }
  function liveSubs() {
    if (!S.subs.tracks.length) {
      var t = Player.textTracks();
      t.forEach(function (x) { x.code = langCode(x.lang); x.name = ''; x.forced = false; });
      S.subs.tracks = t;
    }
    var tr = S.subs.tracks;
    if (!tr.length) return toast('This channel has no subtitles');
    var cur = S.subs.cur, pos = cur && cur.type === 'emb' ? cur.pos + 1 : 0;
    if (pos >= tr.length) applyOpt({ type: 'off' }, true);    // after the last track: off
    else applyOpt({ type: 'emb', pos: pos }, true);
  }

  /* ---- subtitle look: size, colour, background (Settings or the watching menu) ---- */

  var SUB_SIZES = [{ n: 'Small', px: 36 }, { n: 'Medium', px: 44 }, { n: 'Large', px: 52 }, { n: 'Extra large', px: 62 }];
  var SUB_COLORS = [{ id: 'white', n: 'White' }, { id: 'yellow', n: 'Yellow' }];
  var SUB_BGS = [{ id: 'box', n: 'Dark box' }, { id: 'shadow', n: 'Shadow only' }, { id: 'none', n: 'None' }];
  var subStyle = Store.lsGet('subStyle') || { size: 1, color: 0, bg: 0 };

  function cycleSubStyle(what) {
    var n = what === 'size' ? SUB_SIZES.length : what === 'color' ? SUB_COLORS.length : SUB_BGS.length;
    subStyle[what] = ((subStyle[what] || 0) + 1) % n;
    Store.lsSet('subStyle', subStyle);
    showSubSample();
  }

  /** Show what subtitles look like now (2 lines, like the dual mode) for a few seconds. */
  function showSubSample() {
    var real = false;
    for (var k in S.subs.slots) if (S.subs.slots.hasOwnProperty(k) && S.subs.slots[k]) real = true;
    if (real) return renderSubs();
    S.subs.slots = { 'l:a': 'هذا مثال على الترجمة', 'l:b': 'So sehen die Untertitel aus' };
    S.subs.order = ['l:a', 'l:b'];
    renderSubs();
    later('subSample', 3500, function () {
      if (S.subs.slots['l:a'] === 'هذا مثال على الترجمة') { S.subs.slots = {}; S.subs.order = []; hideSub(); }
    });
  }

  function renderMenu() {
    var h = '';
    MENU.items.forEach(function (x, i) {
      h += '<div class="mn-row' + (i === MENU.sel ? ' focus' : '') + '"><span class="mn-key ' + MENU_KEYS[x.key] + '">' +
        (x.key === 'ENTER' ? 'OK' : '') + '</span>' + esc(x.label) + '</div>';
    });
    $('mn-rows').innerHTML = h;
  }

  function closeMenu() { MENU = null; $('menu').classList.add('hidden'); }

  function menuKey(k) {
    var pick = null;
    switch (k) {
      case 'UP': if (MENU.sel > 0) { MENU.sel--; renderMenu(); } return;
      case 'DOWN': if (MENU.sel < MENU.items.length - 1) { MENU.sel++; renderMenu(); } return;
      case 'BACK': case 'LEFT': case 'INFO': closeMenu(); return;
      case 'ENTER': pick = MENU.items[MENU.sel]; break;
      default: MENU.items.forEach(function (x) { if (x.key === k) pick = x; });
    }
    if (!pick) return;
    if (pick.stay) {
      // speed, subtitle size, sleep timer…: change and stay in the menu to press again
      pick.run();
      if (!MENU) return;
      MENU.items = MENU.build();
      if (MENU.sel >= MENU.items.length) MENU.sel = MENU.items.length - 1;
      renderMenu();
      return;
    }
    closeMenu();
    pick.run();
  }

  /** Trailer straight from the list (loads the movie's info first when needed). */
  function menuTrailer(it) {
    var d = movieDetails[it.id];
    if (d) return d.trailer ? playTrailer(d.trailer) : toast('No trailer for this movie');
    if (!S.acc) return toast('No trailer for this movie');
    toast('Loading trailer…', 0);
    Xtream.movieInfo(S.acc, it.id, function (err, info) {
      if (err || !info) return toast('No trailer for this movie');
      movieDetails[it.id] = info;
      if (info.trailer) { $('toast').classList.add('hidden'); playTrailer(info.trailer); } else toast('No trailer for this movie');
    });
  }

  function showAlert(title, bodyHtml, okLabel, backLabel, onOk, onBack, timeoutMs, timeoutIsBack) {
    $('al-title').textContent = title;
    $('al-body').innerHTML = bodyHtml;
    $('al-ok').textContent = okLabel;
    $('al-back').textContent = backLabel;
    $('alert').classList.remove('hidden');
    ALERT = { ok: onOk, back: onBack };
    later('alert', timeoutMs || 60000, function () { closeAlert(timeoutIsBack ? 'back' : 'ok'); });
  }
  function closeAlert(which) {
    clearTimeout(timers.alert);
    var a = ALERT;
    ALERT = null;
    $('alert').classList.add('hidden');
    if (a && a[which]) a[which]();
  }

  /* ---------------- sleep timer ---------------- */

  var SLEEP_STEPS = [0, 30, 60, 90, 120];
  var sleepAt = 0, sleepWarned = false;
  function sleepLabel() {
    if (!sleepAt) return 'Off';
    return Math.max(1, Math.round((sleepAt - Date.now()) / 60000)) + ' min left';
  }
  /** 0 key while watching, or Settings: Off -> 30 -> 60 -> 90 -> 120 min -> Off. */
  function cycleSleep() {
    var left = sleepAt ? Math.round((sleepAt - Date.now()) / 60000) : 0, next = 0;
    for (var i = 0; i < SLEEP_STEPS.length; i++) if (SLEEP_STEPS[i] > left + 1) { next = SLEEP_STEPS[i]; break; }
    sleepAt = next ? Date.now() + next * 60000 : 0;
    sleepWarned = false;
    toast(next ? 'Sleep timer: ' + next + ' min  ·  press 0 to change' : 'Sleep timer off', 3000);
    if (S.section === 'settings') renderSettings();
  }
  function checkSleep() {
    if (!sleepAt) return;
    var left = sleepAt - Date.now();
    if (left <= 60000 && !sleepWarned) {
      sleepWarned = true;
      showAlert('Sleep timer', 'Going to sleep in 1 minute', 'Keep watching', 'Sleep now',
        function () { sleepAt = 0; toast('Sleep timer off'); }, goToSleep, 60000, true);
    }
    if (left <= 0) goToSleep();
  }
  function goToSleep() {
    sleepAt = 0;
    savePos();
    if (Recorder.current()) Recorder.stop();
    Player.stop();
    try { window.tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
  }

  /* ---------------- recently watched channels ---------------- */

  function rememberChannel(c) {
    var keys = Store.lsGet('recent') || [], k = chKey(c), i = keys.indexOf(k);
    if (i >= 0) keys.splice(i, 1);
    keys.unshift(k);
    if (keys.length > 12) keys.length = 12;
    Store.lsSet('recent', keys);
  }
  function recentChannels() {
    var L = S.live, out = [], seen = {};
    (Store.lsGet('recent') || []).forEach(function (k) {
      var idx = L.keyIndex[k];
      if (idx === undefined) return;
      if (L.repOf[idx] !== undefined) idx = L.repOf[idx];
      if (!seen[idx]) { seen[idx] = 1; out.push(idx); }
    });
    return out;
  }

  /* ---------------- backup / restore (USB) ---------------- */

  var BACKUP_DIR = 'AsoosA Backup', BACKUP_FILE = 'asoosa-backup.json';
  function backupData() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^db:|^last$|^refreshedAt$|^upd|^rates$|^prayer$/.test(k)) continue;   // caches and downloaded app code, not settings
      data[k] = localStorage.getItem(k);
    }
    return JSON.stringify({ app: 'AsoosA IPTV', v: 1, at: Date.now(), data: data });
  }
  function backupNow(silent) {
    if (!Recorder.supported()) { if (!silent) toast('Backup needs the TV (USB drive)'); return; }
    Recorder.writeUsbFile(BACKUP_DIR, BACKUP_FILE, backupData(), function (err) {
      if (err) { if (!silent) toast('Backup failed: ' + err, 5000); return; }
      Store.lsSet('lastBackup', Date.now());
      if (!silent) toast('Backup saved to the USB drive (' + BACKUP_DIR + ')', 4000);
      if (S.section === 'settings') renderSettings();
    });
  }
  function restoreNow() {
    Recorder.readUsbFile(BACKUP_DIR, BACKUP_FILE, function (err, text) {
      if (err) return toast('Restore failed: ' + err, 5000);
      var b;
      try { b = JSON.parse(text); } catch (e) { return toast('Restore failed: the backup file is damaged', 5000); }
      if (!b || !b.data) return toast('Restore failed: not an AsoosA backup', 5000);
      for (var k in b.data) if (b.data.hasOwnProperty(k)) { try { localStorage.setItem(k, b.data[k]); } catch (e) {} }
      toast('Restored the backup from ' + new Date(b.at).toLocaleDateString() + '  ·  restarting…', 3000);
      setTimeout(function () { location.reload(); }, 2500);
    });
  }

  /* ---------------- Settings page ---------------- */

  var SET = { mode: 'main', sel: 0, teamSel: 0, armed: '' };

  function allTeams() {
    var names = {}, out = [];
    favTeams().forEach(function (t) { names[t] = 1; });
    (HOME.matches || []).forEach(function (m) { names[m.home] = 1; names[m.away] = 1; });
    for (var n in names) if (names.hasOwnProperty(n) && n) out.push(n);
    out.sort(function (a, b) { var fa = teamIsFav([a]), fb = teamIsFav([b]); return fa !== fb ? (fa ? -1 : 1) : a.localeCompare(b); });
    return out;
  }

  /* ---- updates from the GitHub site (js/boot.js does the work) ---- */

  function appVersion() {
    var u = window.AsoosaUpdate;
    if (!u) return '';
    var v = String(u.running);                                // 2026111601 -> 2026.11.16-1
    return v.substring(0, 4) + '.' + v.substring(4, 6) + '.' + v.substring(6, 8) + '-' + (parseInt(v.substring(8), 10) || 0) +
      (u.running !== u.build ? ' (updated)' : '');
  }

  function checkUpdate() {
    var u = window.AsoosaUpdate;
    if (!u) return;
    SET.updMsg = 'Checking…';
    renderSettings();
    u.check(function (err, st) {
      SET.updMsg = err ? 'Could not check (' + err + ')' : st === 'ready' ? 'Downloaded · restarting…' : 'Up to date';
      renderSettings();
      if (st === 'ready') setTimeout(function () { savePos(); Player.stop(); location.reload(); }, 1500);
    });
  }

  function settingsRows() {
    if (SET.mode === 'teams') {
      return allTeams().map(function (t) { return { id: 'team', team: t, label: t, value: teamIsFav([t]) ? '★ Favorite' : '', on: teamIsFav([t]) }; });
    }
    var lb = Store.lsGet('lastBackup'), upcoming = reminders.filter(function (r) { return r.time > Date.now(); }).length;
    return [
      { id: 'sleep', label: 'Sleep timer', value: sleepLabel() },
      { id: 'subsize', label: 'Subtitle size', value: SUB_SIZES[subStyle.size || 0].n },
      { id: 'subcolor', label: 'Subtitle colour', value: SUB_COLORS[subStyle.color || 0].n },
      { id: 'subbg', label: 'Subtitle background', value: SUB_BGS[subStyle.bg || 0].n },
      { id: 'teams', label: 'Favorite teams', value: favTeams().join(', ') || 'None' },
      { id: 'reminders', label: 'Match reminders', value: upcoming ? upcoming + ' upcoming  ·  OK twice to clear' : 'None' },
      { id: 'backup', label: 'Backup to USB', value: lb ? 'last: ' + new Date(lb).toLocaleString() : 'never' },
      { id: 'restore', label: 'Restore from USB', value: SET.armed === 'restore' ? 'press OK again to restore' : '' },
      { id: 'update', label: 'App version ' + appVersion(), value: SET.updMsg || 'OK to check for updates' }
    ];
  }

  function renderSettings() {
    var rows = settingsRows(), html = '';
    var sel = SET.mode === 'teams' ? SET.teamSel : SET.sel;
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    if (SET.mode === 'teams') SET.teamSel = sel; else SET.sel = sel;
    $('set-title').textContent = SET.mode === 'teams' ? 'Favorite teams' : 'Settings';
    $('set-sub').textContent = SET.mode === 'teams'
      ? 'OK to add or remove  ·  BACK when done  ·  teams from the current match list'
      : 'Sleep timer shortcut: press 0 while watching';
    // Show a window of rows around the selection (the team list can be long).
    var start = Math.max(0, Math.min(sel - 4, rows.length - 9));
    for (var i = start; i < Math.min(rows.length, start + 9); i++) {
      var r = rows[i];
      html += '<div class="set-row' + (SET.mode === 'teams' ? ' small' : '') + (S.focus === 'settings' && i === sel ? ' focus' : '') + '">' +
        '<span>' + esc(r.label) + '</span><span class="sv' + (r.on ? ' on' : '') + '">' + esc(r.value) + '</span></div>';
    }
    $('set-rows').innerHTML = html;
  }

  function settingsKey(k) {
    var rows = settingsRows(), teams = SET.mode === 'teams';
    var sel = teams ? SET.teamSel : SET.sel, row = rows[sel];
    switch (k) {
      case 'UP': if (sel > 0) { if (teams) SET.teamSel--; else SET.sel--; SET.armed = ''; renderSettings(); } break;
      case 'DOWN': if (sel < rows.length - 1) { if (teams) SET.teamSel++; else SET.sel++; SET.armed = ''; renderSettings(); } break;
      case 'LEFT': if (!teams) setFocus('tabs'); break;
      case 'BACK':
        if (teams) { SET.mode = 'main'; renderSettings(); } else panelBack();
        break;
      case 'ENTER':
        if (!row) break;
        if (row.id === 'team') {
          var list = favTeams();
          // remove every saved name that refers to this team ("Real Madrid" / "Real Madrid CF")
          if (teamIsFav([row.team])) list = list.filter(function (t) { return !sameTeam(t, row.team); });
          else list.push(row.team);
          Store.lsSet('favTeams', list);
          autoReminders();
          renderSettings();
          if (S.section === 'home') renderHomeRows();
        } else if (row.id === 'update') checkUpdate();
        else if (row.id === 'sleep') cycleSleep();
        else if (row.id === 'subsize' || row.id === 'subcolor' || row.id === 'subbg') {
          cycleSubStyle(row.id === 'subsize' ? 'size' : row.id === 'subcolor' ? 'color' : 'bg');
          renderSettings();
        }
        else if (row.id === 'teams') { SET.mode = 'teams'; SET.teamSel = 0; renderSettings(); }
        else if (row.id === 'reminders') {
          if (SET.armed !== 'reminders') { SET.armed = 'reminders'; toast('Press OK again to clear all reminders'); }
          else { reminders.forEach(function (r) { remindersOff[r.id] = 1; }); reminders = []; saveReminders(); SET.armed = ''; toast('All reminders cleared'); renderSettings(); }
        } else if (row.id === 'backup') backupNow(false);
        else if (row.id === 'restore') {
          if (SET.armed !== 'restore') { SET.armed = 'restore'; renderSettings(); }
          else { SET.armed = ''; restoreNow(); }
        }
        break;
    }
  }

  /* ---------------- diagnostics (config "debug": true, key 0 while watching) ---------------- */

  /** Draws a labelled red frame around every element that is currently visible on screen. */
  function toggleOutlines() {
    var old = document.getElementById('dbg-layer');
    if (old) { old.parentNode.removeChild(old); return; }
    var layer = document.createElement('div');
    layer.id = 'dbg-layer';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;pointer-events:none;z-index:9999';
    var all = document.body.getElementsByTagName('*'), n = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === 'SCRIPT') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > 1920 || r.top > 1080) continue;
      var cs = window.getComputedStyle(el), hiddenUp = false;
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        var ps = window.getComputedStyle(p);
        if (ps.display === 'none' || ps.visibility === 'hidden' || ps.opacity === '0') { hiddenUp = true; break; }
      }
      if (hiddenUp || cs.display === 'none') continue;
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;border:2px solid #f00;box-sizing:border-box;left:' + r.left + 'px;top:' + r.top +
        'px;width:' + r.width + 'px;height:' + r.height + 'px';
      var lab = document.createElement('span');
      lab.style.cssText = 'position:absolute;left:0;top:0;background:#f00;color:#fff;font:16px Arial;padding:0 4px;white-space:nowrap';
      lab.textContent = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) +
        ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
      box.appendChild(lab);
      layer.appendChild(box);
      n++;
    }
    document.body.appendChild(layer);
    toast(n + ' visible elements outlined  ·  press 0 again to hide', 4000);
  }

  /* ---------------- startup ---------------- */

  function start() {
    Keys.register();
    Player.init(onPlayerStatus);
    Recorder.setListener(onRecordChange);

    listW = new VList($('channels'), { rowH: ROW_H, create: createChRow, render: renderChRow, onSelect: onListSelect });
    gridW = new VGrid($('grid'), {
      cols: GRID.cols, tileW: GRID.tileW, gap: GRID.gap, rowH: GRID.rowH, height: GRID.height, pad: GRID.pad,
      create: createTile, render: renderTile, onSelect: onListSelect
    });
    curW = listW;
    chList = makeContentProxy();
    $('pv-img').onload = function () { this.style.visibility = 'visible'; };
    $('pv-img').onerror = function () { this.style.visibility = 'hidden'; $('pv-none').style.display = ''; };
    grList = new VList($('groups'), { rowH: GROUP_ROW_H, create: createGrRow, render: renderGrRow });

    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { savePos(); Player.suspend(); } else Player.restore();
    });

    var inp = $('search');
    inp.addEventListener('input', function () {
      later('search', 250, function () { S.query = inp.value.trim(); S.queryLabel = ''; applyView(false); });
    });
    inp.addEventListener('blur', function () { if (S.focus === 'typing') setFocus('search'); });

    setInterval(function () {
      if (bannerVisible() && (isVod() || S.seekBase >= 0)) renderBanner();
      // Remember the last good position: after a dropped connection the player reports 0.
      if (isVod() && !S.statusErr) {
        var now = Player.time();
        if (now > 0) { S.playing.lastTime = now; S.playing.lastDur = Player.duration() || S.playing.lastDur; }
      }
      updateRecBadge();
    }, 1000);
    setInterval(savePos, 10000);
    // Home screen: clock every 15 s; weather/matches refresh on their own schedule.
    setInterval(function () {
      if (S.panel && S.section === 'home') {
        renderClock();
        loadHomeData(false);
        // "next prayer in …" counts down: redraw the cards once a minute
        var mn = new Date().getMinutes();
        if (mn !== HOME.lastMin && S.focus !== 'reader') { HOME.lastMin = mn; renderHomeRows(); }
      }
    }, 15000);
    setInterval(tickOnline, 250);
    setInterval(checkReminders, 20000);
    setInterval(checkPrayer, 20000);
    setInterval(function () { if (S.cfg && !HOME.prayer[new Date().toDateString()]) loadPrayer(false); }, 30 * 60000);
    setInterval(checkSleep, 10000);
    setInterval(pollMatches, 60000);
    // Daily automatic backup to the USB drive (silent; skipped when no drive is plugged in).
    setTimeout(function () {
      if (Date.now() - (Store.lsGet('lastBackup') || 0) > 24 * 3600000) backupNow(true);
    }, 30000);

    renderTabs();
    renderRecButton();
    updateHints();

    // 1) Auto-play the last live channel immediately, before config or channels are loaded.
    var last = Store.lsGet('last'), autoPlayed = false;
    if (last && last.p && last.p.url) {
      autoPlayed = true;
      S.zapCtx = last.ctx || 'all';
      var p = last.p;
      startPlaying({ kind: 'live', idx: -1, key: p.key, url: p.url, title: p.title, sub: p.sub, logo: p.logo, num: '', ext: 'ts' });
    } else {
      // Nothing to resume: start on the Home screen.
      switchSection('home');
      openPanel('home');
    }

    // The app started fine: a downloaded version is kept (boot.js drops one that never gets here).
    if (window.AsoosaUpdate) {
      window.AsoosaUpdate.ready();
      var pend = Store.lsGet('updPending');
      if (pend && pend > window.AsoosaUpdate.running) setTimeout(function () { toast('An app update was downloaded · it starts next time you open the app', 6000); }, 8000);
      else if (pend) Store.lsSet('updPending', 0);
    }

    // 2) Read config, then cached channels (or download them on first run).
    Store.loadConfig(function (err, cfg) {
      if (err) { openPanel('list'); listMsg(err); return; }
      S.cfg = cfg;
      S.acc = Xtream.account(cfg);
      if (cfg.bufferSeconds) Player.setBuffering(cfg.bufferSeconds);
      if (cfg.recordFolder) Recorder.setFolder(cfg.recordFolder);
      OpenSubs.setConfig(cfg.opensubtitles);
      // Faster start: while the last channel opens, the ~30 background requests (matches, tables,
      // highlights, categories…) wait a few seconds so the stream gets the connection first.
      var wait = autoPlayed ? 6000 : 0;
      HOME.matchesAt = Date.now();
      setTimeout(function () {
        if (S.section === 'home') loadHomeData(true);   // Home was drawn before the settings were read
        else { HOME.matchesAt = Date.now(); HomeData.matches(homeCfg(), onMatches); loadPrayer(false); }   // reminders, goals, adhan work everywhere
      }, wait);
      S.loading = true;
      loadLive(false, function () {
        S.loading = false;
        if (S.section === 'live') applyView(true);
        setTimeout(function () {
          // Warm up movie/series categories in the background.
          if (S.acc) { loadCats('movies', false); loadCats('series', false); }
          // Channels are known now: link the Home screen's matches to the channels that show them.
          if (S.section === 'home') {
            renderHomeRows();
            loadSportsEpg(function () { linkMatches(); if (S.section === 'home') renderHomeRows(); });
          }
        }, wait);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
