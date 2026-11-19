# Oppsett av salgsløsningen

Slik henger det sammen:

```
Kunde → landingssiden (GitHub Pages) → Vipps → takkesiden
                    ↕
        Google Apps Script (backend)
        ├─ Google Regneark: ordrer og besøk
        ├─ Google Disk: heftet (PDF)
        └─ Gmail: e-post med nedlastingslenke
```

Ingen hemmeligheter ligger i dette repoet. Vipps-nøkler og adminpassord ligger bare i Apps Script.

## 1. Google-kontoen

1. Lag en egen Google-konto for salget, for eksempel `veganskjuleribbe@gmail.com`. E-postene til kundene sendes fra denne adressen.
2. Slå på totrinnsbekreftelse.

## 2. Vipps-avtalen

1. Gå til [vippsmobilepay.com](https://vippsmobilepay.com/no) og søk om **«Betaling på nett»** (ePayment API) for org.nr. 925 145 602.
2. Når avtalen er godkjent, logger du inn på **portal.vippsmobilepay.com** → *Utvikler* og henter disse fire verdiene, først for **testmiljøet**:
   - Client ID
   - Client Secret
   - Ocp-Apim-Subscription-Key (primærnøkkel)
   - Merchant Serial Number (MSN)
3. Last ned appen **Vipps MT** (testversjonen) til testing. Testbrukeren finner du samme sted i portalen.

## 3. Last opp heftet

1. Bruk **`hefte-master.pdf`** (tomt vannmerkefelt nederst). Ikke bruk `hefte-mal.pdf`, som er forhåndsvisningen med eksempelnavnet «Kari Nordmann».
2. Last den opp til Google Disk i den nye kontoen. Ikke del filen med noen.
3. Åpne filen. ID-en er delen av adressen mellom `/d/` og `/view`. Den trenger du i steg 4.

## 4. Lag backend i Apps Script

1. Gå til [script.google.com](https://script.google.com) → **Nytt prosjekt**. Kall det «Vegansk juleribbe».
2. Slett innholdet i `Code.gs` og lim inn hele [`backend/Code.gs`](backend/Code.gs).
3. Under ⚙️ **Prosjektinnstillinger**: huk av for «Vis appsscript.json», og lim inn [`backend/appsscript.json`](backend/appsscript.json) i den filen.
4. Under ⚙️ **Prosjektinnstillinger → Skriptegenskaper**, legg til:

| Egenskap | Verdi |
|---|---|
| `VIPPS_ENV` | `test` (endres til `prod` ved lansering) |
| `VIPPS_CLIENT_ID` | fra Vipps-portalen |
| `VIPPS_CLIENT_SECRET` | fra Vipps-portalen |
| `VIPPS_SUBSCRIPTION_KEY` | fra Vipps-portalen |
| `VIPPS_MSN` | fra Vipps-portalen |
| `MASTER_PDF_ID` | ID-en fra steg 3 |
| `SITE_URL` | `https://ibh2511.github.io/vegansk-juleribbe` |
| `AVSENDER_NAVN` | `Vegansk juleribbe` |
| `SVAR_EPOST` | e-posten kundene kan svare til |
| `MORKE_SIDER` | `1,4,12` (sider med mørk bunn, der vannmerket skal være lyst) |
| `LENKE_DAGER` | `7` |
| `MAKS_NEDLASTINGER` | `5` |
| `PRIS` | valgfri, ordinær pris i kroner (standard `149`) |
| `LANSERING_PRIS` | valgfri, lanseringspris i kroner (standard `99`) |
| `LANSERING_START` | valgfri, når lanseringsprisen starter (standard `2026-11-26T00:00:00+01:00`) |
| `LANSERING_SLUTT` | valgfri, første tidspunkt med ordinær pris (standard `2026-12-03T00:00:00+01:00`, altså til og med 2. desember) |

Prisen bytter automatisk på datoene over: nettsiden spør backend om gjeldende pris, og Vipps-betalingen bruker den samme. Vil du endre pris eller datoer, endrer du bare disse egenskapene. Du trenger ikke publisere på nytt eller endre nettsiden.

5. Velg funksjonen **`oppsett`** i menyen øverst og trykk **Kjør**. Godkjenn tilgangene Google ber om. Funksjonen lager regnearket og en utløser som sjekker ubetalte ordre hvert 5. minutt.
6. Åpne funksjonen **`settAdminPassord`**, bytt ut `SKRIV-PASSORDET-HER` med et passord på minst 12 tegn, kjør den, og **slett passordet fra koden** etterpå.
7. Kjør **`forberedMaster`**. Den lager en kopi av heftet med plass til vannmerket. Kjør den på nytt hver gang du laster opp en ny versjon av heftet (og oppdater `MASTER_PDF_ID` hvis det er en ny fil).
8. Kjør **`testVannmerke`**. Den lager `TEST-vannmerke.pdf` i Disken din. Åpne den og sjekk at linja nederst ser riktig ut.

## 5. Publiser backend

1. Trykk **Implementer → Ny implementering** → type **Nettapp**.
2. «Kjør som»: **Meg**. «Hvem har tilgang»: **Alle**.
3. Kopier nettapp-adressen (slutter på `/exec`).
4. Lim den inn i [`assets/config.js`](assets/config.js) som `VJ_API`, og sett `VJ_KONTAKT` til kontakt-e-posten. Commit endringen.

Når du endrer koden i Apps Script senere: **Implementer → Administrer implementeringer → ✏️ → Ny versjon**. Da beholder du samme adresse.

Med automatisk oppdatering (se [Automatisk oppdatering av backend](#automatisk-oppdatering-av-backend)) skjer dette av seg selv når noe i `backend/` merges til `main`.

## 6. GitHub Pages

Repoet → **Settings → Pages** → «Deploy from a branch» → `main` og `/ (root)`. Siden blir tilgjengelig på `https://ibh2511.github.io/vegansk-juleribbe/`.

## 7. Test før lansering

Med `VIPPS_ENV=test`:

1. Åpne landingssiden på mobilen og trykk **Kjøp med Vipps**.
2. Betal i **Vipps MT**-appen med testbrukeren.
3. Sjekk at takkesiden viser nedlastingsknappen, at e-posten kommer, og at PDF-en har riktig vannmerke.
4. Prøv å avbryte en betaling og sjekk at siden sier at ingenting ble trukket.
5. Logg inn på `/admin.html` og se at ordren og besøkene vises.

**Testkjøp uten Vipps:** I adminpanelet under **Test** velger du «Helt testkjøp» og skriver inn din egen e-post. Da lages en betalt testordre (TEST-…), du får den ekte e-posten, og du kan åpne takkesiden og laste ned heftet med vannmerke. Testkjøp telles ikke i statistikken.

**Test av e-postene:** Under **Test** kan du også sende bare én av e-postene, merket [TEST], uten å lage en ordre: betalingsinfoen for Vipps privat, kvitteringen, og varslene du får om feil beløp, betaling som ikke ble koblet, og banktilgangen. E-postfeltet foreslår adressen i `VARSEL_EPOST` (eller `SVAR_EPOST`). Nedlastingslenken i test-kvitteringen virker ikke. Bruk «Helt testkjøp» for å teste nedlastingen.

**Testlenke med 1 kr:** Under **Test** trykker du «Lag testlenke». Lenken åpner forsiden med 1 kr som pris, og en gul stripe øverst sier at det er testpris. Bare den som åpner lenken, ser og betaler 1 kr. Alle andre ser vanlig pris. Lenken virker i 2 timer, og en ny lenke stopper den gamle. Kjøp med lenken får ordrenummer TEST-… og telles ikke i statistikken, men betalingen kobles og kvitteringen sendes som vanlig, med både Vipps privat og Vipps bedrift. Koden fjernes fra adressen når siden åpnes, og huskes bare i den fanen.

**E-postgrensen:** En vanlig Gmail-konto kan sende til 100 mottakere i døgnet. Vipps privat bruker to e-poster per salg (betalingsinfo og kvittering), Vipps bedrift én. Admin viser under **Test** hvor mange som er igjen. Er det 30 eller færre igjen, sendes ikke betalingsinfo (takkesiden viser den uansett), så kvitteringene og varslene har plass. Samme adresse får heller ikke betalingsinfo mer enn én gang i 10 minutter. En kvittering som ikke kom ut, sendes på nytt av utløseren når det er plass igjen, de første 3 døgnene etter kjøpet.

## 8. Lansering

1. Bytt Vipps-verdiene til **produksjonsnøklene** og sett `VIPPS_ENV` til `prod`.
2. Lag en ny versjon av implementeringen (se steg 5).
3. Gjør ett ekte kjøp selv og refunder det i Vipps-portalen.
4. Fyll inn foretaksnavn, adresse og e-post i `vilkar.html`, `personvern.html` og bunnteksten på forsiden.

**Feilsøking av Vipps bedrift:** Får kundene «Vi fikk ikke kontakt med Vipps», trykker du **Test Vipps bedrift** under Betalingsløsning i adminpanelet. Den lager en betaling på 1 kr, avbryter den med en gang, og viser hva Vipps svarte. Den vanligste årsaken er at nøklene er fra produksjon mens `VIPPS_ENV` ikke er satt til `prod`. Da står det «(testmiljø)» i adminpanelet. Når et kjøp feiler, får du også en e-post med feilmeldingen fra Vipps (høyst én i timen), og ordren får status FEILET.

## 9. Vipps privat (betaling til mobilnummer)

I adminpanelet under **Betalingsløsning** velger du mellom:

- **Vipps bedrift:** Betaling på nett med Vipps-avtalen, som beskrevet over. Vipps tar et gebyr per salg. Satsen fra avtalen, 2,99 % + 1 kr, er lagt inn i koden, så adminpanelet viser gebyr og netto. Satsen styres ikke av Skriptegenskaper. Endrer Vipps den, endres `GEBYR_PROSENT` og `GEBYR_KR` øverst i `backend/Code.gs`.
- **Vipps privat:** Kunden skriver navn og e-post, får et ordrenummer og vippser til mobilnummeret du legger inn. Backend leser innbetalingene på kontoen din i SpareBank 1 og kobler dem til ordren på navn og beløp. Når betalingen er funnet, får kunden kvitteringen med heftet.

Byttet gjelder med en gang på nettsiden. Tabellen **Salg per betalingsløsning** viser salg, omsetning, gebyr og netto for hver av dem.

**Slik kobler du til banken (gjøres én gang):**

1. Lag gjerne en egen konto i nettbanken, og velg den som konto for innbetalinger i Vipps-appen.
2. Gå til [developer.sparebank1.no](https://developer.sparebank1.no), logg inn og trykk **Create new client**. Velg SpareBank 1 Lom og Skjåk. Som redirect-adresse limer du inn adressen adminpanelet viser under **Banken** (backendadressen med `?action=bank` bak).
3. I adminpanelet under **Banken**: lim inn klient-ID og klienthemmelighet, og bank-ID hvis portalen viser en. Trykk **Koble til banken** og logg inn med BankID i fanen som åpnes.
4. Velg kontoen Vipps-pengene kommer inn på, og trykk **Test banken**. Da ser du de siste innbetalingene slik banken sender dem.

Hemmeligheten og tilgangen fra banken lagres bare i Skriptegenskaper (`BANK_CLIENT_ID`, `BANK_CLIENT_SECRET`, `BANK_REFRESH_TOKEN` m.fl.) og sendes aldri tilbake til nettleseren. Backend kaller bare konto- og transaksjonsoppslag og flytter aldri penger.

**Slik fungerer det:**

- Takkesiden viser betalingsboksen: kopier nummeret, åpne Vipps, betal, kom tilbake. Når kunden kommer tilbake til siden etter å ha trykket «Åpne Vipps» eller kopiert nummeret, bytter siden til «Vi ser etter betalingen din. Har du betalt, er du ferdig», så ingen tror de må betale på nytt. «Vis betalingen» tar dem tilbake til stegene. Siden vet ikke at noen har betalt før banken viser betalingen, så teksten er skrevet slik at den stemmer for begge. På PC vises en QR-kode. Er banken koblet til, får kunden e-post med samme informasjon bare hvis betalingen ikke har kommet etter 5 minutter (`EPOST_VENT_MIN` i `backend/Code.gs`). Betaler kunden med en gang, kommer bare kvitteringen med heftet. Uten banken sendes betalingsinfoen med en gang.
- «Åpne Vipps» bruker en lenke som fyller ut nummer, beløp og meldingen «Juleribbe VJ-…». Formatet er ikke offisielt dokumentert. Virker det ikke, kan du slå av utfyllingen i admin, så fylles bare nummeret ut. Test lenkene på `vipps-test.html` fra iPhone og Android (nettleseren, Instagram, Facebook, Messenger og Gmail) og PC. «Send inn» lagrer resultatene i arket «Vippstest» og sender dem på e-post til `VARSEL_EPOST` (eller `SVAR_EPOST`). Mobilnummeret sendes ikke med.
- Inne i Instagram, Facebook, TikTok og andre apper kan ikke kunden laste ned heftet, så nedlastingssiden ber kunden åpne i Safari eller Chrome. Test hvilke måter som virker i hver app på `nettleser-test.html`. Åpne lenken inne i hver app på iPhone og Android, trykk «Prøv» på variantene og merk resultatet. Kommer siden over i nettleseren, står det «Det virket». Resultatene lagres i arket «Nettlesertest» og sendes på e-post som for Vipps-testen.
- Mens kunden står på takkesiden, spør siden hvert 10. sekund, og backend spør banken høyst hvert 20. sekund. I tillegg sjekker en utløser banken hvert minutt de første 2 timene etter siste ordre, deretter hvert 5. minutt til 48 timer har gått, og bare når noen faktisk ikke har betalt. Det holder skriptet godt under Googles grense på 90 minutter utløsertid i døgnet, som deles med juletreff-skriptet på samme Google-konto. Utløseren lages når du kobler til banken eller velger Vipps privat.
- Innbetalinger kobles på ordrenummeret i meldingen hvis det følger med, ellers på fornavn, etternavn og beløp. Ekstra navn i Vipps (mellomnavn, to fornavn) gjør ingenting. Venter bare én ordre på beløpet, holder det at ett av navnene stemmer (for eksempel «Kris» i Vipps og «Kristian» i skjemaet, eller nytt etternavn).
- Bare innbetalinger med heftets beløp lagres (fanen **Bank**). Unntaket er når en kunde som venter, har betalt feil beløp (navnet eller ordrenummeret står i bankteksten). Den lagres som «Feil beløp» med ordren som forslag i adminpanelet. Private vippsinger med andre beløp lagres ikke.
- Samme Vipps-nummer og konto brukes av juletreffet på KUMI. Innbetalinger med «Juletreff» eller et JT-nummer i meldingen hoppes over, så de blir aldri koblet til en ordre her eller gir «Feil beløp». Juletreffet hopper over «Juleribbe» og VJ- og TEST-numre på samme måte.
- Du får e-post (til `VARSEL_EPOST`, ellers `SVAR_EPOST`) når en betaling har feil beløp, eller når en betaling med riktig beløp ikke kan kobles til en ordre. Trykk «Koble» i adminpanelet, så får kunden heftet.
- Innbetalinger som ikke kan kobles sikkert, havner i adminpanelet under **Vipps privat: venter på betaling**. Der kobler du dem til riktig ordre, eller trykker **Marker som betalt** når du har sett betalingen i nettbanken. Det fungerer også uten bankkobling.
- Går tilgangen til banken ut eller slutter å virke, får du e-post til `VARSEL_EPOST` (eller `SVAR_EPOST`) med beskjed om å koble til på nytt.
- Hver privat-ordre sender to e-poster (betalingsinfo og kvittering). Med Gmail-grensen på 100 e-poster i døgnet holder det til ca. 50 salg om dagen.

## Automatisk oppdatering av backend

Når dette er satt opp, sendes `backend/Code.gs` og `appsscript.json` til Apps Script og implementeringen får en ny versjon hver gang noe i `backend/` merges til `main`. Nettadressen til backenden er den samme. Bruk Google-kontoen som eier heftets Apps Script i alle stegene, ikke kontoen til juletreff-kumi.

1. Åpne [script.google.com/home/usersettings](https://script.google.com/home/usersettings), sjekk at riktig konto står øverst til høyre, og slå på **Google Apps Script API**.
2. I Terminal (Ubuntu: Ctrl+Alt+T), én linje om gangen. Den første flytter en eventuell innlogging for kumi til side:
   ```bash
   mv ~/.clasprc.json ~/.clasprc-kumi.json
   npx @google/clasp@2.4.2 login
   cat ~/.clasprc.json
   ```
   Logg inn med heftekontoen i nettleseren som åpnes. Kopier alt fra `{` til `}` som siste linje viser (Ctrl+Shift+C). Mangler `npx`, kjører du `sudo snap install node --classic` først.
3. I GitHub: **Settings → Secrets and variables → Actions**.
   - Under **Secrets**: `CLASPRC_JSON` med innholdet du kopierte.
   - Under **Variables**: `APPS_SCRIPT_ID` (Apps Script → tannhjulet → Skript-ID) og `APPS_SCRIPT_DEPLOYMENT_ID` (ID-en i backendadressen, mellom `/s/` og `/exec`).
4. Under **Actions** kjører du «Deploy Apps Script» én gang med **Run workflow** for å teste.

Secret-et gir tilgang til Apps Script-prosjektene på kontoen. Koden i repoet overskriver det som ligger i Apps Script, så gjør endringer i repoet og ikke i Apps Script-editoren. Skriptegenskaper røres ikke.

## Samarbeidslenker

Gi hver samarbeidspartner sin egen lenke med `?fra=navn`, for eksempel:

- `…/vegansk-juleribbe/?fra=gronnehverdag`
- `…/vegansk-juleribbe/?fra=veganmamma`

Lag lenkene i adminpanelet under **Lag samarbeidslenke**. I tabellen **Kilder og samarbeid** ser du for hver partner:
unike besøkende, besøk, trykk på hver av de tre Vipps-knappene (øverst, mobil nederst på skjermen, kjøpskortet nederst),
salg, omsetning og konvertering. Trykk på en kolonne for å sortere, og velg periode øverst.

Har en kunde fulgt flere lenker, teller den siste lenken hun kom fra.

**Nullstill statistikk** nederst i adminpanelet lar tellingen starte på null, for eksempel når en kampanje starter. Ingen ordre eller besøk slettes (tidspunktet lagres som `STATS_FRA` i Skriptegenskaper), og du kan angre.

## Markedsføring med sporing

Legg til `?utm_source=` og `?utm_campaign=` på lenkene du deler. Da ser du i adminpanelet hvor salget kommer fra:

- Bio på Instagram: `…/vegansk-juleribbe/?utm_source=instagram&utm_campaign=bio`
- Story: `…/?utm_source=instagram&utm_campaign=story-uke48`
- Samarbeidspartner: `…/?utm_source=partnernavn`

## Grenser å kjenne til

- Gmail-kontoer kan sende 100 e-poster i døgnet fra Apps Script. Det holder for ca. 100 salg om dagen.
- Apps Script tåler ca. 30 samtidige forespørsler. Det holder godt for et julehefte.
- Adminpanelet er beskyttet av passordet i backend. Selve siden er offentlig, men den viser ingenting uten riktig passord.

## Sikkerhet

Dette er innebygd:

- **Ingen hemmeligheter i repoet.** Vipps-nøkler og adminpassord ligger bare i Skriptegenskaper i Apps Script.
- **Betalingen sjekkes alltid direkte hos Vipps**, aldri ut fra hva nettleseren sier. Det går ikke an å «late som» man har betalt.
- **Hemmelig nøkkel per ordre.** Takkesiden må ha nøkkelen fra Vipps-returadressen for å vise nedlastingslenken, så ingen kan gjette seg til andres ordrenummer.
- **Nedlastingslenker** er lange tilfeldige koder, går ut etter 7 dager og virker maks 5 ganger.
- **Adminpassordet** lagres bare som en saltet hash (2000 runder SHA-256). Etter 10 feil forsøk stenges innloggingen i 15 minutter.
- **Innlogging i adminpanelet** gir en tilfeldig nøkkel som varer i 2 timer og slettes ved «Logg ut». Passordet lagres aldri i nettleseren.
- **Adminsiden** har streng innholdssikkerhet (CSP), så den bare kan snakke med Apps Script, og den skjules for søkemotorer.
- **Regnearket** er beskyttet mot formel-injeksjon fra tekst som kommer fra nettet.
- **Bremse mot misbruk:** maks 30 nye kjøp og 300 sidevisninger per minutt.
- **«Send ny lenke»** svarer likt uansett om e-posten finnes, så ingen kan sjekke hvem som har kjøpt.

Dette må du gjøre selv:

- Slå på **totrinnsbekreftelse** på Google-, GitHub- og Vipps-kontoen.
- **Ikke del** regnearket, heftet i Disken eller Apps Script-prosjektet med noen.
- Bruk et **langt, unikt adminpassord** (gjerne fra en passordbehandler), og logg ut av adminpanelet på delte maskiner.
- Ser du mistenkelig aktivitet, bytter du Client Secret i Vipps-portalen og kjører `settAdminPassord` med nytt passord.

Vannmerket er avskrekkende, men ikke kopisikkert: noen med PDF-verktøy kan fjerne linja. Ordrenummeret ligger også skjult i PDF-ens metadata, slik at du kan spore en delt kopi.
