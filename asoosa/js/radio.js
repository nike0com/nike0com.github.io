/*
 * Radio and Quran: free public directories, no keys. ES5.
 *  - mp3quran.net: live Quran radios, reciters and their surahs (MP3 files).
 *  - radio-browser.info: radio stations by country, language and music type.
 * Lists are kept for a day (IndexedDB through Store), so the Radio section opens fast.
 */
var RadioData = (function () {
  'use strict';

  var RB = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
  var DAY = 24 * 3600000;

  /* Music groups: [id, label, radio-browser query]. Order = order in the Radio section. */
  var GROUPS = [
    ['eg', 'Egypt', 'bycountrycodeexact/EG'],
    ['tarab', 'Tarab & classic Arabic', 'bytag/tarab'],
    ['arabic', 'Arabic music', 'bytag/arabic'],
    ['ch', 'Switzerland', 'bycountrycodeexact/CH'],
    ['de', 'Germany', 'bycountrycodeexact/DE'],
    ['pop', 'Pop & hits', 'bytagexact/pop'],
    ['80s', '80s', 'bytagexact/80s'],
    ['90s', '90s', 'bytagexact/90s'],
    ['oldies', 'Oldies', 'bytagexact/oldies'],
    ['rock', 'Rock', 'bytagexact/rock'],
    ['dance', 'Dance & electronic', 'bytagexact/dance'],
    ['hiphop', 'Hip-hop & R&B', 'bytagexact/hip hop'],
    ['lounge', 'Lounge & chill', 'bytagexact/chillout'],
    ['jazz', 'Jazz', 'bytagexact/jazz'],
    ['classical', 'Classical', 'bytagexact/classical'],
    ['kids', 'Kids', 'bytagexact/kids'],
    ['news', 'News & talk', 'bytagexact/news']
  ];

  function getJSON(url, cb) {
    var xhr = new XMLHttpRequest(), done = false;
    function finish(e, d) { if (!done) { done = true; cb(e, d); } }
    try { xhr.open('GET', url, true); xhr.timeout = 20000; } catch (e) { return finish(e.message); }
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return finish('HTTP ' + xhr.status);
      try { finish(null, JSON.parse(xhr.responseText)); } catch (e) { finish('bad data'); }
    };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    xhr.send();
  }

  /** Saved list (under a day old), else load(cb) and save it. */
  function cached(key, load, cb) {
    Store.get('radio:' + key, function (e) {
      if (e && e.items && Date.now() - e.at < DAY) return cb(null, e.items);
      load(function (err, items) {
        if (err) return e && e.items ? cb(null, e.items) : cb(err);   // offline: an older list is better than none
        Store.put('radio:' + key, { at: Date.now(), items: items });
        cb(null, items);
      });
    });
  }

  /** radio-browser with fallback servers. */
  function rb(path, cb, n) {
    n = n || 0;
    getJSON(RB[n] + path, function (err, d) {
      if (err && n + 1 < RB.length) return rb(path, cb, n + 1);
      cb(err, d);
    });
  }

  /** Stations of one music group: [{ id, n, l, u, tag }] most listened first, without duplicates. */
  function stations(groupId, cb) {
    var g = null;
    GROUPS.forEach(function (x) { if (x[0] === groupId) g = x; });
    if (!g) return cb('unknown group');
    cached('g:' + groupId, function (done) {
      rb('/json/stations/' + g[2].replace(/ /g, '%20') + '?hidebroken=true&order=clickcount&reverse=true&limit=200', function (err, list) {
        if (err || !(list instanceof Array)) return done(err || 'no stations');
        var seen = {}, out = [];
        list.forEach(function (s) {
          var codec = String(s.codec || '').toUpperCase(), name = String(s.name || '').replace(/\s+/g, ' ').trim();
          var key = name.toLowerCase();
          if (!name || seen[key] || !(s.url_resolved || s.url)) return;
          if (codec && !/MP3|AAC|OGG/.test(codec)) return;            // what the TV plays
          seen[key] = 1;
          out.push({ id: 'rb:' + s.stationuuid, n: name, l: s.favicon || '', u: s.url_resolved || s.url,
            tag: [s.country, (s.tags || '').split(',').slice(0, 2).join(', ')].filter(function (x) { return x; }).join(' · '), rb: s.stationuuid });
        });
        done(null, out.slice(0, 150));
      });
    }, cb);
  }

  /** Counts a play on radio-browser (they ask apps to do this; it keeps their ranking useful). */
  function clicked(uuid) { if (uuid) rb('/json/url/' + uuid, function () {}); }

  /** Live Quran radios (reciters, tafsir, ruqyah…). */
  function quranRadios(cb) {
    cached('quranlive', function (done) {
      getJSON('https://mp3quran.net/api/v3/radios?language=ar', function (err, d) {
        var r = d && d.radios;
        if (err || !r) return done(err || 'no radios');
        done(null, r.map(function (x) { return { id: 'qr:' + x.id, n: String(x.name || '').trim(), l: '', u: x.url, tag: 'إذاعة' }; }));
      });
    }, cb);
  }

  /** Reciters with their best complete recording: [{ id, n, server, surahs: [ids], rewaya }]. */
  function reciters(cb) {
    cached('reciters', function (done) {
      getJSON('https://mp3quran.net/api/v3/reciters?language=ar', function (err, d) {
        var r = d && d.reciters;
        if (err || !r) return done(err || 'no reciters');
        var out = [];
        r.forEach(function (x) {
          var best = null;
          (x.moshaf || []).forEach(function (m) { if (!best || (m.surah_total || 0) > (best.surah_total || 0)) best = m; });
          if (!best || !best.server) return;
          out.push({ id: 'rc:' + x.id, n: String(x.name || '').trim(), server: best.server, rewaya: best.name || '',
            surahs: String(best.surah_list || '').split(',').map(function (s) { return parseInt(s, 10); }).filter(function (s) { return s > 0; }) });
        });
        out.sort(function (a, b) { return b.surahs.length - a.surahs.length || (a.n < b.n ? -1 : 1); });
        done(null, out);
      });
    }, cb);
  }

  /** Surah names: { 1: 'الفاتحة', … } */
  function suwar(cb) {
    cached('suwar', function (done) {
      getJSON('https://mp3quran.net/api/v3/suwar?language=ar', function (err, d) {
        var s = d && d.suwar;
        if (err || !s) return done(err || 'no suwar');
        var names = {};
        s.forEach(function (x) { names[x.id] = x.name; });
        done(null, names);
      });
    }, cb);
  }

  /*
   * Verse by verse: mp3quran has the start/end time of every ayah for 115 recordings (matched by
   * the recording's folder). cb(err, [{ ayah, s, e }]) in ms; ayah 0 = the basmala before verse 1.
   */
  var timingCache = {};
  function norm(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase(); }
  function timing(reciter, surah, cb) {
    cached('reads', function (done) {
      getJSON('https://mp3quran.net/api/v3/ayat_timing/reads', function (err, d) {
        if (err || !(d instanceof Array)) return done(err || 'no timing list');
        done(null, d.map(function (x) { return { id: x.id, f: norm(x.folder_url) }; }));
      });
    }, function (err, reads) {
      if (err) return cb(err);
      var f = norm(reciter.server), read = null;
      reads.forEach(function (x) { if (x.f === f) read = x.id; });
      if (!read) return cb('no verse timing for this reciter');
      var key = read + ':' + surah;
      if (timingCache[key]) return cb(null, timingCache[key]);
      getJSON('https://mp3quran.net/api/v3/ayat_timing?surah=' + surah + '&read=' + read, function (e2, t) {
        if (e2 || !(t instanceof Array)) return cb(e2 || 'no timing');
        timingCache[key] = t.map(function (x) { return { ayah: x.ayah, s: x.start_time, e: x.end_time }; });
        cb(null, timingCache[key]);
      });
    });
  }

  /** Text of a surah: cb(err, ['verse 1', 'verse 2', …]); edition 'quran-uthmani' (Arabic) or a translation like 'en.sahih'. */
  function surahText(surah, cb, edition) {
    edition = edition || 'quran-uthmani';
    cached('qt:' + edition + ':' + surah, function (done) {
      getJSON('https://api.alquran.cloud/v1/surah/' + surah + '/' + edition, function (err, d) {
        var a = d && d.data && d.data.ayahs;
        if (err || !a) return done(err || 'no text');
        done(null, a.map(function (x) { return String(x.text || '').replace(/^﻿/, ''); }));
      });
    }, cb);
  }

  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
  function surahUrl(reciter, n) { return reciter.server.replace(/\/?$/, '/') + pad3(n) + '.mp3'; }

  return { GROUPS: GROUPS, stations: stations, clicked: clicked, quranRadios: quranRadios, reciters: reciters, suwar: suwar, surahUrl: surahUrl,
    timing: timing, surahText: surahText };
})();
