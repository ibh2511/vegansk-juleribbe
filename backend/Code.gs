/**
 * Vegansk juleribbe – salgsbackend (Google Apps Script)
 *
 * Gjør dette:
 *  - To betalingsløsninger som velges i adminpanelet:
 *    · Vipps bedrift (ePayment API): oppretter betaling, sender kunden til Vipps, trekker beløpet
 *    · Vipps privat: kunden vippser til et mobilnummer, og backend finner betalingen i
 *      SpareBank 1-kontoen (personal banking API) og kobler den til ordren på navn og beløp
 *  - Lager en personlig PDF med vannmerke nederst på hver side
 *  - Sender e-post med nedlastingslenke
 *  - Leverer PDF-en via nedlastingssiden (tidsbegrenset og med maks antall nedlastinger)
 *  - Logger sidebesøk uten informasjonskapsler og uten personopplysninger
 *  - Gir statistikk til adminpanelet bak passord
 *
 * Alle hemmeligheter ligger i Skriptegenskaper (Prosjektinnstillinger > Skriptegenskaper).
 * Se OPPSETT.md i repoet.
 */

var PDF_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
// Pris og lanseringsperiode. Standardverdiene under kan overstyres i Script Properties
// (PRIS, LANSERING_PRIS, LANSERING_START, LANSERING_SLUTT) uten å endre koden.
// Nettsiden henter prisen herfra (action=pris), så siden og Vipps viser alltid det samme.
var PRIS_ORE = 14900;              // ordinær pris
var LANSERING_PRIS_ORE = 9900;     // lanseringspris
var LANSERING_START = '2026-11-26T00:00:00+01:00'; // lanseringsprisen gjelder fra 26. november ...
var LANSERING_SLUTT = '2026-12-03T00:00:00+01:00'; // ... til og med 2. desember (slutt er første dag med ordinær pris)

function prisOppsett_() {
  var props = PropertiesService.getScriptProperties();
  function les(k, std) { var v = props.getProperty(k); return v === null || v === '' ? std : v; }
  return {
    ordinaer: Number(les('PRIS', PRIS_ORE / 100)),
    lansering: Number(les('LANSERING_PRIS', LANSERING_PRIS_ORE / 100)),
    start: new Date(les('LANSERING_START', LANSERING_START)),
    slutt: new Date(les('LANSERING_SLUTT', LANSERING_SLUTT))
  };
}

function prisOre_(tid, oppsett) {
  var o = oppsett || prisOppsett_();
  var t = tid ? new Date(tid) : new Date();
  return Math.round((t >= o.start && t < o.slutt ? o.lansering : o.ordinaer) * 100);
}

// Offentlig prisinfo til nettsiden: gjeldende pris, periode og serverens klokke
function prisInfo_() {
  var o = prisOppsett_(), naa = new Date();
  var fase = naa < o.start ? 'for' : naa < o.slutt ? 'lansering' : 'etter';
  return { ok: true, pris: prisOre_(naa, o) / 100, ordinaer: o.ordinaer, lansering: o.lansering,
    start: o.start.toISOString(), slutt: o.slutt.toISOString(), naa: naa.toISOString(), fase: fase,
    betaling: betalingsmate_() };
}

var ORDRE_ARK = 'Ordrer';
var BESOK_ARK = 'Besøk';
var BANK_ARK = 'Bank';
var VTEST_ARK = 'Vippstest';
// betaling: «bedrift» eller «privat». gebyr: Vipps-gebyret i kroner for salget (bare bedrift).
// bank_id: transaksjonen i banken som betalte ordren. vipps_navn: navnet kunden betaler fra i Vipps.
var ORDRE_KOLONNER = ['ordre', 'opprettet', 'status', 'navn', 'epost', 'telefon', 'token',
  'nedlastinger', 'utloper', 'kilde', 'betalt', 'epost_sendt', 'nokkel', 'belop', 'cta', 'partner',
  'betaling', 'gebyr', 'bank_id', 'vipps_navn'];
var BESOK_KOLONNER = ['tid', 'side', 'kilde', 'utm_source', 'utm_campaign', 'enhet', 'besokende', 'partner'];
// Innbetalinger fra banken som har samme beløp som heftet. Andre innbetalinger lagres ikke.
var BANK_KOLONNER = ['sett', 'bank_id', 'dato', 'belop', 'navn', 'tekst', 'type', 'bokforing', 'status', 'ordre'];
var VTEST_KOLONNER = ['tid', 'sted', 'oppdaget', 'resultater', 'belop', 'melding', 'ua'];
var CTA_NAVN = ['hero', 'sticky', 'final'];

/* ------------------------------------------------------------------ */
/* Innstillinger                                                       */
/* ------------------------------------------------------------------ */

function cfg_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Mangler skriptegenskap: ' + key);
  }
  return v;
}

function vippsBase_() {
  return cfg_('VIPPS_ENV', 'test') === 'prod' ? 'https://api.vipps.no' : 'https://apitest.vipps.no';
}

/** «bedrift» (Vipps ePayment-avtalen) eller «privat» (vennebetaling til mobilnummer). Velges i adminpanelet. */
function betalingsmate_() { return cfg_('BETALING', 'bedrift') === 'privat' ? 'privat' : 'bedrift'; }

/** Alle fire nøklene til Vipps bedrift må ligge i Skriptegenskaper. */
function harVippsNokler_() {
  return ['VIPPS_CLIENT_ID', 'VIPPS_CLIENT_SECRET', 'VIPPS_SUBSCRIPTION_KEY', 'VIPPS_MSN']
    .every(function (k) { return !!cfg_(k, ''); });
}

/** Mobilnummeret kundene vippser til i privat-løsningen (8 sifre). Settes i adminpanelet. */
function privatNr_() { return String(cfg_('VIPPS_PRIVAT_NR', '')).replace(/\D/g, ''); }

/**
 * Lenke som åpner Vipps med mottaker (og beløp og melding) fylt ut. Samme format som Vipps bruker i
 * QR-kodene for privatpersoner. Formatet er ikke offisielt dokumentert, så det kan slås av i admin
 * (VIPPS_LENKE_UTFYLT=nei), og da fylles bare nummeret ut. Beløpet er i øre.
 */
function vippsLenke_(nr, ore, melding) {
  var l = 'https://qr.vipps.no/28/2/01/031/' + String(nr).replace(/\D/g, '') + '?v=1';
  if (cfg_('VIPPS_LENKE_UTFYLT', 'ja') !== 'nei') {
    if (ore) l += '&a=' + Math.round(ore);
    if (melding) l += '&m=' + encodeURIComponent(String(melding).slice(0, 50));
  }
  return l;
}

/** Vipps-gebyret for et salg med Vipps bedrift, ut fra satsen i adminpanelet (prosent + kroner per salg). */
// Vipps bedrift, Nettbetalinger / Checkout: 2,99 % + 1,00 kr per salg. Kan endres i admin.
var GEBYR_STANDARD = { GEBYR_PROSENT: '2.99', GEBYR_KR: '1' };

function gebyr_(kr) {
  var tall = function (k) { return Number(String(cfg_(k, GEBYR_STANDARD[k])).replace(',', '.')) || 0; };
  return Math.round((Number(kr) * tall('GEBYR_PROSENT') / 100 + tall('GEBYR_KR')) * 100) / 100;
}

function sheet_(name) {
  var kol = name === ORDRE_ARK ? ORDRE_KOLONNER : name === BESOK_ARK ? BESOK_KOLONNER : name === VTEST_ARK ? VTEST_KOLONNER : BANK_KOLONNER;
  var ss = SpreadsheetApp.openById(cfg_('SHEET_ID'));
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(kol);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < kol.length) {
    sh.getRange(1, 1, 1, kol.length).setValues([kol]); // nye kolonner i eldre ark
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/* Web-app-inngang                                                     */
/* ------------------------------------------------------------------ */

function doGet(e) { return route_(e, null); }

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return route_(e, body);
}

function route_(e, body) {
  var p = Object.assign({}, (e && e.parameter) || {}, body || {});
  // SpareBank 1 sender nettleseren hit etter BankID-innloggingen. Svaret er en vanlig nettside.
  if (p.action === 'bank' && !body) return bankCallback_(p);
  try {
    switch (p.action) {
      case 'create':   begrens_('create', 30); return json_(createPayment_(p));
      case 'status':   return json_(checkOrder_(p.ordre, p.k, false, p.sjekk === '1'));
      case 'download': return json_(download_(p.t));
      case 'hit':      begrens_('hit', 300); return json_(hit_(p));
      case 'pris':     begrens_('pris', 300); return json_(prisInfo_());
      case 'admin':    return json_(adminLogin_(p.passord));
      case 'stats':    return json_(adminStats_(p.okt, p.dager));
      case 'logout':   return json_(adminLogout_(p.okt));
      case 'nullstill': return json_(adminNullstill_(p.okt, p.angre));
      case 'testkjop': return json_(adminTestkjop_(p));
      case 'resend':   return json_(resend_(p.epost));
      case 'navn':     begrens_('navn', 30); return json_(endreVippsNavn_(p));
      case 'innstillinger': return json_(adminInnstillinger_(p));
      case 'bankstart':  return json_(adminBankStart_(p));
      case 'bankkontoer': return json_(adminBankKontoer_(p));
      case 'banktest':   return json_(adminBankTest_(p));
      case 'koble':      return json_(adminKoble_(p));
      case 'ignorer':    return json_(adminIgnorer_(p));
      case 'vippstest':  begrens_('vippstest', 10); return json_(vippsTest_(p));
      case 'vippstestliste': begrens_('vippstestliste', 60); return json_(vippsTestListe_());
      default:         return json_({ ok: true, info: 'Vegansk juleribbe API' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Vipps ePayment API                                                  */
/* ------------------------------------------------------------------ */

function vippsHeaders_(token) {
  var h = {
    'Ocp-Apim-Subscription-Key': cfg_('VIPPS_SUBSCRIPTION_KEY'),
    'Merchant-Serial-Number': cfg_('VIPPS_MSN'),
    'Vipps-System-Name': 'vegansk-juleribbe',
    'Vipps-System-Version': '1.0',
    'Vipps-System-Plugin-Name': 'apps-script',
    'Vipps-System-Plugin-Version': '1.0'
  };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

function vippsToken_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('vipps_token');
  if (t) return t;
  var h = vippsHeaders_();
  h.client_id = cfg_('VIPPS_CLIENT_ID');
  h.client_secret = cfg_('VIPPS_CLIENT_SECRET');
  var res = UrlFetchApp.fetch(vippsBase_() + '/accesstoken/get', { method: 'post', headers: h, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Vipps token feilet: ' + res.getContentText());
  var d = JSON.parse(res.getContentText());
  cache.put('vipps_token', d.access_token, Math.min(3000, Number(d.expires_in || 3600) - 300));
  return d.access_token;
}

function vipps_(method, path, payload, idemKey) {
  var h = vippsHeaders_(vippsToken_());
  if (idemKey) h['Idempotency-Key'] = idemKey;
  var opt = { method: method, headers: h, muteHttpExceptions: true, contentType: 'application/json' };
  if (payload) opt.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(vippsBase_() + path, opt);
  var code = res.getResponseCode();
  var txt = res.getContentText();
  if (code >= 300) throw new Error('Vipps ' + method + ' ' + path + ' → ' + code + ': ' + txt);
  return txt ? JSON.parse(txt) : {};
}

/* ------------------------------------------------------------------ */
/* Ordreflyt                                                           */
/* ------------------------------------------------------------------ */

function nextOrderNo_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('NESTE_ORDRE') || 10001);
  props.setProperty('NESTE_ORDRE', String(n + 1));
  return 'VJ-' + n;
}

function createPayment_(p) {
  // Backend bestemmer løsningen, så en side som ble lastet før du byttet i admin, havner riktig likevel.
  if (betalingsmate_() === 'privat') return createPrivat_(p);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var ordre, row;
  try {
    ordre = nextOrderNo_();
    var refDomene = String(p.ref || '').replace(/^https?:\/\//, '').split('/')[0];
    // Fast rekkefølge: knapp / utm_source / utm_campaign / nettside kunden kom fra
    var kilde = [p.cta, p.utm_source, p.utm_campaign, refDomene].map(function (x) { return String(x || '').slice(0, 40); }).join(' / ');
    row = {}; ORDRE_KOLONNER.forEach(function (k) { row[k] = ''; });
    row.ordre = ordre; row.opprettet = new Date(); row.status = 'OPPRETTET'; row.nedlastinger = 0; row.kilde = kilde;
    row.nokkel = nyNokkel_(); row.belop = prisOre_(row.opprettet) / 100;
    row.cta = CTA_NAVN.indexOf(p.cta) >= 0 ? p.cta : 'annet';
    row.partner = partnerNavn_(p.fra);
    row.betaling = 'bedrift';
    sheet_(ORDRE_ARK).appendRow(ORDRE_KOLONNER.map(function (k) { return celle_(row[k]); }));
  } finally { lock.releaseLock(); }

  var site = cfg_('SITE_URL').replace(/\/$/, '');
  var res = vipps_('post', '/epayment/v1/payments', {
    amount: { currency: 'NOK', value: row.belop * 100 },
    paymentMethod: { type: 'WALLET' },
    reference: ordre,
    userFlow: 'WEB_REDIRECT',
    // retur=vipps: kunden kommer fra Vipps etter å ha betalt, så takkesiden skriver «Sjekker betalingen …»
    returnUrl: site + '/takk.html?ordre=' + encodeURIComponent(ordre) + '&k=' + row.nokkel + '&retur=vipps',
    paymentDescription: 'Vegansk juleribbe – oppskriftshefte (PDF)',
    profile: { scope: 'name phoneNumber email' }
  }, 'create-' + ordre);

  return { ok: true, ordre: ordre, redirectUrl: res.redirectUrl };
}

/**
 * Kalles fra takkesiden og fra tidsstyrt utløser. Trygg å kalle mange ganger.
 * Takkesiden må sende med den hemmelige nøkkelen fra returadressen. Uten den kan ingen
 * gjette seg til andres ordrenummer og få nedlastingslenken deres.
 */
function checkOrder_(ordre, nokkel, fraUtloser, sjekkBanken) {
  if (!/^(VJ|TEST)-\d{5,}$/.test(ordre || '')) throw new Error('Ugyldig ordrenummer');
  // Vipps privat: ingen betaling å sjekke hos Vipps. Betalingen finnes i banken (se statusPrivat_).
  var forst = findOrder_('ordre', ordre);
  if (forst && forst.data.betaling === 'privat') {
    if (!fraUtloser && !(nokkel && String(nokkel) === String(forst.data.nokkel))) throw new Error('Fant ikke ordren');
    return statusPrivat_(forst, sjekkBanken);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = findOrder_('ordre', ordre);
    if (!o) throw new Error('Fant ikke ordren');
    var eier = !!fraUtloser || (!!nokkel && String(nokkel) === String(o.data.nokkel));
    if (!eier) throw new Error('Fant ikke ordren');
    if (o.data.status === 'BETALT') return { ok: true, status: 'BETALT', epost: maskEmail_(o.data.epost), token: o.data.token };

    var pay = vipps_('get', '/epayment/v1/payments/' + encodeURIComponent(ordre));
    if (pay.state === 'CREATED') return { ok: true, status: 'VENTER' };
    if (pay.state !== 'AUTHORIZED') {
      updateOrder_(o.row, { status: pay.state }); // ABORTED, EXPIRED, TERMINATED
      return { ok: true, status: pay.state };
    }

    // Digitalt produkt som leveres med en gang, så beløpet trekkes nå.
    vipps_('post', '/epayment/v1/payments/' + encodeURIComponent(ordre) + '/capture',
      { modificationAmount: { currency: 'NOK', value: pay.amount.value } }, 'capture-' + ordre);

    var info = {};
    if (pay.profile && pay.profile.sub) {
      info = vipps_('get', '/vipps-userinfo-api/userinfo/' + encodeURIComponent(pay.profile.sub));
    }
    var token = nyNokkel_(40);
    var dager = Number(cfg_('LENKE_DAGER', '7'));
    var fields = {
      status: 'BETALT',
      navn: info.name || '',
      epost: info.email || '',
      telefon: formatPhone_(info.phone_number || ''),
      token: token,
      utloper: new Date(Date.now() + dager * 864e5),
      betalt: new Date(),
      betaling: 'bedrift',
      gebyr: gebyr_(pay.amount.value / 100) // satsen som gjaldt da salget skjedde
    };
    updateOrder_(o.row, fields);
    try {
      sendMail_(fields.epost, fields.navn, ordre, token, pay.amount.value / 100);
      updateOrder_(o.row, { epost_sendt: new Date() });
    } catch (err) { console.error('E-post feilet for ' + ordre + ': ' + err); }
    return { ok: true, status: 'BETALT', epost: maskEmail_(fields.epost), token: token };
  } finally { lock.releaseLock(); }
}

/** Tidsstyrt utløser (hvert 5. minutt): fullfører ordre der kunden lukket Vipps før retur. */
function pollPending() {
  var sh = sheet_(ORDRE_ARK);
  var vals = sh.getDataRange().getValues();
  var grense = Date.now() - 2 * 36e5;
  for (var i = 1; i < vals.length; i++) {
    if (vals[i][2] === 'OPPRETTET' && new Date(vals[i][1]).getTime() > grense) {
      try { checkOrder_(vals[i][0], null, true); } catch (err) { console.error(err); }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Vipps privat: kunden vippser til et mobilnummer                     */
/* ------------------------------------------------------------------ */

var PRIVAT_TIMER = 48; // så lenge en ubetalt ordre kan kobles automatisk

/** Kjøp med Vipps privat: lager ordren og sender betalingsinfo på e-post. Kunden betaler fra takkesiden. */
function createPrivat_(p) {
  var nr = privatNr_();
  if (nr.length !== 8) throw new Error('Salget er ikke helt klart. Prøv igjen litt senere.');
  var navn = String(p.navn || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  var epost = String(p.epost || '').trim().toLowerCase().slice(0, 120);
  // Siden ble lastet før du byttet til privat: be den vise skjemaet først.
  if (!navn && !epost) return { ok: false, error: 'MANGLER_INFO', betaling: 'privat' };
  if (navnOrd_(navn).length < 2) return { ok: false, error: 'Skriv fullt navn, slik det står i Vipps.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) return { ok: false, error: 'Skriv en gyldig e-postadresse.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var row;
  try {
    var ordre = nextOrderNo_();
    var refDomene = String(p.ref || '').replace(/^https?:\/\//, '').split('/')[0];
    row = {}; ORDRE_KOLONNER.forEach(function (k) { row[k] = ''; });
    row.ordre = ordre; row.opprettet = new Date(); row.status = 'VENTER_BANK'; row.nedlastinger = 0;
    row.kilde = [p.cta, p.utm_source, p.utm_campaign, refDomene].map(function (x) { return String(x || '').slice(0, 40); }).join(' / ');
    row.nokkel = nyNokkel_(); row.belop = prisOre_(row.opprettet) / 100;
    row.cta = CTA_NAVN.indexOf(p.cta) >= 0 ? p.cta : 'annet';
    row.partner = partnerNavn_(p.fra);
    row.navn = navn; row.epost = epost; row.vipps_navn = navn; row.betaling = 'privat';
    sheet_(ORDRE_ARK).appendRow(ORDRE_KOLONNER.map(function (k) { return celle_(row[k]); }));
    // Utløseren spør banken bare så lenge noen venter på betaling.
    PropertiesService.getScriptProperties().setProperty('BANK_VENTER_TIL', String(Date.now() + PRIVAT_TIMER * 36e5));
  } finally { lock.releaseLock(); }

  var site = cfg_('SITE_URL').replace(/\/$/, '');
  var takkUrl = site + '/takk.html?ordre=' + encodeURIComponent(row.ordre) + '&k=' + row.nokkel;
  try { sendBetalingMail_(row, nr, takkUrl); } catch (err) { console.error('Betalings-e-post feilet for ' + row.ordre + ': ' + err); }
  // Betalingsinfoen følger med, så takkesiden kan vise «Åpne Vipps» med en gang, uten å vente på et nytt kall.
  return { ok: true, ordre: row.ordre, k: row.nokkel, takkUrl: takkUrl, betaling: 'privat', info: venterSvar_(row) };
}

function vippsMelding_(ordre) { return 'Juleribbe ' + ordre; }

/**
 * Svar til takkesiden for en privat-ordre. Første kall svarer med en gang, så betalingsboksen vises uten å vente
 * på banken. Med sjekkBanken spør backend også banken, høyst hvert 20. sekund.
 */
function statusPrivat_(o, sjekkBanken) {
  var betalt = function (d) { return { ok: true, status: 'BETALT', betaling: 'privat', epost: maskEmail_(d.epost), token: d.token }; };
  if (o.data.status === 'BETALT') return betalt(o.data);
  if (o.data.status !== 'VENTER_BANK') return { ok: true, status: o.data.status, betaling: 'privat' };
  if (sjekkBanken && bankKlar_()) {
    var t0 = Date.now();
    try { sjekkBankHvisLenge_(20); } catch (err) { console.error('Banksjekk feilet etter ' + (Date.now() - t0) + ' ms: ' + err); }
    if (Date.now() - t0 > 5000) console.warn('Banksjekk tok ' + (Date.now() - t0) + ' ms');
    o = findOrder_('ordre', o.data.ordre);
    if (o.data.status === 'BETALT') return betalt(o.data);
  }
  return venterSvar_(o.data);
}

/** Det takkesiden trenger for å vise betalingsboksen. Sendes både fra kjøpet og fra statuskallet. */
function venterSvar_(d) {
  var nr = privatNr_(), ore = Math.round(Number(d.belop) * 100);
  return {
    ok: true, status: 'VENTER_BANK', betaling: 'privat', ordre: d.ordre, belop: Number(d.belop),
    nr: nr, mottaker: formatPhone_(nr), navn: d.vipps_navn || d.navn, epost: maskEmail_(d.epost),
    lenke: vippsLenke_(nr, ore, vippsMelding_(d.ordre)), melding: vippsMelding_(d.ordre),
    automatisk: bankKlar_()
  };
}

/** Kunden betaler fra en annen persons Vipps (f.eks. en partner): oppdaterer navnet vi ser etter i banken. */
function endreVippsNavn_(p) {
  var o = findOrder_('ordre', p.ordre);
  if (!o || !p.k || String(p.k) !== String(o.data.nokkel)) throw new Error('Fant ikke ordren');
  if (o.data.betaling !== 'privat' || o.data.status !== 'VENTER_BANK') return { ok: false, error: 'Ordren venter ikke på betaling' };
  var navn = String(p.navn || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (navnOrd_(navn).length < 2) return { ok: false, error: 'Skriv fullt navn, slik det står i Vipps.' };
  updateOrder_(o.row, { vipps_navn: navn });
  return { ok: true, navn: navn };
}

/* ---- Navn og matching ---- */

/** Navnet som ord uten store bokstaver, æøå og tegn: «Kari-Anne Nordmann» → ['kari', 'anne', 'nordmann']. */
function navnOrd_(s) {
  return String(s || '').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(function (w) { return w.length > 1; });
}

/** Fornavn og etternavn fra skjemaet må begge finnes i bankteksten. Mellomnavn i Vipps gjør ingenting. */
function navnTreff_(navn, tekst) {
  var o = navnOrd_(navn);
  if (o.length < 2) return false;
  var t = ' ' + navnOrd_(tekst).join(' ') + ' ';
  return t.indexOf(' ' + o[0] + ' ') >= 0 && t.indexOf(' ' + o[o.length - 1] + ' ') >= 0;
}

function ore_(kr) { return Math.round(Number(kr) * 100); }

/**
 * Finner ordren en innbetaling hører til. Først på ordrenummer i meldingen (Vipps-lenken fyller det ut),
 * så på navn og beløp. Returnerer ordren, 'FLERE' hvis det ikke går å skille, eller null.
 */
function finnOrdreForBetaling_(t, ventende) {
  var tz = Session.getScriptTimeZone();
  var kand = ventende.filter(function (o) {
    if (ore_(o.data.belop) !== ore_(t.belop)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.dato)) return true;
    return t.dato >= Utilities.formatDate(new Date(new Date(o.data.opprettet).getTime() - 864e5), tz, 'yyyy-MM-dd');
  });
  var m = t.tekst.match(/VJ[\s-]?(\d{5,})/i);
  if (m) {
    var nr = kand.filter(function (o) { return o.data.ordre === 'VJ-' + m[1]; });
    if (nr.length === 1) return nr[0];
  }
  var navn = kand.filter(function (o) {
    return navnTreff_(o.data.vipps_navn || o.data.navn, t.tekst) || navnTreff_(o.data.navn, t.tekst);
  });
  if (navn.length === 1) return navn[0];
  if (navn.length > 1) {
    // Samme kunde har trykket kjøp flere ganger: den nyeste ordren får betalingen.
    var eposter = {}; navn.forEach(function (o) { eposter[String(o.data.epost).toLowerCase()] = 1; });
    if (Object.keys(eposter).length === 1) return navn[navn.length - 1];
    return 'FLERE';
  }
  // Reserve: kunden brukte et annet navn enn i Vipps (kallenavn, nytt etternavn). Venter bare én ordre på dette
  // beløpet, og minst ett av navnene står i bankteksten, er det nesten sikkert den.
  if (kand.length === 1 && (delvisNavnTreff_(kand[0].data.vipps_navn || kand[0].data.navn, t.tekst) || delvisNavnTreff_(kand[0].data.navn, t.tekst))) {
    return kand[0];
  }
  return null;
}

/** Minst ett av navnene (tre bokstaver eller mer) står i bankteksten. */
function delvisNavnTreff_(navn, tekst) {
  var t = ' ' + navnOrd_(tekst).join(' ') + ' ';
  return navnOrd_(navn).some(function (w) { return w.length >= 3 && t.indexOf(' ' + w + ' ') >= 0; });
}

/**
 * Betaling med et annet beløp enn heftet: hvilken ventende kunde den trolig kommer fra, på ordrenummer eller navn.
 * Brukes bare som forslag i adminpanelet. Gir null hvis den ikke ligner på noen som venter.
 */
function kundeForBetaling_(t, ventende) {
  var tz = Session.getScriptTimeZone();
  var kand = ventende.filter(function (o) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.dato)) return true;
    return t.dato >= Utilities.formatDate(new Date(new Date(o.data.opprettet).getTime() - 864e5), tz, 'yyyy-MM-dd');
  });
  var m = t.tekst.match(/VJ[\s-]?(\d{5,})/i);
  if (m) {
    var nr = kand.filter(function (o) { return o.data.ordre === 'VJ-' + m[1]; });
    if (nr.length) return nr[0];
  }
  var navn = kand.filter(function (o) {
    return navnTreff_(o.data.vipps_navn || o.data.navn, t.tekst) || navnTreff_(o.data.navn, t.tekst);
  });
  return navn.length ? navn[navn.length - 1] : null;
}

/** 14.9 → «14,90 kr», 149 → «149 kr». */
function kroner_(kr) {
  var n = Number(kr) || 0;
  return (n % 1 ? n.toFixed(2).replace('.', ',') : String(n)) + ' kr';
}

/** Ordren er betalt: lager nedlastingslenke og sender kvitteringen. bankId er transaksjonen, eller tom ved manuell kobling. */
function markerPrivatBetalt_(o, bankId) {
  var token = nyNokkel_(40);
  var dager = Number(cfg_('LENKE_DAGER', '7'));
  updateOrder_(o.row, { status: 'BETALT', token: token, utloper: new Date(Date.now() + dager * 864e5),
    betalt: new Date(), bank_id: bankId || 'manuell', gebyr: 0 });
  o.data.status = 'BETALT'; o.data.bank_id = bankId || 'manuell'; o.data.token = token;
  try {
    sendMail_(o.data.epost, o.data.navn, o.data.ordre, token, o.data.belop);
    updateOrder_(o.row, { epost_sendt: new Date() });
  } catch (err) { console.error('E-post feilet for ' + o.data.ordre + ': ' + err); }
}

/* ---- SpareBank 1 personal banking API ---- */

var SB1_AUTH = 'https://api-auth.sparebank1.no';
var SB1_API = 'https://api.sparebank1.no';
var SB1_ACCEPT = 'application/vnd.sparebank1.v1+json; charset=utf-8';

function bankKlar_() { return !!(cfg_('BANK_REFRESH_TOKEN', '') && cfg_('BANK_ACCOUNT_KEY', '')); }

function qs_(o) {
  return Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
}

/** Bytter en BankID-kode eller et refresh-token mot nye tokens. */
function bankTokenKall_(felter, erFornyelse) {
  felter.client_id = cfg_('BANK_CLIENT_ID');
  felter.client_secret = cfg_('BANK_CLIENT_SECRET');
  var res = UrlFetchApp.fetch(SB1_AUTH + '/oauth/token', {
    method: 'post', payload: felter, headers: { Accept: 'application/json' }, muteHttpExceptions: true
  });
  var code = res.getResponseCode(), txt = res.getContentText();
  if (code !== 200) {
    var melding = 'SpareBank 1 svarte ' + code + ' på token: ' + txt.slice(0, 200);
    if (erFornyelse && (code === 400 || code === 401)) bankFrakoblet_(melding);
    throw new Error(melding);
  }
  return JSON.parse(txt);
}

/** Lagrer tokens. Et nytt refresh-token erstatter det gamle med en gang, fordi det gamle kan slutte å virke. */
function lagreBankTokens_(d) {
  var props = PropertiesService.getScriptProperties();
  if (d.refresh_token) props.setProperty('BANK_REFRESH_TOKEN', d.refresh_token);
  if (d.refresh_token_expires_in) {
    props.setProperty('BANK_REFRESH_UTLOPER', new Date(Date.now() + Number(d.refresh_token_expires_in) * 1000).toISOString());
    props.deleteProperty('BANK_VARSLET_UTLOP');
  }
  props.setProperty('BANK_SIST_FORNYET', new Date().toISOString());
  props.deleteProperty('BANK_FEIL'); props.deleteProperty('BANK_VARSLET_FEIL');
  var sek = Math.max(60, Math.min(540, Number(d.expires_in || 600) - 60));
  CacheService.getScriptCache().put('bank_token', d.access_token, sek);
}

function bankToken_(tving) {
  var cache = CacheService.getScriptCache();
  var t = tving ? null : cache.get('bank_token');
  if (t) return t;
  var rt = cfg_('BANK_REFRESH_TOKEN', '');
  if (!rt) throw new Error('Banken er ikke koblet til');
  var d = bankTokenKall_({ grant_type: 'refresh_token', refresh_token: rt }, true);
  lagreBankTokens_(d);
  return d.access_token;
}

/** Fornyelsen feilet: banken må godkjennes på nytt med BankID. Gir beskjed på e-post én gang. */
function bankFrakoblet_(melding) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('BANK_FEIL', new Date().toISOString() + ' ' + melding);
  if (props.getProperty('BANK_VARSLET_FEIL')) return;
  props.setProperty('BANK_VARSLET_FEIL', '1');
  varsle_('Banken må kobles til på nytt',
    'Backend fikk ikke lenger lese innbetalinger fra SpareBank 1. Gå til adminpanelet, trykk «Koble til banken» og logg inn med BankID.\n\n' +
    'Til det er gjort, må Vipps-betalinger kobles til ordre for hånd i adminpanelet.\n\nFeilmelding: ' + melding);
}

/** E-post til deg (VARSEL_EPOST, ellers SVAR_EPOST). Gir true hvis e-posten ble sendt. */
function varsle_(emne, tekst) {
  var til = cfg_('VARSEL_EPOST', '') || cfg_('SVAR_EPOST', '');
  if (!til) return false;
  try { MailApp.sendEmail(til, 'Vegansk juleribbe: ' + emne, tekst + '\n\nAdmin: ' + cfg_('SITE_URL', '').replace(/\/$/, '') + '/admin.html'); return true; }
  catch (err) { console.error('Varsel feilet: ' + err); return false; }
}

function bankGet_(path, query) {
  var url = SB1_API + path + (query ? '?' + qs_(query) : '');
  for (var forsok = 0; forsok < 2; forsok++) {
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + bankToken_(forsok > 0), Accept: SB1_ACCEPT }, muteHttpExceptions: true
    });
    var code = res.getResponseCode(), txt = res.getContentText();
    if (code === 401 && forsok === 0) continue; // tokenet gikk nettopp ut: hent nytt og prøv igjen
    if (code >= 300) throw new Error('SpareBank 1 ' + path + ' → ' + code + ': ' + txt.slice(0, 300));
    return txt ? JSON.parse(txt) : {};
  }
}

/** Første liste i svaret (accounts, transactions, list …). Tåler at feltnavnet er et annet enn ventet. */
function finnListe_(d, nokler) {
  if (Array.isArray(d)) return d;
  for (var i = 0; i < nokler.length; i++) if (d && Array.isArray(d[nokler[i]])) return d[nokler[i]];
  for (var k in d) if (Array.isArray(d[k])) return d[k];
  return [];
}

function tekstAv_(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.formatted || v.value || v.name || v.amount || '');
  return String(v);
}

function bankKontoer_() {
  var d = bankGet_('/personal/banking/accounts');
  return finnListe_(d, ['accounts', 'list', 'items']).map(function (a) {
    return { key: String(a.key || a.accountKey || a.id || ''), navn: tekstAv_(a.name || a.description || a.accountName),
      nummer: tekstAv_(a.accountNumber || a.number) };
  }).filter(function (a) { return a.key; });
}

/** Alle tekstfelt i en transaksjon, så navnet og meldingen blir funnet uansett hvilket felt banken bruker. */
function alleTekster_(o, dybde) {
  var ut = [];
  if (dybde > 3 || o == null) return ut;
  if (typeof o === 'string') { ut.push(o); return ut; }
  if (typeof o !== 'object') return ut;
  Object.keys(o).forEach(function (k) {
    if (/key$|^id$|links?$/i.test(k)) return;
    ut = ut.concat(alleTekster_(o[k], (dybde || 0) + 1));
  });
  return ut;
}

/** Gjør om en transaksjon fra banken til et fast format. Tåler ulike feltnavn. */
function normTrans_(t) {
  var tz = Session.getScriptTimeZone();
  var a = t.amount;
  var belop = a && typeof a === 'object' ? Number(a.amount != null ? a.amount : a.value) : Number(a);
  var d = t.date || t.bookingDate || t.accountingDate || t.transactionDate || t.valueDate || '';
  var dato = typeof d === 'number' ? Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd') : String(d).slice(0, 10);
  var id = t.id || t.transactionId || t.archiveReference || '';
  if (!id) {
    var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(t));
    id = 'h' + dig.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  }
  return {
    id: String(id), belop: belop, dato: dato,
    navn: tekstAv_(t.remoteAccountName || t.counterpartyName || t.counterPartyName),
    beskrivelse: [tekstAv_(t.description || t.cleanedDescription), tekstAv_(t.kidOrMessage || t.message)].filter(String).join(' · '),
    type: tekstAv_(t.typeText || t.typeCode || t.type),
    bokforing: tekstAv_(t.bookingStatus || t.status),
    tekst: alleTekster_(t, 0).join(' ').slice(0, 2000)
  };
}

/** Transaksjonene på kontoen fra de siste «dager» dagene, slik banken sender dem. */
function bankRaa_(dager) {
  var key = cfg_('BANK_ACCOUNT_KEY');
  var fra = Utilities.formatDate(new Date(Date.now() - dager * 864e5), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var d;
  try { d = bankGet_('/personal/banking/transactions', { accountKey: key, fromDate: fra }); }
  catch (err) {
    if (!/→ 400/.test(err.message)) throw err;
    d = bankGet_('/personal/banking/transactions', { accountKey: key }); // uten datofilter hvis banken ikke tar det
  }
  return finnListe_(d, ['transactions', 'list', 'items']);
}

function bankTransaksjoner_(dager) { return bankRaa_(dager).map(normTrans_); }

/** Spør banken høyst én gang per «sek» sekunder, uansett hvor mange kunder som venter samtidig. */
function sjekkBankHvisLenge_(sek) {
  var cache = CacheService.getScriptCache();
  if (cache.get('bank_sist')) return;
  cache.put('bank_sist', '1', sek);
  sjekkBank_();
}

/**
 * Henter innbetalinger fra de siste tre dagene og kobler dem til ventende ordre.
 * Bare innbetalinger med samme beløp som heftet lagres (fanen «Bank»), så private vippsinger blir ikke liggende.
 * Unntak: har en kunde som venter skrevet feil beløp (navnet eller ordrenummeret står i bankteksten), lagres den
 * som «FEIL_BELOP» med ordren som forslag, og du får en e-post. Den kobles aldri automatisk.
 */
function sjekkBank_() {
  if (!bankKlar_()) return { ok: false, error: 'Banken er ikke koblet til' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: true, opptatt: true };
  try {
    var trans = bankTransaksjoner_(3);
    PropertiesService.getScriptProperties().setProperty('BANK_SIST_SJEKKET', new Date().toISOString());

    var bsh = sheet_(BANK_ARK), B = {}; BANK_KOLONNER.forEach(function (k, i) { B[k] = i; });
    var sett = {}, feilSett = {};
    bsh.getDataRange().getValues().slice(1).forEach(function (r) {
      sett[String(r[B.bank_id])] = 1;
      if (r[B.status] === 'FEIL_BELOP') feilSett[r[B.ordre] + '|' + ore_(r[B.belop])] = 1;
    });

    var vals = sheet_(ORDRE_ARK).getDataRange().getValues(), O = {}; ORDRE_KOLONNER.forEach(function (k, i) { O[k] = i; });
    var grense = Date.now() - PRIVAT_TIMER * 36e5, nylig = Date.now() - 4 * 864e5;
    var ventende = [], betalte = [];
    for (var i = 1; i < vals.length; i++) {
      if (vals[i][O.betaling] !== 'privat') continue;
      var data = {}; ORDRE_KOLONNER.forEach(function (k, j) { data[k] = vals[i][j]; });
      var o = { row: i + 1, data: data };
      if (data.status === 'VENTER_BANK' && new Date(data.opprettet).getTime() > grense) ventende.push(o);
      else if (data.status === 'BETALT' && new Date(data.betalt).getTime() > nylig) betalte.push(o);
    }
    var po = prisOppsett_(), priser = {};
    priser[ore_(po.ordinaer)] = 1; priser[ore_(po.lansering)] = 1;
    ventende.forEach(function (o) { priser[ore_(o.data.belop)] = 1; });

    var nye = 0, koblet = 0;
    var lagre = function (t, status, ordre) {
      bsh.appendRow([new Date(), t.id, t.dato, t.belop, t.navn, [t.navn, t.beskrivelse].filter(String).join(' · ').slice(0, 300),
        t.type, t.bokforing, status, ordre].map(celle_));
      sett[t.id] = 1; nye++;
    };
    trans.forEach(function (t) {
      if (!(t.belop > 0) || sett[t.id]) return;
      if (!priser[ore_(t.belop)]) {
        var kunde = kundeForBetaling_(t, ventende);
        if (!kunde) return; // en vanlig vipps som ikke gjelder heftet
        var nokkel = kunde.data.ordre + '|' + ore_(t.belop);
        if (feilSett[nokkel]) { lagre(t, 'DUPLIKAT', kunde.data.ordre); return; } // samme betaling igjen (reservert, så bokført)
        feilSett[nokkel] = 1;
        lagre(t, 'FEIL_BELOP', kunde.data.ordre);
        varsle_('Betaling med feil beløp (' + kroner_(t.belop) + ')',
          'Det har kommet ' + kroner_(t.belop) + ' fra ' + (t.navn || 'en kunde') + (t.dato ? ' (' + t.dato + ')' : '') + '. ' +
          'Den ser ut til å høre til ordre ' + kunde.data.ordre + ' fra ' + (kunde.data.vipps_navn || kunde.data.navn) +
          ', som koster ' + kroner_(kunde.data.belop) + '.\n\n' +
          'Betalinger med feil beløp kobles ikke automatisk, så kunden har ikke fått heftet ennå. ' +
          'I adminpanelet, under «Innbetalinger som ikke ble koblet», kan du trykke «Koble» for å sende heftet, eller «Ignorer». ' +
          'Kunden har e-post ' + kunde.data.epost + ' hvis du vil be om resten av beløpet.');
        return;
      }
      var treff = finnOrdreForBetaling_(t, ventende), status = 'UMATCHET', ordre = '', kandidater = ventende.slice();
      if (treff && treff !== 'FLERE') {
        markerPrivatBetalt_(treff, t.id);
        ventende.splice(ventende.indexOf(treff), 1);
        betalte.push(treff);
        status = 'KOBLET'; ordre = treff.data.ordre; koblet++;
      } else if (!treff && betalte.some(function (o) {
        // Samme navn og beløp som en ordre som nettopp ble betalt: trolig samme betaling igjen
        // (reservert først, bokført etterpå), eller at kunden betalte to ganger.
        return ore_(o.data.belop) === ore_(t.belop) && o.data.bank_id !== t.id && navnTreff_(o.data.vipps_navn || o.data.navn, t.tekst);
      })) {
        status = 'DUPLIKAT';
      }
      lagre(t, status, ordre);
      if (status === 'UMATCHET') {
        var samme = kandidater.filter(function (o) { return ore_(o.data.belop) === ore_(t.belop); });
        varsle_('Betaling som ikke ble koblet (' + kroner_(t.belop) + ')',
          'Det har kommet ' + kroner_(t.belop) + ' fra ' + (t.navn || 'ukjent') + (t.dato ? ' (' + t.dato + ')' : '') + ', ' +
          (treff === 'FLERE' ? 'men flere ventende ordre har samme navn og beløp.' : 'men navnet passer ikke med noen ventende ordre.') + '\n\n' +
          (samme.length ? 'Ordre som venter på ' + kroner_(t.belop) + ':\n' + samme.map(function (o) {
            return '· ' + o.data.ordre + ': ' + (o.data.vipps_navn || o.data.navn) + ' (' + o.data.epost + ')';
          }).join('\n') + '\n\n' : 'Ingen ordre venter på dette beløpet.\n\n') +
          'I adminpanelet, under «Innbetalinger som ikke ble koblet», velger du ordren og trykker «Koble», så får kunden heftet. Gjelder den ikke heftet, trykker du «Ignorer».');
      }
    });
    return { ok: true, transaksjoner: trans.length, nye: nye, koblet: koblet };
  } finally { lock.releaseLock(); }
}

/**
 * Tidsstyrt utløser hvert minutt. Spør banken bare når noen venter på betaling (de siste 48 timene),
 * så kjøretiden holder seg langt under Googles grense. Fornyer også tilgangen én gang i døgnet.
 */
function sjekkBankUtloser() {
  if (!cfg_('BANK_REFRESH_TOKEN', '')) return;
  var props = PropertiesService.getScriptProperties();
  var sist = new Date(props.getProperty('BANK_SIST_FORNYET') || 0).getTime();
  if (Date.now() - sist > 20 * 36e5) {
    try { bankToken_(true); } catch (err) { console.error(err); return; }
  }
  var utloper = props.getProperty('BANK_REFRESH_UTLOPER');
  if (utloper && new Date(utloper).getTime() - Date.now() < 14 * 864e5 && !props.getProperty('BANK_VARSLET_UTLOP')) {
    props.setProperty('BANK_VARSLET_UTLOP', '1');
    varsle_('Banktilgangen går snart ut',
      'Tilgangen til SpareBank 1 går ut ' + Utilities.formatDate(new Date(utloper), Session.getScriptTimeZone(), 'd. MMMM yyyy') +
      '. Gå til adminpanelet, trykk «Koble til banken» og logg inn med BankID, så varer den på nytt.');
  }
  if (Date.now() > Number(props.getProperty('BANK_VENTER_TIL') || 0) || !bankKlar_()) return;
  CacheService.getScriptCache().put('bank_sist', '1', 20);
  sjekkBank_();
}

function sikreBankUtloser_() {
  var finnes = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sjekkBankUtloser'; });
  if (!finnes) ScriptApp.newTrigger('sjekkBankUtloser').timeBased().everyMinutes(1).create();
}

/** SpareBank 1 sender nettleseren hit etter BankID. Bytter koden mot tokens og velger konto. */
function bankCallback_(p) {
  var side = function (tittel, tekst) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#2a1d17">' +
      '<h1 style="font-size:26px;color:#741218">' + escapeHtml_(tittel) + '</h1><p style="font-size:17px;line-height:1.5">' +
      escapeHtml_(tekst) + '</p></div>').setTitle(tittel).addMetaTag('viewport', 'width=device-width, initial-scale=1');
  };
  if (p.error) return side('Tilkoblingen ble avbrutt', String(p.error_description || p.error).slice(0, 200));
  var cache = CacheService.getScriptCache();
  if (!p.state || !/^[a-f0-9]{32}$/.test(p.state) || !cache.get('bank_state_' + p.state)) {
    return side('Lenken er gått ut', 'Gå tilbake til adminpanelet og trykk «Koble til banken» på nytt.');
  }
  cache.remove('bank_state_' + p.state);
  try {
    var d = bankTokenKall_({ grant_type: 'authorization_code', code: String(p.code || ''), redirect_uri: cfg_('BANK_REDIRECT') }, false);
    lagreBankTokens_(d);
    var props = PropertiesService.getScriptProperties();
    props.setProperty('BANK_TILKOBLET', new Date().toISOString());
    var kontoer = bankKontoer_();
    var valgt = kontoer.filter(function (k) { return k.key === cfg_('BANK_ACCOUNT_KEY', ''); })[0] ||
      (kontoer.length === 1 ? kontoer[0] : kontoer.filter(function (k) { return /hefte|salg/i.test(k.navn); })[0]);
    if (valgt) { props.setProperty('BANK_ACCOUNT_KEY', valgt.key); props.setProperty('BANK_KONTO_NAVN', valgt.navn + ' ' + valgt.nummer); }
    sikreBankUtloser_();
    return side('Banken er koblet til', valgt
      ? 'Backend leser innbetalinger på kontoen «' + valgt.navn + '». Du kan lukke denne siden og gå tilbake til adminpanelet.'
      : 'Gå tilbake til adminpanelet og velg kontoen Vipps-pengene kommer inn på.');
  } catch (err) {
    console.error(err);
    return side('Noe gikk galt', String(err.message || err).slice(0, 300));
  }
}

function download_(token) {
  if (!/^[a-f0-9]{40}$/.test(token || '')) throw new Error('Ugyldig lenke');
  var o = findOrder_('token', token);
  if (!o || o.data.status !== 'BETALT') throw new Error('Ugyldig lenke');
  var maks = Number(cfg_('MAKS_NEDLASTINGER', '5'));
  if (new Date(o.data.utloper).getTime() < Date.now()) {
    return { ok: false, error: 'UTLOPT', melding: 'Lenken har gått ut. Skriv til oss, så sender vi en ny.' };
  }
  if (Number(o.data.nedlastinger) >= maks) {
    return { ok: false, error: 'MAKS', melding: 'Lenken er brukt ' + maks + ' ganger. Skriv til oss, så hjelper vi deg.' };
  }
  var bytes = stampPdf_(o.data);
  updateOrder_(o.row, { nedlastinger: Number(o.data.nedlastinger) + 1 });
  return {
    ok: true,
    filnavn: 'Vegansk-juleribbe-' + o.data.ordre + '.pdf',
    pdf: Utilities.base64Encode(bytes),
    igjen: maks - Number(o.data.nedlastinger) - 1
  };
}

/** Sender ny lenke hvis kunden har mistet e-posten. Svarer alltid likt for å ikke avsløre hvem som har kjøpt. */
function resend_(epost) {
  epost = String(epost || '').trim().toLowerCase();
  if (!epost) return { ok: true };
  var cache = CacheService.getScriptCache();
  if (cache.get('resend_' + epost)) return { ok: true };
  cache.put('resend_' + epost, '1', 600);
  var o = findOrder_('epost', epost, true);
  if (o && o.data.status === 'BETALT') {
    var dager = Number(cfg_('LENKE_DAGER', '7'));
    var token = nyNokkel_(40);
    updateOrder_(o.row, { token: token, nedlastinger: 0, utloper: new Date(Date.now() + dager * 864e5) });
    sendMail_(o.data.epost, o.data.navn, o.data.ordre, token, o.data.belop);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Vannmerket PDF                                                      */
/* ------------------------------------------------------------------ */

/*
 * Vannmerket lages uten å laste hele PDF-biblioteket ved hvert kjøp:
 *  1. forberedMaster() kjøres én gang fra redigeringsvinduet når heftet er ferdig.
 *     Den legger inn to tomme «vannmerke-felt» (ett for lyse og ett for mørke sider)
 *     i en kopi av heftet og lagrer kopien i Disken.
 *  2. Ved hvert kjøp skriver stampPdf_() bare inn ny tekst i de to feltene
 *     (en «inkrementell oppdatering» av PDF-en). Det går på et øyeblikk.
 */

/** Kjør fra redigeringsvinduet hver gang du laster opp en ny versjon av heftet. */
async function forberedMaster() {
  globalThis.setTimeout = globalThis.setTimeout || function (fn) { fn(); return 0; };
  globalThis.clearTimeout = globalThis.clearTimeout || function () {};
  if (typeof PDFLib === 'undefined') eval(UrlFetchApp.fetch(PDF_LIB_URL).getContentText());

  var src = DriveApp.getFileById(cfg_('MASTER_PDF_ID'));
  var morke = cfg_('MORKE_SIDER', '1,4,12').split(',').map(function (x) { return Number(x.trim()) - 1; });
  // updateMetadata:false beholder heftets egen tittel, forfatter og datoer
  var doc = await PDFLib.PDFDocument.load(new Uint8Array(src.getBlob().getBytes()), { updateMetadata: false });
  var font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  var ctx = doc.context;
  var qRef = ctx.register(ctx.stream('q\n'));
  var lysRef = ctx.register(ctx.stream(' '));
  var morkRef = ctx.register(ctx.stream(' '));
  doc.getPages().forEach(function (page, i) {
    page.node.normalizedEntries().Font.set(PDFLib.PDFName.of('FWM'), font.ref);
    var c = page.node.Contents();
    var arr = ctx.obj([]);
    arr.push(qRef); // lagrer grafikktilstanden før sidens eget innhold
    if (c instanceof PDFLib.PDFArray) { for (var j = 0; j < c.size(); j++) arr.push(c.get(j)); }
    else if (c) arr.push(page.node.get(PDFLib.PDFName.of('Contents')));
    arr.push(morke.indexOf(i) >= 0 ? morkRef : lysRef);
    page.node.set(PDFLib.PDFName.of('Contents'), arr);
  });
  var out = await doc.save({ useObjectStreams: false });
  var tail = '';
  for (var k = Math.max(0, out.length - 64); k < out.length; k++) tail += String.fromCharCode(out[k]);
  var startxref = Number(tail.slice(tail.lastIndexOf('startxref') + 9).trim().split(/\s/)[0]);

  var signed = Array.from(out).map(function (b) { return b > 127 ? b - 256 : b; });
  var gammel = cfg_('MASTER_FORBEREDT_ID', '');
  if (gammel) { try { DriveApp.getFileById(gammel).setTrashed(true); } catch (e) {} }
  var f = DriveApp.createFile(Utilities.newBlob(signed, 'application/pdf', 'hefte-forberedt (ikke del).pdf'));
  var props = PropertiesService.getScriptProperties();
  props.setProperty('MASTER_FORBEREDT_ID', f.getId());
  props.setProperty('MASTER_META', JSON.stringify({
    lys: lysRef.objectNumber, mork: morkRef.objectNumber, root: ctx.trailerInfo.Root.toString(),
    size: ctx.largestObjectNumber + 1, startxref: startxref,
    tittel: doc.getTitle() || 'Vegansk juleribbe', forfatter: doc.getAuthor() || '', laget: doc.getCreator() || ''
  }));
  console.log('Heftet er forberedt: ' + doc.getPageCount() + ' sider. Kjør testVannmerke() for å sjekke.');
}

/** Lager kjøperens personlige PDF. Returnerer en byte-liste klar for Utilities.newBlob/base64Encode. */
function stampPdf_(o) {
  var meta = JSON.parse(cfg_('MASTER_META'));
  var master = DriveApp.getFileById(cfg_('MASTER_FORBEREDT_ID')).getBlob().getBytes();
  var tekst = 'Lisensiert til ' + [o.navn, o.epost, o.telefon].filter(String).join(' · ') + ' · Ordre ' + o.ordre;
  var x = cfg_('VANNMERKE_X', '22.7'), y = cfg_('VANNMERKE_Y', '10.3');

  var off = master.length, deler = [], pos = {};
  function legg(n, s) { pos[n] = off; deler.push(s); off += s.length; }
  function felt(rgb) {
    var c = 'Q q BT /FWM 6.8 Tf ' + rgb + ' rg ' + x + ' ' + y + ' Td ' + pdfStr_(tekst) + ' Tj ET Q\n';
    return '<< /Length ' + c.length + ' >>\nstream\n' + c + 'endstream\n';
  }
  legg(meta.lys, '\n' + meta.lys + ' 0 obj\n' + felt('0.478 0.392 0.333') + 'endobj\n');   // #7A6455
  legg(meta.mork, meta.mork + ' 0 obj\n' + felt('0.914 0.851 0.753') + 'endobj\n');        // #E9D9C0
  var info = meta.size;
  // Beholder heftets tittel og forfatter. Emne og nøkkelord brukes til ordrenummeret.
  legg(info, info + ' 0 obj\n<< /Title ' + pdfStr_(meta.tittel || 'Vegansk juleribbe') +
    (meta.forfatter ? ' /Author ' + pdfStr_(meta.forfatter) : '') +
    (meta.laget ? ' /Creator ' + pdfStr_(meta.laget) : '') +
    ' /Subject ' + pdfStr_('Ordre ' + o.ordre) +
    ' /Keywords ' + pdfStr_(o.ordre + ', ' + o.epost) + ' /Producer (Vegansk juleribbe) >>\nendobj\n');
  var xref = 'xref\n0 1\n0000000000 65535 f \n';
  Object.keys(pos).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) {
    xref += n + ' 1\n' + ('0000000000' + pos[n]).slice(-10) + ' 00000 n \n';
  });
  deler.push(xref + 'trailer\n<< /Size ' + (info + 1) + ' /Root ' + meta.root + ' /Info ' + info +
    ' 0 R /Prev ' + meta.startxref + ' >>\nstartxref\n' + off + '\n%%EOF\n');

  var s = deler.join('');
  var bytes = master.slice();
  for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); // s er ren ASCII
  return bytes;
}

/** PDF-tekststreng i WinAnsi: æøå og · skrives som oktale koder, ukjente tegn blir «?». */
function pdfStr_(s) {
  s = String(s).normalize('NFC');
  var o = '(';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 40 || c === 41 || c === 92) o += '\\' + s[i];
    else if (c >= 32 && c < 127) o += s[i];
    else if (c >= 160 && c < 256) o += '\\' + c.toString(8);
    else {
      var d = s[i].normalize('NFD').replace(/[̀-ͯ]/g, '');
      o += /^[\x20-\x7E]$/.test(d) ? d : '?';
    }
  }
  return o + ')';
}

/* ------------------------------------------------------------------ */
/* E-post                                                              */
/* ------------------------------------------------------------------ */

function sendMail_(to, navn, ordre, token, belop) {
  if (!to) return;
  var link = cfg_('SITE_URL').replace(/\/$/, '') + '/last-ned.html?t=' + token;
  var fornavn = String(navn || '').split(' ')[0] || 'du';
  var dager = cfg_('LENKE_DAGER', '7');
  var kr = Number(belop) || prisOre_() / 100;
  var site = cfg_('SITE_URL').replace(/\/$/, '');
  // Samme farger og uttrykk som nettsiden: kremfarget papir, rødt strikkebånd med gull, grønn knapp.
  // Tabeller og innebygd stil fordi e-postprogrammer (Gmail, Outlook) ikke støtter vanlig CSS. Ingen bilder.
  var serif = "font-family:'Playfair Display',Georgia,'Times New Roman',serif";
  var sans = "font-family:'Source Sans 3','Segoe UI',Arial,sans-serif";
  var html =
    '<!doctype html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>Takk for kjøpet</title></head>' +
    '<body style="margin:0;padding:0;background:#f8f1e3">' +
    // Forhåndsvisning i innboksen
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">Heftet ditt er klart. Last det ned her, lenken virker i ' + dager + ' dager.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f1e3"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fffaf0;border:1px solid #e6d8bf;border-radius:14px;overflow:hidden">' +
    // Toppstripe
    '<tr><td style="background:#5e0f16;color:#f8f1e3;' + sans + ';font-size:12px;letter-spacing:2px;text-transform:uppercase;text-align:center;padding:9px 16px">Vegansk juleribbe · av Celia Grimsgaard</td></tr>' +
    // Strikkebånd: rødt med gullinjer og en rad med små mønstertegn
    '<tr><td style="background:#9e1b22;border-top:2px solid #c8a04a;border-bottom:2px solid #c8a04a;color:#c8a04a;text-align:center;font-size:13px;letter-spacing:6px;line-height:22px;padding:2px 0">✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦</td></tr>' +
    // Overskrift
    '<tr><td style="padding:34px 32px 6px;text-align:center">' +
    '<div style="' + sans + ';font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9e1b22;font-weight:bold">Ordrebekreftelse</div>' +
    '<h1 style="margin:10px 0 0;' + serif + ';font-size:32px;line-height:1.2;color:#741218;font-weight:700">Takk for kjøpet!</h1>' +
    '<div style="margin:14px auto 0;width:60px;border-top:2px solid #c8a04a;font-size:0;line-height:0">&nbsp;</div>' +
    '</td></tr>' +
    // Tekst og knapp
    '<tr><td style="padding:18px 32px 8px;' + sans + ';font-size:17px;line-height:1.6;color:#2a1d17">' +
    '<p style="margin:0 0 14px">Hei ' + escapeHtml_(fornavn) + '!</p>' +
    '<p style="margin:0">Her er heftet ditt med oppskriften på vegansk juleribbe med sprø, stekt svor. Lykke til på kjøkkenet, dette blir godt.</p>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding:26px 32px 8px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#1f3d2b;border-radius:999px">' +
    '<a href="' + link + '" style="display:inline-block;padding:15px 34px;' + sans + ';font-size:17px;font-weight:bold;color:#f8f1e3;text-decoration:none;border-radius:999px">Last ned heftet (PDF)</a>' +
    '</td></tr></table>' +
    '<div style="margin-top:12px;' + sans + ';font-size:14px;color:#6b5a4e">Lenken virker i ' + dager + ' dager.</div>' +
    '</td></tr>' +
    // Ordredetaljer
    // Lite luft og ingen linjeskift, slik at hver opplysning holder seg på én linje på mobil
    '<tr><td style="padding:20px 20px 6px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f1e3;border:1px solid #e6d8bf;border-radius:10px;' + sans + ';font-size:15px;line-height:1.35;color:#2a1d17">' +
    '<tr><td style="padding:9px 12px 4px;color:#6b5a4e;white-space:nowrap">Ordrenummer</td><td align="right" style="padding:9px 12px 4px;font-weight:bold;white-space:nowrap">' + ordre + '</td></tr>' +
    '<tr><td style="padding:4px 12px 8px;color:#6b5a4e;white-space:nowrap">Produkt</td><td align="right" style="padding:4px 12px 8px;white-space:nowrap">Heftet som PDF</td></tr>' +
    '<tr><td style="padding:8px 12px 9px;color:#6b5a4e;border-top:1px solid #e6d8bf;white-space:nowrap">Betalt</td><td align="right" style="padding:8px 12px 9px;font-weight:bold;border-top:1px solid #e6d8bf;white-space:nowrap">' + kr + ' kr</td></tr>' +
    '</table></td></tr>' +
    // Hilsen: en rolig linje og signaturen, med en liten gullstjerne over
    '<tr><td align="center" style="padding:32px 32px 36px;text-align:center">' +
    '<div style="font-size:16px;line-height:1;color:#c8a04a">✦</div>' +
    '<p style="margin:14px 0 0;' + sans + ';font-size:16px;line-height:1.5;color:#6b5a4e">Med ønske om en varm og nydelig jul</p>' +
    '<p style="margin:6px 0 0;' + serif + ';font-size:30px;line-height:1.2;font-style:italic;color:#741218">God jul fra Celia</p>' +
    '</td></tr>' +
    // Bunn
    '<tr><td style="background:#9e1b22;border-top:2px solid #c8a04a;font-size:0;line-height:0;height:6px">&nbsp;</td></tr>' +
    '<tr><td style="background:#2a1d17;color:#e6d8bf;padding:20px 32px;' + sans + ';font-size:13px;line-height:1.6;text-align:center">' +
    // Instagram: lite bilde fra nettsiden (Gmail og Outlook viser ikke SVG), med tekst ved siden av hvis bildet blokkeres
    '<a href="https://www.instagram.com/cgrimsgaard/" style="text-decoration:none;color:#f8f1e3">' +
    '<img src="' + site + '/assets/instagram-epost.png" width="40" height="40" alt="Instagram" style="display:block;margin:0 auto 8px;border:0;width:40px;height:40px"></a>' +
    '<div style="' + serif + ';font-size:19px;color:#f8f1e3">Følg meg på Instagram</div>' +
    '<div style="margin:4px 0 14px"><a href="https://www.instagram.com/cgrimsgaard/" style="color:#c8a04a;font-weight:bold;text-decoration:none">@cgrimsgaard</a> for flere oppskrifter og julestemning</div>' +
    '<div style="border-top:1px solid #4a3a30;padding-top:14px;color:#b8a690;font-size:12px">' +
    'Heftet er personlig merket og kun til eget bruk.<br>' +
    'Spørsmål? Bare svar på denne e-posten.</div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
  MailApp.sendEmail(to, 'Heftet ditt: Vegansk juleribbe (' + ordre + ')',
    // Full tekstversjon ved siden av HTML: e-post med bare en kort tekstdel havner lettere i søppelpost
    'Hei ' + fornavn + '!\n\n' +
    'Takk for kjøpet. Her er heftet ditt med oppskriften på vegansk juleribbe med sprø, stekt svor.\n\n' +
    'Last ned heftet: ' + link + '\n\n' +
    'Lenken virker i ' + dager + ' dager. Heftet er personlig merket og kun til eget bruk.\n\n' +
    'Ordrenummer: ' + ordre + '\n' +
    'Beløp: ' + kr + ' kr\n' +
    'Du samtykket ved kjøpet til at heftet leveres med en gang, og bekreftet at angreretten dermed faller bort (angrerettloven § 22 bokstav n).\n\n' +
    'Har du spørsmål, kan du svare på denne e-posten.\n\n' +
    'Med ønske om en varm og nydelig jul\n\nGod jul fra Celia',
    { htmlBody: html, name: cfg_('AVSENDER_NAVN', 'Vegansk juleribbe'), replyTo: cfg_('SVAR_EPOST', '') || undefined });
}

/** Vipps privat: e-post med betalingsinfo rett etter at kunden har bestilt. Kvitteringen kommer når betalingen er funnet. */
function sendBetalingMail_(o, nr, takkUrl) {
  if (!o.epost) return;
  var fornavn = String(o.navn || '').split(' ')[0] || 'du';
  var kr = Number(o.belop);
  var lenke = vippsLenke_(nr, Math.round(kr * 100), vippsMelding_(o.ordre));
  var serif = "font-family:'Playfair Display',Georgia,'Times New Roman',serif";
  var sans = "font-family:'Source Sans 3','Segoe UI',Arial,sans-serif";
  // Lite luft og ingen linjeskift, slik at hver opplysning holder seg på én linje på mobil. Bare navnet får bryte hvis det er langt.
  var rad = function (etikett, verdi, forste, kanBrytes) {
    var kant = forste ? '' : 'border-top:1px solid #e6d8bf;';
    return '<tr><td style="padding:8px 12px;color:#6b5a4e;white-space:nowrap;' + kant + '">' + etikett + '</td>' +
      '<td align="right" style="padding:8px 12px;font-weight:bold;' + kant + (kanBrytes ? '' : 'white-space:nowrap;') + '">' + verdi + '</td></tr>';
  };
  var html =
    '<!doctype html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>Betal med Vipps</title></head>' +
    '<body style="margin:0;padding:0;background:#f8f1e3">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">Betal ' + kr + ' kr med Vipps, så får du heftet med en gang.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f1e3"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fffaf0;border:1px solid #e6d8bf;border-radius:14px;overflow:hidden">' +
    '<tr><td style="background:#5e0f16;color:#f8f1e3;' + sans + ';font-size:12px;letter-spacing:2px;text-transform:uppercase;text-align:center;padding:9px 16px">Vegansk juleribbe · av Celia Grimsgaard</td></tr>' +
    '<tr><td style="background:#9e1b22;border-top:2px solid #c8a04a;border-bottom:2px solid #c8a04a;color:#c8a04a;text-align:center;font-size:13px;letter-spacing:6px;line-height:22px;padding:2px 0">✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦</td></tr>' +
    '<tr><td style="padding:34px 32px 6px;text-align:center">' +
    '<div style="' + sans + ';font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9e1b22;font-weight:bold">Betaling</div>' +
    '<h1 style="margin:10px 0 0;' + serif + ';font-size:32px;line-height:1.2;color:#741218;font-weight:700">Nesten ferdig!</h1>' +
    '<div style="margin:14px auto 0;width:60px;border-top:2px solid #c8a04a;font-size:0;line-height:0">&nbsp;</div>' +
    '</td></tr>' +
    '<tr><td style="padding:18px 32px 8px;' + sans + ';font-size:17px;line-height:1.6;color:#2a1d17">' +
    '<p style="margin:0 0 14px">Hei ' + escapeHtml_(fornavn) + '!</p>' +
    '<p style="margin:0">Betal <b>' + kr + ' kr</b> med Vipps til nummeret under. Heftet kommer på e-post så snart betalingen er registrert, vanligvis i løpet av kort tid.</p>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding:24px 32px 8px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#ff5b24;border-radius:999px">' +
    '<a href="' + escapeHtml_(lenke) + '" style="display:inline-block;padding:15px 34px;' + sans + ';font-size:17px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:999px">Åpne Vipps og betal ' + kr + ' kr</a>' +
    '</td></tr></table>' +
    '<div style="margin-top:12px;' + sans + ';font-size:14px;color:#6b5a4e">Knappen åpner Vipps med nummeret fylt ut, og så skriver du inn ' + kr + ' kr selv. Er du på PC, kan du skanne QR-koden på <a href="' + escapeHtml_(takkUrl) + '" style="color:#9e1b22">betalingssiden</a>.</div>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 20px 6px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f1e3;border:1px solid #e6d8bf;border-radius:10px;' + sans + ';font-size:15px;line-height:1.35;color:#2a1d17">' +
    rad('Vipps til', '<span style="font-size:16px">' + formatPhone_(nr) + '</span>', true) +
    rad('Beløp', kr + ' kr') +
    rad('Fra Vipps-konto', escapeHtml_(o.vipps_navn || o.navn), false, true) +
    rad('Ordrenummer', o.ordre) +
    '</table></td></tr>' +
    '<tr><td style="padding:18px 32px 30px;' + sans + ';font-size:15px;line-height:1.6;color:#6b5a4e">' +
    'Vi finner betalingen din på navnet og beløpet, så det trenger ikke stå noe i meldingen. Betaler du fra en annen persons Vipps, kan du skrive det navnet på <a href="' + escapeHtml_(takkUrl) + '" style="color:#9e1b22">betalingssiden</a>.' +
    '</td></tr>' +
    '<tr><td style="background:#9e1b22;border-top:2px solid #c8a04a;font-size:0;line-height:0;height:6px">&nbsp;</td></tr>' +
    '<tr><td style="background:#2a1d17;color:#b8a690;padding:16px 32px;' + sans + ';font-size:12px;line-height:1.6;text-align:center">Spørsmål? Bare svar på denne e-posten.</td></tr>' +
    '</table></td></tr></table></body></html>';
  MailApp.sendEmail(o.epost, 'Betal med Vipps: Vegansk juleribbe (' + o.ordre + ')',
    'Hei ' + fornavn + '!\n\n' +
    'Betal ' + kr + ' kr med Vipps til ' + formatPhone_(nr) + ', fra Vipps-kontoen til ' + (o.vipps_navn || o.navn) + '.\n\n' +
    'Åpne Vipps (på mobilen): ' + lenke + '\n' +
    'Betalingssiden: ' + takkUrl + '\n\n' +
    'Heftet kommer på e-post så snart betalingen er registrert, vanligvis i løpet av kort tid.\n\n' +
    'Ordrenummer: ' + o.ordre + '\n\nHar du spørsmål, kan du svare på denne e-posten.',
    { htmlBody: html, name: cfg_('AVSENDER_NAVN', 'Vegansk juleribbe'), replyTo: cfg_('SVAR_EPOST', '') || undefined });
}

/* ------------------------------------------------------------------ */
/* Statistikk                                                          */
/* ------------------------------------------------------------------ */

function hit_(p) {
  var side = String(p.side || '/').slice(0, 60);
  var ref = String(p.ref || '').replace(/^https?:\/\//, '').split('/')[0].slice(0, 60);
  // Anonym daglig besøks-ID uten informasjonskapsler: siden sender en tilfeldig ID per dag fra sessionStorage.
  sheet_(BESOK_ARK).appendRow([new Date(), side, ref, String(p.utm_source || '').slice(0, 40),
    String(p.utm_campaign || '').slice(0, 40), p.mobil === '1' ? 'mobil' : 'pc', String(p.v || '').slice(0, 16),
    partnerNavn_(p.fra)].map(celle_));
  return { ok: true };
}

/** Samarbeidsnavn fra lenka (?fra=navn): små bokstaver, tall, - og _. */
function partnerNavn_(v) {
  return String(v || '').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

/* ---- Innlogging til adminpanelet ---- */

function hashPassord_(passord, salt) {
  var h = String(salt || '') + String(passord || '');
  var n = salt ? 2000 : 1; // med salt: 2000 runder gjør det tregt å gjette seg fram om hashen lekker
  var bytes;
  for (var i = 0; i < n; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = Utilities.base64Encode(bytes);
  }
  return h;
}

function adminLogin_(passord) {
  var cache = CacheService.getScriptCache();
  var forsok = Number(cache.get('admin_feil') || 0);
  if (forsok >= 10) throw new Error('For mange forsøk. Vent 15 minutter.');
  if (hashPassord_(passord, cfg_('ADMIN_SALT', '')) !== cfg_('ADMIN_PASSORD_HASH')) {
    cache.put('admin_feil', String(forsok + 1), 900);
    Utilities.sleep(800);
    return { ok: false, error: 'Feil passord' };
  }
  cache.remove('admin_feil');
  var okt = nyNokkel_(48);
  cache.put('admin_okt_' + okt, '1', 2 * 3600); // innloggingen varer i 2 timer
  return { ok: true, okt: okt };
}

function adminLogout_(okt) {
  if (okt) CacheService.getScriptCache().remove('admin_okt_' + okt);
  return { ok: true };
}

function sjekkOkt_(okt) {
  if (!/^[a-f0-9]{48}$/.test(okt || '') || !CacheService.getScriptCache().get('admin_okt_' + okt)) {
    var e = new Error('Logg inn på nytt'); e.utlogget = true; throw e;
  }
}

/* ---- Statistikk ---- */

/** Nullstiller statistikken ved å la tellingen starte på nytt fra nå. Ingen data slettes, så det kan angres. */
function adminNullstill_(okt, angre) {
  try { sjekkOkt_(okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  var props = PropertiesService.getScriptProperties();
  if (angre === true || angre === 'true' || angre === '1') props.deleteProperty('STATS_FRA');
  else props.setProperty('STATS_FRA', new Date().toISOString());
  return { ok: true, statsFra: props.getProperty('STATS_FRA') || '' };
}

/**
 * Testkjøp fra adminpanelet: lager en betalt ordre uten Vipps, sender den ekte e-posten
 * og gir adressen til takkesiden. Ordrenummeret starter med TEST- og telles ikke i statistikken.
 */
function adminTestkjop_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  begrens_('testkjop', 10);
  var epost = String(p.epost || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) return { ok: false, error: 'Skriv inn en gyldig e-postadresse' };
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var row;
  try {
    var n = Number(props.getProperty('NESTE_TEST') || 10001);
    props.setProperty('NESTE_TEST', String(n + 1));
    var dager = Number(cfg_('LENKE_DAGER', '7'));
    row = {}; ORDRE_KOLONNER.forEach(function (k) { row[k] = ''; });
    row.ordre = 'TEST-' + n; row.opprettet = new Date(); row.status = 'BETALT'; row.betalt = row.opprettet;
    row.navn = String(p.navn || 'Test Testesen').slice(0, 80); row.epost = epost.slice(0, 120);
    row.telefon = formatPhone_(String(p.telefon || '').slice(0, 20)); row.nedlastinger = 0;
    row.token = nyNokkel_(40); row.nokkel = nyNokkel_(); row.utloper = new Date(Date.now() + dager * 864e5);
    row.belop = prisOre_(row.opprettet) / 100; row.kilde = 'test'; row.cta = '';
    sheet_(ORDRE_ARK).appendRow(ORDRE_KOLONNER.map(function (k) { return celle_(row[k]); }));
  } finally { lock.releaseLock(); }
  var sendt = true;
  try {
    sendMail_(row.epost, row.navn, row.ordre, row.token, row.belop);
    var o = findOrder_('ordre', row.ordre);
    if (o) updateOrder_(o.row, { epost_sendt: new Date() });
  } catch (err) { sendt = false; console.error('Test-e-post feilet: ' + err); }
  var site = cfg_('SITE_URL').replace(/\/$/, '');
  return { ok: true, ordre: row.ordre, epostSendt: sendt, epost: row.epost,
    takkUrl: site + '/takk.html?ordre=' + encodeURIComponent(row.ordre) + '&k=' + row.nokkel };
}

/* ---- Betalingsløsning og bank (adminpanelet) ---- */

/** Innstillingene adminpanelet viser. Hemmeligheter sendes aldri tilbake, bare om de er lagt inn. */
function innstillinger_() {
  var nr = privatNr_();
  return {
    betaling: betalingsmate_(), bedriftKlar: harVippsNokler_(), vippsEnv: cfg_('VIPPS_ENV', 'test'),
    nr: nr ? formatPhone_(nr) : '', utfylt: cfg_('VIPPS_LENKE_UTFYLT', 'ja') !== 'nei',
    gebyrProsent: cfg_('GEBYR_PROSENT', GEBYR_STANDARD.GEBYR_PROSENT), gebyrKr: cfg_('GEBYR_KR', GEBYR_STANDARD.GEBYR_KR),
    bank: {
      klientId: !!cfg_('BANK_CLIENT_ID', ''), hemmelighet: !!cfg_('BANK_CLIENT_SECRET', ''), finInst: cfg_('BANK_FININST', ''),
      tilkoblet: !!cfg_('BANK_REFRESH_TOKEN', ''), klar: bankKlar_(), konto: cfg_('BANK_KONTO_NAVN', ''),
      sistSjekket: cfg_('BANK_SIST_SJEKKET', ''), tilkobletTid: cfg_('BANK_TILKOBLET', ''),
      utloper: cfg_('BANK_REFRESH_UTLOPER', ''), feil: cfg_('BANK_FEIL', '')
    }
  };
}

function adminInnstillinger_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  if (p.lagre) {
    var props = PropertiesService.getScriptProperties();
    var nr = String(p.nr || '').replace(/\D/g, '');
    if (nr.length === 10 && nr.indexOf('47') === 0) nr = nr.slice(2);
    if (nr && !/^[49]\d{7}$/.test(nr)) return { ok: false, error: 'Mobilnummeret må ha 8 sifre og starte på 4 eller 9.' };
    var tall = function (v) { v = String(v == null ? '' : v).replace(',', '.').trim(); return v === '' ? '' : (isFinite(Number(v)) && Number(v) >= 0 ? v : null); };
    var pst = tall(p.gebyrProsent), fast = tall(p.gebyrKr);
    if (pst === null || fast === null) return { ok: false, error: 'Gebyret må være tall, for eksempel 2,99 og 1.' };
    var betaling = p.betaling === 'privat' ? 'privat' : 'bedrift';
    if (betaling === 'privat' && !nr) return { ok: false, error: 'Legg inn mobilnummeret kundene skal vippse til før du bytter til Vipps privat.' };
    if (betaling === 'bedrift' && !harVippsNokler_()) return { ok: false, error: 'Vipps bedrift mangler nøkler i Skriptegenskaper (VIPPS_CLIENT_ID, VIPPS_CLIENT_SECRET, VIPPS_SUBSCRIPTION_KEY, VIPPS_MSN).' };
    props.setProperties({ BETALING: betaling, VIPPS_PRIVAT_NR: nr, VIPPS_LENKE_UTFYLT: p.utfylt === false || p.utfylt === 'nei' ? 'nei' : 'ja',
      GEBYR_PROSENT: pst, GEBYR_KR: fast });
    if (betaling === 'privat') sikreBankUtloser_();
  }
  return { ok: true, innstillinger: innstillinger_() };
}

/** Lagrer klientopplysningene og gir lenken til BankID-innloggingen hos SpareBank 1. */
function adminBankStart_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  var props = PropertiesService.getScriptProperties();
  var rens = function (v) { return String(v || '').trim().slice(0, 200); };
  if (rens(p.klientId)) props.setProperty('BANK_CLIENT_ID', rens(p.klientId));
  if (rens(p.hemmelighet)) props.setProperty('BANK_CLIENT_SECRET', rens(p.hemmelighet));
  if (p.finInst !== undefined) props.setProperty('BANK_FININST', rens(p.finInst));
  var redirect = String(p.redirect || '');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\?action=bank$/.test(redirect)) {
    return { ok: false, error: 'Ugyldig redirect-adresse. Sjekk VJ_API i assets/config.js.' };
  }
  props.setProperty('BANK_REDIRECT', redirect);
  if (!cfg_('BANK_CLIENT_ID', '') || !cfg_('BANK_CLIENT_SECRET', '')) return { ok: false, error: 'Lim inn klient-ID og hemmelighet fra SpareBank 1 først.' };
  var state = nyNokkel_(32);
  CacheService.getScriptCache().put('bank_state_' + state, '1', 900);
  var url = SB1_AUTH + '/oauth/authorize?' + qs_({ client_id: cfg_('BANK_CLIENT_ID'), state: state, redirect_uri: redirect,
    finInst: cfg_('BANK_FININST', ''), response_type: 'code' });
  return { ok: true, url: url, redirect: redirect };
}

/** Kontoene i banken. Med p.key velges kontoen Vipps-pengene kommer inn på. */
function adminBankKontoer_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  if (!cfg_('BANK_REFRESH_TOKEN', '')) return { ok: false, error: 'Koble til banken først.' };
  var kontoer = bankKontoer_();
  if (p.key) {
    var k = kontoer.filter(function (x) { return x.key === p.key; })[0];
    if (!k) return { ok: false, error: 'Fant ikke kontoen' };
    PropertiesService.getScriptProperties().setProperties({ BANK_ACCOUNT_KEY: k.key, BANK_KONTO_NAVN: k.navn + ' ' + k.nummer });
    sikreBankUtloser_();
  }
  return { ok: true, kontoer: kontoer.map(function (x) { return { key: x.key, navn: x.navn, nummer: x.nummer, valgt: x.key === cfg_('BANK_ACCOUNT_KEY', '') }; }),
    innstillinger: innstillinger_() };
}

/** Sjekker banken nå og viser de siste innbetalingene slik banken sender dem, så feltene kan kontrolleres. */
function adminBankTest_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  if (!bankKlar_()) return { ok: false, error: 'Koble til banken og velg konto først.' };
  var raa = bankRaa_(7);
  var inn = raa.filter(function (t) { return normTrans_(t).belop > 0; }).slice(0, 5);
  var sjekk = sjekkBank_();
  return { ok: true, antall: raa.length, eksempler: inn.map(function (t) { return { tolket: normTrans_(t), raa: t }; }), sjekk: sjekk,
    innstillinger: innstillinger_() };
}

/** Kobler en innbetaling (eller ingen, når du har sett betalingen selv) til en ventende privat-ordre. */
function adminKoble_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = findOrder_('ordre', p.ordre);
    if (!o || o.data.betaling !== 'privat') return { ok: false, error: 'Fant ikke ordren' };
    if (o.data.status === 'BETALT') return { ok: false, error: o.data.ordre + ' er allerede betalt' };
    var bankId = String(p.bankId || '');
    var b = bankId ? finnBankRad_(bankId) : null;
    if (bankId && !b) return { ok: false, error: 'Fant ikke innbetalingen' };
    markerPrivatBetalt_(o, bankId || 'manuell');
    if (b) oppdaterBankRad_(b.row, { status: 'MANUELT', ordre: o.data.ordre });
    return { ok: true, ordre: o.data.ordre };
  } finally { lock.releaseLock(); }
}

function adminIgnorer_(p) {
  try { sjekkOkt_(p.okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }
  var b = finnBankRad_(String(p.bankId || ''));
  if (!b) return { ok: false, error: 'Fant ikke innbetalingen' };
  oppdaterBankRad_(b.row, { status: 'IGNORERT' });
  return { ok: true };
}

function finnBankRad_(bankId) {
  var vals = sheet_(BANK_ARK).getDataRange().getValues(), col = BANK_KOLONNER.indexOf('bank_id');
  for (var i = vals.length - 1; i >= 1; i--) if (String(vals[i][col]) === bankId) return { row: i + 1 };
  return null;
}

function oppdaterBankRad_(row, fields) {
  var sh = sheet_(BANK_ARK);
  Object.keys(fields).forEach(function (k) { sh.getRange(row, BANK_KOLONNER.indexOf(k) + 1).setValue(celle_(fields[k])); });
}

function adminStats_(okt, antallDager) {
  try { sjekkOkt_(okt); } catch (e) { return { ok: false, error: e.message, utlogget: true }; }

  var tz = Session.getScriptTimeZone();
  var dag = function (d) { return Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd'); };
  var n = Number(antallDager) || 0;
  var fra = n ? dag(new Date(Date.now() - (n - 1) * 864e5)) : '0000';
  var statsFra = cfg_('STATS_FRA', '');
  var fraTid = statsFra ? new Date(statsFra).getTime() : 0; // satt med «Nullstill statistikk»
  var iPerioden = function (d) { return dag(d) >= fra && new Date(d).getTime() >= fraTid; };

  var perDag = {}, kilder = {}, enheter = { mobil: 0, pc: 0 };
  var dagRad = function (k) { return perDag[k] = perDag[k] || { besok: 0, unike: {}, klikk: 0, salg: 0, omsetning: 0 }; };
  var kildeRad = function (navn, type) {
    var key = type + ':' + navn;
    return kilder[key] = kilder[key] || { kilde: navn, type: type, besok: 0, unikeSett: {}, klikk: { hero: 0, sticky: 0, final: 0, annet: 0 }, salg: 0, omsetning: 0 };
  };
  var kildeFor = function (partner, utm, ref) {
    if (partner) return kildeRad(partner, 'samarbeid');
    if (utm) return kildeRad(String(utm).toLowerCase(), 'kampanje');
    if (ref) return kildeRad(String(ref).replace(/^www\./, ''), 'nettside');
    return kildeRad('direkte', 'direkte');
  };

  var B = {}; BESOK_KOLONNER.forEach(function (k, i) { B[k] = i; });
  sheet_(BESOK_ARK).getDataRange().getValues().slice(1).forEach(function (r) {
    if ((r[B.side] !== '/' && r[B.side] !== '/index.html') || !iPerioden(r[B.tid])) return;
    var d = dag(r[B.tid]), v = r[B.besokende];
    var dr = dagRad(d); dr.besok++; if (v) dr.unike[v] = 1;
    var kr = kildeFor(r[B.partner], r[B.utm_source], r[B.kilde]); kr.besok++; if (v) kr.unikeSett[d + v] = 1;
    enheter[r[B.enhet] === 'mobil' ? 'mobil' : 'pc']++;
  });

  var O = {}; ORDRE_KOLONNER.forEach(function (k, i) { O[k] = i; });
  var po = prisOppsett_();
  var perBetaling = { bedrift: { salg: 0, omsetning: 0, gebyr: 0 }, privat: { salg: 0, omsetning: 0, gebyr: 0 } };
  var ordre = sheet_(ORDRE_ARK).getDataRange().getValues().slice(1);
  ordre.forEach(function (r) {
    if (String(r[O.ordre]).indexOf('TEST-') === 0) return; // testkjøp fra adminpanelet telles ikke
    if (!iPerioden(r[O.opprettet])) return;
    var gammelKilde = String(r[O.kilde] || '').split(' / '); // ordre fra før cta/partner fikk egne kolonner
    var cta = r[O.cta] || gammelKilde[0] || 'annet';
    if (CTA_NAVN.indexOf(cta) < 0) cta = 'annet';
    var kr = kildeFor(r[O.partner], gammelKilde[1], gammelKilde[3]);
    var dr = dagRad(dag(r[O.opprettet]));
    kr.klikk[cta]++; dr.klikk++;
    if (r[O.status] === 'BETALT') {
      var belop = Number(r[O.belop]) || prisOre_(r[O.opprettet], po) / 100;
      kr.salg++; kr.omsetning += belop; dr.salg++; dr.omsetning += belop;
      // Ordre fra før løsningene fikk egen kolonne ble betalt med Vipps bedrift.
      var los = r[O.betaling] === 'privat' ? 'privat' : 'bedrift';
      var g = los === 'privat' ? 0 : (r[O.gebyr] !== '' && r[O.gebyr] != null ? Number(r[O.gebyr]) : gebyr_(belop));
      perBetaling[los].salg++; perBetaling[los].omsetning += belop; perBetaling[los].gebyr += g;
    }
  });
  Object.keys(perBetaling).forEach(function (k) {
    var x = perBetaling[k];
    x.gebyr = Math.round(x.gebyr * 100) / 100; x.netto = Math.round((x.omsetning - x.gebyr) * 100) / 100;
  });

  var liste = Object.keys(kilder).map(function (k) {
    var x = kilder[k];
    x.unike = Object.keys(x.unikeSett).length; delete x.unikeSett;
    x.klikkTotalt = x.klikk.hero + x.klikk.sticky + x.klikk.final + x.klikk.annet;
    return x;
  });
  var dager = Object.keys(perDag).sort().map(function (k) {
    var d = perDag[k];
    return { dag: k, besok: d.besok, unike: Object.keys(d.unike).length, klikk: d.klikk, salg: d.salg, omsetning: d.omsetning };
  });
  var tot = dager.reduce(function (a, d) {
    a.besok += d.besok; a.unike += d.unike; a.klikk += d.klikk; a.salg += d.salg; a.omsetning += d.omsetning; return a;
  }, { besok: 0, unike: 0, klikk: 0, salg: 0, omsetning: 0 });
  var knapper = { hero: 0, sticky: 0, final: 0, annet: 0 };
  liste.forEach(function (x) { Object.keys(knapper).forEach(function (c) { knapper[c] += x.klikk[c]; }); });

  var siste = ordre.slice(-25).reverse().map(function (r) {
    return { ordre: r[O.ordre], tid: r[O.opprettet], status: r[O.status], navn: r[O.navn], epost: r[O.epost], telefon: r[O.telefon],
      nedlastinger: r[O.nedlastinger], belop: r[O.belop], cta: r[O.cta] || String(r[O.kilde] || '').split(' / ')[0], partner: r[O.partner],
      betaling: String(r[O.ordre]).indexOf('TEST-') === 0 ? 'test' : (r[O.betaling] || 'bedrift') };
  });

  // Vipps privat: ordre som venter på betaling, og innbetalinger som ikke ble koblet automatisk
  var ventende = ordre.filter(function (r) {
    return r[O.betaling] === 'privat' && r[O.status] === 'VENTER_BANK' && new Date(r[O.opprettet]).getTime() > Date.now() - 7 * 864e5;
  }).reverse().map(function (r) {
    return { ordre: r[O.ordre], tid: r[O.opprettet], navn: r[O.navn], vippsNavn: r[O.vipps_navn], epost: r[O.epost], belop: r[O.belop] };
  });
  var Bk = {}; BANK_KOLONNER.forEach(function (k, i) { Bk[k] = i; });
  var umatchede = sheet_(BANK_ARK).getDataRange().getValues().slice(1).filter(function (r) {
    return r[Bk.status] === 'UMATCHET' || r[Bk.status] === 'DUPLIKAT' || r[Bk.status] === 'FEIL_BELOP';
  }).slice(-30).reverse().map(function (r) {
    return { bankId: String(r[Bk.bank_id]), dato: r[Bk.dato] instanceof Date ? dag(r[Bk.dato]) : String(r[Bk.dato]), belop: r[Bk.belop],
      navn: r[Bk.navn], tekst: r[Bk.tekst], status: r[Bk.status], forslag: String(r[Bk.ordre] || '') };
  });

  return { ok: true, periode: n, statsFra: statsFra, totalt: tot, dager: dager, kilder: liste, knapper: knapper, enheter: enheter, siste: siste,
    perBetaling: perBetaling, ventende: ventende, umatchede: umatchede, innstillinger: innstillinger_() };
}

/* ------------------------------------------------------------------ */
/* Hjelpere for regnearket                                             */
/* ------------------------------------------------------------------ */

function findOrder_(field, value, last) {
  var sh = sheet_(ORDRE_ARK);
  var vals = sh.getDataRange().getValues();
  var col = ORDRE_KOLONNER.indexOf(field);
  var hit = null;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][col]).toLowerCase() === String(value).toLowerCase()) {
      hit = i;
      if (!last) break;
    }
  }
  if (hit === null) return null;
  var data = {};
  ORDRE_KOLONNER.forEach(function (k, j) { data[k] = vals[hit][j]; });
  return { row: hit + 1, data: data };
}

function updateOrder_(row, fields) {
  var sh = sheet_(ORDRE_ARK);
  Object.keys(fields).forEach(function (k) {
    sh.getRange(row, ORDRE_KOLONNER.indexOf(k) + 1).setValue(celle_(fields[k]));
  });
}

/** Hindrer at tekst fra nettet (f.eks. «=IMPORTDATA(...)») blir tolket som formel i regnearket. */
function celle_(v) {
  return (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;
}

/** Tilfeldig hemmelig nøkkel med heksadesimale tegn. */
function nyNokkel_(len) {
  var s = '';
  while (s.length < (len || 32)) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, len || 32);
}

// ---------- Test av Vipps-lenker (vipps-test.html) ----------

var VTEST_VARIANTER = {
  'https-nr': 'Nettadresse, bare nummer', 'https-alt': 'Nettadresse med beløp og melding', 'https-belop': 'Nettadresse med beløp',
  'vipps-alt': 'vipps:// med beløp og melding', 'vipps-nr': 'vipps://, bare nummer', 'intent-alt': 'Android-intent med beløp og melding',
  'vipps-app': 'Bare åpne Vipps-appen'
};
var VTEST_SVAR = { ok: '✓ Åpnet med alt utfylt', delvis: '◐ Åpnet, men mangler noe', nei: '✗ Åpnet ikke Vipps' };
var VTEST_DELER = { nummer: 'nummer', belop: 'beløp', melding: 'melding' };
var VTEST_STEDER = {
  'iphone-safari': 'iPhone, Safari', 'iphone-instagram': 'iPhone, Instagram', 'iphone-facebook': 'iPhone, Facebook',
  'iphone-messenger': 'iPhone, Messenger', 'iphone-gmail': 'iPhone, Gmail', 'android-chrome': 'Android, Chrome',
  'android-instagram': 'Android, Instagram', 'android-facebook': 'Android, Facebook', 'android-messenger': 'Android, Messenger',
  'android-gmail': 'Android, Gmail', 'pc': 'PC, QR-kode'
};
var VTEST_PER_DAG = 40;

/** Lagrer resultatene fra ett sted i arket Vippstest og sender dem til deg på e-post. Mobilnummeret lagres ikke. */
function vippsTest_(p) {
  var rent = function (v, maks) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maks); };
  var sted = VTEST_STEDER[p.stedId];
  if (!sted) throw new Error('Velg hvor du tester fra.');
  var tolk = function (v) { try { return (typeof v === 'string' ? JSON.parse(v) : v) || {}; } catch (e) { return {}; } };
  var res = tolk(p.res), mangler = tolk(p.mangler);
  // Hva som manglet ved «◐»: bare kjente deler, i fast rekkefølge.
  var manglerFor = function (id) {
    var l = Array.isArray(mangler[id]) ? mangler[id] : [];
    return Object.keys(VTEST_DELER).filter(function (d) { return l.indexOf(d) >= 0; });
  };
  var linjer = [];
  Object.keys(VTEST_VARIANTER).forEach(function (id) {
    var s = res[id], m = s === 'delvis' ? manglerFor(id) : [];
    var tekst = m.length ? '◐ Åpnet, men mangler ' + m.map(function (d) { return VTEST_DELER[d]; }).join(' og ') : (VTEST_SVAR[s] || 'ikke testet');
    linjer.push('- ' + VTEST_VARIANTER[id] + ': ' + tekst);
  });
  var testet = Object.keys(VTEST_VARIANTER).filter(function (id) { return VTEST_SVAR[res[id]]; });
  if (!testet.length) throw new Error('Merk minst én variant før du sender.');

  var cache = CacheService.getScriptCache(), nok = 'vtest_' + Utilities.formatDate(new Date(), 'Europe/Oslo', 'yyyyMMdd');
  var n = Number(cache.get(nok) || 0) + 1;
  if (n > VTEST_PER_DAG) throw new Error('Nok tester for i dag. Prøv igjen i morgen.');
  cache.put(nok, String(n), 21600);

  var oppdaget = rent(p.oppdaget, 80), ua = rent(p.ua, 400), belop = rent(p.belop, 10), melding = rent(p.melding, 50);
  var lagret = {};
  testet.forEach(function (id) { var m = res[id] === 'delvis' ? manglerFor(id) : []; lagret[id] = res[id] + (m.length ? ':' + m.join('+') : ''); });
  sheet_(VTEST_ARK).appendRow([new Date().toISOString(), sted + ' (' + p.stedId + ')', oppdaget, JSON.stringify(lagret), belop, melding, ua]);

  var tekst = 'Vipps-lenketest fra: ' + sted + '\nSiden oppdaget: ' + oppdaget + '\nBeløp: ' + belop + ' kr, melding: «' + melding + '»\n\n' +
    linjer.join('\n') + '\n\nNettleser-ID: ' + ua;
  var sendt = varsle_('Vipps-lenketest: ' + sted, tekst);
  return { ok: true, sendt: sendt };
}

/** Hvilke steder som er sendt inn, med siste tidspunkt og hvor mange varianter som åpnet. Ingen nettleser-ID eller annet. */
function vippsTestListe_() {
  var steder = {};
  var ss = SpreadsheetApp.openById(cfg_('SHEET_ID')), sh = ss.getSheetByName(VTEST_ARK);
  if (sh) sh.getDataRange().getValues().slice(1).forEach(function (r) {
    var m = String(r[1] || '').match(/\(([a-z-]+)\)$/);
    if (!m || !VTEST_STEDER[m[1]]) return;
    var tid = r[0] instanceof Date ? r[0].toISOString() : String(r[0] || '');
    if (steder[m[1]] && steder[m[1]].tid >= tid) return;
    var res = {};
    try { res = JSON.parse(r[3] || '{}'); } catch (e) {}
    var telling = { ok: 0, delvis: 0, nei: 0 };
    Object.keys(res).forEach(function (id) { var s = String(res[id]).split(':')[0]; if (telling[s] != null) telling[s]++; });
    steder[m[1]] = { tid: tid, ok: telling.ok, delvis: telling.delvis, nei: telling.nei };
  });
  return { ok: true, steder: steder };
}

/** Enkel bremse mot misbruk: maks antall kall per minutt for hele løsningen. */
function begrens_(navn, maksPerMinutt) {
  var cache = CacheService.getScriptCache();
  var key = 'rate_' + navn + '_' + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  if (n > maksPerMinutt) throw new Error('Mange forespørsler akkurat nå. Prøv igjen om et minutt.');
}

function maskEmail_(e) {
  e = String(e || '');
  var at = e.indexOf('@');
  return at > 1 ? e[0] + '•••' + e.slice(at - 1) : e;
}

function formatPhone_(p) {
  p = String(p).replace(/\D/g, '');
  if (p.length === 10 && p.indexOf('47') === 0) p = p.slice(2);
  return p.length === 8 ? p.replace(/(\d{3})(\d{2})(\d{3})/, '$1 $2 $3') : p;
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

/* ------------------------------------------------------------------ */
/* Engangsoppsett – kjør fra redigeringsvinduet                        */
/* ------------------------------------------------------------------ */

/** 1) Lager regnearket og utløseren. Kjør én gang. */
function oppsett() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create('Vegansk juleribbe – ordrer og statistikk');
    props.setProperty('SHEET_ID', ss.getId());
  }
  sheet_(ORDRE_ARK); sheet_(BESOK_ARK);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollPending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollPending').timeBased().everyMinutes(5).create();
  sheet_(BANK_ARK);
  sikreBankUtloser_(); // Vipps privat: spør banken hvert minutt mens noen venter på betaling
  console.log('Regneark: ' + SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getUrl());
}

/** 2) Sett adminpassord: skriv passordet inn her, kjør funksjonen, og slett passordet fra koden etterpå. */
function settAdminPassord() {
  var passord = 'SKRIV-PASSORDET-HER';
  if (passord === 'SKRIV-PASSORDET-HER' || passord.length < 12) throw new Error('Velg et passord på minst 12 tegn');
  var salt = nyNokkel_(32);
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_SALT', salt);
  props.setProperty('ADMIN_PASSORD_HASH', hashPassord_(passord, salt));
  console.log('Passord lagret. Husk å fjerne det fra koden nå.');
}

/** 3) Test vannmerket uten Vipps: lager en PDF i Disken din med eksempeldata. */
function testVannmerke() {
  var bytes = stampPdf_({ navn: 'Kari Nordmann', epost: 'kari@example.no', telefon: '912 34 567', ordre: 'VJ-TEST' });
  var f = DriveApp.createFile(Utilities.newBlob(bytes, 'application/pdf', 'TEST-vannmerke.pdf'));
  console.log('Test-PDF: ' + f.getUrl());
}
