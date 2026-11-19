// Vipps privat: lenker som åpner Vipps med mottaker, beløp og melding ferdig utfylt.
// Formatet er det samme som Vipps bruker i QR-kodene for privatpersoner. Det er ikke offisielt
// dokumentert, så takkesiden har alltid en reservelenke og kopier-knapp. Test variantene på vipps-test.html.
(function () {
  function miljo() {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    var android = /Android/i.test(ua);
    var app = window.vjInApp ? window.vjInApp() : null;
    var navn = app ? app.app : /CriOS/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /EdgiOS|Edg\//.test(ua) ? 'Edge' :
      /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /GSA\//.test(ua) ? 'Google-appen' : android && /Chrome/.test(ua) ? 'Chrome' :
      /Safari/.test(ua) && ios ? 'Safari' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'ukjent nettleser';
    return { ios: ios, android: android, mobil: ios || android, inApp: app ? app.app : '', nettleser: navn,
      tekst: (ios ? 'iPhone/iPad' : android ? 'Android' : 'PC/Mac') + ', ' + (app ? 'inne i ' + app.app : navn) };
  }

  /** Lenken backend lager. nr: 8 sifre, ore: beløpet i øre. */
  function https(nr, ore, melding) {
    var l = 'https://qr.vipps.no/28/2/01/031/' + String(nr).replace(/\D/g, '') + '?v=1';
    if (ore) l += '&a=' + Math.round(ore);
    if (melding) l += '&m=' + encodeURIComponent(String(melding).slice(0, 50));
    return l;
  }

  /** Samme lenke i tre varianter: vanlig nettadresse, Vipps-appens egen adresse og Android-«intent». */
  function lenker(h) {
    var uten = h.replace(/^https:\/\//, '');
    return {
      https: h,
      vipps: 'vipps://' + uten,
      intent: 'intent://' + uten + '#Intent;scheme=vipps;package=no.dnb.vipps;S.browser_fallback_url=' + encodeURIComponent(h) + ';end'
    };
  }

  /**
   * Hvilken variant «Åpne Vipps»-knappen bruker, og hvilken som er reserve («Åpnet ikke Vipps?»).
   * Justeres etter resultatene fra vipps-test.html.
   */
  function valg(m) {
    m = m || miljo();
    if (m.android) return { hoved: 'intent', reserve: 'https' };
    if (m.ios && m.inApp) return { hoved: 'vipps', reserve: 'https' };
    return { hoved: 'https', reserve: 'vipps' };
  }

  // Nettleseren inne i apper (særlig på Android) nekter ofte navigator.clipboard. Da prøver vi den gamle måten.
  function kopier(tekst) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(tekst).catch(function () { return kopierGammel(tekst); });
    }
    return kopierGammel(tekst);
  }

  function kopierGammel(tekst) {
    return new Promise(function (ok, feil) {
      var t = document.createElement('textarea');
      t.value = tekst; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(t); t.select(); t.setSelectionRange(0, tekst.length);
      var lyktes = false; try { lyktes = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(t); lyktes ? ok() : feil();
    });
  }

  /** QR-kode som SVG (krever assets/qrcode.min.js). */
  function qrSvg(tekst) {
    if (typeof window.qrcode !== 'function') return '';
    var q = window.qrcode(0, 'M'); q.addData(tekst); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR-kode som åpner Vipps' });
  }

  window.vjVipps = { miljo: miljo, https: https, lenker: lenker, valg: valg, kopier: kopier, qrSvg: qrSvg };
})();
