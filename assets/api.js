// Felles hjelpere: kall til backend og anonym besøkstelling (ingen informasjonskapsler)
(function () {
  function qs(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k] == null ? '' : o[k]); }).join('&'); }
  window.vjGet = function (params) {
    if (!window.VJ_API) return Promise.reject(new Error('API ikke satt opp'));
    return fetch(window.VJ_API + '?' + qs(params), { redirect: 'follow' }).then(function (r) { return r.json(); });
  };
  window.vjPost = function (params) {
    if (!window.VJ_API) return Promise.reject(new Error('API ikke satt opp'));
    return fetch(window.VJ_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(params) })
      .then(function (r) { return r.json(); });
  };
  window.vjUtm = function () {
    var p = new URLSearchParams(location.search), u = {};
    ['utm_source', 'utm_campaign'].forEach(function (k) {
      var v = p.get(k);
      try { if (v) sessionStorage.setItem(k, v); else v = sessionStorage.getItem(k); } catch (e) {}
      u[k] = v || '';
    });
    return u;
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
    window.vjGet({ action: 'hit', side: side, ref: document.referrer && document.referrer.indexOf(location.host) < 0 ? document.referrer : '',
      utm_source: u.utm_source, utm_campaign: u.utm_campaign, mobil: /Mobi|Android/i.test(navigator.userAgent) ? 1 : 0, v: v }).catch(function () {});
  };
})();
