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
var PRIS_ORE = 14900;              // ordinær pris
var LANSERING_PRIS_ORE = 9900;     // lanseringspris
var LANSERING_SLUTT = new Date('2026-12-03T00:00:00+01:00'); // lanseringsprisen gjelder til og med 2. desember

function prisOre_(tid) {
  return (tid || new Date()) < LANSERING_SLUTT ? LANSERING_PRIS_ORE : PRIS_ORE;
}
var ORDRE_ARK = 'Ordrer';
var BESOK_ARK = 'Besøk';
var ORDRE_KOLONNER = ['ordre', 'opprettet', 'status', 'navn', 'epost', 'telefon', 'token',
  'nedlastinger', 'utloper', 'kilde', 'betalt', 'epost_sendt', 'nokkel', 'belop'];

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
    if (name === BESOK_ARK) sh.appendRow(['tid', 'side', 'kilde', 'utm_source', 'utm_campaign', 'enhet', 'besokende']);
    sh.setFrozenRows(1);
  } else if (name === ORDRE_ARK && sh.getLastColumn() < ORDRE_KOLONNER.length) {
    sh.getRange(1, 1, 1, ORDRE_KOLONNER.length).setValues([ORDRE_KOLONNER]); // nye kolonner i eldre ark
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
      case 'admin':    return json_(adminStats_(p.passord));
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
    var kilde = [p.cta, p.utm_source, p.utm_campaign].filter(String).join(' / ').slice(0, 120);
    row = {}; ORDRE_KOLONNER.forEach(function (k) { row[k] = ''; });
    row.ordre = ordre; row.opprettet = new Date(); row.status = 'OPPRETTET'; row.nedlastinger = 0; row.kilde = kilde;
    row.nokkel = nyNokkel_(); row.belop = prisOre_(row.opprettet) / 100;
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
  if (!/^VJ-\d{5,}$/.test(ordre || '')) throw new Error('Ugyldig ordrenummer');
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
  var morke = cfg_('MORKE_SIDER', '1,4,11').split(',').map(function (x) { return Number(x.trim()) - 1; });
  var doc = await PDFLib.PDFDocument.load(new Uint8Array(src.getBlob().getBytes()));
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
    size: ctx.largestObjectNumber + 1, startxref: startxref
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
  legg(info, info + ' 0 obj\n<< /Title (Vegansk juleribbe) /Subject ' + pdfStr_('Ordre ' + o.ordre) +
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
  var html =
    '<div style="font-family:Georgia,serif;max-width:520px;margin:auto;background:#fffaf0;border:1px solid #e6d8bf;border-radius:12px;overflow:hidden">' +
    '<div style="background:#9e1b22;color:#f8f1e3;padding:20px 24px;font-size:22px">Takk for kjøpet! 🎄</div>' +
    '<div style="padding:24px;color:#2a1d17;font-family:Arial,sans-serif;font-size:16px;line-height:1.6">' +
    '<p>Hei ' + escapeHtml_(fornavn) + '!</p>' +
    '<p>Her er heftet ditt med oppskriften på vegansk juleribbe med sprø, stekt svor.</p>' +
    '<p style="text-align:center;margin:28px 0"><a href="' + link + '" style="background:#1f3d2b;color:#f8f1e3;padding:14px 26px;border-radius:10px;text-decoration:none;font-weight:bold">Last ned heftet</a></p>' +
    '<p style="font-size:14px;color:#6b5a4e">Lenken virker i ' + dager + ' dager. Heftet er merket med navnet ditt og ordrenummeret og er kun til eget bruk.</p>' +
    '<p style="font-size:14px;color:#6b5a4e">Ordrenummer: <b>' + ordre + '</b> · Beløp: 99 kr (0 % mva)<br>' +
    'Du samtykket ved kjøpet til at heftet leveres med en gang, og bekreftet at angreretten dermed faller bort (angrerettloven § 22 bokstav n).</p>' +
    '<p>God jul og lykke til på kjøkkenet!<br>Celia</p></div></div>';
  GmailApp.sendEmail(to, 'Heftet ditt: Vegansk juleribbe (' + ordre + ')',
    'Takk for kjøpet! Last ned heftet her: ' + link + '\nOrdrenummer: ' + ordre,
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
    String(p.utm_campaign || '').slice(0, 40), p.mobil === '1' ? 'mobil' : 'pc', String(p.v || '').slice(0, 16)].map(celle_));
  return { ok: true };
}

function adminStats_(passord) {
  var cache = CacheService.getScriptCache();
  var forsok = Number(cache.get('admin_feil') || 0);
  if (forsok >= 10) throw new Error('For mange forsøk. Vent 15 minutter.');
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(passord || ''), Utilities.Charset.UTF_8));
  if (hash !== cfg_('ADMIN_PASSORD_HASH')) {
    cache.put('admin_feil', String(forsok + 1), 900);
    Utilities.sleep(800);
    return { ok: false, error: 'Feil passord' };
  }

  var tz = Session.getScriptTimeZone();
  var dag = function (d) { return Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd'); };
  var perDag = {};
  var ensure = function (k) { return perDag[k] = perDag[k] || { besok: 0, unike: {}, kjopstart: 0, salg: 0 }; };

  var kilder = {}, enheter = { mobil: 0, pc: 0 };
  var besok = sheet_(BESOK_ARK).getDataRange().getValues().slice(1);
  besok.forEach(function (r) {
    if (r[1] !== '/' && r[1] !== '/index.html') return;
    var d = ensure(dag(r[0]));
    d.besok++; if (r[6]) d.unike[r[6]] = 1;
    var k = r[3] || r[2] || 'direkte';
    kilder[k] = (kilder[k] || 0) + 1;
    enheter[r[5] === 'mobil' ? 'mobil' : 'pc']++;
  });

  var ordre = sheet_(ORDRE_ARK).getDataRange().getValues().slice(1);
  var siste = [], ctaSalg = {};
  ordre.forEach(function (r) {
    var d = ensure(dag(r[1]));
    d.kjopstart++;
    if (r[2] === 'BETALT') {
      d.salg++;
      var cta = String(r[9] || '').split(' / ')[0] || 'ukjent';
      ctaSalg[cta] = (ctaSalg[cta] || 0) + 1;
    }
  });
  ordre.slice(-25).reverse().forEach(function (r) {
    siste.push({ ordre: r[0], tid: r[1], status: r[2], navn: r[3], epost: r[4], telefon: r[5], nedlastinger: r[7], kilde: r[9] });
  });

  var dager = Object.keys(perDag).sort().map(function (k) {
    var d = perDag[k];
    return { dag: k, besok: d.besok, unike: Object.keys(d.unike).length, kjopstart: d.kjopstart, salg: d.salg };
  });
  var tot = dager.reduce(function (a, d) { a.besok += d.besok; a.unike += d.unike; a.kjopstart += d.kjopstart; a.salg += d.salg; return a; },
    { besok: 0, unike: 0, kjopstart: 0, salg: 0 });
  tot.omsetning = ordre.reduce(function (sum, r) {
    return sum + (r[2] === 'BETALT' ? (Number(r[13]) || LANSERING_PRIS_ORE / 100) : 0);
  }, 0);

  cache.remove('admin_feil');
  return { ok: true, totalt: tot, dager: dager, kilder: kilder, enheter: enheter, ctaSalg: ctaSalg, siste: siste };
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
  if (passord === 'SKRIV-PASSORDET-HER' || passord.length < 10) throw new Error('Velg et passord på minst 10 tegn');
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, passord, Utilities.Charset.UTF_8));
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSORD_HASH', hash);
  console.log('Passord lagret. Husk å fjerne det fra koden nå.');
}

/** 3) Test vannmerket uten Vipps: lager en PDF i Disken din med eksempeldata. */
function testVannmerke() {
  var bytes = stampPdf_({ navn: 'Kari Nordmann', epost: 'kari@example.no', telefon: '912 34 567', ordre: 'VJ-TEST' });
  var f = DriveApp.createFile(Utilities.newBlob(bytes, 'application/pdf', 'TEST-vannmerke.pdf'));
  console.log('Test-PDF: ' + f.getUrl());
}
