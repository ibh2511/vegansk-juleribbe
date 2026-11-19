// Felles hjelpere: kall til backend og anonym besøkstelling (ingen informasjonskapsler)
(function () {
  function qs(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k] == null ? '' : o[k]); }).join('&'); }
  // Et kall som henger, gir opp etter 30 sekunder (eller ms) i stedet for å la siden vente for alltid.
  // Svarer backend med noe annet enn JSON (f.eks. en feilside fra Google), blir det en lesbar feilmelding.
  function hent(url, opt, ms) {
    ms = ms || 30000;
    var ctrl = window.AbortController ? new AbortController() : null, t = null;
    if (ctrl) { opt.signal = ctrl.signal; t = setTimeout(function () { ctrl.abort(); }, ms); }
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (tekst) {
        try { return JSON.parse(tekst); } catch (e) {
          var tittel = (tekst.match(/<title>([^<]*)<\/title>/i) || [])[1];
          throw new Error('Uventet svar fra serveren (HTTP ' + r.status + (tittel ? ': ' + tittel.trim() : '') + ')');
        }
      });
    }, function (e) {
      throw new Error(e && e.name === 'AbortError' ? 'Serveren svarte ikke innen ' + Math.round(ms / 1000) + ' sekunder' : 'Fikk ikke kontakt med serveren (' + (e && e.message || e) + ')');
    }).finally(function () { clearTimeout(t); });
  }
  window.vjGet = function (params, ms) {
    if (!window.VJ_API) return Promise.reject(new Error('API ikke satt opp'));
    return hent(window.VJ_API + '?' + qs(params), { redirect: 'follow' }, ms);
  };
  window.vjPost = function (params, ms) {
    if (!window.VJ_API) return Promise.reject(new Error('API ikke satt opp'));
    return hent(window.VJ_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(params) }, ms);
  };
  // Husker kampanje, samarbeidslenke (?fra=navn) og nettsiden kunden kom fra, så kjøpet kan knyttes til riktig kilde.
  window.vjUtm = function () {
    var p = new URLSearchParams(location.search), u = {};
    // Ny lenke med kilde i adressen erstatter det vi husket fra før (siste klikk teller).
    if (p.get('fra') || p.get('utm_source')) {
      try { ['utm_source', 'utm_campaign', 'fra'].forEach(function (k) { sessionStorage.removeItem('vj_' + k); }); } catch (e) {}
    }
    ['utm_source', 'utm_campaign', 'fra'].forEach(function (k) {
      var v = p.get(k);
      try { if (v) sessionStorage.setItem('vj_' + k, v); else v = sessionStorage.getItem('vj_' + k); } catch (e) {}
      u[k] = v || '';
    });
    var ref = document.referrer && document.referrer.indexOf(location.host) < 0 ? document.referrer : '';
    try { if (ref) sessionStorage.setItem('vj_ref', ref); else ref = sessionStorage.getItem('vj_ref') || ''; } catch (e) {}
    u.ref = ref;
    return u;
  };
  // Nettleseren inne i Instagram, Facebook, Messenger, TikTok, Snapchat o.l. Der virker ikke vanlig filnedlasting.
  window.vjInApp = function () {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    // Messenger må sjekkes før Facebook, fordi Messenger også har Facebook-merker i nettleser-ID-en.
    // Threads heter «Barcelona» i nettleser-ID-en.
    var app = /Instagram/i.test(ua) ? 'Instagram' : /Barcelona/.test(ua) ? 'Threads' : /Messenger|Orca-Android|FBAN\/(MessengerForiOS|MessengerLiteForiOS)/i.test(ua) ? 'Messenger' :
      /FBAN|FBAV|FB_IAB|FBIOS|FB4A/i.test(ua) ? 'Facebook' :
      /TikTok|musical_ly|Bytedance/i.test(ua) ? 'TikTok' : /Snapchat/i.test(ua) ? 'Snapchat' : /LinkedInApp/i.test(ua) ? 'LinkedIn' :
      /Pinterest/i.test(ua) ? 'Pinterest' : /; wv\)/.test(ua) ? 'appen' :
      // Andre apper på iPhone: Safari, Chrome, Firefox og Edge har «Safari/» i nettleser-ID-en, nettleseren inne i apper har det ikke.
      // Unntaket er nettsider lagt til på hjemskjermen (standalone), som heller ikke har det.
      ios && !/Safari\//.test(ua) && !navigator.standalone ? 'appen' : '';
    return app ? { app: app, ios: ios } : null;
  };
  // Lenke som åpner samme side i telefonens vanlige nettleser (Safari på iPhone fra iOS 17, Chrome på Android)
  window.vjEksternLenke = function (ios) {
    if (ios) return 'x-safari-' + location.href;
    return 'intent://' + location.host + location.pathname + location.search + location.hash +
      '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(location.href) + ';end';
  };
  window.vjHit = function () {
    if (!window.VJ_API || /^(localhost|127\.)/.test(location.hostname) || location.protocol === 'file:') return;
    var v = '';
    try {
      var d = new Date().toISOString().slice(0, 10), s = JSON.parse(sessionStorage.getItem('vj_v') || '{}');
      if (s.d !== d) { s = { d: d, v: Math.random().toString(36).slice(2, 10) }; sessionStorage.setItem('vj_v', JSON.stringify(s)); }
      v = s.v;
    } catch (e) {}
    var u = window.vjUtm();
    var side = location.pathname.replace(/^.*\//, '/') || '/';
    window.vjGet({ action: 'hit', side: side, ref: u.ref, fra: u.fra,
      utm_source: u.utm_source, utm_campaign: u.utm_campaign, mobil: /Mobi|Android/i.test(navigator.userAgent) ? 1 : 0, v: v }).catch(function () {});
  };
})();
