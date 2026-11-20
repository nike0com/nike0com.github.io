/*
 * Live cams: ad-free direct streams only (no YouTube, so no ads), played by the normal player.
 * They are public broadcaster streams, so they don't use the IPTV subscription's single connection.
 * Shown on the TV only (the phone app hides them). Checked 2026-11-20. ES5.
 */
var Cams = (function () {
  'use strict';

  var LIST = [
    { cat: 'Makkah', n: 'Makkah · المسجد الحرام', sub: 'Saudi Quran TV · live from the Haram', u: 'https://win.holol.com/live/quran/playlist.m3u8' },
    { cat: 'Madinah', n: 'Madinah · المسجد النبوي', sub: 'Saudi Sunnah TV · live from the Prophet\'s Mosque', u: 'https://win.holol.com/live/sunnah/playlist.m3u8' },
    { cat: 'Space', n: 'NASA TV · Space & ISS', sub: 'NASA live', u: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8' }
  ];
  LIST.forEach(function (x, i) { x.id = 'cam:' + i; x.l = ''; });

  return { list: LIST };
})();
