/*
 * Live cams of the world (YouTube live streams that allow playback outside YouTube). ES5.
 * v = the live video, c = its channel: if the video ends (streams restart with a new id),
 * the player page falls back to whatever the channel is streaming live now.
 * Checked 2026-11-20: live and embeddable.
 */
var Cams = (function () {
  'use strict';

  var LIST = [
    // Makkah & Madinah
    { cat: 'Makkah', n: 'Makkah · المسجد الحرام', v: 'set2h7QcqPg', c: 'UCfBw_uwZb_oFLyVsjWk6owQ' },
    { cat: 'Madinah', n: 'Madinah · المسجد النبوي', v: 'nCpee4ZZGo8', c: 'UCWainKMJPyXikjekccFf3NA' },
    // Switzerland
    { cat: 'Swiss', n: 'Swiss Alps panorama', v: 'enYFXf8u7Lc', c: 'UC9xLSF0SZDbVa70iTpghQBw' },
    { cat: 'Swiss', n: 'Switzerland weather panorama', v: '8eQOB7BPzvE', c: 'UCgL2EJAYMsU9ifTuiZ9wUFA' },
    { cat: 'Swiss', n: 'Lucerne', v: 'QIt1FaDMnQc', c: 'UCPXrtNyzerjndFhzPyJD7vA' },
    { cat: 'Swiss', n: 'Geneva · Lake Geneva', v: '3HsL6AA6rPM', c: 'UCfkbmwi67lrETUqnOmf-Hqw' },
    { cat: 'Swiss', n: 'Grimentz · Valais', v: 'iCxfe27HpaY', c: 'UC4BM1oZhL6hnMp13bws6-sg' },
    // Cities
    { cat: 'City', n: 'New York · Times Square', v: 'ZxCeWQ3Lcig', c: 'UC6qrG3W8SMK0jior2olka3g' },
    { cat: 'City', n: 'Tokyo · Shibuya Crossing', v: 'dfVK7ld38Ys', c: 'UCoQBJMzcwmXrRSHBFAlTsIw' },
    { cat: 'City', n: 'London · Abbey Road', v: 'zMCea32gpmg', c: 'UC6qrG3W8SMK0jior2olka3g' },
    { cat: 'City', n: 'London · Notting Hill', v: 'Qno7wrid-uw', c: 'UC4-aIBtpNAPqEcMhAyFN6iQ' },
    { cat: 'City', n: 'Venice · Grand Canal', v: 'r8N6IsoIkTk', c: 'UCMpn1qLudF-zb4M4bqxLIbw' },
    { cat: 'City', n: 'Istanbul · Bosphorus', v: 'xKaWhDoufbk', c: 'UCrRYP4a33Fvvd9j6TLtzj_Q' },
    { cat: 'City', n: 'Dublin', v: '3nyPER2kzqk', c: 'UC6qrG3W8SMK0jior2olka3g' },
    { cat: 'City', n: 'The World Live · cities worldwide', v: 'HfgIFGbdGJ0', c: 'UCRuyAVeVd7oUwh0LWmxxBBQ' },
    // Nature
    { cat: 'Nature', n: 'Wild Africa · safari 24/7', v: 'qpukdDslCjk', c: 'UCuoNAKa3P0QR1Lw9QdpmoVg' },
    { cat: 'Nature', n: 'Kenya · ol Donyo waterhole', v: 'XsOU8JnEpNM', c: 'UCuoNAKa3P0QR1Lw9QdpmoVg' },
    { cat: 'Nature', n: 'Namib desert waterhole', v: 'ydYDqZQpim8', c: 'UC9X6gGKDv2yhMoofoeS7-Gg' },
    { cat: 'Nature', n: 'Namibia · Safarihoek', v: 'qwvk5hbEJnY', c: 'UCuoNAKa3P0QR1Lw9QdpmoVg' },
    { cat: 'Nature', n: 'Tropical reef', v: 'DHUnz4dyb54', c: 'UC-2KSeUU5SMCX6XLRD-AEvw' },
    { cat: 'Nature', n: 'Shark cam · Monterey Bay Aquarium', v: 'tEtg5Kg3voQ', c: 'UCnM5iMGiKsZg-iOlIO2ZkdQ' },
    // Space
    { cat: 'Space', n: 'Earth from space · 4K', v: 'fO9e9jnhYK8', c: 'UCkvW_7kp9LJrztmgA4q4bJQ' },
    { cat: 'Space', n: 'Earth from the ISS', v: 'tj4knR4r1UU', c: 'UCaG0IHN1RMOZ4-U3wDXAkwA' }
  ];
  LIST.forEach(function (x) { x.id = 'cam:' + x.v; x.l = 'https://i.ytimg.com/vi/' + x.v + '/mqdefault.jpg'; });

  return { list: LIST };
})();
