/* Daily content: verse (alquran.cloud) and hadith (HadeethEnc, Arabic + German) of the day, Hijri occasion dates (Aladhan), screensaver photos (Bing, else Wikimedia). ES5. */
var Daily = (function () {
  'use strict';

  function getJSON(url, cb) {
    var xhr = new XMLHttpRequest(), done = false;
    function finish(e, d) { if (!done) { done = true; cb(e, d); } }
    xhr.open('GET', url, true);
    xhr.timeout = 20000;
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return finish('HTTP ' + xhr.status);
      try { finish(null, JSON.parse(xhr.responseText)); } catch (e) { finish('bad data'); }
    };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    try { xhr.send(); } catch (e) { finish('network error'); }
  }

  /** Days since 1970 in local time: the same number all day, a new one at midnight. */
  function dayNum() {
    var d = new Date();
    return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
  }

  /* ---------- verse of the day: well-known verses that read well on their own ---------- */

  var AYAT = ['2:152', '2:153', '2:186', '2:201', '2:255', '2:286', '3:8', '3:26', '3:139', '3:159', '3:173', '3:190',
    '4:110', '6:162', '7:23', '7:56', '9:51', '12:87', '13:11', '13:28', '14:7', '15:49', '16:97', '16:128', '17:80',
    '18:10', '20:114', '21:87', '21:89', '23:118', '25:74', '28:24', '29:69', '33:41', '33:56', '39:10', '39:53',
    '40:44', '40:60', '42:19', '47:7', '50:16', '51:56', '55:13', '59:22', '64:11', '65:3', '67:2', '87:14', '93:5',
    '94:5', '94:6', '112:1'];

  /** cb(err, { ar, tr, ref, refAr }) for today. `edition` = translation id (en.sahih, de.bubenheim) or ''. */
  function ayah(edition, cb) {
    var key = dayNum() + '|' + (edition || ''), saved = Store.lsGet('dailyAyah');
    if (saved && saved.key === key) return cb(null, saved.v);
    var ref = AYAT[dayNum() % AYAT.length];
    getJSON('https://api.alquran.cloud/v1/ayah/' + ref + '/editions/quran-uthmani' + (edition ? ',' + edition : ''), function (err, j) {
      var d = j && j.data;
      if (err || !d || !d[0]) return cb(err || 'no verse');
      var v = {
        ar: d[0].text, tr: d[1] ? d[1].text : '',
        ref: d[0].surah.englishName + ' ' + ref, refAr: d[0].surah.name + ' · ' + d[0].numberInSurah
      };
      Store.lsSet('dailyAyah', { key: key, v: v });
      cb(null, v);
    });
  }

  /** The Prophet's words: the quoted part of the narration. A dialogue (several quotes) stays whole. */
  function matn(t) {
    // the narration ends where the source note starts ("رواه …" / "حديث حسن …"); quotes after it are book names
    var H = '[ً-ْ]*', end = new RegExp('ر' + H + 'و' + H + 'ا' + H + 'ه|ح' + H + 'د' + H + 'ي' + H + 'ث' + H + '\\s+(ح' + H + 'س|ص' + H + 'ح)').exec(t);
    var body = end ? t.substring(0, end.index) : t;
    var all = body.match(/[“"«][^”"»]{3,}[”"»]/g) || [];
    if (all.length !== 1) {
      // no single quote: drop the chain of narrators, up to the first "قال:"
      var said = new RegExp('ق' + H + 'ا' + H + 'ل' + H + '\\s*:').exec(body);
      if (said && said.index < 250) body = body.substring(said.index + said[0].length);
      return body.replace(/^[\s"“«]+|[\s.]+$/g, '');
    }
    return all[0].slice(1, -1).replace(/^\s+|\s+$/g, '');
  }

  /* ---------- hadith of the day: HadeethEnc.com, "good character" hadiths, Arabic + German ---------- */

  var HE = 'https://hadeethenc.com/api/v1/hadeeths/';

  /** Ids of the hadiths in the "Guter Charakter und Benehmen" category (258), kept for 30 days. */
  function hadithIds(cb) {
    var saved = Store.lsGet('hadithIds');
    if (saved && saved.ids && saved.ids.length && Date.now() - saved.at < 30 * 86400000) return cb(null, saved.ids);
    getJSON(HE + 'list/?language=de&category_id=5&page=1&per_page=400', function (err, j) {
      var ids = j && j.data ? j.data.map(function (x) { return x.id; }) : [];
      if (!ids.length) return cb(err || 'no hadiths', saved && saved.ids || []);
      Store.lsSet('hadithIds', { at: Date.now(), ids: ids });
      cb(null, ids);
    });
  }

  /** cb(err, { ar, short, de, deShort, expl, src, srcAr }) for today. */
  function hadith(cb) {
    var key = String(dayNum()), saved = Store.lsGet('dailyHadith');
    if (saved && saved.key === key && saved.v.de != null) return cb(null, saved.v);
    hadithIds(function (err, ids) {
      if (!ids.length) return cb(err || 'no hadith');
      getJSON(HE + 'one/?language=de&id=' + ids[dayNum() % ids.length], function (e, h) {
        if (e || !h || !h.hadeeth_ar) return cb(e || 'no hadith');
        var ar = h.hadeeth_ar, intro = h.hadeeth_intro_ar || '';
        // the Prophet's words: the Arabic text after "عن … قال:"
        var short = intro && ar.indexOf(intro) === 0 ? ar.substring(intro.length) : matn(ar);
        var v = {
          ar: ar, short: short.replace(/^[\s«"“]+|[\s»"”.]+$/g, ''),
          de: h.hadeeth || '', deShort: String(h.title || '').replace(/^[\s„"“]+|[\s“"”.]+$/g, ''),
          expl: h.explanation || '',
          src: [h.attribution, h.grade].filter(function (x) { return x; }).join(' · '),
          srcAr: [h.attribution_ar, h.grade_ar].filter(function (x) { return x; }).join(' · ')
        };
        Store.lsSet('dailyHadith', { key: key, v: v });
        cb(null, v);
      });
    });
  }

  /* ---------- Hijri calendar: Gregorian day of a Hijri date (cached for good) ---------- */

  /** cb(err, ms at local noon of that day) for Hijri day hd of month hm, year hy. */
  function gregorian(hd, hm, hy, cb) {
    var map = Store.lsGet('hijriG') || {}, k = hd + '-' + hm + '-' + hy;
    if (map[k]) return cb(null, map[k]);
    getJSON('https://api.aladhan.com/v1/hToG/' + (hd < 10 ? '0' : '') + hd + '-' + (hm < 10 ? '0' : '') + hm + '-' + hy, function (err, j) {
      var g = j && j.data && j.data.gregorian;
      if (err || !g || !g.date) return cb(err || 'no date');
      var p = g.date.split('-');                               // DD-MM-YYYY
      var t = new Date(+p[2], +p[1] - 1, +p[0], 12, 0, 0).getTime();
      map = Store.lsGet('hijriG') || {};
      map[k] = t;
      Store.lsSet('hijriG', map);
      cb(null, t);
    });
  }

  /* ---------- screensaver photos ---------- */

  function bing(cb) {
    var out = [], pending = 2;
    [0, 8].forEach(function (idx) {
      getJSON('https://www.bing.com/HPImageArchive.aspx?format=js&n=8&mkt=en-US&idx=' + idx, function (err, j) {
        if (!err && j && j.images) j.images.forEach(function (im) {
          if (im.urlbase) out.push({ u: 'https://www.bing.com' + im.urlbase + '_1920x1080.jpg', c: String(im.copyright || '') });
        });
        if (--pending === 0) cb(out);
      });
    });
  }
  function commons(cb) {
    getJSON('https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers' +
      '&gcmtitle=Category:Featured_pictures_of_landscapes&gcmtype=file&gcmlimit=60&prop=imageinfo' +
      '&iiprop=url|size&iiurlwidth=1920&format=json&origin=*', function (err, j) {
      var out = [], pages = j && j.query && j.query.pages;
      if (pages) Object.keys(pages).forEach(function (id) {
        var p = pages[id], ii = p.imageinfo && p.imageinfo[0];
        if (ii && ii.thumburl && ii.width > ii.height * 1.3) {
          out.push({ u: ii.thumburl, c: String(p.title || '').replace(/^File:/, '').replace(/\.\w+$/, '').replace(/_/g, ' ') + ' · Wikimedia Commons' });
        }
      });
      cb(out);
    });
  }
  /** cb(list of { u: image url, c: credit }), shuffled. Kept for a day. */
  function photos(cb) {
    var saved = Store.lsGet('saverPics');
    function shuffle(a) {
      a = a.slice();
      for (var i = a.length - 1; i > 0; i--) { var r = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[r]; a[r] = t; }
      return a;
    }
    if (saved && saved.list && saved.list.length && Date.now() - saved.at < 24 * 3600000) return cb(shuffle(saved.list));
    bing(function (list) {
      function done(l) {
        if (l.length) Store.lsSet('saverPics', { at: Date.now(), list: l });
        cb(shuffle(l.length ? l : (saved && saved.list) || []));
      }
      if (list.length >= 8) return done(list);
      commons(function (l2) { done(list.concat(l2)); });
    });
  }

  return { ayah: ayah, hadith: hadith, gregorian: gregorian, photos: photos, dayNum: dayNum };
})();
