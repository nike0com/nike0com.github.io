/*
 * Second subtitle from OpenSubtitles.com: search by file hash / TMDB id, download as SRT, parse cues.
 * Needs an API key in config.json ("opensubtitles": { "apiKey", "username", "password" }).
 */
var OpenSubs = (function () {
  'use strict';

  var API = 'https://api.opensubtitles.com/api/v1';
  var UA = 'AsoosA IPTV v1.0';
  var cfg = null, token = null, base = API;

  function setConfig(c) { cfg = c && c.apiKey ? c : null; token = null; base = API; }
  function enabled() { return !!cfg; }

  function request(method, url, body, cb) {
    var xhr = new XMLHttpRequest(), done = false;
    function finish(err, data) { if (!done) { done = true; cb(err, data); } }
    try {
      xhr.open(method, url, true);
      xhr.timeout = 20000;
      xhr.setRequestHeader('Api-Key', cfg.apiKey);
      xhr.setRequestHeader('Accept', 'application/json');
      try { xhr.setRequestHeader('User-Agent', UA); } catch (e) {}
      try { xhr.setRequestHeader('X-User-Agent', UA); } catch (e) {}
      if (body) xhr.setRequestHeader('Content-Type', 'application/json');
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    } catch (e) { return finish(e.message); }
    xhr.onload = function () {
      var json = null;
      try { json = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) return finish(null, json || {});
      finish((json && (json.message || (json.errors && json.errors.join(', ')))) || 'HTTP ' + xhr.status);
    };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  /** Logging in raises the daily download limit; without a user it still works with a lower limit. */
  function login(cb) {
    if (token || !cfg.username || !cfg.password) return cb();
    request('POST', API + '/login', { username: cfg.username, password: cfg.password }, function (err, d) {
      if (!err && d && d.token) {
        token = d.token;
        if (d.base_url) base = 'https://' + String(d.base_url).replace(/^https?:\/\//, '').replace(/\/+$/, '') + '/api/v1';
      }
      cb();
    });
  }

  /** Query string with keys sorted and lower-case, as the API asks (otherwise it redirects). */
  function qs(params) {
    var keys = Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== '' && params[k] !== null; }).sort();
    return keys.map(function (k) { return k.toLowerCase() + '=' + encodeURIComponent(String(params[k]).toLowerCase()); }).join('&');
  }

  /**
   * info: { hash, tmdb, parentTmdb, season, episode, query }. lang: 'ar', 'de'...
   * cb(err, { text, release, hashMatch })
   */
  function fetchSubtitle(info, lang, cb) {
    if (!cfg) return cb('no OpenSubtitles API key in config.json');
    login(function () {
      var p = { languages: lang };
      if (info.parentTmdb) { p.parent_tmdb_id = info.parentTmdb; p.season_number = info.season; p.episode_number = info.episode; }
      else if (info.tmdb) p.tmdb_id = info.tmdb;
      else if (info.query) p.query = info.query;
      if (info.hash) p.moviehash = info.hash;
      request('GET', base + '/subtitles?' + qs(p), null, function (err, d) {
        if (err) return cb(err);
        var list = (d && d.data) || [];
        if (!list.length && info.hash && (p.tmdb_id || p.parent_tmdb_id || p.query)) {
          // Retry without the hash: some releases are not hashed on the site.
          delete p.moviehash;
          return request('GET', base + '/subtitles?' + qs(p), null, function (e2, d2) {
            if (e2) return cb(e2);
            pick((d2 && d2.data) || []);
          });
        }
        pick(list);
      });
    });

    function pick(list) {
      var cands = [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i].attributes || {};
        if (!a.files || !a.files.length) continue;
        a._score = (a.moviehash_match ? 1e9 : 0) + (a.from_trusted ? 1e6 : 0) + (a.download_count || 0) - (a.hearing_impaired ? 1000 : 0);
        cands.push(a);
      }
      if (!cands.length) return cb('no ' + lang + ' subtitles found online');
      cands.sort(function (x, y) { return y._score - x._score; });
      tryCandidate(cands, 0);
    }

    // Some uploads are labelled with the wrong language: check the text, then try the next file.
    function tryCandidate(cands, n) {
      var best = cands[n];
      request('POST', base + '/download', { file_id: best.files[0].file_id, sub_format: 'srt' }, function (err, d) {
        if (err) return cb(err);
        if (!d || !d.link) return cb((d && d.message) || 'download refused');
        getText(d.link, lang, function (e3, text) {
          if (e3) return cb(e3);
          if (!looksLike(text, lang) && n + 1 < cands.length && n < 2 && d.remaining > 0) return tryCandidate(cands, n + 1);
          cb(null, { text: text, release: best.release || '', hashMatch: !!best.moviehash_match, remaining: d.remaining });
        });
      });
    }
  }

  var COMMON = {
    de: ['der', 'die', 'das', 'und', 'ich', 'nicht', 'ist', 'sie', 'du', 'wir', 'ein', 'zu', 'mit', 'es', 'was', 'mir'],
    en: ['the', 'you', 'and', 'to', 'is', 'it', 'that', 'what', 'of', 'i', 'me', 'this', 'we', 'in', 'my'],
    fr: ['le', 'la', 'les', 'et', 'je', 'vous', 'est', 'pas', 'que', 'de', 'un', 'tu', 'ce'],
    es: ['el', 'la', 'que', 'de', 'no', 'es', 'y', 'en', 'lo', 'un', 'por', 'qué', 'me']
  };

  /** Rough check that a subtitle is really in `lang` (Arabic by script, others by common words). */
  function looksLike(text, lang) {
    var sample = String(text).replace(/^\d+\s*$/gm, '').replace(/[\d:,.]+\s*-->\s*[\d:,.]+/g, '').substring(0, 20000);
    if (lang === 'ar' || lang === 'fa') {
      var ar = (sample.match(/[؀-ۿ]/g) || []).length, lat = (sample.match(/[A-Za-z]/g) || []).length;
      return ar > lat;
    }
    var words = COMMON[lang];
    if (!words) return true;
    var all = sample.toLowerCase().match(/[a-zäöüßéèàçñ']+/g) || [];
    if (all.length < 50) return true;
    var set = {}, hits = 0;
    for (var i = 0; i < words.length; i++) set[words[i]] = 1;
    for (var j = 0; j < all.length; j++) if (set[all[j]]) hits++;
    return hits / all.length > 0.08;
  }

  /** Downloads the file and decodes it: UTF-8, else the usual legacy code page for the language. */
  function getText(url, lang, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 20000;
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return cb('HTTP ' + xhr.status);
      var bytes = new Uint8Array(xhr.response), text = null;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (e) {
        var legacy = { ar: 'windows-1256', fa: 'windows-1256', ru: 'windows-1251', bg: 'windows-1251', el: 'windows-1253', tr: 'windows-1254', he: 'windows-1255', pl: 'windows-1250', cs: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250' }[lang] || 'windows-1252';
        try { text = new TextDecoder(legacy).decode(bytes); } catch (e2) { text = String.fromCharCode.apply(null, bytes.subarray(0, 200000)); }
      }
      cb(null, text.replace(/^﻿/, ''));
    };
    xhr.onerror = function () { cb('network error'); };
    xhr.ontimeout = function () { cb('timeout'); };
    xhr.send();
  }

  /** SRT -> [{ s, e, t }] in ms, sorted. */
  function parseSrt(text) {
    var cues = [], blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
    var re = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
    function ms(h, m, s, f) { return ((+h * 60 + +m) * 60 + +s) * 1000 + +((f + '00').substring(0, 3)); }
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      for (var j = 0; j < lines.length; j++) {
        var m = re.exec(lines[j]);
        if (!m) continue;
        var t = lines.slice(j + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
        if (t) cues.push({ s: ms(m[1], m[2], m[3], m[4]), e: ms(m[5], m[6], m[7], m[8]), t: t });
        break;
      }
    }
    cues.sort(function (a, b) { return a.s - b.s; });
    return cues;
  }

  /** Text of the cue showing at time ms ('' when none). */
  function cueAt(cues, ms) {
    var lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].s <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (var k = found; k >= 0 && k > found - 3; k--) if (cues[k].e > ms) return cues[k].t;
    return '';
  }

  /**
   * OpenSubtitles file hash: file size + sum of the 64-bit little-endian words
   * of the first and last 64 KB, modulo 2^64, as 16 hex digits.
   */
  function fileHash(size, head, tail) {
    var lo = size % 4294967296, hi = Math.floor(size / 4294967296);
    function add(buf) {
      var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (var i = 0; i + 8 <= buf.byteLength; i += 8) {
        lo += dv.getUint32(i, true);
        hi += dv.getUint32(i + 4, true) + Math.floor(lo / 4294967296);
        lo %= 4294967296; hi %= 4294967296;
      }
    }
    add(head); add(tail);
    function hex(n) { var h = n.toString(16); while (h.length < 8) h = '0' + h; return h; }
    return hex(hi) + hex(lo);
  }

  return { setConfig: setConfig, enabled: enabled, fetchSubtitle: fetchSubtitle, parseSrt: parseSrt, cueAt: cueAt, fileHash: fileHash };
})();
