// Lim inn adressen til Apps Script-web-appen her (slutter på /exec). Se OPPSETT.md.
window.VJ_API = "https://script.google.com/macros/s/AKfycbw7lndGNmZ-XA401wgLCG-ZaAnNA3Wafbn51-dDX06YAeLlru-_IWweSY1_QJ-C_D16/exec";
window.VJ_KONTAKT = "vegansk.julemat@gmail.com"; // e-post kundene kan skrive til

// Reserveverdier for prisen. Når VJ_API er satt, henter siden pris og datoer fra backend
// (Script Properties PRIS, LANSERING_PRIS, LANSERING_START, LANSERING_SLUTT), og Vipps tar samme beløp.
// Lanseringsprisen gjelder fra START til (men ikke med) SLUTT, altså 26. november til og med 2. desember.
window.VJ_PRIS = 149;
window.VJ_LANSERING_PRIS = 99;
window.VJ_LANSERING_START = "2026-11-26T00:00:00+01:00";
window.VJ_LANSERING_SLUTT = "2026-12-03T00:00:00+01:00";
