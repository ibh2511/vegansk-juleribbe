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

1. Lag den endelige PDF-en med **tomt vannmerkefelt** nederst.
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
| `MORKE_SIDER` | `1,4,11` (sider med mørk bunn, der vannmerket skal være lyst) |
| `LENKE_DAGER` | `7` |
| `MAKS_NEDLASTINGER` | `5` |

5. Velg funksjonen **`oppsett`** i menyen øverst og trykk **Kjør**. Godkjenn tilgangene Google ber om. Funksjonen lager regnearket og en utløser som sjekker ubetalte ordre hvert 5. minutt.
6. Åpne funksjonen **`settAdminPassord`**, bytt ut `SKRIV-PASSORDET-HER` med et passord på minst 10 tegn, kjør den, og **slett passordet fra koden** etterpå.
7. Kjør **`forberedMaster`**. Den lager en kopi av heftet med plass til vannmerket. Kjør den på nytt hver gang du laster opp en ny versjon av heftet (og oppdater `MASTER_PDF_ID` hvis det er en ny fil).
8. Kjør **`testVannmerke`**. Den lager `TEST-vannmerke.pdf` i Disken din. Åpne den og sjekk at linja nederst ser riktig ut.

## 5. Publiser backend

1. Trykk **Implementer → Ny implementering** → type **Nettapp**.
2. «Kjør som»: **Meg**. «Hvem har tilgang»: **Alle**.
3. Kopier nettapp-adressen (slutter på `/exec`).
4. Lim den inn i [`assets/config.js`](assets/config.js) som `VJ_API`, og sett `VJ_KONTAKT` til kontakt-e-posten. Commit endringen.

Når du endrer koden i Apps Script senere: **Implementer → Administrer implementeringer → ✏️ → Ny versjon**. Da beholder du samme adresse.

## 6. GitHub Pages

Repoet → **Settings → Pages** → «Deploy from a branch» → `main` og `/ (root)`. Siden blir tilgjengelig på `https://ibh2511.github.io/vegansk-juleribbe/`.

## 7. Test før lansering

Med `VIPPS_ENV=test`:

1. Åpne landingssiden på mobilen og trykk **Kjøp med Vipps**.
2. Betal i **Vipps MT**-appen med testbrukeren.
3. Sjekk at takkesiden viser nedlastingsknappen, at e-posten kommer, og at PDF-en har riktig vannmerke.
4. Prøv å avbryte en betaling og sjekk at siden sier at ingenting ble trukket.
5. Logg inn på `/admin.html` og se at ordren og besøkene vises.

## 8. Lansering

1. Bytt Vipps-verdiene til **produksjonsnøklene** og sett `VIPPS_ENV` til `prod`.
2. Lag en ny versjon av implementeringen (se steg 5).
3. Gjør ett ekte kjøp selv og refunder det i Vipps-portalen.
4. Fyll inn foretaksnavn, adresse og e-post i `vilkar.html`, `personvern.html` og bunnteksten på forsiden.

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
- **Adminpassordet** lagres bare som en hash. Etter 10 feil forsøk stenges innloggingen i 15 minutter.
- **Regnearket** er beskyttet mot formel-injeksjon fra tekst som kommer fra nettet.
- **Bremse mot misbruk:** maks 30 nye kjøp og 300 sidevisninger per minutt.
- **«Send ny lenke»** svarer likt uansett om e-posten finnes, så ingen kan sjekke hvem som har kjøpt.

Dette må du gjøre selv:

- Slå på **totrinnsbekreftelse** på Google-, GitHub- og Vipps-kontoen.
- **Ikke del** regnearket, heftet i Disken eller Apps Script-prosjektet med noen.
- Bruk et **langt, unikt adminpassord** (gjerne fra en passordbehandler), og logg ut av adminpanelet på delte maskiner.
- Ser du mistenkelig aktivitet, bytter du Client Secret i Vipps-portalen og kjører `settAdminPassord` med nytt passord.

Vannmerket er avskrekkende, men ikke kopisikkert: noen med PDF-verktøy kan fjerne linja. Ordrenummeret ligger også skjult i PDF-ens metadata, slik at du kan spore en delt kopi.
