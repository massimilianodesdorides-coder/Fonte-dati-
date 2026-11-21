# Guida: mettere online "Lavoro Facile" (per neofiti)

Servono circa 30–40 minuti e **un computer** (da telefono è scomodo).
Hai 3 file: `schema.sql` (il database), `index.html` (l'app), questa guida.

Costo: tutto gratuito per iniziare.

---

## PASSO 1 — Creare il database (Supabase)

1. Vai su **supabase.com** → *Start your project* → registrati.
2. Clicca **New project**. Scegli un nome (es. `lavoro-facile`), una password
   per il database (salvala nel gestore password) e come **Region**
   scegli **Europe (Frankfurt)** o **Milan**: i dati restano in Europa (GDPR).
3. Aspetta 2 minuti che il progetto si crei.
4. Menu a sinistra → **SQL Editor** → **New query**.
5. Apri `schema.sql`, copia tutto, incolla, premi **RUN**.
   Deve comparire "Success". Ora hai tabelle e regole di sicurezza.

## PASSO 2 — Impostazioni di sicurezza (importante)

Nel menu **Authentication**:
- **Providers → Email**: lascia attivo *Confirm email* (gli utenti devono
  confermare la mail: evita account falsi).
- **Policies / Password**: imposta lunghezza minima 8 e, se vuoi,
  richiedi anche numeri e simboli.
- **URL Configuration → Site URL**: dopo il Passo 4 ci metterai
  l'indirizzo del tuo sito.
- Valuta di attivare **CAPTCHA** (Authentication → Attack Protection)
  contro i bot.

## PASSO 3 — Collegare l'app al database

1. In Supabase: **Project Settings → API**.
2. Copia **Project URL** e la chiave **anon public**.
3. Apri `index.html` con un editor di testo (Blocco note va bene)
   e in cima al blocco `<script>` sostituisci:
   - `INCOLLA_QUI_PROJECT_URL` con il Project URL
   - `INCOLLA_QUI_ANON_PUBLIC_KEY` con la chiave anon
   - `TITOLARE` con il tuo nome/azienda e un'email di contatto

⚠️ NON usare MAI la chiave **service_role**: è segreta e darebbe accesso a tutto.
La chiave *anon* invece è fatta per essere pubblica: la protezione vera sono
le regole che hai caricato con `schema.sql`.

## PASSO 4 — Mettere online il sito

Il modo più semplice: **Netlify Drop**
1. Vai su **app.netlify.com/drop** e registrati.
2. Metti `index.html` in una cartella vuota e trascinala sulla pagina.
3. Ottieni subito un indirizzo `https://xxxx.netlify.app`
   (https = connessione cifrata, già inclusa).
4. Torna su Supabase → Authentication → URL Configuration e incolla
   quell'indirizzo in **Site URL**.
5. (Opzionale) Collega un tuo dominio, es. `lavorofacile.it`, dalle
   impostazioni di Netlify.

## PASSO 5 — Prova

1. Apri il sito, registra un account **"Offro lavoro"** (usa una mail tua),
   conferma la mail, pubblica un annuncio.
2. Registra un secondo account **"Cerco lavoro"** (altra mail),
   candidati all'annuncio.
3. Rientra col primo account → *I miei annunci*: vedi la candidatura.
4. Prova *Profilo → Cancella il mio account*.

---

## Cosa è protetto e come

- Le password le gestisce Supabase (mai salvate in chiaro da noi).
- Ogni utente può leggere/modificare solo i propri dati.
- Un datore vede i dati di un candidato **solo se** quel candidato si è
  candidato a un suo annuncio.
- Solo chi ha scelto "Offro lavoro" può pubblicare, solo chi ha scelto
  "Cerco lavoro" può candidarsi. Il ruolo non è modificabile dopo.
- Tutto il testo inserito dagli utenti viene "neutralizzato" (niente
  codice malevolo nelle pagine).
- Cancellazione account = cancellazione di tutti i dati (GDPR).

## Cosa NON è ancora incluso (da fare prima del lancio vero)

1. **Revisione legale GDPR**: l'informativa nell'app è una bozza.
   Servono anche termini di servizio e, se sei un'attività, registro dei
   trattamenti.
2. **Revisione di sicurezza** da parte di un esperto.
3. **Moderazione**: come eliminare annunci falsi/abusivi (oggi puoi farlo
   dalla tabella `jobs` in Supabase → Table Editor).
4. **Limiti anti-spam** e CAPTCHA.
5. **Backup**: il piano gratuito non include backup automatici;
   il piano Pro sì.
6. **Normativa sul collocamento**: in Italia l'intermediazione del lavoro
   può richiedere autorizzazioni (D.Lgs. 276/2003). Chiedi a un consulente
   se il tuo servizio rientra, o se è una semplice bacheca.

"Sicurezza al 100%" non esiste: questa architettura è solida e in uso da
molti servizi, ma va verificata prima di raccogliere dati reali.
