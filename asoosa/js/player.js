/* Playback: Samsung AVPlay on the TV, HTML5 <video> fallback for desktop testing. ES5. */
var Player = (function () {
  'use strict';

  var av = null;
  var video = null;
  var token = 0;          // increments on every play(); stale async callbacks are ignored
  var paused = false;
  var onStatus = function () {};
  var bufferSeconds = 0;
  var startedAt = 0;

  function emit(type, data) { onStatus(type, data); }

  // Android app: Media3 player under the page (android/…/MainActivity.java), events by token.
  var droid = window.AndroidPlayer || null, droidTracksSent = -1, droidLive = false;

  function init(statusCb) {
    onStatus = statusCb || onStatus;
    if (droid) {
      document.getElementById('av-player').style.display = 'none';
      document.getElementById('html5-player').style.display = 'none';
      window.__avEvent = function (tok, type, data) {
        if (tok !== token) return;
        if (type === 'playing') {
          emit('playing');
          if (!droidLive && droidTracksSent !== tok) { droidTracksSent = tok; emit('tracks'); }
        } else if (type === 'buffering') emit('buffering', 0);
        else if (type === 'ended') emit('ended');
        else if (type === 'error') emit('error', data || 'stream error');
        else if (type === 'subtitle') emit('subtitle', data);
      };
      return;
    }
    try { if (window.webapis && window.webapis.avplay) av = window.webapis.avplay; } catch (e) { av = null; }
    if (!av) {
      video = document.getElementById('html5-player');
      video.style.display = 'block';
      document.getElementById('av-player').style.display = 'none';
      video.addEventListener('playing', function () { emit('playing'); });
      video.addEventListener('waiting', function () { emit('buffering', 0); });
      video.addEventListener('ended', function () { emit('ended'); });
      video.addEventListener('error', function () { emit('error', 'cannot play this stream in the browser'); });
    }
  }

  function setBuffering(sec) { bufferSeconds = sec || 0; }

  function closeAV() {
    try {
      var st = av.getState();
      if (st === 'PLAYING' || st === 'PAUSED') av.stop();
      if (st !== 'NONE') av.close();
    } catch (e) {
      try { av.close(); } catch (e2) {}
    }
  }

  function errText(step, e) {
    var n = e && (e.name || e.message) ? (e.name || '') + (e.message && e.message !== e.name ? ' ' + e.message : '') : String(e);
    return n + ' (' + step + ')';
  }

  function playAV(url, my, opts) {
    closeAV();
    var step = 'open';
    try {
      av.open(url);
      step = 'setup';
      av.setListener({
        onbufferingstart: function () { if (my === token) emit('buffering', 0); },
        onbufferingprogress: function (p) { if (my === token) emit('buffering', p); },
        onbufferingcomplete: function () { if (my === token) emit('playing'); },
        onstreamcompleted: function () {
          if (my !== token) return;
          if (!opts.live) return emit('ended');
          // Live streams sometimes "end" on a hiccup: reopen, but never in a tight loop.
          if (Date.now() - startedAt > 10000) play(url, opts);
          else emit('error', 'stream ended');
        },
        onerror: function (err) { if (my === token) emit('error', err); },
        // AVPlay decodes embedded subtitles but leaves drawing them to the app.
        onsubtitlechange: function (duration, text) { if (my === token) emit('subtitle', { text: text, ms: parseInt(duration, 10) || 3000 }); },
        onevent: function () {}
      });
      av.setDisplayRect(0, 0, 1920, 1080);
      try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
      if (bufferSeconds > 0) {
        try {
          av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', bufferSeconds);
          av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', bufferSeconds);
        } catch (e) {}
      }
      step = 'prepare';
      av.prepareAsync(function () {
        if (my !== token) return;
        try { av.play(); } catch (e) { return failed('play', e); }
        if (opts.startMs > 0) { try { av.seekTo(opts.startMs); } catch (e) {} }
        // The app's own handlers run outside the player's try, so their mistakes never look like a player error.
        try { emit('playing'); if (!opts.live) emit('tracks'); } catch (e) { if (window.console) console.log('player handler: ' + e); }
      }, function (err) {
        if (my === token) failed('prepare', err);
      });
    } catch (e) {
      failed(step, e);
    }

    /**
     * InvalidStateError / InvalidAccessError mean the TV's player was still busy with the last
     * stream: close it fully, wait a moment and try once more before reporting the error.
     */
    function failed(at, e) {
      if (my !== token) return;
      var name = (e && e.name) || '';
      if (!opts.retried && /InvalidAccess|InvalidState/i.test(name + ' ' + (e && e.message))) {
        opts.retried = true;
        try { av.stop(); } catch (x) {}
        try { av.close(); } catch (x2) {}
        setTimeout(function () { if (my === token) playAV(url, my, opts); }, 1200);
        return;
      }
      emit('error', errText(at, e));
    }
  }

  /** opts: { live: bool, startMs: number } */
  function play(url, opts) {
    opts = opts || {};
    var my = ++token;
    startedAt = Date.now();
    paused = false;
    emit('buffering', 0);
    if (droid) { droidLive = !!opts.live; droid.play(url, !!opts.live, opts.startMs || 0, my, opts.title || '', opts.sub || '', opts.art || ''); return; }
    if (av) return playAV(url, my, opts);
    video.src = url;
    if (opts.startMs > 0) {
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        try { video.currentTime = opts.startMs / 1000; } catch (e) {}
      });
    }
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  function stop() {
    token++;
    if (droid) return droid.stop(token);
    if (av) closeAV();
    else if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  }

  function togglePause() {
    if (droid) { paused = droid.togglePause(); return paused; }
    try {
      if (av) {
        var st = av.getState();
        if (st === 'PLAYING') { av.pause(); paused = true; }
        else if (st === 'PAUSED') { av.play(); paused = false; }
      } else if (video) {
        if (video.paused) { video.play(); paused = false; } else { video.pause(); paused = true; }
      }
    } catch (e) {}
    return paused;
  }

  /** Current position and duration in ms (0 when unknown). */
  function time() {
    if (droid) return droid.time() || 0;
    try {
      if (av) return av.getCurrentTime() || 0;
      if (video) return Math.round((video.currentTime || 0) * 1000);
    } catch (e) {}
    return 0;
  }
  function duration() {
    if (droid) return droid.duration() || 0;
    try {
      if (av) return av.getDuration() || 0;
      if (video && isFinite(video.duration)) return Math.round(video.duration * 1000);
    } catch (e) {}
    return 0;
  }

  function seekTo(ms) {
    var d = duration();
    ms = Math.max(0, d ? Math.min(ms, d - 3000) : ms);
    if (droid) return droid.seekTo(ms);
    try {
      if (av) av.seekTo(ms, function () {}, function () {});
      else if (video) video.currentTime = ms / 1000;
    } catch (e) {}
  }

  /** Embedded subtitle tracks: [{ index, lang }] (lang as the file states it, e.g. "ara", "ger", "eng"). */
  function droidTracks(type) { try { return JSON.parse(droid.tracks(type)) || []; } catch (e) { return []; } }

  function textTracks() {
    var out = [];
    if (droid) return droidTracks('TEXT');
    if (!av) return out;
    try {
      var all = av.getTotalTrackInfo() || [];
      for (var i = 0; i < all.length; i++) {
        var t = all[i];
        if (t.type !== 'TEXT') continue;
        // extra_info is a JSON string on most TVs but an object on some; the key name varies too.
        var ex = t.extra_info, raw = '', lang = '';
        if (typeof ex === 'string') {
          raw = ex;
          try { ex = JSON.parse(ex); } catch (e) { ex = null; }
        } else {
          try { raw = JSON.stringify(ex); } catch (e) { raw = String(ex); }
        }
        if (ex && typeof ex === 'object') {
          lang = ex.track_lang || ex.language || ex.lang || ex.track_language || ex.trackLang || '';
        }
        if (!lang) {
          var m = /(?:track_lang|language|lang)"?\s*[:=]\s*"?([A-Za-z-]{2,12})/.exec(raw);
          if (m) lang = m[1];
        }
        out.push({ index: t.index, lang: String(lang) });
      }
    } catch (e) {}
    return out;
  }

  /** The TV player's state (NONE / IDLE / READY / PLAYING / PAUSED), for messages. */
  function state() { if (droid) return droid.state(); try { return av ? av.getState() : (video && !video.paused ? 'PLAYING' : 'IDLE'); } catch (e) { return '?'; } }

  /** Audio tracks: [{ index, lang }] (the TV often leaves lang empty; the app reads it from the file). */
  function audioTracks() {
    var out = [];
    if (droid) return droidTracks('AUDIO');
    if (!av) return out;
    try {
      var all = av.getTotalTrackInfo() || [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].type !== 'AUDIO') continue;
        var ex = all[i].extra_info, lang = '';
        if (typeof ex === 'string') { try { ex = JSON.parse(ex); } catch (e) { ex = null; } }
        if (ex && typeof ex === 'object') lang = ex.language || ex.track_lang || ex.lang || '';
        out.push({ index: all[i].index, lang: String(lang) });
      }
    } catch (e) {}
    return out;
  }
  function selectAudio(index) {
    if (droid) { droid.selectTrack('AUDIO', index); return true; }
    if (!av) return false;
    try { av.setSelectTrack('AUDIO', index); return true; } catch (e) { return false; }
  }

  /** Shift the TV's own subtitle timing (ms, negative = earlier). Returns false if not supported. */
  function setTextOffset(ms) {
    if (droid) return false;
    if (!av || !av.setSubtitlePosition) return false;
    try { av.setSubtitlePosition(ms); return true; } catch (e) { return false; }
  }

  /** Show subtitle track `index`, or hide subtitles with -1. */
  function selectText(index) {
    if (droid) return droid.selectTrack('TEXT', index);
    if (!av) return;
    try {
      if (index < 0) { av.setSilentSubtitle(true); return; }
      av.setSilentSubtitle(false);
      av.setSelectTrack('TEXT', index);
    } catch (e) {}
  }

  /** Speeds this player can do: the TV's player only knows whole numbers (1x, 2x), a browser any rate. */
  function speeds() { return av && !droid ? [1, 2] : [1, 1.25, 1.5, 2]; }

  /** Playback speed; returns false when the TV refuses (some files only play at 1x). */
  function setSpeed(rate) {
    if (droid) { droid.setSpeed(rate); return true; }
    try {
      if (av) { av.setSpeed(rate); return true; }
      if (video) { video.playbackRate = rate; return true; }
    } catch (e) {}
    return false;
  }

  // App sent to background / brought back (multitasking)
  function suspend() { if (droid) return droid.pauseIfVideo(); if (av) { try { av.suspend(); } catch (e) {} } }
  function restore() { if (av) { try { av.restore(); } catch (e) {} } }

  return {
    init: init, play: play, stop: stop, togglePause: togglePause,
    time: time, duration: duration, seekTo: seekTo, textTracks: textTracks, selectText: selectText, setTextOffset: setTextOffset,
    suspend: suspend, restore: restore, setBuffering: setBuffering, speeds: speeds, setSpeed: setSpeed,
    audioTracks: audioTracks, selectAudio: selectAudio, state: state
  };
})();
