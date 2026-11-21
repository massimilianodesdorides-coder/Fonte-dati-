# Come testiamo Lavoro Facile

Un'app che tratta dati personali, soldi e lavoro delle persone non si prova "a occhio". Questo documento
dice **cosa può andare storto**, **come lo cerchiamo** e **cosa manca ancora** prima del lancio.

## I rischi, in ordine di gravità

1. **Fuga di dati personali**: telefono, codice fiscale, foto, selfie, note private, giudizi. Una persona vede ciò che non deve.
2. **Azioni non autorizzate**: qualcuno si dà un bollino, accetta al posto di un altro, legge o cancella dati altrui.
3. **Errori sui soldi**: paga o commissioni registrate due volte, o mai; importi sbagliati.
4. **Persone fuori posto**: più persone dei posti, due turni sovrapposti, una riserva senza garanzia.
5. **Decisioni automatiche ingiuste o opache**: classifica, scelta automatica, penalità. Vanno spiegabili e contestabili.
6. **Cancellazione incompleta** dell'account (diritto all'oblio).
7. **Interfaccia che inganna o esclude**: schermate poco leggibili, messaggi poco chiari, impossibile da usare con screen reader.
8. **Disponibilità**: il giorno dell'evento il sistema deve reggere e non perdere dati.

## Le difese automatiche (si lanciano con un comando, ad ogni modifica)

| Livello | Cosa prova | File | Test |
|---|---|---|---|
| Regole di funzionamento | classifica, inviti, garanzie, soldi, presenze, no-show, annullamenti, giudizi, candidature, canali | `sql/business.test.mjs` | 25 |
| Sicurezza | permessi esatti, funzioni esposte, visibilità riga per riga per ogni utente, tentativi di scavalcare le regole, iniezione SQL, cancellazione dell'account | `sql/security.test.mjs` | 21 |
| Fiducia e identità | codice fiscale (anche contro un riferimento indipendente), livelli, conferma sul campo, foto | `sql/trust.test.mjs` | 18 |
| Invarianti | 1000 operazioni casuali in 4 serie ripetibili; dopo ognuna si controllano 19 regole che non devono mai essere violate | `sql/invariants.test.mjs` | 4 |
| Concorrenza | più persone nello stesso istante su un PostgreSQL vero (ultimo posto, slot di riserva, no-show doppio) | `sql/concurrency.test.mjs` | 5 |
| Interfaccia | percorsi completi di organizzatore e lavoratore, codice malevolo nei testi, accessibilità (chiaro e scuro), telefono stretto | `e2e/demo.test.mjs` | 12 |

Le liste di permessi e di funzioni esposte sono **"congelate"**: se una modifica ne cambia una, il test fallisce
e costringe a decidere di proposito. È la protezione contro il tipico errore "ho aggiunto una funzione e
l'ho lasciata aperta a tutti".

## Cosa hanno già trovato

I test non sono teoria: scritti per la prima volta, hanno scoperto difetti veri, tutti corretti.

- Permessi troppo larghi per l'utente anonimo sulle tabelle (protetti da una sola barriera): aggiunta la seconda (`schema_fase2i_permessi.sql`).
- Le funzioni nuove erano eseguibili da tutti per impostazione predefinita: ora nascono chiuse.
- Un errore nelle regole sulle candidature (ricorsione infinita) impediva a chiunque di candidarsi.
- **Stallo (deadlock)** con venti persone che accettano insieme: le righe venivano bloccate in ordine diverso.
- **Posto occupato due volte** dopo una sostituzione: l'organizzatore poteva assegnare una terza persona.
- Messaggi tecnici al posto di rifiuti chiari: candidatura accettata due volte, check-in inviato due volte.
- Notifiche con il nome di una persona che restavano dopo la cancellazione del suo account.
- Colori dei badge sotto la soglia di leggibilità e testo bianco su rosso nel tema scuro.
- Un codice SMS sbagliato obbligava a ricominciare da capo la verifica.

## Cosa NON è ancora coperto (da fare prima del lancio)

1. **Prova su Supabase vero**, non solo su PostgreSQL: email di conferma, SMS, Storage (foto e selfie), Realtime, `pg_cron`. Serve un ambiente di collaudo (staging) con dati finti.
2. **Fornitore di identità e pagamenti**: oggi simulati. Vanno provati con il fornitore reale, compresi i webhook e gli esiti strani (pagato ma verifica fallita, richiamato due volte).
3. **Dispositivi reali**: iPhone e Android, con fotocamera, GPS, rete lenta, schermata bloccata durante il check-in.
4. **Carico**: un evento con centinaia di persone che fanno check-in nello stesso quarto d'ora.
5. **Backup e ripristino**: provare davvero a ripristinare un backup, non solo averlo.
6. **Controllo di sicurezza esterno** (penetration test) e **revisione legale** (privacy, collocamento, decisioni automatiche). Nessun test automatico li sostituisce.
7. **Persone vere**: cinque hostess e tre organizzatori che provano l'app senza istruzioni.

## Gli agenti: come usarli

Gli agenti sono utili dove un test scritto prima non arriva: pensare "come potrei rompere questo?". Regole fisse:
**solo su dati finti** (demo o collaudo), **mai sulla produzione**, **solo lettura del codice** (riferiscono, non
modificano), e ogni segnalazione deve avere **una prova ripetibile** (uno script o una sequenza di passi).
Quando un agente trova un difetto, prima si scrive il test che lo fa fallire, poi si corregge.

### 1. Agente "attaccante" (sicurezza)
> Sei un attaccante con un account da lavoratore e uno da organizzatore sul database di prova (`tests/lib/db.mjs`,
> `newDb()` o `richDb()`). Leggi gli schemi SQL in `schema*.sql`. Obiettivo: leggere dati di altri utenti,
> scrivere dove non dovresti, ottenere un bollino che non hai, farti pagare due volte, bloccare un evento altrui.
> Prova funzioni con parametri ostili, chiamate fuori ordine, chiamate ripetute, ruoli sbagliati. Per ogni
> riuscita scrivi uno script ripetibile. Non modificare i file del progetto. Elenca anche ciò che hai tentato e
> non è riuscito.

### 2. Agente "esploratore" (usabilità e accessibilità)
> Usa la demo (`demo.html`) con un browser. Interpreta queste persone, una alla volta, senza leggere il codice:
> (a) una hostess alla prima volta che deve accettare un turno e fare il check-in; (b) un organizzatore
> frettoloso che deve coprire un no-show; (c) una persona con screen reader; (d) una persona con telefono
> piccolo e connessione lenta. Annota ogni punto in cui ti blocchi, non capisci un testo o devi indovinare.
> Riferisci passi, schermata e gravità. Non proporre grafica: segnala solo ostacoli.

### 3. Agente "revisore delle regole"
> Leggi le decisioni di prodotto (cronologia delle richieste e `GUIDA_APP.md`) e confrontale con i test in
> `tests/`. Elenca ogni regola dichiarata che non ha un test, e ogni test che verifica qualcosa di diverso da
> ciò che dice il nome. Proponi i test mancanti in ordine di rischio.

### 4. Agente "privacy e lavoro" (preparazione al legale, non è consulenza)
> Per ogni dato personale trattato (vedi `INFORMATIVA` in `app/app.js` e le tabelle in `schema*.sql`) indica:
> dove nasce, chi lo vede, quanto resta, come si cancella. Segnala dati raccolti senza finalità chiara,
> decisioni automatiche che incidono sul lavoro, e domande da fare a un avvocato del lavoro e della privacy.

### 5. Agente "guardiano" (continuo)
Gira a ogni modifica (CI, file `tests/ci/github-actions.yml`): lancia l'intera suite, e se qualcosa fallisce
riassume cosa è cambiato e quale regola è stata rotta.

## Criteri per aprire al pubblico

- Tutta la suite verde, concorrenza compresa, su un server PostgreSQL vero.
- Prova completa su Supabase di collaudo con almeno due account veri per ruolo.
- Penetration test esterno chiuso, senza difetti gravi aperti.
- Revisione legale: informativa, collocamento, decisioni automatiche, conservazione dei selfie.
- Ripristino di un backup provato.
- Un evento pilota piccolo (10-20 persone) con un organizzatore di fiducia, con supporto umano pronto.
- Un modo per segnalare e correggere errori su soldi e identità, con una persona che risponde.

## Come aggiungere un test

Ogni difetto trovato diventa un test **prima** di essere corretto: così non torna. Per il database si
scrive in `sql/*.test.mjs` usando `newDb()` e gli aiuti `db.as(utente, sql)`, `db.fails(...)`, `db.hidden(...)`.
Per l'interfaccia in `e2e/demo.test.mjs`. Se un'invariante nuova non deve mai essere violata, si aggiunge
all'elenco in `sql/invariants.test.mjs`: il fuzzer la controllerà dopo ogni operazione casuale.
