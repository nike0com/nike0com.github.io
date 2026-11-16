/* Home screen data: weather (Open-Meteo) and football matches (ESPN + TheSportsDB). No keys needed. ES5. */
var HomeData = (function () {
  'use strict';

  function getJSON(url, cb) {
    var xhr = new XMLHttpRequest(), done = false;
    function finish(e, d) { if (!done) { done = true; cb(e, d); } }
    try { xhr.open('GET', url, true); xhr.timeout = 15000; } catch (e) { return finish(e.message); }
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return finish('HTTP ' + xhr.status);
      try { finish(null, JSON.parse(xhr.responseText)); } catch (e) { finish('bad data'); }
    };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    xhr.send();
  }

  /* ---------- weather ---------- */

  /** cb(err, { temp, feels, code, day, today: { max, min }, days: [{ date, max, min, code }] }) */
  function weather(loc, cb) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=4&timezone=auto';
    getJSON(url, function (err, d) {
      if (err || !d || !d.current) return cb(err || 'no weather data');
      var days = [];
      for (var i = 0; i < d.daily.time.length; i++) {
        days.push({ date: d.daily.time[i], max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i], code: d.daily.weather_code[i] });
      }
      cb(null, {
        temp: d.current.temperature_2m, feels: d.current.apparent_temperature,
        code: d.current.weather_code, day: d.current.is_day === 1, days: days
      });
    });
  }

  /** WMO weather code -> { text, icon } where icon is one of: sun moon partly cloud fog rain snow storm */
  function describe(code, day) {
    if (code === 0) return { text: 'Clear', icon: day ? 'sun' : 'moon' };
    if (code === 1 || code === 2) return { text: code === 1 ? 'Mostly clear' : 'Partly cloudy', icon: 'partly' };
    if (code === 3) return { text: 'Cloudy', icon: 'cloud' };
    if (code === 45 || code === 48) return { text: 'Fog', icon: 'fog' };
    if (code >= 51 && code <= 57) return { text: 'Drizzle', icon: 'rain' };
    if (code >= 61 && code <= 67) return { text: 'Rain', icon: 'rain' };
    if (code >= 71 && code <= 77) return { text: 'Snow', icon: 'snow' };
    if (code >= 80 && code <= 82) return { text: 'Showers', icon: 'rain' };
    if (code === 85 || code === 86) return { text: 'Snow showers', icon: 'snow' };
    if (code >= 95) return { text: 'Thunderstorm', icon: 'storm' };
    return { text: '', icon: 'cloud' };
  }

  /* ---------- matches ---------- */

  /** One ESPN event (from a league scoreboard or a team schedule) as a match card, or null. */
  function espnEvent(e, name, league) {
    var c = e.competitions && e.competitions[0];
    if (!c || !c.competitors || c.competitors.length < 2) return null;
    var home = c.competitors[0].homeAway === 'home' ? c.competitors[0] : c.competitors[1];
    var away = home === c.competitors[0] ? c.competitors[1] : c.competitors[0];
    var st = ((e.status || c.status) && (e.status || c.status).type) || {};
    function logo(t) { return t.logo || (t.logos && t.logos[0] && t.logos[0].href) || ''; }
    function score(s) { return s && typeof s === 'object' ? s.displayValue : s; }
    return {
      id: e.id, league: name, code: league, time: Date.parse(e.date),
      home: home.team.shortDisplayName || home.team.displayName, away: away.team.shortDisplayName || away.team.displayName,
      // every name the team goes by, to find the match in the TV guide ("Man City" / "Manchester City")
      homeNames: [home.team.displayName, home.team.shortDisplayName, home.team.name, home.team.location],
      awayNames: [away.team.displayName, away.team.shortDisplayName, away.team.name, away.team.location],
      homeLogo: logo(home.team), awayLogo: logo(away.team),
      hs: score(home.score), as: score(away.score),
      state: st.state === 'in' ? 'live' : st.state === 'post' ? 'done' : 'pre',
      detail: st.shortDetail || ''
    };
  }

  /** One ESPN league: its current matchday (today's games, or the next matchday when there are none). */
  function espn(league, cb) {
    getJSON('https://site.api.espn.com/apis/site/v2/sports/soccer/' + league + '/scoreboard', function (err, d) {
      if (err || !d) return cb([]);
      var name = (d.leagues && d.leagues[0] && (d.leagues[0].abbreviation || d.leagues[0].name)) || league;
      var out = [], evs = d.events || [];
      for (var i = 0; i < evs.length; i++) { var m = espnEvent(evs[i], name, league); if (m) out.push(m); }
      cb(out);
    });
  }

  /** A team's upcoming fixtures in every competition (league scoreboards only show today). */
  function teamFixtures(id, cb) {
    getJSON('https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/' + id + '/schedule?fixture=true', function (err, d) {
      if (err || !d) return cb([]);
      var out = [], evs = d.events || [];
      for (var i = 0; i < evs.length; i++) {
        var lg = evs[i].league || {};
        var m = espnEvent(evs[i], lg.abbreviation || lg.name || '', lg.slug || '');
        if (m) { m.sched = true; out.push(m); }
      }
      cb(out);
    });
  }

  /** Egyptian Premier League (TheSportsDB free tier: next match and last result only). */
  function egypt(cb) {
    var base = 'https://www.thesportsdb.com/api/v1/json/123/';
    var out = [], pending = 2;
    function add(d, done) {
      var evs = (d && d.events) || [];
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i], when = Date.parse((e.strTimestamp || (e.dateEvent + 'T' + (e.strTime || '00:00:00'))) + (/[Z+]/.test(e.strTimestamp || '') ? '' : 'Z'));
        out.push({
          league: 'Egypt', code: 'egypt', time: when, home: e.strHomeTeam, away: e.strAwayTeam,
          homeNames: [e.strHomeTeam], awayNames: [e.strAwayTeam],
          homeLogo: e.strHomeTeamBadge || '', awayLogo: e.strAwayTeamBadge || '',
          hs: e.intHomeScore, as: e.intAwayScore, state: done ? 'done' : 'pre', detail: done ? 'FT' : ''
        });
      }
    }
    getJSON(base + 'eventsnextleague.php?id=4829', function (e, d) { if (!e) add(d, false); if (--pending === 0) cb(out); });
    getJSON(base + 'eventspastleague.php?id=4829', function (e, d) { if (!e) add(d, true); if (--pending === 0) cb(out); });
  }

  /**
   * All configured leagues; cb(list) sorted: live first, then upcoming by time, then recent results.
   * Upcoming covers the next week, results the last 36 h (Egypt: its last result).
   */
  function matches(cfg, cb) {
    // favLeagues (national teams): kept only when cfg.keep(match) says so (a favorite team plays).
    var leagues = cfg.leagues || [], favLeagues = cfg.favLeagues || [], teamIds = cfg.teamIds || [], all = [];
    var pending = leagues.length + favLeagues.length + teamIds.length + (cfg.egypt ? 1 : 0);
    if (!pending) return cb([]);
    function done(list) {
      all = all.concat(list);
      if (--pending) return;
      var now = Date.now();
      // Same match from a scoreboard and a team schedule: keep the scoreboard one (live score).
      var byId = {};
      all.forEach(function (m) { if (m.id && (!byId[m.id] || byId[m.id].sched)) byId[m.id] = m; });
      all = all.filter(function (m) { return !m.id || byId[m.id] === m; });
      all = all.filter(function (m) {
        if (m.favOnly && !(cfg.keep && cfg.keep(m))) return false;
        if (m.state === 'done') return now - m.time < 36 * 3600000 || m.league === 'Egypt';
        return m.state === 'live' || m.time - now < 8 * 86400000;
      });
      var rank = { live: 0, pre: 1, done: 2 };
      all.sort(function (a, b) {
        if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
        return a.state === 'done' ? b.time - a.time : a.time - b.time;
      });
      cb(all.slice(0, 24));
    }
    for (var i = 0; i < leagues.length; i++) espn(leagues[i], done);
    favLeagues.forEach(function (lg) {
      espn(lg, function (list) { list.forEach(function (m) { m.favOnly = true; }); done(list); });
    });
    teamIds.forEach(function (id) { teamFixtures(id, done); });
    if (cfg.egypt) egypt(done);
  }

  /* ---------- news (RSS) ---------- */

  function getText(url, cb) {
    var xhr = new XMLHttpRequest(), done = false;
    function finish(e, d) { if (!done) { done = true; cb(e, d); } }
    try { xhr.open('GET', url, true); xhr.timeout = 15000; } catch (e) { return finish(e.message); }
    xhr.onload = function () { if (xhr.status >= 200 && xhr.status < 300) finish(null, xhr.responseText); else finish('HTTP ' + xhr.status); };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    xhr.send();
  }

  /** Plain text from feed HTML. DOMParser runs no scripts and loads no images (unlike innerHTML). */
  function stripHtml(s) {
    try {
      var doc = new DOMParser().parseFromString(String(s || ''), 'text/html');
      return ((doc.body && doc.body.textContent) || '').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  function tagText(item, name) {
    var el = item.getElementsByTagName(name)[0];
    return el ? el.textContent : '';
  }

  /** cb(err, [{ title, source, time, image, text }]) newest first, at most `max`. */
  function news(url, max, cb) {
    getText(url, function (err, xml) {
      if (err) return cb(err);
      var doc;
      try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return cb('bad feed'); }
      var items = doc.getElementsByTagName('item'), out = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i], title = tagText(it, 'title').trim(), source = tagText(it, 'source').trim();
        // Google News titles end with " - Source"
        var m = /^(.*\S)\s+-\s+([^-]{2,60})$/.exec(title);
        if (m && (!source || m[2] === source)) { title = m[1]; source = source || m[2]; }
        var img = '', thumbs = it.getElementsByTagName('media:thumbnail');
        if (!thumbs.length) thumbs = it.getElementsByTagName('media:content');
        if (!thumbs.length) thumbs = it.getElementsByTagName('enclosure');
        if (thumbs.length) img = thumbs[0].getAttribute('url') || '';
        var text = stripHtml(tagText(it, 'description'));
        if (/^<|^https?:/.test(text) || text === title) text = '';
        out.push({ title: title, source: source, time: Date.parse(tagText(it, 'pubDate')) || 0, image: img, text: text });
      }
      out.sort(function (a, b) { return b.time - a.time; });
      cb(null, out.slice(0, max));
    });
  }

  /* ---------- prayer times (Aladhan) ---------- */

  /** cb(err, { date: 'YYYY-MM-DD', times: { Fajr: 'HH:MM', Sunrise, Dhuhr, Asr, Maghrib, Isha } }) for day `d`. */
  function prayer(loc, method, d, cb) {
    var ds = (d.getDate() < 10 ? '0' : '') + d.getDate() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + d.getFullYear();
    getJSON('https://api.aladhan.com/v1/timings/' + ds + '?latitude=' + loc.lat + '&longitude=' + loc.lon + '&method=' + method, function (err, j) {
      var t = j && j.data && j.data.timings;
      if (err || !t) return cb(err || 'no prayer times');
      var times = {};
      ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(function (k) { times[k] = String(t[k] || '').substring(0, 5); });
      cb(null, { day: d.toDateString(), times: times });
    });
  }

  /* ---------- exchange rates (open.er-api.com, updated daily) ---------- */

  /** cb(err, { CHF: 1, EGP: .., EUR: .., USD: .. }) = units per 1 CHF. */
  function rates(cb) {
    getJSON('https://open.er-api.com/v6/latest/CHF', function (err, j) {
      if (err || !j || !j.rates) return cb(err || 'no rates');
      cb(null, j.rates);
    });
  }

  /* ---------- league tables (ESPN) ---------- */

  /** cb(err, { name, rows: [{ rank, team, logo, gp, gd, pts }] }) */
  function standings(league, cb) {
    getJSON('https://site.api.espn.com/apis/v2/sports/soccer/' + league + '/standings', function (err, d) {
      var g = d && d.children && d.children[0], e = g && g.standings && g.standings.entries;
      if (err || !e) return cb(err || 'no table');
      var rows = e.map(function (x) {
        var st = {};
        (x.stats || []).forEach(function (s) { st[s.name] = s.displayValue; });
        var t = x.team || {};
        return {
          rank: parseInt(st.rank, 10) || 0, team: t.shortDisplayName || t.displayName || '', names: [t.displayName, t.shortDisplayName, t.name],
          logo: (t.logos && t.logos[0] && t.logos[0].href) || '', gp: st.gamesPlayed || '0', gd: st.pointDifferential || '0', pts: st.points || '0'
        };
      });
      rows.sort(function (a, b) { return a.rank - b.rank; });
      cb(null, { name: (d.abbreviation || d.name || league), rows: rows });
    });
  }

  /* ---------- match highlights (YouTube channel feeds, no key) ---------- */

  var HL_WORDS = /highlight|ملخص|zusammenfassung|resumen|sintesi/i;

  /** Highlight videos from the channels' latest uploads; cb([{ id, title, source, time, image }]) newest first. */
  function highlights(channels, cb) {
    var out = [], pending = channels.length;
    if (!pending) return cb([]);
    channels.forEach(function (ch) {
      getText('https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.id, function (err, xml) {
        if (!err) {
          try {
            var doc = new DOMParser().parseFromString(xml, 'text/xml'), es = doc.getElementsByTagName('entry');
            for (var i = 0; i < es.length; i++) {
              var id = tagText(es[i], 'yt:videoId'), title = tagText(es[i], 'title');
              if (id && HL_WORDS.test(title)) {
                out.push({ id: id, title: title, source: ch.name, time: Date.parse(tagText(es[i], 'published')) || 0, image: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' });
              }
            }
          } catch (e) {}
        }
        if (--pending === 0) {
          out.sort(function (a, b) { return b.time - a.time; });
          cb(out);
        }
      });
    });
  }

  /** cb(true) when the owner allows the video to play in other pages (else YouTube shows an error). */
  function embeddable(id, cb) {
    getText('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), function (err) { cb(!err); });
  }

  return {
    weather: weather, describe: describe, matches: matches, news: news,
    prayer: prayer, rates: rates, standings: standings, highlights: highlights, embeddable: embeddable
  };
})();
