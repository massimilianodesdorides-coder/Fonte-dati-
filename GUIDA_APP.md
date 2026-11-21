# Lavoro Facile: l'app (demo e messa online)

## Cosa c'è

| File | A cosa serve |
|---|---|
| `app/` | il codice dell'app (`app.js`, `style.css`) e della demo (`demo_backend.js`, `demo_seed.sql`) |
| `tools/build.py` | unisce tutto in pagine singole |
| `app.html` | l'app **online**: parla con Supabase |
| `demo.html` | la **demo** da aprire dal computer (doppio clic): contiene un vero PostgreSQL |
| `schema*.sql` | il database, da caricare in quest'ordine: `schema.sql`, `schema_fase2.sql`, `2b`, `2c`, `2d`, `2e`, `2f`, `2g` |
| `tools/test_utenti.sql` | solo per i test: crea lavoratori finti (vedi sotto) |

`demo.html` non è nel repository (pesa 6 MB): si genera con `python3 tools/build.py`
dopo `cd tools && npm install @electric-sql/pglite@0.2.17 esbuild`.

## Provare la demo

Apri il link della pagina demo oppure `demo.html`. Scegli un utente:

1. **Evento Srl** (organizzatore): apri "Gala Aziendale", guarda "Candidati consigliati",
   invita qualcuno, aggiungi una garanzia no-show e invita una riserva.
2. Dagli "Strumenti demo" passa a **Marco Esperto** o **Nina Nuova**: vedi la proposta
   e la accetti. Passa a **Luca Libero** per accettare la riserva.
3. Strumenti demo → "Fai iniziare il prossimo evento". Come Marco fai il check-in
   dal Calendario; come organizzatore apri "Presenze", conferma Marco e segnala il
   no-show di Nina: la riserva subentra e riceve l'avviso.
4. Prova anche: scelta automatica, "Canali" (link per Subito, Facebook…), preferiti
   e "da evitare", annullamento di un ruolo, giudizi sull'organizzatore.

In demo i dati restano solo nel tuo browser e il selfie non viene conservato.

## Metterla online (computer, 40 minuti)

1. **Supabase**: crea il progetto (regione Europa) e, in *SQL Editor*, esegui i file
   SQL **in ordine**: `schema.sql`, `schema_fase2.sql`, `schema_fase2b_matching.sql`,
   `schema_fase2c_calendario.sql`, `schema_fase2d_evento_completo.sql`,
   `schema_fase2e_canali_scheda.sql`, `schema_fase2f_rating_organizzatori.sql`,
   `schema_fase2g_verifica_identita.sql`.
2. **Controlli automatici** (scadenze inviti, promemoria, chiusura garanzie):
   attiva l'estensione *pg_cron* (Database → Extensions) ed esegui
   ```sql
   select cron.schedule('inviti', '*/5 * * * *', 'select public.run_offer_maintenance()');
   select cron.schedule('garanzie', '*/10 * * * *', 'select public.close_guarantees()');
   ```
3. **Selfie di presenza**: Storage → nuovo bucket **privato** `checkins`; poi esegui le regole
   commentate in fondo a `schema_fase2.sql` (sezione 9).
4. **Impostazioni di sicurezza**: come in `GUIDA.md`, Passo 2 (conferma email, password
   di almeno 8 caratteri, CAPTCHA).
5. **Collega l'app**: apri `app/app.js`, in `CFG` inserisci *Project URL*, chiave
   *anon public* (mai la *service_role*) e il tuo nome come titolare; poi
   `python3 tools/build.py`. Pubblica `app.html` (rinominato `index.html`) su Netlify Drop.
   Metti l'indirizzo ottenuto in Supabase → Authentication → Site URL.
6. **Prova** con due account (organizzatore e lavoratore) come nella demo.

## Utenti finti per i test

- **Nella demo**: Strumenti demo, poi "Aggiungi 20 lavoratori di prova". Compaiono nelle classifiche
  (con storie, no-show, ritardi e qualcuno già verificato) e li trovi nel menu "Altri utenti di prova".
- **Online** (solo ambiente di test): dopo tutti gli schemi esegui `tools/test_utenti.sql`, poi
  ```sql
  select public.test_generate_workers(30);              -- 30 lavoratori a Milano
  select public.test_generate_workers(20, 'Roma', 50);  -- 20 a Roma, metà verificati
  select public.test_purge();                           -- li toglie tutti (email @test.invalid)
  ```
  Questi utenti non hanno password: servono a riempire le classifiche. Per provare l'app "da dentro"
  registra a mano due o tre account veri, con indirizzi tuoi (per esempio `tuamail+org@gmail.com` e
  `tuamail+marco@gmail.com`) e, solo durante i test, spegni "Confirm email" in
  Authentication, Providers, Email.
- **Non eseguire mai `test_utenti.sql` in produzione.**

## Identità verificata (facoltativa, a carico di chi la vuole)

- L'organizzatore può chiedere "solo persone con identità verificata" ruolo per ruolo, senza costi per lui.
- Un lavoratore non verificato che riceve una proposta su quel ruolo, o si candida, deve prima
  verificarsi (costo una tantum a suo carico, validità 12 mesi). Altrimenti la proposta non ha effetto.
- Il bollino vale 10 punti in classifica. Salviamo solo "verificato fino al…": documenti e selfie
  restano al fornitore.
- Prezzo e durata si cambiano in `platform_settings` (`verification_price_cents`, `verification_months`).
  Il prezzo vero dipende dal fornitore scelto: 15 € è un segnaposto.
- **Da collegare online**: una Edge Function che, dopo `start_verification()`, apre pagamento e verifica
  del fornitore (per esempio Stripe Identity) e, sul suo webhook, chiama con la chiave di servizio
  `complete_verification(richiesta, 'ok' o 'rifiutata', riferimento)`. Non è inclusa: in demo
  l'esito del fornitore è simulato.

## Cosa manca prima del lancio

- Notifiche **push** sul telefono: oggi esiste la casella dentro l'app (si aggiorna ogni 12 secondi).
- **Pagamenti** reali: il registro dice chi deve cosa a chi, ma nessun denaro si muove.
- Riconoscimento facciale e verifica documenti (da affidare a un fornitore).
- Moderazione dei commenti sugli organizzatori e procedura di contestazione.
- Verifica legale (privacy, collocamento, decisioni automatiche) e controllo di sicurezza di un esperto.
