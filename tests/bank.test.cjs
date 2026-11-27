// Banksjekken: transaksjoner kjennes igjen på innholdet, selv om SpareBank 1 gir dem ny ID. Kjør: node tests/bank.test.cjs
const fs=require('fs'),vm=require('vm'),crypto=require('crypto'),assert=require('assert');
const ctx={console,Date,JSON,Math,Object,String,Number,Array,RegExp,Error,
  Utilities:{DigestAlgorithm:{MD5:'md5'},Charset:{UTF_8:'utf8'},
    computeDigest:(a,s)=>[...crypto.createHash('md5').update(s,'utf8').digest()].map(b=>b>127?b-256:b),
    formatDate:(d)=>d.toISOString().slice(0,10)},
  Session:{getScriptTimeZone:()=>'Europe/Oslo'},
  LockService:{getScriptLock:()=>({tryLock:()=>true,waitLock(){},releaseLock(){}})},
  PropertiesService:{getScriptProperties:()=>({setProperty(){},getProperty(){return null}})},
  CacheService:{getScriptCache:()=>({get(){return null},put(){}})}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../backend/Code.gs"), "utf8"), ctx);
const bank=[ctx.BANK_KOLONNER.slice()], ordre=[ctx.ORDRE_KOLONNER.slice()];
const fake=rows=>({getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),appendRow:r=>rows.push(r),
  getRange:(r,c)=>({setValue:v=>{rows[r-1][c-1]=v}})});
const O=k=>ctx.ORDRE_KOLONNER.indexOf(k);
const rad=(o)=>{const r=ctx.ORDRE_KOLONNER.map(()=> '');Object.keys(o).forEach(k=>r[O(k)]=o[k]);return r;};
ordre.push(rad({ordre:'VJ-1',betaling:'privat',status:'VENTER_BANK',opprettet:new Date(),navn:'Kari Nordmann',epost:'k@x.no',belop:99}));
let varsler=0, raa=[];
Object.assign(ctx,{bankKlar_:()=>true, sheet_:n=>n===ctx.ORDRE_ARK?fake(ordre):fake(bank), varsle_:()=>varsler++,
  prisOppsett_:()=>({ordinaer:149,lansering:99}), bankRaa_:()=>raa,
  markerPrivatBetalt_:(o,id)=>{ordre[o.row-1][O('status')]='BETALT';ordre[o.row-1][O('betalt')]=new Date();ordre[o.row-1][O('bank_id')]=id;o.data.status='BETALT';o.data.bank_id=id;}});
const tx=(id,navn,status,extra)=>Object.assign({id,amount:99,date:'2026-11-27',description:navn,bookingStatus:status},extra||{});
// 1) Reservert med navn: kobles
raa=[tx('a1','Kari Nordmann','PENDING'), tx('a2','Ola Ukjent','BOOKED')];
ctx.sjekkBank_();
assert.equal(ordre[1][O('status')],'BETALT');
assert.deepEqual(bank.slice(1).map(r=>r[8]),['KOBLET','UMATCHET']); assert.equal(varsler,1);
// 2) Samme transaksjoner med nye ID-er: ingenting nytt, ingen nye varsler
raa=[tx('b1','Kari Nordmann','PENDING'), tx('b2','Ola Ukjent','BOOKED')];
ctx.sjekkBank_(); assert.equal(bank.length,3); assert.equal(varsler,1);
// 3) Bokført versjon av reservasjonen: BOKFORT, ikke mulig dobbel betaling
raa=[tx('c1','Kari Nordmann','BOOKED'), tx('c2','Ola Ukjent','BOOKED')];
ctx.sjekkBank_(); assert.deepEqual(bank.slice(1).map(r=>r[8]),['KOBLET','UMATCHET','BOKFORT']);
// 4) Gamle rader med bankens ID kjennes igjen på innholdet
bank.splice(1); bank.push([new Date(),'gammel1','2026-11-27',99,'','Ola Ukjent','','BOOKED','UMATCHET','']);
raa=[tx('d1','Ola Ukjent','BOOKED')]; ctx.sjekkBank_(); assert.equal(bank.length,2);
// 5) To like i samme svar lagres begge
bank.splice(1); raa=[tx('e1','Per Hansen','BOOKED'),tx('e2','Per Hansen','BOOKED')]; ctx.sjekkBank_();
assert.equal(bank.length,3); assert.notEqual(bank[1][1],bank[2][1]);
console.log('alle banktester OK');

// «Legg til kjøper»: med «Har betalt» blir ordren betalt, uten mobilnummer for privat gis en feilmelding
Object.assign(ctx,{sjekkOkt_:()=>{}, nextOrderNo_:()=>'VJ-2000', prisOre_:()=>9900, nyNokkel_:()=>'n', privatNr_:()=>''});
let r=ctx.adminLeggTil_({navn:'Per Hansen',epost:'per@x.no',betalt:true});
assert.equal(r.ok,true); assert.equal(ordre[ordre.length-1][O('ordre')],'VJ-2000'); assert.equal(ordre[ordre.length-1][O('status')],'BETALT');
r=ctx.adminLeggTil_({navn:'Per Hansen',epost:'per@x.no',betalt:false}); assert.equal(r.ok,false);
r=ctx.adminLeggTil_({navn:'Per',epost:'per@x.no',betalt:true}); assert.equal(r.ok,false);
console.log('legg til kjøper OK');
