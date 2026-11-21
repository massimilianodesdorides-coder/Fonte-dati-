# Lavoro Facile: l'app (demo e messa online)

## Cosa c'è

| File | A cosa serve |
|---|---|
| `app/` | il codice dell'app (`app.js`, `style.css`) e della demo (`demo_backend.js`, `demo_seed.sql`) |
| `tools/build.py` | unisce tutto in pagine singole |
| `app.html` | l'app **online**: parla con Supabase |
| `demo.html` | la **demo** da aprire dal computer (doppio clic): contiene un vero PostgreSQL |
| `schema*.sql` | il database, da caricare in quest'ordine: `schema.sql`, `schema_fase2.sql`, `2b`, `2c`, `2d`, `2e`, `2f` |

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
   `schema_fase2e_canali_scheda.sql`, `schema_fase2f_rating_organizzatori.sql`.
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

## Cosa manca prima del lancio

- Notifiche **push** sul telefono: oggi esiste la casella dentro l'app (si aggiorna ogni 12 secondi).
- **Pagamenti** reali: il registro dice chi deve cosa a chi, ma nessun denaro si muove.
- Riconoscimento facciale e verifica documenti (da affidare a un fornitore).
- Moderazione dei commenti sugli organizzatori e procedura di contestazione.
- Verifica legale (privacy, collocamento, decisioni automatiche) e controllo di sicurezza di un esperto.
