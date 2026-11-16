/* Persistence: big playlist in IndexedDB, small state in localStorage. Plus config + download. ES5. */
var Store = (function () {
  'use strict';

  var DB_NAME = 'iptv', DB_STORE = 'kv';
  var db = null, dbWaiters = null, dbFailed = false;

  function openDB(cb) {
    if (db || dbFailed) return cb(db);
    if (dbWaiters) { dbWaiters.push(cb); return; }
    dbWaiters = [cb];
    var settled = false;
    // Never let a stuck IndexedDB block startup: fall back to localStorage after 2 s.
    var guard = setTimeout(function () { done(null); }, 2000);
    function done(d) {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      db = d;
      dbFailed = !d;
      var w = dbWaiters; dbWaiters = null;
      for (var i = 0; i < w.length; i++) w[i](d);
    }
    if (!window.indexedDB) return done(null);
    var req;
    try { req = window.indexedDB.open(DB_NAME, 1); } catch (e) { return done(null); }
    req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
    req.onsuccess = function () { done(req.result); };
    req.onerror = function () { done(null); };
  }

  // Open the database right away so it is ready by the time the config is read.
  openDB(function () {});

  /*
   * Profiles: these keys are kept per person (favorites, positions, watched, subtitles, teams…).
   * The first profile ("main") uses the plain keys, so nothing changes for existing data.
   * The profile is chosen before the app starts (js/boot.js); switching reloads the app.
   */
  var PER_PROFILE = /^(favs|favMovies|favSeries|ui|laterMovies|laterSeries|watched|subLang|pos|cw|last|reminders|remindersOff|favTeams|favTeamsCfg|subStyle|recent|homeRows|audioLang|subDelay2:.*|audio:.*)$/;
  function rawGet(key) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  var profileId = rawGet('profile') || 'main';
  function realKey(key) { return profileId !== 'main' && PER_PROFILE.test(key) ? 'p:' + profileId + ':' + key : key; }

  function lsGet(key) { return rawGet(realKey(key)); }
  function lsSet(key, val) {
    try { localStorage.setItem(realKey(key), JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  function profiles() {
    var p = rawGet('profiles');
    return p instanceof Array && p.length ? p : [{ id: 'main', name: 'Main' }];
  }
  function saveProfiles(list) { try { localStorage.setItem('profiles', JSON.stringify(list)); } catch (e) {} }
  /** Removes everything a profile saved (not "main"). */
  function dropProfileData(id) {
    if (id === 'main') return;
    var pre = 'p:' + id + ':', del = [];
    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(pre) === 0) del.push(k); }
    del.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  }

  function get(key, cb) {
    openDB(function (d) {
      if (!d) return cb(lsGet('db:' + key));
      try {
        var r = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
        r.onsuccess = function () { cb(r.result || null); };
        r.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }

  function put(key, val, cb) {
    cb = cb || function () {};
    openDB(function (d) {
      if (!d) return cb(lsSet('db:' + key, val));
      try {
        var tx = d.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = function () { cb(true); };
        tx.onerror = function () { cb(false); };
      } catch (e) { cb(false); }
    });
  }

  function xhrText(url, timeoutMs, cb) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(err, text) { if (finished) return; finished = true; cb(err, text); }
    try {
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs;
    } catch (e) { return finish(e.message); }
    xhr.onload = function () {
      // Local package files report status 0 on Tizen
      if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText)) finish(null, xhr.responseText);
      else finish('HTTP ' + xhr.status);
    };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    xhr.send();
  }

  function loadConfig(cb) {
    xhrText('config.json', 5000, function (err, text) {
      if (err) return cb('config.json not found. Copy config.example.json to config.json and set playlistUrl.');
      var cfg;
      try { cfg = JSON.parse(text); } catch (e) { return cb('config.json is not valid JSON: ' + e.message); }
      // Subscription entered on the TV (Settings > Subscription) wins over config.json.
      var ov = rawGet('cfgOverride');
      if (cfg && ov && ov.server && ov.username && ov.password) {
        cfg.server = ov.server; cfg.username = ov.username; cfg.password = ov.password; cfg.fromTV = true;
      }
      if (!cfg || (!cfg.playlistUrl && !cfg.server)) return cb('config.json needs "playlistUrl" (or server/username/password).');
      if (cfg.showLogos === undefined) cfg.showLogos = true;
      if (!(cfg.live instanceof Array)) cfg.live = [];
      if (!(cfg.movies instanceof Array)) cfg.movies = [];
      if (!(cfg.series instanceof Array)) cfg.series = [];
      cb(null, cfg);
    });
  }

  function parseText(text, cb) {
    var worker;
    function fallback() {
      try { cb(null, M3U.parse(text)); } catch (e) { cb('parse error: ' + e.message); }
    }
    try { worker = new Worker('js/m3u-worker.js'); } catch (e) { return fallback(); }
    var done = false;
    worker.onmessage = function (e) {
      if (done) return; done = true; worker.terminate();
      if (e.data && e.data.ok) cb(null, e.data.data); else fallback();
    };
    worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (done) return; done = true; worker.terminate(); fallback();
    };
    worker.postMessage(text);
  }

  function downloadPlaylist(url, cb) {
    xhrText(url, 90000, function (err, text) {
      if (err) return cb(err);
      if (text.indexOf('#EXTINF') === -1 && text.indexOf('#EXTM3U') === -1) return cb('response is not an M3U playlist');
      parseText(text, function (perr, pl) {
        if (perr) return cb(perr);
        if (!pl.channels.length) return cb('playlist has no channels');
        pl.url = url;
        pl.savedAt = Date.now();
        cb(null, pl);
      });
    });
  }

  return {
    get: get,
    put: put,
    lsGet: lsGet,
    lsSet: lsSet,
    profile: function () { return profileId; },
    profiles: profiles,
    saveProfiles: saveProfiles,
    dropProfileData: dropProfileData,
    xhrText: xhrText,
    loadConfig: loadConfig,
    downloadPlaylist: downloadPlaylist
  };
})();
