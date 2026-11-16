/*
 * Reads the subtitle track list (language + name) from the start of an MKV file.
 * Samsung's player reports subtitle tracks without their language, so the app reads it itself.
 * Only the first ~2 MB are downloaded (HTTP Range), before playback starts.
 */
var MKV = (function () {
  'use strict';

  var LIMIT = 1024 * 1024;
  var ID_SEGMENT = 0x18538067, ID_TRACKS = 0x1654AE6B, ID_CLUSTER = 0x1F43B675, ID_ENTRY = 0xAE;
  var ID_TYPE = 0x83, ID_LANG = 0x22B59C, ID_IETF = 0x22B59D, ID_NAME = 0x536E, ID_FORCED = 0x55AA;

  /** Variable-length integer at b[p]. keep = keep the length marker (element IDs). */
  function vint(b, p, keep) {
    if (p >= b.length) return null;
    var first = b[p], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
    if (len > 8 || p + len > b.length) return null;
    var v = keep ? first : (first & (mask - 1)), allOnes = v === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xFF) allOnes = false; }
    return { v: v, len: len, unknown: !keep && allOnes };
  }

  /** Calls fn(id, start, end) for each child element in b[s..e). Returns false if data ran out. */
  function each(b, s, e, fn) {
    var p = s;
    while (p < e) {
      var id = vint(b, p, true); if (!id) return false;
      var sz = vint(b, p + id.len, false); if (!sz) return false;
      var ds = p + id.len + sz.len, de = sz.unknown ? e : ds + sz.v;
      if (fn(id.v, ds, Math.min(de, b.length), de > b.length) === false) return true;
      p = de;
    }
    return p <= b.length;
  }

  function text(b, s, e) {
    var out = '';
    for (var i = s; i < e; i++) { if (!b[i]) break; out += String.fromCharCode(b[i]); }
    try { return decodeURIComponent(escape(out)); } catch (x) { return out; }
  }
  function uint(b, s, e) { var v = 0; for (var i = s; i < e; i++) v = v * 256 + b[i]; return v; }

  /** Returns [{ lang, name, forced }] for subtitle tracks in file order, or null if not found yet. */
  function parse(b) {
    var result = null;
    each(b, 0, b.length, function (id, s, e) {
      if (id !== ID_SEGMENT) return true;
      each(b, s, e, function (id2, s2, e2, cut) {
        if (id2 === ID_CLUSTER) return false;            // media data starts: no track list
        if (id2 !== ID_TRACKS) return true;
        if (cut) return false;                           // need more bytes
        var subs = [];
        each(b, s2, e2, function (id3, s3, e3) {
          if (id3 !== ID_ENTRY) return true;
          var t = { type: 0, lang: 'eng', ietf: '', name: '', forced: false }; // MKV default language is English
          each(b, s3, e3, function (id4, s4, e4) {
            if (id4 === ID_TYPE) t.type = uint(b, s4, e4);
            else if (id4 === ID_LANG) t.lang = text(b, s4, e4);
            else if (id4 === ID_IETF) t.ietf = text(b, s4, e4);
            else if (id4 === ID_NAME) t.name = text(b, s4, e4);
            else if (id4 === ID_FORCED) t.forced = uint(b, s4, e4) === 1;
            return true;
          });
          if (t.type === 17) subs.push({ lang: t.ietf || t.lang, name: t.name, forced: t.forced });
          return true;
        });
        result = subs;
        return false;
      });
      return false;
    });
    return result;
  }

  var HASH_CHUNK = 65536;

  /**
   * cb({ tracks: [...] or null, size, hash }) — never takes longer than timeoutMs.
   * hash is the OpenSubtitles file hash (needs the first and last 64 KB), or '' if unavailable.
   */
  function probe(url, timeoutMs, cb) {
    var done = false, reader = null, out = { tracks: null, size: 0, hash: '' };
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (reader) { try { reader.cancel(); } catch (e) {} }
      cb(out);
    }
    var timer = setTimeout(finish, timeoutMs);
    if (!window.fetch) return finish();
    var buf = new Uint8Array(LIMIT), used = 0;

    function tail() {
      if (!out.size || out.size < HASH_CHUNK * 2 || typeof OpenSubs === 'undefined' || !OpenSubs.enabled()) return finish();
      var start = out.size - HASH_CHUNK;
      window.fetch(url, { headers: { Range: 'bytes=' + start + '-' + (out.size - 1) } }).then(function (res) {
        if (res.status !== 206) return null;
        return res.arrayBuffer();
      }).then(function (ab) {
        if (ab && ab.byteLength === HASH_CHUNK) out.hash = OpenSubs.fileHash(out.size, buf.subarray(0, HASH_CHUNK), new Uint8Array(ab));
        finish();
      }).catch(finish);
    }

    // Ask for a fixed 1 MB and read it to the end, so the server sees a normal, completed request
    // (cutting a download midway can leave the connection counted against a one-connection plan).
    window.fetch(url, { headers: { Range: 'bytes=0-' + (LIMIT - 1) } }).then(function (res) {
      if (res.status !== 206) {
        // Server ignored the range and would send the whole movie: stop right away.
        if (res.body) { try { res.body.cancel(); } catch (e) {} }
        return null;
      }
      var cr = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') || '');
      if (cr) out.size = parseInt(cr[1], 10);
      return res.arrayBuffer();
    }).then(function (ab) {
      if (done || !ab) return finish();
      used = Math.min(ab.byteLength, LIMIT);
      buf.set(new Uint8Array(ab, 0, used), 0);
      out.tracks = parse(buf.subarray(0, used));
      if (used >= HASH_CHUNK) tail(); else finish();
    }).catch(finish);
  }

  return { probe: probe, parse: parse };
})();
