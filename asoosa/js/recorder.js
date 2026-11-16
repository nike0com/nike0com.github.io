/*
 * Records a stream to a USB drive: fetch() streams the bytes, tizen.filesystem writes them.
 * Needs a Tizen 5.0+ TV (2019 or newer). Live channels are saved as .ts, movies/episodes keep their format.
 * Note: recording opens its own connection to the provider, separate from playback.
 */
var Recorder = (function () {
  'use strict';

  var FLUSH_BYTES = 1024 * 1024;
  var folder = 'IPTV Recordings';
  var active = null;
  var onChange = function () {};

  function fs() { return window.tizen && window.tizen.filesystem; }

  function supported() {
    var f = fs();
    return !!(f && f.openFile && f.listStorages && window.fetch && window.ReadableStream);
  }

  function setFolder(name) { if (name) folder = String(name); }
  function setListener(fn) { onChange = fn || onChange; }

  function findUsb(cb) {
    if (!supported()) return cb('Recording needs a 2019 or newer Samsung TV');
    try {
      fs().listStorages(function (list) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].type === 'EXTERNAL' && list[i].state === 'MOUNTED') return cb(null, list[i].label);
        }
        cb('No USB drive found. Plug a USB drive into the TV.');
      }, function (e) { cb(e.message); });
    } catch (e) { cb(e.message); }
  }

  function sanitize(name) {
    return String(name).replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80) || 'recording';
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes());
  }

  function flush(rec, done) {
    if (!rec.queued) { if (done) done(); return; }
    var buf = new Uint8Array(rec.queued), off = 0;
    for (var i = 0; i < rec.queue.length; i++) { buf.set(rec.queue[i], off); off += rec.queue[i].length; }
    rec.queue = []; rec.queued = 0;
    try {
      rec.handle.writeDataNonBlocking(buf, function () { if (done) done(); },
        function (e) { rec.error = e.message; if (done) done(); });
    } catch (e) {
      try { rec.handle.writeData(buf); } catch (e2) { rec.error = e2.message; }
      if (done) done();
    }
  }

  function finish(rec, err) {
    if (rec.finished) return;
    rec.finished = true;
    if (rec.reader) { try { rec.reader.cancel(); } catch (e) {} }
    flush(rec, function () {
      // Don't leave empty files behind when the stream never delivered data.
      function cleanup() { if (!rec.bytes) { try { fs().deleteFile(rec.file, function () {}, function () {}); } catch (e) {} } }
      try { rec.handle.closeNonBlocking(cleanup, cleanup); }
      catch (e) { try { rec.handle.close(); } catch (e2) {} cleanup(); }
    });
    if (active === rec) active = null;
    onChange(rec, err || rec.error || null);
  }

  function pump(rec) {
    rec.reader.read().then(function (r) {
      if (rec.finished) return;
      if (r.done) return finish(rec, null);
      rec.queue.push(r.value);
      rec.queued += r.value.length;
      rec.bytes += r.value.length;
      if (rec.queued >= FLUSH_BYTES) flush(rec);
      if (rec.error) return finish(rec, rec.error);
      pump(rec);
    }, function (e) { finish(rec, e && e.message || 'stream error'); });
  }

  /** cb(err, rec) fires once the file is open and recording has started. */
  function start(url, title, ext, cb) {
    if (active) return cb('Already recording ' + active.title);
    findUsb(function (err, root) {
      if (err) return cb(err);
      var dir = root + '/' + folder;
      var file = dir + '/' + sanitize(title) + ' ' + stamp() + '.' + (ext || 'ts');
      function open() {
        var handle;
        try { handle = fs().openFile(file, 'w'); } catch (e) { return cb('Cannot write to the USB drive: ' + e.message); }
        var rec = { title: title, file: file, bytes: 0, started: Date.now(), handle: handle, queue: [], queued: 0 };
        active = rec;
        cb(null, rec);
        onChange(rec, null);
        window.fetch(url).then(function (res) {
          if (!res.ok) throw new Error('server answered HTTP ' + res.status);
          if (rec.finished) return;
          rec.reader = res.body.getReader();
          pump(rec);
        }).catch(function (e) { finish(rec, e && e.message || 'connection failed'); });
      }
      try { fs().createDirectory(dir, true, open, open); } catch (e) { open(); }
    });
  }

  function stop() { if (active) finish(active, null); }

  function current() { return active; }

  /** Recordings on the first USB drive, newest first: [{ n, path }] */
  function list(cb) {
    findUsb(function (err, root) {
      if (err) return cb(err);
      var dir = root + '/' + folder;
      try {
        fs().listDirectory(dir, function (names) {
          var out = [];
          for (var i = 0; i < names.length; i++) {
            if (/\.(ts|mp4|mkv|avi|m4v|mov)$/i.test(names[i])) out.push({ n: names[i], path: dir + '/' + names[i] });
          }
          out.sort(function (a, b) { return a.n < b.n ? 1 : a.n > b.n ? -1 : 0; });
          cb(null, out);
        }, function () { cb(null, []); });
      } catch (e) { cb(null, []); }
    });
  }

  function remove(path, cb) {
    try { fs().deleteFile(path, function () { cb(null); }, function (e) { cb(e.message); }); }
    catch (e) { cb(e.message); }
  }

  function uri(path) {
    try { return fs().toURI(path); } catch (e) { return path; }
  }

  /** Writes text to <USB>/<folder>/<name>. cb(err, path) */
  function writeUsbFile(folderName, name, text, cb) {
    findUsb(function (err, root) {
      if (err) return cb(err);
      var dir = root + '/' + folderName, path = dir + '/' + name;
      function write() {
        try {
          var h = fs().openFile(path, 'w');
          h.writeString(text);
          h.close();
          cb(null, path);
        } catch (e) { cb('cannot write to the USB drive: ' + e.message); }
      }
      try { fs().createDirectory(dir, true, write, write); } catch (e) { write(); }
    });
  }

  /** Reads <USB>/<folder>/<name> as text. cb(err, text) */
  function readUsbFile(folderName, name, cb) {
    findUsb(function (err, root) {
      if (err) return cb(err);
      try {
        var h = fs().openFile(root + '/' + folderName + '/' + name, 'r');
        var text = h.readString();
        h.close();
        cb(null, text);
      } catch (e) { cb('no backup found on the USB drive'); }
    });
  }

  return {
    writeUsbFile: writeUsbFile, readUsbFile: readUsbFile,
    supported: supported, setFolder: setFolder, setListener: setListener,
    start: start, stop: stop, current: current, list: list, remove: remove, uri: uri
  };
})();
