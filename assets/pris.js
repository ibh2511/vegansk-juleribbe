// Pris som oppdaterer seg selv etter dato. Designet er det samme hele tiden, bare beløpet bytter.
// Backend (Apps Script) bestemmer prisen og hvilken periode som gjelder, og Vipps tar samme beløp.
// Siden viser først verdiene fra config.js, og bytter til backendens tall og klokke så snart de er hentet.
// Sjekker hvert minutt, så prisen bytter også hos den som har siden åpen når lanseringen starter eller slutter.
(function () {
  var C = {
    ordinaer: window.VJ_PRIS || 149,
    lansering: window.VJ_LANSERING_PRIS || 99,
    start: new Date(window.VJ_LANSERING_START || 0).getTime(),
    slutt: new Date(window.VJ_LANSERING_SLUTT || 0).getTime()
  };
  var avvik = 0; // forskjell mellom serverens og maskinens klokke

  function dato(ms, medAar) {
    var o = { day: 'numeric', month: 'long', timeZone: 'Europe/Oslo' };
    if (medAar) o.year = 'numeric';
    return new Date(ms).toLocaleDateString('nb-NO', o);
  }
  function alle(sel, fn) { document.querySelectorAll(sel).forEach(fn); }

  function vis() {
    var naa = Date.now() + avvik;
    var fase = naa < C.start ? 'for' : naa < C.slutt ? 'lansering' : 'etter';
    var pris = fase === 'lansering' ? C.lansering : C.ordinaer;

    document.documentElement.setAttribute('data-prisfase', fase);
    alle('[data-pris]', function (el) { el.textContent = pris + ' kr'; });
    // Tekst i vilkårene
    alle('[data-pris-ordinaer]', function (el) { el.textContent = C.ordinaer + ' kr'; });
    alle('[data-pris-lansering]', function (el) { el.textContent = C.lansering + ' kr'; });
    alle('[data-lansering-periode]', function (el) { el.textContent = dato(C.start) + ' til og med ' + dato(C.slutt - 1, true); });

    // Strukturerte data for Google følger samme pris
    var ld = document.querySelector('script[type="application/ld+json"]');
    if (ld) {
      try {
        var d = JSON.parse(ld.textContent);
        (d['@graph'] || [d]).forEach(function (n) {
          if (n['@type'] !== 'Product' || !n.offers) return;
          n.offers.price = pris.toFixed(2);
          if (fase === 'lansering') n.offers.priceValidUntil = new Date(C.slutt - 1).toISOString().slice(0, 10);
          else delete n.offers.priceValidUntil;
        });
        ld.textContent = JSON.stringify(d);
      } catch (e) {}
    }
  }

  vis();
  setInterval(vis, 60000);

  if (window.VJ_API && window.vjGet) {
    window.vjGet({ action: 'pris' }).then(function (d) {
      if (!d || !d.ok) return;
      C = { ordinaer: d.ordinaer, lansering: d.lansering, start: new Date(d.start).getTime(), slutt: new Date(d.slutt).getTime() };
      avvik = new Date(d.naa).getTime() - Date.now();
      vis();
    }).catch(function () {});
  }
})();
