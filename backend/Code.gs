/**
 * Vegansk juleribbe – salgsbackend (Google Apps Script)
 *
 * Gjør dette:
 *  - Oppretter Vipps-betaling (ePayment API) og sender kunden til Vipps
 *  - Sjekker betaling, trekker beløpet og henter navn, e-post og telefon fra Vipps
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
    start: o.start.toISOString(), slutt: o.slutt.toISOString(), naa: naa.toISOString(), fase: fase };
}

var ORDRE_ARK = 'Ordrer';
var BESOK_ARK = 'Besøk';
var ORDRE_KOLONNER = ['ordre', 'opprettet', 'status', 'navn', 'epost', 'telefon', 'token',
  'nedlastinger', 'utloper', 'kilde', 'betalt', 'epost_sendt', 'nokkel', 'belop', 'cta', 'partner'];
var BESOK_KOLONNER = ['tid', 'side', 'kilde', 'utm_source', 'utm_campaign', 'enhet', 'besokende', 'partner'];
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

function sheet_(name) {
  var ss = SpreadsheetApp.openById(cfg_('SHEET_ID'));
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (name === ORDRE_ARK) sh.appendRow(ORDRE_KOLONNER);
    if (name === BESOK_ARK) sh.appendRow(BESOK_KOLONNER);
    sh.setFrozenRows(1);
  } else if (name === ORDRE_ARK && sh.getLastColumn() < ORDRE_KOLONNER.length) {
    sh.getRange(1, 1, 1, ORDRE_KOLONNER.length).setValues([ORDRE_KOLONNER]); // nye kolonner i eldre ark
  } else if (name === BESOK_ARK && sh.getLastColumn() < BESOK_KOLONNER.length) {
    sh.getRange(1, 1, 1, BESOK_KOLONNER.length).setValues([BESOK_KOLONNER]);
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
  try {
    switch (p.action) {
      case 'create':   begrens_('create', 30); return json_(createPayment_(p));
      case 'status':   return json_(checkOrder_(p.ordre, p.k));
      case 'download': return json_(download_(p.t));
      case 'hit':      begrens_('hit', 300); return json_(hit_(p));
      case 'pris':     begrens_('pris', 300); return json_(prisInfo_());
      case 'admin':    return json_(adminLogin_(p.passord));
      case 'stats':    return json_(adminStats_(p.okt, p.dager));
      case 'logout':   return json_(adminLogout_(p.okt));
      case 'nullstill': return json_(adminNullstill_(p.okt, p.angre));
      case 'testkjop': return json_(adminTestkjop_(p));
      case 'resend':   return json_(resend_(p.epost));
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
    sheet_(ORDRE_ARK).appendRow(ORDRE_KOLONNER.map(function (k) { return celle_(row[k]); }));
  } finally { lock.releaseLock(); }

  var site = cfg_('SITE_URL').replace(/\/$/, '');
  var res = vipps_('post', '/epayment/v1/payments', {
    amount: { currency: 'NOK', value: row.belop * 100 },
    paymentMethod: { type: 'WALLET' },
    reference: ordre,
    userFlow: 'WEB_REDIRECT',
    returnUrl: site + '/takk.html?ordre=' + encodeURIComponent(ordre) + '&k=' + row.nokkel,
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
function checkOrder_(ordre, nokkel, fraUtloser) {
  if (!/^(VJ|TEST)-\d{5,}$/.test(ordre || '')) throw new Error('Ugyldig ordrenummer');
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
      betalt: new Date()
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
    '<tr><td style="padding:24px 32px 6px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f1e3;border:1px solid #e6d8bf;border-radius:10px;' + sans + ';font-size:15px;color:#2a1d17">' +
    '<tr><td style="padding:14px 18px 6px;color:#6b5a4e">Ordrenummer</td><td align="right" style="padding:14px 18px 6px;font-weight:bold">' + ordre + '</td></tr>' +
    '<tr><td style="padding:6px 18px;color:#6b5a4e">Produkt</td><td align="right" style="padding:6px 18px">Heftet som PDF</td></tr>' +
    '<tr><td style="padding:6px 18px 14px;color:#6b5a4e;border-top:1px solid #e6d8bf">Betalt</td><td align="right" style="padding:6px 18px 14px;font-weight:bold;border-top:1px solid #e6d8bf">' + kr + ' kr</td></tr>' +
    '</table></td></tr>' +
    // Hilsen
    '<tr><td style="padding:28px 32px 30px;' + sans + ';font-size:17px;line-height:1.5;color:#2a1d17">' +
    '<p style="margin:0">God jul!</p>' +
    '<p style="margin:4px 0 0;' + serif + ';font-size:24px;font-style:italic;color:#741218">Celia</p>' +
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
    'God jul og lykke til på kjøkkenet!\nCelia',
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
    }
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
      nedlastinger: r[O.nedlastinger], belop: r[O.belop], cta: r[O.cta] || String(r[O.kilde] || '').split(' / ')[0], partner: r[O.partner] };
  });

  return { ok: true, periode: n, statsFra: statsFra, totalt: tot, dager: dager, kilder: liste, knapper: knapper, enheter: enheter, siste: siste };
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
