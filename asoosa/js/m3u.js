/* M3U / M3U8 playlist parser. Works in the page and inside a Web Worker. ES5 only. */
(function (root) {
  'use strict';

  var ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

  function parseExtinf(line) {
    // "#EXTINF:-1 tvg-id="x" tvg-logo="y" group-title="z",Channel Name"
    // The name starts after the first comma that is not inside quotes.
    var inQ = false, comma = -1, i, ch;
    for (i = 8; i < line.length; i++) {
      ch = line.charCodeAt(i);
      if (ch === 34) inQ = !inQ;
      else if (ch === 44 && !inQ) { comma = i; break; }
    }
    var attrs = comma === -1 ? line : line.substring(0, comma);
    var name = comma === -1 ? '' : line.substring(comma + 1).trim();
    var info = { name: name, logo: '', group: '', id: '' };
    var m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(attrs)) !== null) {
      var k = m[1].toLowerCase();
      if (k === 'tvg-logo') info.logo = m[2];
      else if (k === 'group-title') info.group = m[2].trim();
      else if (k === 'tvg-id') info.id = m[2];
      else if (k === 'tvg-name' && !info.name) info.name = m[2].trim();
    }
    return info;
  }

  /**
   * Returns { groups: [name, ...], channels: [{ n: name, u: url, g: groupIndex, l: logo }] }
   * Groups keep the order of first appearance in the playlist.
   */
  function parse(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    var lines = text.split(/\r?\n/);
    var channels = [], groups = [], gIndex = {};
    var cur = null, extgrp = '';

    for (var i = 0, len = lines.length; i < len; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charCodeAt(0) === 35 /* # */) {
        if (line.lastIndexOf('#EXTINF', 0) === 0) cur = parseExtinf(line);
        else if (line.lastIndexOf('#EXTGRP:', 0) === 0) extgrp = line.substring(8).trim();
        continue;
      }
      line = line.trim();
      if (!line || line.charCodeAt(0) === 35) continue;

      var gname = (cur && cur.group) || extgrp || 'Other';
      var gi = gIndex[gname];
      if (gi === undefined) { gi = groups.length; gIndex[gname] = gi; groups.push(gname); }

      channels.push({
        n: (cur && cur.name) || line,
        u: line,
        g: gi,
        l: (cur && cur.logo) || ''
      });
      cur = null;
      extgrp = '';
    }
    return { groups: groups, channels: channels };
  }

  root.M3U = { parse: parse };
})(typeof self !== 'undefined' ? self : this);
