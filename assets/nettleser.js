// Åpnet i nettleseren inne i Instagram, Facebook, Messenger o.l.? Der virker Vipps og nedlasting dårligere,
// så vi sender folk til standardnettleseren. Samme løsning som på juletreff.
//  - Android: siden åpnes i standardnettleseren med en gang (intent-lenke), én gang per økt, så det ikke går i ring.
//  - iPhone: apper kan ikke åpnes i Safari automatisk. Øverst står en stripe med «Åpne i Safari»
//    (x-safari-https, iOS 17 og nyere) og hvordan man gjør det selv via menyen.
// Krever assets/api.js (vjInApp).
(function () {
  var app = window.vjInApp ? window.vjInApp() : null;
  if (!app) return;
  var NOKKEL = 'vj_apnet_i_nettleser';
  var url = location.href, uten = url.replace(/^https?:\/\//, '');
  var android = !app.ios;
  var lenke = android
    ? 'intent://' + uten + '#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=' + encodeURIComponent(url) + ';end'
    : 'x-safari-' + url;

  if (android) {
    var provd = false;
    try { provd = sessionStorage.getItem(NOKKEL) === '1'; sessionStorage.setItem(NOKKEL, '1'); } catch (e) {}
    if (!provd) location.href = lenke;
  }

  var css = '.nettleser-stripe{position:relative;display:grid;justify-items:center;gap:8px;padding:14px 44px 14px 16px;background:var(--green);color:var(--cream);font-size:14.5px;line-height:1.5;text-align:center}' +
    '.nettleser-stripe p{margin:0;text-wrap:balance}' +
    '.nettleser-stripe small{font-size:13px;opacity:.8}' +
    '.nettleser-knapp{padding:8px 18px;border-radius:999px;background:var(--cream);color:var(--green);font-weight:700;text-decoration:none}' +
    '.nettleser-lukk{position:absolute;top:6px;right:6px;width:36px;height:36px;padding:0;border:0;background:none;color:var(--cream);opacity:.8;font-size:22px;line-height:1;cursor:pointer}';

  function vis() {
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    var d = document.createElement('div');
    d.className = 'nettleser-stripe'; d.setAttribute('role', 'note');
    var p = document.createElement('p');
    p.textContent = 'Du er i nettleseren til ' + app.app + '. Vipps virker best i ' + (app.ios ? 'Safari' : 'nettleseren din') + '.';
    var a = document.createElement('a');
    a.className = 'nettleser-knapp'; a.href = lenke; a.textContent = 'Åpne i ' + (app.ios ? 'Safari' : 'nettleseren');
    var sm = document.createElement('small');
    sm.textContent = 'Eller trykk ' + (app.ios ? '⋯' : '⋮') + ' øverst og velg «Åpne i nettleser».';
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'nettleser-lukk'; x.setAttribute('aria-label', 'Lukk'); x.textContent = '×';
    x.onclick = function () { d.remove(); };
    d.appendChild(p); d.appendChild(a); d.appendChild(sm); d.appendChild(x);
    document.body.insertBefore(d, document.body.firstChild);
  }
  if (document.body) vis(); else document.addEventListener('DOMContentLoaded', vis);
})();
