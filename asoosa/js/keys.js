/* Remote control key registration and key-code -> name mapping. ES5. */
var Keys = (function () {
  'use strict';

  // Defaults for Samsung TV remotes; refreshed from tvinputdevice when available.
  var codes = {
    37: 'LEFT', 38: 'UP', 39: 'RIGHT', 40: 'DOWN', 13: 'ENTER',
    10009: 'BACK', 427: 'CH_UP', 428: 'CH_DOWN',
    403: 'RED', 404: 'GREEN', 405: 'YELLOW', 406: 'BLUE',
    457: 'INFO', 10073: 'CH_LIST', 10190: 'PREV_CH',
    10252: 'PLAYPAUSE', 415: 'PLAY', 19: 'PAUSE', 413: 'STOP',
    416: 'RECORD', 417: 'FF', 412: 'RW',
    65376: 'DONE', 65385: 'CANCEL',
    // Desktop keyboard (for testing in a browser)
    27: 'BACK', 8: 'BKSP', 33: 'CH_UP', 34: 'CH_DOWN', 73: 'INFO'
  };
  for (var d = 0; d <= 9; d++) { codes[48 + d] = 'D' + d; codes[96 + d] = 'D' + d; }

  var tizenNames = {
    ChannelUp: 'CH_UP', ChannelDown: 'CH_DOWN',
    ColorF0Red: 'RED', ColorF1Green: 'GREEN', ColorF2Yellow: 'YELLOW', ColorF3Blue: 'BLUE',
    Info: 'INFO', ChannelList: 'CH_LIST', PreviousChannel: 'PREV_CH',
    MediaPlayPause: 'PLAYPAUSE', MediaPlay: 'PLAY', MediaPause: 'PAUSE', MediaStop: 'STOP',
    MediaRecord: 'RECORD', MediaFastForward: 'FF', MediaRewind: 'RW',
    '0': 'D0', '1': 'D1', '2': 'D2', '3': 'D3', '4': 'D4',
    '5': 'D5', '6': 'D6', '7': 'D7', '8': 'D8', '9': 'D9'
  };

  var onTV = !!(window.tizen && window.tizen.tvinputdevice);

  function register() {
    if (!onTV) {
      // Browser testing: r/g/y/b letters act as color keys.
      codes[82] = 'RED'; codes[71] = 'GREEN'; codes[89] = 'YELLOW'; codes[66] = 'BLUE'; codes[75] = 'RECORD';
      return;
    }
    var tv = window.tizen.tvinputdevice;
    var names = [];
    for (var n in tizenNames) if (tizenNames.hasOwnProperty(n)) names.push(n);

    var supported = {};
    try {
      var list = tv.getSupportedKeys();
      for (var i = 0; i < list.length; i++) supported[list[i].name] = list[i].code;
    } catch (e) {}

    var toRegister = [];
    for (var j = 0; j < names.length; j++) {
      if (supported[names[j]] !== undefined) {
        codes[supported[names[j]]] = tizenNames[names[j]];
        toRegister.push(names[j]);
      }
    }
    if (!toRegister.length) toRegister = names;

    if (tv.registerKeyBatch) {
      try { tv.registerKeyBatch(toRegister); return; } catch (e) {}
    }
    for (var k = 0; k < toRegister.length; k++) {
      try { tv.registerKey(toRegister[k]); } catch (e) {}
    }
  }

  function name(e) {
    return codes[e.keyCode] || null;
  }

  return { register: register, name: name, onTV: onTV };
})();
