/* Xtream Codes API client (player_api.php). Loads only the categories the config asks for. ES5. */
var Xtream = (function () {
  'use strict';

  function enc(s) { return encodeURIComponent(s); }

  function parseQuery(url) {
    var out = {}, i = url.indexOf('?');
    if (i < 0) return out;
    var parts = url.substring(i + 1).split('#')[0].split('&');
    for (var k = 0; k < parts.length; k++) {
      var kv = parts[k].split('=');
      try { out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) {}
    }
    return out;
  }

  /** Account from config: explicit server/username/password, or taken from a get.php playlist URL. */
  function account(cfg) {
    var server = cfg.server, user = cfg.username, pass = cfg.password;
    if ((!server || !user || !pass) && cfg.playlistUrl) {
      var m = /^(https?:\/\/[^\/?#]+)/i.exec(cfg.playlistUrl);
      var q = parseQuery(cfg.playlistUrl);
      if (m && q.username && q.password) { server = m[1]; user = q.username; pass = q.password; }
    }
    if (!server || !user || !pass) return null;
    return { server: String(server).replace(/\/+$/, ''), user: String(user), pass: String(pass) };
  }

  function api(acc, action, extra, cb) {
    var url = acc.server + '/player_api.php?username=' + enc(acc.user) + '&password=' + enc(acc.pass) +
      '&action=' + action + (extra || '');
    Store.xhrText(url, 60000, function (err, text) {
      if (err) return cb(err);
      var json;
      try { json = JSON.parse(text); } catch (e) { return cb('invalid server response'); }
      cb(null, json);
    });
  }

  function norm(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }

  /** "|AR| أفلام" matches prefix "|AR|"; "AR| EGYPT" matches "AR|". Empty prefix list = everything. */
  function matches(name, prefixes) {
    if (!prefixes || !prefixes.length) return true;
    var n = norm(name);
    for (var i = 0; i < prefixes.length; i++) if (n.indexOf(norm(prefixes[i])) === 0) return true;
    return false;
  }

  function categories(acc, kind, prefixes, cb) {
    var action = kind === 'live' ? 'get_live_categories' : kind === 'movies' ? 'get_vod_categories' : 'get_series_categories';
    api(acc, action, '', function (err, cats) {
      if (err) return cb(err);
      if (!(cats instanceof Array)) return cb('login failed (check username/password)');
      var out = [];
      for (var i = 0; i < cats.length; i++) {
        if (matches(cats[i].category_name, prefixes)) out.push({ id: String(cats[i].category_id), name: String(cats[i].category_name).trim() });
      }
      cb(null, out);
    });
  }

  /** Live channels of all matching categories, loaded with a few parallel requests. */
  function loadLive(acc, prefixes, progress, cb) {
    categories(acc, 'live', prefixes, function (err, cats) {
      if (err) return cb(err);
      if (!cats.length) return cb('no live categories match ' + JSON.stringify(prefixes));
      var results = new Array(cats.length), next = 0, done = 0, failed = 0;
      function finish() {
        var groups = [], channels = [];
        for (var i = 0; i < cats.length; i++) {
          var list = results[i] || [];
          if (!list.length) continue;
          var g = groups.length;
          groups.push(cats[i].name);
          for (var j = 0; j < list.length; j++) {
            var s = list[j];
            channels.push({ n: String(s.name || '').trim(), id: s.stream_id, g: g, l: s.stream_icon || '', e: s.epg_channel_id || '' });
          }
        }
        if (!channels.length) return cb('no channels returned by the server');
        cb(null, { groups: groups, channels: channels, failed: failed });
      }
      function work() {
        if (next >= cats.length) return;
        var i = next++;
        api(acc, 'get_live_streams', '&category_id=' + enc(cats[i].id), function (e, arr) {
          results[i] = (!e && arr instanceof Array) ? arr : [];
          if (e) failed++;
          done++;
          progress(done, cats.length);
          if (done === cats.length) finish(); else work();
        });
      }
      for (var k = 0; k < 6; k++) work();
    });
  }

  function movies(acc, catId, cb) {
    api(acc, 'get_vod_streams', '&category_id=' + enc(catId), function (err, arr) {
      if (err) return cb(err);
      if (!(arr instanceof Array)) return cb('invalid server response');
      var out = new Array(arr.length);
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        out[i] = {
          n: String(m.name || '').trim(), id: m.stream_id, l: m.stream_icon || '', ext: m.container_extension || 'mp4', r: rating(m.rating),
          a: parseInt(m.added, 10) || 0, c: String(catId)        // added (unix s) for "New", category for "For you"
        };
      }
      cb(null, out);
    });
  }

  function series(acc, catId, cb) {
    api(acc, 'get_series', '&category_id=' + enc(catId), function (err, arr) {
      if (err) return cb(err);
      if (!(arr instanceof Array)) return cb('invalid server response');
      var out = new Array(arr.length);
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        out[i] = {
          n: String(s.name || '').trim(), id: s.series_id, l: s.cover || '', r: rating(s.rating),
          y: String(s.releaseDate || s.release_date || '').substring(0, 4),
          p: String(s.plot || '').substring(0, 400), gn: String(s.genre || '').substring(0, 60),
          a: parseInt(s.last_modified, 10) || 0, c: String(catId)
        };
      }
      cb(null, out);
    });
  }

  function rating(r) { var n = parseFloat(r); return n > 0 ? Math.round(n * 10) / 10 : 0; }

  /** Details for the poster panel: plot, year, rating, duration and the large cover. */
  function movieInfo(acc, id, cb) {
    api(acc, 'get_vod_info', '&vod_id=' + enc(id), function (err, data) {
      if (err) return cb(err);
      var i = (data && data.info) || {};
      cb(null, {
        p: String(i.plot || i.description || '').substring(0, 400),
        y: String(i.releasedate || i.release_date || '').substring(0, 4),
        r: rating(i.rating), d: i.duration || '', gn: String(i.genre || '').substring(0, 60),
        cover: i.cover_big || i.movie_image || '', tmdb: i.tmdb_id || i.tmdb || '',
        trailer: String(i.youtube_trailer || '').replace(/^.*(?:v=|youtu\.be\/|embed\/)/, '').replace(/[^A-Za-z0-9_-].*$/, ''),
        backdrop: (i.backdrop_path instanceof Array ? i.backdrop_path[0] : i.backdrop_path) || ''
      });
    });
  }

  function pad(n) { n = parseInt(n, 10) || 0; return n < 10 ? '0' + n : '' + n; }

  /** All episodes of a series, sorted by season then episode. */
  function episodes(acc, seriesId, cb) {
    api(acc, 'get_series_info', '&series_id=' + enc(seriesId), function (err, info) {
      if (err) return cb(err);
      var eps = info && info.episodes;
      if (!eps) return cb(null, []);
      var all = [];
      var seasons = eps instanceof Array ? eps : Object.keys(eps).map(function (k) { return eps[k]; });
      for (var s = 0; s < seasons.length; s++) {
        var list = seasons[s] instanceof Array ? seasons[s] : [seasons[s]];
        for (var e = 0; e < list.length; e++) {
          var ep = list[e];
          if (!ep || !ep.id) continue;
          var sn = parseInt(ep.season, 10) || 0, en = parseInt(ep.episode_num, 10) || 0;
          var title = String(ep.title || '').trim();
          all.push({ n: 'S' + pad(sn) + 'E' + pad(en) + (title ? ' · ' + title : ''), id: ep.id, ext: ep.container_extension || 'mp4', s: sn, e: en });
        }
      }
      all.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
      var si = (info && info.info) || {};
      all.tmdb = si.tmdb || si.tmdb_id || '';
      cb(null, all);
    });
  }

  function b64(s) {
    if (!s) return '';
    try { return decodeURIComponent(escape(window.atob(s))); } catch (e) {}
    try { return window.atob(s); } catch (e2) { return String(s); }
  }

  /**
   * A channel's full guide (several days) from the provider: [{ t: title, s: start ms, e: end ms }].
   * (get_short_epg only returns ~4 programmes on this provider, not enough to reach the weekend.)
   */
  function shortEpg(acc, streamId, limit, cb) {
    api(acc, 'get_simple_data_table', '&stream_id=' + enc(streamId), function (err, d) {
      if (err) return cb(err);
      var l = (d && d.epg_listings) || [], out = [];
      for (var i = 0; i < l.length; i++) {
        var s = parseInt(l[i].start_timestamp, 10), e = parseInt(l[i].stop_timestamp, 10);
        if (s && e) out.push({ t: b64(l[i].title), s: s * 1000, e: e * 1000 });
      }
      cb(null, out);
    });
  }

  function liveUrl(acc, id) { return acc.server + '/live/' + enc(acc.user) + '/' + enc(acc.pass) + '/' + id + '.ts'; }
  function movieUrl(acc, id, ext) { return acc.server + '/movie/' + enc(acc.user) + '/' + enc(acc.pass) + '/' + id + '.' + ext; }
  function episodeUrl(acc, id, ext) { return acc.server + '/series/' + enc(acc.user) + '/' + enc(acc.pass) + '/' + id + '.' + ext; }

  return {
    account: account, matches: matches, categories: categories, loadLive: loadLive,
    movies: movies, series: series, episodes: episodes, movieInfo: movieInfo, shortEpg: shortEpg,
    liveUrl: liveUrl, movieUrl: movieUrl, episodeUrl: episodeUrl
  };
})();
