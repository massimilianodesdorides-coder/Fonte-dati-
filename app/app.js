'use strict';
/* =====================================================================
   LAVORO FACILE: app web per domanda e offerta di lavoro a eventi
   - Online: collega Supabase (inserisci URL e chiave qui sotto)
   - Demo: stessa app su un database PostgreSQL nel browser (vedi build)
   ===================================================================== */
const CFG = {
  SUPABASE_URL: 'INCOLLA_QUI_PROJECT_URL',
  SUPABASE_ANON_KEY: 'INCOLLA_QUI_ANON_PUBLIC_KEY',
  TITOLARE: 'NOME E COGNOME / RAGIONE SOCIALE, email di contatto',
};
const DEMO = /*__DEMO__*/false;

/* ---------- utilità ---------- */
class Raw { constructor(s) { this.s = s; } }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(str).join('') : (v == null || v === false) ? '' : esc(v);
const attr = (n, v) => (v == null || v === false) ? new Raw('') : new Raw(` ${n}="${esc(v)}"`);
const html = (st, ...v) => new Raw(st.reduce((a, s, i) => a + s + (i < v.length ? str(v[i]) : ''), ''));
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const D = t => new Date(t);
const fDay = t => new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(D(t));
const fShort = t => new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).format(D(t));
const fFull = t => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }).format(D(t));
const fTime = t => new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(D(t));
const fDT = t => `${fShort(t)} ${fTime(t)}`;
const eur = c => (Number(c) / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const num1 = n => Number(n).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (n, s, p) => n === 1 ? `1 ${s}` : `${n} ${p}`;
const toLocalInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ok */ } } };

const S = { uid: null, profile: null, view: 'welcome', arg: null, tab: 'ruoli', open: {}, unread: 0, roles: [], settings: null, linkCode: null, demo: null, token: 0 };
const roleName = c => (S.roles.find(r => r.code === c) || {}).label || c;
const isSeeker = () => S.profile && S.profile.role === 'seeker';
const isOrg = () => S.profile && S.profile.role === 'employer';
let sb;

const INFORMATIVA = `INFORMATIVA PRIVACY (BOZZA DA FAR REVISIONARE A UN LEGALE)

Titolare del trattamento: ${CFG.TITOLARE}

Dati trattati: email, nome, città, telefono, presentazione, ruoli e disponibilità; annunci, proposte, turni, presenze e giudizi; selfie di presenza (conservati per un tempo limitato).

Finalità: registrazione, incontro tra domanda e offerta di lavoro per eventi, gestione di turni, presenze e sostituzioni.

Chi vede i dati: l'organizzatore vede una scheda con nome abbreviato, città, presentazione ed esperienze solo se hai attivato "Visibile agli organizzatori" o ti sei candidato. Telefono ed email si aprono solo dopo un turno accettato. I giudizi sugli organizzatori sono anonimi per l'organizzatore.

Decisioni automatiche: la classifica e la scelta automatica usano città, esperienza e affidabilità. Non usano foto, età, genere o origine. Nessun turno è assegnato senza la tua accettazione.

Conservazione: fino alla cancellazione dell'account, che puoi fare dal Profilo.

Diritti: accesso, rettifica, cancellazione, portabilità, opposizione, reclamo al Garante.`;

const HERR = e => {
  const m = (e && e.message) || String(e || 'Errore');
  if (/Invalid login/i.test(m)) return 'Email o password errate.';
  if (/already registered/i.test(m)) return 'Questa email è già registrata.';
  if (/Email not confirmed/i.test(m)) return 'Conferma prima l\'email: controlla la posta.';
  if (/Password should be/i.test(m)) return 'Password troppo corta (minimo 8 caratteri).';
  if (/permission denied|row-level security/i.test(m)) return 'Operazione non consentita.';
  if (/duplicate key/i.test(m)) return 'Esiste già.';
  return m;
};

function toast(text, bad) {
  $$('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' err' : ''); t.setAttribute('role', 'status'); t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), bad ? 6000 : 3600);
}
async function call(p, okMsg) {          // esegue una chiamata, mostra errore o conferma
  const r = await p;
  if (r.error) { toast(HERR(r.error), true); return { ok: false, data: null }; }
  if (okMsg) toast(okMsg);
  return { ok: true, data: r.data };
}

/* ---------- finestre di dialogo (niente alert/confirm del browser) ---------- */
function fieldHtml(f) {
  const id = 'm_' + f.name, req = f.required ? attr('required', '') : '';
  const lab = f.label ? html`<label class="f" for="${id}">${f.label}</label>` : '';
  if (f.type === 'select') return html`${lab}<select id="${id}" name="${f.name}"${req}>${f.options.map(([v, l]) => html`<option value="${v}"${String(v) === String(f.value) ? attr('selected', '') : ''}>${l}</option>`)}</select>`;
  if (f.type === 'textarea') return html`${lab}<textarea id="${id}" name="${f.name}"${attr('maxlength', f.max || 500)}${req}>${f.value || ''}</textarea>`;
  if (f.type === 'checkbox') return html`<label class="chk"><input type="checkbox" id="${id}" name="${f.name}"${f.value ? attr('checked', '') : ''}><span>${f.label}</span></label>`;
  if (f.type === 'file') return html`${lab}<input id="${id}" name="${f.name}" type="file"${attr('accept', f.accept || 'image/*')}${f.capture ? attr('capture', 'user') : ''}${req}>`;
  const txt = (f.type || 'text') === 'text';
  return html`${lab}<input id="${id}" name="${f.name}" type="${f.type || 'text'}"${attr('value', f.value ?? '')}${txt ? attr('maxlength', f.max) : html`${attr('min', f.min)}${attr('max', f.max)}`}${attr('step', f.step)}${req}>`;
}
function modal({ title, intro = '', fields = [], body = '', ok = 'Conferma', danger = false, cancel = 'Annulla', hideOk = false }) {
  return new Promise(res => {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const ov = document.createElement('div'); ov.className = 'ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = html`<form class="sheet"><h3>${title}</h3>${intro ? html`<p class="muted">${intro}</p>` : ''}${body}${fields.map(fieldHtml)}
      <div class="acts">${hideOk ? '' : html`<button class="btn ${danger ? 'bad' : ''}" type="submit">${ok}</button>`}<button class="btn sec" type="button" data-cancel>${cancel}</button></div></form>`.s;
    const done = v => { ov.remove(); document.removeEventListener('keydown', onKey); res(v); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', e => { if (e.target === ov || e.target.hasAttribute('data-cancel')) done(null); });
    $('form', ov).addEventListener('submit', e => {
      e.preventDefault(); const o = {};
      fields.forEach(f => { const el = $('#m_' + f.name, ov); o[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'file' ? (el.files[0] || null) : el.value; });
      done(o);
    });
    document.body.appendChild(ov);
    const first = $('input,select,textarea,button.btn', ov); if (first) first.focus();
  });
}

/* ---------- avvio ---------- */
async function loadScript(src) { return new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ko(new Error('Impossibile caricare ' + src)); document.head.appendChild(s); }); }
async function initBackend() {
  if (DEMO) { sb = await makeDemoBackend(); S.demo = sb.demo; return true; }
  if (CFG.SUPABASE_URL.startsWith('INCOLLA')) return false;
  await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js');
  sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  return true;
}
async function loadSession() {
  const { data } = await sb.auth.getSession();
  S.uid = data.session ? data.session.user.id : null;
  S.profile = null;
  if (S.uid) {
    const r = await sb.from('profiles').select('*').eq('id', S.uid).maybeSingle();
    S.profile = r.data;
    const st = await sb.from('platform_settings').select('*').maybeSingle(); S.settings = st.data;
    S.trust = S.profile && S.profile.role === 'seeker' ? (await sb.rpc('my_trust')).data : null;
  }
}
function home() { return !S.profile ? 'welcome' : isOrg() ? 'events' : 'offers'; }
async function boot() {
  const app = $('#app'); app.innerHTML = html`<div class="wrap"><div class="sk"></div><div class="sk"></div><p class="empty">Avvio in corso${DEMO ? ': carico il database di prova (qualche secondo)' : ''}…</p></div>`.s;
  try {
    if (!(await initBackend())) {
      app.innerHTML = html`<div class="wrap"><div class="card"><h3>Configurazione mancante</h3><p>Apri <b>app.html</b> e inserisci URL e chiave anon di Supabase all'inizio della sezione CFG (vedi GUIDA.md).</p></div></div>`.s; return;
    }
    S.roles = ((await sb.from('job_roles').select('*')).data) || [];
    await loadSession();
    const m = /^#e-([a-z0-9]+)$/.exec(location.hash);
    if (m) { S.linkCode = m[1]; ls.set('lf_link', m[1]); S.view = 'public'; S.arg = m[1]; }
    else { S.linkCode = ls.get('lf_link'); S.view = home(); }
    await render(); startTick();
  } catch (e) {
    const wasm = DEMO && /WebAssembly|wasm|CompileError|unsafe-eval|Content Security|DecompressionStream/i.test(String(e && e.message));
    app.innerHTML = html`<div class="wrap"><div class="card"><h3>Non riesco ad avviare l'app</h3><p class="muted">${e.message}</p>
      ${wasm ? html`<p>Questo ambiente di visualizzazione non permette di avviare il database di prova nel browser. Apri il file <b>demo.html</b> direttamente dal tuo computer (doppio clic) e funzionerà.</p>` : ''}</div></div>`.s;
  }
}
window.addEventListener('hashchange', () => { const m = /^#e-([a-z0-9]+)$/.exec(location.hash); if (m) { S.linkCode = m[1]; ls.set('lf_link', m[1]); go('public', m[1]); } });

/* ---------- impalcatura: intestazione, navigazione, tick ---------- */
function tabsFor() {
  if (isOrg()) return [['events', 'Eventi'], ['notifs', 'Notifiche'], ['orgprofile', 'Profilo']];
  if (isSeeker()) return [['offers', 'Proposte'], ['board', 'Bacheca'], ['calendar', 'Calendario'], ['profile', 'Profilo']];
  return [];
}
async function go(view, arg = null) { S.view = view; S.arg = arg; await render(); window.scrollTo(0, 0); }
async function refreshBadge() {
  if (!S.uid) { S.unread = 0; return; }
  const r = await sb.from('notifications').select('id').is('read_at', null);
  S.unread = (r.data || []).length;
  const b = $('#bell'); if (b) b.innerHTML = bellHtml().s;
}
const bellHtml = () => html`Notifiche${S.unread ? html`<b>${S.unread}</b>` : ''}`;
function shell(inner) {
  const tabs = tabsFor();
  const active = S.view === 'job' ? 'board' : S.view === 'event' ? 'events' : S.view;
  return html`<div class="top"><div class="in"><div class="brand" data-act="home"><i></i>Lavoro Facile</div>
      ${S.uid ? html`<button class="bell" id="bell" data-act="bell" aria-label="Notifiche">${bellHtml()}</button>` : ''}</div></div>
    <div class="wrap">${DEMO ? demoBar() : ''}${inner}</div>
    ${tabs.length ? html`<nav class="tabs"><div class="in">${tabs.map(([k, l]) => html`<button data-act="tab" data-v="${k}" class="${active === k ? 'on' : ''}">${l}</button>`)}</div></nav>` : ''}`;
}
function demoBar() {
  const name = S.profile ? S.profile.full_name : 'nessun utente';
  return html`<div class="demo"><span>DEMO su database di prova. Utente: <b>${name}</b></span><span><button data-act="demoTools">Strumenti demo</button></span></div>`;
}
let rendering = 0;
async function render() {
  const my = ++rendering; S.token = my;
  const fn = VIEWS[S.view] || VIEWS.welcome;
  let inner;
  try { inner = await fn(S.arg); } catch (e) { inner = html`<div class="card"><h3>Qualcosa è andato storto</h3><p class="muted">${e.message}</p></div>`; }
  if (my !== rendering) return;
  const y = window.scrollY;
  $('#app').innerHTML = shell(inner).s;
  window.scrollTo(0, y);
  refreshBadge();
  hydrateImages();
}
function startTick() {
  setInterval(async () => {
    if (document.hidden || $('.ov')) return;
    await refreshBadge();
    if (S.view === 'event' && S.tab === 'presenze') render();
    if (S.view === 'offers') render();
  }, 12000);
}

/* ---------- componenti comuni ---------- */
const SHIFT = { assegnato: ['Assegnato', ''], confermato: ['Presente', 'good'], completato: ['Completato', 'good'], no_show: ['No-show', 'bad'], annullato: ['Annullato', 'gray'] };
const OFFER = { inviata: ['In attesa', 'warn'], accettata: ['Accettata', 'good'], rifiutata: ['Rifiutata', 'gray'], scaduta: ['Scaduta', 'gray'], ritirata: ['Ritirata', 'gray'] };
const badge = (m, k) => { const [l, c] = (m[k] || [k, 'gray']); return html`<span class="badge ${c}">${l}</span>`; };
const orgLine = o => !o ? '' : o.nuovo ? html`<span class="badge gray">Nuovo organizzatore</span>`
  : html`<span class="badge ${o.overall >= 4 ? 'good' : o.overall >= 3 ? 'warn' : 'bad'}">Organizzatore ${num1(o.overall)}/5</span> <span class="muted sm">${plural(o.n, 'giudizio', 'giudizi')}${o.pagato_puntuale_pct != null ? html`, pagato puntuale ${o.pagato_puntuale_pct}%` : ''}${o.annullamenti_tardivi_12m ? html`, ${plural(o.annullamenti_tardivi_12m, 'annullamento tardivo', 'annullamenti tardivi')}` : ''}</span>`;
const MIN_LABEL = { base: 'verifica di base', forte: 'identità certificata (documento)' };
const LEVEL = { nessuna: 0, base: 1, forte: 2 };
const myLevel = () => LEVEL[(S.trust && S.trust.livello) || 'nessuna'];
const reqBadge = m => (m && m !== 'nessuna') ? html`<span class="badge warn">Richiede ${MIN_LABEL[m]}</span>` : '';
const lvBadge = t => !t ? '' : t.livello === 'forte' ? html`<span class="badge good">Identità certificata</span>` : t.livello === 'base' ? html`<span class="badge good">Verifica di base</span>` : '';
const fieldBadge = t => !t ? '' : t.foto_segnalata ? html`<span class="badge warn">Foto da aggiornare</span>`
  : t.conferme_sul_campo > 0 ? html`<span class="badge">Foto confermata da ${plural(t.conferme_sul_campo, 'organizzatore', 'organizzatori')}</span>` : '';
const hue = str => [...str].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
function avatarSvg(name, kind) {      // immagine di esempio per la demo: la foto vera sta nello storage privato
  const h = hue(name || '?'), ini = (name || '?').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
  const ring = kind === 'selfie' ? `<circle cx="60" cy="60" r="54" fill="none" stroke="#fff" stroke-width="4" stroke-dasharray="6 5"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${h} 45% ${kind === 'selfie' ? 42 : 50}%)"/>${ring}<text x="60" y="72" text-anchor="middle" font-family="sans-serif" font-size="40" font-weight="700" fill="#fff">${ini}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
const photoImg = (path, name, kind) => !path ? html`<div class="muted sm">Nessuna foto</div>`
  : html`<img class="avatar" alt="${kind === 'selfie' ? 'Selfie di oggi' : 'Foto del profilo'}" data-bucket="${kind === 'selfie' ? 'checkins' : 'profili'}" data-path="${path}" data-name="${name}" data-kind="${kind}">`;
async function hydrateImages() {
  for (const img of document.querySelectorAll('img[data-path]')) {
    if (DEMO) { img.src = avatarSvg(img.dataset.name, img.dataset.kind); continue; }
    const r = await sb.storage.from(img.dataset.bucket).createSignedUrl(img.dataset.path, 300);
    if (r.data) img.src = r.data.signedUrl; else img.alt = 'Immagine non disponibile';
  }
}
const empty = t => html`<div class="empty">${t}</div>`;
const skel = () => html`<div class="sk"></div><div class="sk"></div>`;

/* =====================================================================
   SCHERMATE
   ===================================================================== */
const VIEWS = {};

/* ---------- ingresso ---------- */
VIEWS.welcome = async () => {
  const users = DEMO ? (await S.demo.users()).filter(u => u.ord < 100) : [];
  return html`<div class="hero"><h1>Personale per eventi, senza giri a vuoto</h1>
    <p>Gli organizzatori pubblicano i ruoli, il sistema propone le persone più adatte e copre i no-show con le riserve. Chi lavora sceglie, accetta e si trova tutto in un calendario.</p>
    <div class="acts"><button class="btn" data-act="goto" data-v="register">Registrati</button><button class="btn" data-act="goto" data-v="login">Accedi</button></div></div>
    ${DEMO ? html`<h2>Prova la demo</h2><p class="muted">Scegli chi vuoi essere. Puoi cambiare utente in qualsiasi momento dai "Strumenti demo" per vedere l'altro lato.</p>
      ${users.map(u => html`<div class="card row"><div class="grow"><h3>${u.label}</h3><div class="muted">${u.descr}</div></div>
        <button class="btn s" data-act="demoLogin" data-id="${u.id}">Entra</button></div>`)}` : ''}`;
};
VIEWS.login = async () => html`<h2>Accedi</h2><form class="card" data-form="login">
  <label class="f" for="em">Email</label><input id="em" type="email" autocomplete="email" required>
  <label class="f" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
  ${DEMO ? html`<p class="small-note">Demo: la password non viene verificata.</p>` : ''}
  <div class="acts"><button class="btn" type="submit">Accedi</button><button class="btn sec" type="button" data-act="goto" data-v="register">Crea account</button></div></form>`;
VIEWS.register = async () => html`<h2>Crea il tuo account</h2><form class="card" data-form="register">
  <label class="f">Cosa vuoi fare?</label>
  <div class="chips" id="rolechips"><button type="button" class="chip on" data-act="pickrole" data-v="seeker">Cerco lavoro</button><button type="button" class="chip" data-act="pickrole" data-v="employer">Organizzo eventi</button></div>
  <label class="f" for="nm">Nome e cognome (o ragione sociale)</label><input id="nm" required maxlength="100">
  <label class="f" for="ci">Città</label><input id="ci" maxlength="100">
  <label class="f" for="em">Email</label><input id="em" type="email" required autocomplete="email">
  <label class="f" for="pw">Password (minimo 8 caratteri)</label><input id="pw" type="password" required minlength="8" autocomplete="new-password">
  <label class="chk"><input id="pr" type="checkbox"><span>Ho letto l'<a href="#" data-act="privacy">informativa privacy</a> e acconsento al trattamento dei dati.</span></label>
  ${S.linkCode ? html`<p class="small-note">Arrivi da un annuncio condiviso: dopo la registrazione potrai candidarti.</p>` : ''}
  <div class="acts"><button class="btn" type="submit">Registrati</button><button class="btn sec" type="button" data-act="goto" data-v="login">Ho già un account</button></div></form>`;

/* ---------- pagina pubblica dell'evento (link per canale) ---------- */
VIEWS.public = async code => {
  const r = await sb.rpc('public_event_page', { p_code: code });
  const p = r.data;
  if (!p) return html`<div class="card"><h3>Evento non trovato</h3><p class="muted">Il link potrebbe essere scaduto.</p><button class="btn" data-act="home">Vai alla home</button></div>`;
  return html`<div class="hero"><h1>${p.evento.nome}</h1><p>${p.evento.citta}, ${fDay(p.evento.data)}</p></div>
    <h2>Ruoli aperti</h2>
    ${p.ruoli.length ? p.ruoli.map(j => html`<div class="card"><div class="row"><div class="grow"><h3>${j.titolo}</h3><div class="muted">${j.azienda}</div></div><span class="badge ${j.posti_liberi ? 'good' : 'gray'}">${j.posti_liberi ? plural(j.posti_liberi, 'posto libero', 'posti liberi') : 'Completo'}</span></div>
      ${j.verifica && j.verifica !== 'nessuna' ? html`<div style="margin:4px 0">${reqBadge(j.verifica)}</div>` : ''}
      <p class="sm">${fShort(j.inizio)} · ${fTime(j.inizio)}-${fTime(j.fine)} · ${eur(j.paga_cents)} a persona</p>
      ${j.posti_liberi ? html`<div class="acts"><button class="btn" data-act="applyLink" data-job="${j.job_id}" data-min="${j.verifica || 'nessuna'}">${S.uid ? 'Candidati' : 'Accedi per candidarti'}</button></div>` : ''}</div>`) : empty('Nessun ruolo aperto al momento.')}
    <p class="small-note">Tutte le risposte arrivano all'organizzatore su Lavoro Facile. I tuoi dati restano nascosti finché non ti candidi.</p>`;
};

/* =====================================================================
   LAVORATORE
   ===================================================================== */
VIEWS.offers = async () => {
  if (!S.uid) return VIEWS.welcome();
  const { data: offs } = await sb.from('offers').select('*').eq('status', 'inviata').order('expires_at');
  let cards = '';
  if (offs && offs.length) {
    const jobs = (await sb.from('jobs').select('id,title,company_name,city,shift_pay_cents,starts_at,ends_at,role_code,employer_id,event_id,min_verification').in('id', offs.map(o => o.job_id))).data || [];
    const evs = (await sb.from('events').select('id,name,city').in('id', [...new Set(jobs.map(j => j.event_id))])).data || [];
    const orgs = {};
    await Promise.all([...new Set(jobs.map(j => j.employer_id))].map(async e => { orgs[e] = (await sb.rpc('organizer_profile', { p_employer: e })).data; }));
    const feePct = S.settings ? S.settings.standby_fee_pct : 20;
    cards = offs.map(o => {
      const j = jobs.find(x => x.id === o.job_id); if (!j) return '';
      const ev = evs.find(x => x.id === j.event_id) || {};
      const res = o.kind === 'riserva';
      return html`<div class="card"><div class="row"><div class="grow"><h3>${j.title}</h3><div class="muted">${j.company_name} · ${ev.name || ''}, ${j.city}</div></div>
        <span class="badge ${res ? 'fav' : ''}">${res ? 'Riserva' : 'Turno'}</span></div>
        ${j.min_verification && j.min_verification !== 'nessuna' ? html`<div style="margin-top:6px">${reqBadge(j.min_verification)} ${myLevel() >= LEVEL[j.min_verification] ? html`<span class="badge good">Hai già il livello richiesto</span>` : html`<span class="muted sm">Dovrai verificarti per accettare.</span>`}</div>` : ''}
        <dl class="kv" style="margin-top:8px"><dt>Quando</dt><dd>${fShort(j.starts_at)}, ${fTime(j.starts_at)}-${fTime(j.ends_at)}</dd>
          <dt>Paga</dt><dd>${eur(j.shift_pay_cents)}${res ? html` se vieni attivata. Se non serve: <b>${eur(Math.round(j.shift_pay_cents * feePct / 100))}</b> per la disponibilità.` : ''}</dd>
          <dt>Rispondi entro</dt><dd><b>${fDT(o.expires_at)}</b></dd></dl>
        <div style="margin-top:8px">${orgLine(orgs[j.employer_id])}</div>
        <div class="acts"><button class="btn" data-act="respond" data-id="${o.id}" data-yes="1" data-min="${j.min_verification || 'nessuna'}">Accetta</button><button class="btn sec" data-act="respond" data-id="${o.id}" data-yes="0">Rifiuta</button>
          <button class="btn ghost" data-act="block" data-emp="${j.employer_id}" data-name="${j.company_name}">Non voglio più proposte da qui</button></div></div>`;
    });
  }
  const { data: apps } = await sb.from('applications').select('id,job_id,created_at').eq('seeker_id', S.uid).order('created_at', { ascending: false });
  let mine = '';
  if (apps && apps.length) {
    const js = (await sb.from('jobs').select('id,title,company_name,starts_at').in('id', apps.map(a => a.job_id))).data || [];
    mine = html`<h2>Le mie candidature</h2>${apps.map(a => { const j = js.find(x => x.id === a.job_id) || {}; return html`<div class="card flat row"><div class="grow"><b>${j.title || 'Annuncio'}</b><div class="muted sm">${j.company_name || ''} ${j.starts_at ? '· ' + fShort(j.starts_at) : ''}</div></div><button class="btn ghost" data-act="withdrawApp" data-id="${a.id}">Ritira</button></div>`; })}`;
  }
  return html`<h2>Proposte per te</h2>
    ${!S.profile.discoverable ? html`<div class="card flat"><b>Vuoi ricevere proposte?</b><p class="muted">Per ora gli organizzatori non possono trovarti. Attiva "Visibile agli organizzatori" dal Profilo e scegli i tuoi ruoli.</p><button class="btn s" data-act="tab" data-v="profile">Vai al profilo</button></div>` : ''}
    ${cards.length ? cards : empty('Nessuna proposta in attesa. Quando un organizzatore ti sceglie, la vedi qui e nelle notifiche.')}${mine}`;
};

VIEWS.board = async () => {
  const q = (S.search || '').toLowerCase();
  const { data: jobs } = await sb.from('jobs').select('id,title,company_name,city,shift_pay_cents,starts_at,ends_at,role_code,event_id,headcount,min_verification').eq('is_open', true).order('starts_at').limit(60);
  const list = (jobs || []).filter(j => !q || [j.title, j.city, j.company_name, roleName(j.role_code)].join(' ').toLowerCase().includes(q));
  let slots = [];
  if (isSeeker()) slots = (await sb.rpc('open_standby_slots')).data || [];
  return html`<h2>Annunci aperti</h2>
    <input id="search" placeholder="Cerca per ruolo, città o azienda" value="${S.search || ''}" aria-label="Cerca">
    ${slots.length ? html`<h2>Posti da riserva</h2><p class="muted">Se un lavoratore non si presenta, la riserva prende il suo posto con paga piena. Se non serve, ricevi comunque un compenso.</p>
      ${slots.map(s => html`<div class="card"><div class="row"><div class="grow"><h3>${roleName(s.role_code)} · ${s.event_name}</h3><div class="muted">${s.city}, ${fShort(s.starts_at)}, ${fTime(s.starts_at)}-${fTime(s.ends_at)}</div></div></div>
        <p class="sm">Se non serve: <b>${eur(s.fee_if_unused_cents)}</b>. Se vieni attivata: <b>${eur(s.pay_if_activated_cents)}</b>.</p>
        <div class="acts"><button class="btn s" data-act="claim" data-id="${s.guarantee_id}" data-min="${s.verifica || 'nessuna'}">Prendi lo slot</button></div></div>`)}` : ''}
    <div id="joblist">${list.length ? list.map(jobCard) : empty('Nessun annuncio trovato.')}</div>`;
};
const jobCard = j => html`<div class="card" data-act="job" data-id="${j.id}" style="cursor:pointer"><div class="row"><div class="grow"><h3>${j.title}</h3><div class="muted">${j.company_name} · ${j.city}</div></div><span class="badge">${roleName(j.role_code)}</span></div>
  <p class="sm">${j.starts_at ? html`${fShort(j.starts_at)}, ${fTime(j.starts_at)}-${fTime(j.ends_at)}` : ''}${j.shift_pay_cents ? html` · <b>${eur(j.shift_pay_cents)}</b>` : ''}</p>${reqBadge(j.min_verification) ? html`<div>${reqBadge(j.min_verification)}</div>` : ''}</div>`;

VIEWS.job = async id => {
  const { data: j } = await sb.from('jobs').select('*').eq('id', id).maybeSingle();
  if (!j) return html`<div class="card">Annuncio non trovato.</div><button class="btn sec" data-act="tab" data-v="board">Indietro</button>`;
  const ev = j.event_id ? (await sb.from('events').select('*').eq('id', j.event_id).maybeSingle()).data : null;
  const org = (await sb.rpc('organizer_profile', { p_employer: j.employer_id })).data;
  let applied = false;
  if (isSeeker()) applied = !!(await sb.from('applications').select('id').eq('job_id', id).eq('seeker_id', S.uid).maybeSingle()).data;
  return html`<button class="btn ghost" data-act="tab" data-v="board">← Annunci</button>
    <div class="card"><div class="row"><div class="grow"><h2 style="margin:0">${j.title}</h2><div class="muted">${j.company_name}${ev ? ' · ' + ev.name : ''}, ${j.city}</div></div><span class="badge">${roleName(j.role_code)}</span></div>
      ${j.starts_at ? html`<dl class="kv" style="margin-top:10px"><dt>Quando</dt><dd>${fDay(j.starts_at)}, ${fTime(j.starts_at)}-${fTime(j.ends_at)}</dd><dt>Paga</dt><dd>${eur(j.shift_pay_cents)} a persona</dd><dt>Posti</dt><dd>${j.headcount}</dd></dl>` : ''}
      <p style="white-space:pre-wrap">${j.description}</p>${j.min_verification && j.min_verification !== 'nessuna' ? html`<p>${reqBadge(j.min_verification)}</p>` : ''}<div>${orgLine(org)}</div></div>
    ${!S.uid ? html`<button class="btn block" data-act="goto" data-v="login">Accedi per candidarti</button>`
      : isOrg() ? html`<p class="muted">Sei registrato come organizzatore: non puoi candidarti.</p>`
      : applied ? html`<div class="card flat"><b>Ti sei già candidato.</b> L'organizzatore vedrà il tuo profilo.</div>`
      : html`<button class="btn block" data-act="applyJob" data-job="${j.id}" data-min="${j.min_verification || 'nessuna'}">Candidati</button><p class="small-note">Candidandoti, l'organizzatore potrà vedere nome, città, presentazione e telefono.</p>`}`;
};

VIEWS.calendar = async () => {
  const { data: items } = await sb.rpc('my_calendar');
  const list = (items || []).sort((a, b) => D(a.starts_at) - D(b.starts_at));
  const now = Date.now();
  const groups = {};
  list.forEach(i => { const k = fDay(i.starts_at); (groups[k] = groups[k] || []).push(i); });
  const body = Object.keys(groups).length ? Object.entries(groups).map(([day, arr]) => html`<div class="day">${day}</div>${arr.map(i => {
    const kind = i.kind === 'non_disponibile' ? 'nd' : i.kind;
    const started = D(i.starts_at) - now <= 60 * 60 * 1000, ended = D(i.ends_at) < now;
    const d = i.detail || {};
    let acts = '';
    if (i.kind === 'turno') {
      if (i.status === 'assegnato' && started && !ended) acts = html`<button class="btn s" data-act="checkin" data-id="${i.ref_id}">Check-in con selfie</button>`;
      else if (i.status === 'confermato' && !ended) acts = html`<button class="btn s" data-act="checkout" data-id="${i.ref_id}">Check-out</button>`;
      if (ended && (i.status === 'confermato' || i.status === 'completato')) acts = html`<button class="btn s sec" data-act="review" data-id="${i.ref_id}">Valuta l'organizzatore</button>`;
    }
    if (i.kind === 'proposta') acts = html`<button class="btn s" data-act="tab" data-v="offers">Rispondi</button>`;
    if (i.kind === 'non_disponibile') acts = html`<button class="btn s ghost" data-act="delUnav" data-id="${i.ref_id}">Rimuovi</button>`;
    const label = { turno: 'Turno', riserva: 'Riserva', proposta: 'Proposta', non_disponibile: 'Non disponibile' }[i.kind];
    return html`<div class="card tl ${kind}"><div class="row"><div class="grow"><h3>${i.title}</h3>
      <div class="muted">${fTime(i.starts_at)}-${fTime(i.ends_at)}${i.city ? ' · ' + i.city : ''}</div></div>
      <span>${i.kind === 'turno' ? badge(SHIFT, i.status) : html`<span class="badge ${i.kind === 'riserva' ? 'fav' : i.kind === 'proposta' ? 'warn' : 'gray'}">${label}</span>`}</span></div>
      ${i.kind === 'turno' && d.paga_cents ? html`<p class="sm">${eur(d.paga_cents)}${d.sostituzione ? ' · sostituzione, presentati subito' : ''}${d.presentarsi_entro && d.sostituzione ? ' entro le ' + fTime(d.presentarsi_entro) : ''}</p>` : ''}
      ${i.kind === 'riserva' ? html`<p class="sm">Resta a disposizione. Se non serve: ${eur(d.compenso_se_non_usata_cents)}. Se attivata: ${eur(d.paga_se_attivata_cents)}.</p>` : ''}
      ${i.kind === 'proposta' ? html`<p class="sm">Rispondi entro ${fDT(d.scade)}</p>` : ''}
      ${acts ? html`<div class="acts">${acts}</div>` : ''}</div>`; })}`) : empty('Il calendario è vuoto. Quando accetti un turno o una riserva compare qui.');
  return html`<div class="row"><h2>Calendario</h2><span><button class="btn s sec" data-act="addUnav">Non sono disponibile</button> <button class="btn s ghost" data-act="ics">Esporta</button></span></div>${body}`;
};

VIEWS.profile = async () => {
  if (!isSeeker()) return VIEWS.orgprofile();
  const p = S.profile;
  const [mr, av, pref, blocks, ver, trust] = await Promise.all([
    sb.from('worker_roles').select('role_code'), sb.from('standby_availability').select('*').order('from_at'),
    sb.from('worker_preferences').select('*').maybeSingle(), sb.rpc('my_blocks'), sb.rpc('my_verification'), sb.rpc('my_trust')]);
  const mine = new Set((mr.data || []).map(r => r.role_code));
  const pr = pref.data || { min_organizer_rating: null, allow_new_organizers: true };
  return html`<h2>Il tuo profilo</h2>
    <form class="card" data-form="saveProfile"><label class="f" for="nm">Nome e cognome</label><input id="nm" value="${p.full_name}" maxlength="100" required>
      <div class="two"><div><label class="f" for="ci">Città</label><input id="ci" value="${p.city || ''}" maxlength="100"></div>
      <div><label class="f" for="ph">Telefono (solo dopo un turno accettato)</label><input id="ph" value="${p.phone || ''}" maxlength="30"></div></div>
      <label class="f" for="bio">Presentazione ed esperienze</label><textarea id="bio" maxlength="2000">${p.bio || ''}</textarea>
      <div class="acts"><button class="btn" type="submit">Salva</button></div></form>
    ${trustCard(trust.data, ver.data)}
    <div class="card"><h3>Cosa sai fare</h3><div class="chips" style="margin-top:8px">${S.roles.map(r => html`<button class="chip ${mine.has(r.code) ? 'on' : ''}" data-act="toggleRole" data-code="${r.code}">${r.label}</button>`)}</div>
      <div class="sep"></div><label class="chk"><input type="checkbox" id="disc" data-act="toggleDisc" ${p.discoverable ? 'checked' : ''}><span><b>Visibile agli organizzatori</b><br><span class="muted">Possono trovarti e proporti turni. Vedono nome abbreviato, città, presentazione ed esperienze. Mai telefono o email.</span></span></label></div>
    <div class="card"><div class="row"><h3>Disponibilità come riserva</h3><button class="btn s sec" data-act="addAvail">Aggiungi</button></div>
      <p class="muted">Se un lavoratore non si presenta, la riserva prende il suo posto. Per essere trovato come riserva devi essere visibile agli organizzatori.</p>
      ${(av.data || []).length ? av.data.map(a => html`<div class="row" style="padding:6px 0"><span class="sm">${roleName(a.role_code)} · ${a.city} · ${fShort(a.from_at)} - ${fShort(a.to_at)}</span><button class="btn ghost s" data-act="delAvail" data-id="${a.id}">Rimuovi</button></div>`) : html`<p class="muted">Nessuna disponibilità dichiarata.</p>`}</div>
    <div class="card"><h3>Da chi vuoi ricevere proposte</h3>
      <label class="f" for="minr">Solo da organizzatori con almeno</label>
      <select id="minr" data-act="savePref">${[['', 'Nessuna soglia'], ['3', '3 su 5'], ['3.5', '3,5 su 5'], ['4', '4 su 5'], ['4.5', '4,5 su 5']].map(([v, l]) => html`<option value="${v}" ${String(pr.min_organizer_rating ?? '') === v ? 'selected' : ''}>${l}</option>`)}</select>
      <label class="chk"><input type="checkbox" id="newo" data-act="savePref" ${pr.allow_new_organizers ? 'checked' : ''}><span>Accetta anche organizzatori nuovi, senza ancora giudizi</span></label>
      <p class="small-note">Gli organizzatori non vengono avvisati delle tue scelte: semplicemente non compari nelle loro ricerche.</p>
      ${(blocks.data || []).length ? html`<div class="sep"></div><b>Organizzatori bloccati</b>${blocks.data.map(b => html`<div class="row" style="padding:6px 0"><span>${b.azienda || 'Organizzatore'}</span><button class="btn ghost s" data-act="unblock" data-emp="${b.employer_id}">Sblocca</button></div>`)}` : ''}</div>
    ${accountCard()}`;
};
const trow = (label, ok, okText, action, actLabel, warnText) => html`<div class="row" style="padding:7px 0;border-top:1px solid var(--line)"><span>${label}</span>
  <span>${ok ? html`<span class="badge good">${okText}</span>` : action ? html`${warnText ? html`<span class="badge warn">${warnText}</span> ` : ''}<button class="btn s sec" data-act="${action}">${actLabel}</button>` : html`<span class="badge gray">${okText}</span>`}</span></div>`;
const trustCard = (t, v) => !t ? '' : html`<div class="card"><div class="row"><h3>Fiducia e verifiche</h3>${lvBadge(t) || html`<span class="badge gray">Nessuna verifica</span>`}</div>
  <p class="muted">Registrarsi è libero e le verifiche sono facoltative: ti fanno salire in classifica (fiducia <b>${t.punti}/10</b>) e ti aprono i ruoli che le richiedono.</p>
  ${trow('Email', t.email, 'Confermata', null, '', null)}
  ${trow('Telefono', t.telefono, 'Confermato', 'verifyPhone', 'Verifica con SMS')}
  ${trow('Codice fiscale', t.codice_fiscale, 'Congruo con i tuoi dati', 'verifyCf', 'Controlla')}
  ${trow('Foto del profilo', t.foto && t.foto_valida, 'Valida', 'uploadPhoto', t.foto ? 'Aggiorna' : 'Carica', !t.foto ? '' : t.foto_segnalata ? 'Da aggiornare' : 'Da riconfermare')}
  ${trow('Confermata da un organizzatore', t.conferme_sul_campo > 0, plural(t.conferme_sul_campo, 'organizzatore', 'organizzatori'), null, '', null)}
  ${trow('Identità certificata con documento', v && v.verificato, v && v.verificato ? 'Fino al ' + fFull(v.valida_fino_al) : '', 'verify', v && v.verificato ? 'Rinnova' : `Certificati (${eur(v ? v.prezzo_cents : 0)})`)}
  <div class="sep"></div>
  <p class="small-note"><b>Come funziona.</b> L'organizzatore vede la tua foto solo dopo che hai un turno con lui, e al check-in la confronta con il tuo selfie. La foto vale 12 mesi: se è datata o non ti somiglia più, aggiornala. Codice fiscale e conferma dell'organizzatore dicono che i dati sono coerenti, non provano l'identità legale: per quella serve il documento (facoltativo, a pagamento).</p></div>`;
const accountCard = () => html`<div class="card"><h3>Account</h3><p class="muted">${DEMO ? 'Demo' : ''}</p><div class="acts"><button class="btn sec" data-act="privacy">Informativa privacy</button><button class="btn sec" data-act="logout">Esci</button><button class="btn bad" data-act="deleteAccount">Elimina il mio account</button></div></div>`;

/* =====================================================================
   ORGANIZZATORE
   ===================================================================== */
VIEWS.events = async () => {
  const { data: evs } = await sb.from('events').select('*').eq('organizer_id', S.uid).order('event_date');
  return html`<div class="row"><h2>I tuoi eventi</h2><button class="btn s" data-act="newEvent">Nuovo evento</button></div>
    ${(evs || []).length ? evs.map(e => html`<div class="card" data-act="openEvent" data-id="${e.id}" style="cursor:pointer"><div class="row"><div class="grow"><h3>${e.name}</h3><div class="muted">${e.city} · ${fDay(e.event_date)}</div></div>
      <span class="badge ${e.complete ? 'good' : 'warn'}">${e.complete ? 'Completo' : 'Da completare'}</span></div></div>`) : empty('Nessun evento. Creane uno e aggiungi i ruoli di cui hai bisogno.')}`;
};

const EVTABS = [['ruoli', 'Ruoli'], ['presenze', 'Presenze'], ['canali', 'Canali']];
VIEWS.event = async id => {
  const { data: ev } = await sb.from('events').select('*').eq('id', id).maybeSingle();
  if (!ev) return html`<div class="card">Evento non trovato.</div>`;
  const head = html`<button class="btn ghost" data-act="tab" data-v="events">← Eventi</button>
    <div class="row"><div class="grow"><h2 style="margin:4px 0">${ev.name}</h2><div class="muted">${ev.city} · ${fDay(ev.event_date)}</div></div>
      <span class="badge ${ev.complete ? 'good' : 'warn'}">${ev.complete ? 'Evento completo' : 'Da completare'}</span></div>
    ${ev.complete ? html`<div class="card flat" style="background:var(--good-bg)"><b>Evento completo.</b> Tutti i posti sono coperti e le garanzie no-show hanno una riserva.</div>` : ''}
    <div class="seg">${EVTABS.map(([k, l]) => html`<button class="${S.tab === k ? 'on' : ''}" data-act="evtab" data-v="${k}">${l}</button>`)}</div>`;
  const body = S.tab === 'presenze' ? await evPresenze(ev) : S.tab === 'canali' ? await evCanali(ev) : await evRuoli(ev);
  return html`${head}${body}`;
};

async function evRuoli(ev) {
  const [jobsR, ovR, offR, gR] = await Promise.all([
    sb.from('jobs').select('*').eq('event_id', ev.id).order('starts_at'), sb.rpc('event_overview', { p_event: ev.id }),
    sb.from('offers').select('id,job_id,worker_id,status,kind,guarantee_id'), sb.from('guarantees').select('id,job_id,status,created_at')]);
  const jobs = jobsR.data || [], ov = ovR.data || [];
  const feeTot = S.settings ? S.settings.standby_fee_pct + S.settings.platform_fee_pct : 30;
  const cards = await Promise.all(jobs.map(async j => {
    const o = ov.find(x => x.job_id === j.id) || {};
    const open = S.open[j.id];
    let panel = '';
    if (open === 'cand') panel = await panelCandidates(j, offR.data || []);
    if (open === 'ris') panel = await panelReserves(j, gR.data || [], offR.data || []);
    if (open === 'apps') panel = await panelApps(j);
    const pct = j.headcount ? Math.min(100, Math.round(100 * (o.coperti || 0) / j.headcount)) : 0;
    const gOpen = (gR.data || []).filter(g => g.job_id === j.id && g.status === 'aperta').length;
    return html`<div class="card"><div class="row"><div class="grow"><h3>${j.title}</h3><div class="muted">${roleName(j.role_code)} · ${fShort(j.starts_at)}, ${fTime(j.starts_at)}-${fTime(j.ends_at)} · ${eur(j.shift_pay_cents)}</div></div>
        ${j.min_verification && j.min_verification !== 'nessuna' ? html`<span class="badge good">Richiede ${MIN_LABEL[j.min_verification]}</span>` : ''}${!j.is_open && !(o.coperti) ? html`<span class="badge gray">Annullato</span>` : o.ruolo_completo ? html`<span class="badge good">Completo</span>` : html`<span class="badge warn">Da coprire</span>`}</div>
      <div style="margin:10px 0 4px" class="row sm"><span>Posti coperti</span><b>${o.coperti || 0}/${j.headcount}</b></div><div class="bar ${o.ruolo_completo ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
      <div class="row sm" style="margin-top:8px"><span>Garanzia no-show</span><b>${o.garanzie || 0} acquistate, ${o.garanzie_coperte || 0} con riserva</b></div>
      <div class="acts">${j.is_open ? html`<button class="btn s" data-act="panel" data-job="${j.id}" data-p="cand">${open === 'cand' ? 'Chiudi candidati' : 'Candidati consigliati'}</button>
        <button class="btn s sec" data-act="panel" data-job="${j.id}" data-p="apps">Candidature ricevute</button>
        ${(o.garanzie || 0) < j.headcount ? html`<button class="btn s sec" data-act="buyG" data-job="${j.id}" data-cost="${eur(Math.round(j.shift_pay_cents * feeTot / 100))}">Aggiungi garanzia no-show</button>` : ''}
        ${gOpen ? html`<button class="btn s sec" data-act="panel" data-job="${j.id}" data-p="ris">Riserve (${gOpen} da coprire)</button>` : ''}
        ${j.auto_select ? html`<span class="badge good">Scelta automatica attiva</span>` : html`<button class="btn s sec" data-act="auto" data-job="${j.id}">Scelta automatica</button>`}
        <button class="btn s ghost" data-act="cancelJob" data-job="${j.id}">Annulla il ruolo</button>` : ''}</div>${panel}</div>`;
  }));
  return html`${cards.length ? cards : empty('Nessun ruolo ancora. Aggiungi il primo: barman, hostess, servizio ai tavoli…')}
    <button class="btn block" data-act="newRole" data-ev="${ev.id}">Aggiungi un ruolo</button>
    <p class="small-note">La garanzia no-show costa il ${feeTot}% della paga del ruolo per ogni sostituzione prenotata (${S.settings ? S.settings.standby_fee_pct : 20}% alla riserva, ${S.settings ? S.settings.platform_fee_pct : 10}% alla piattaforma). Se la riserva viene attivata prende la paga piena.</p>`;
}

const noteBadge = c => c.annotation === 'preferito' ? html`<span class="badge fav">Preferito</span>` : c.annotation === 'da_evitare' ? html`<span class="badge bad">Da evitare</span>` : '';
function candCard(c, job, offers, reserveG) {
  const off = offers.find(o => o.worker_id === c.worker_id && o.job_id === job.id && o.status === 'inviata');
  const bd = c.breakdown || {};
  const bar = (l, v, m) => html`<div>${l}<div class="bar"><i style="width:${Math.round(100 * v / m)}%"></i></div></div>`;
  const canInvite = !c.offer_status && c.annotation !== 'da_evitare';
  return html`<div class="card flat"><div class="row"><div class="grow"><b>${c.display_name}</b> ${lvBadge(c.trust)} ${fieldBadge(c.trust)} ${noteBadge(c)} ${c.applied ? html`<span class="badge">Si è candidato</span>` : ''}
      <div class="muted sm">${c.city || 'Città non indicata'} · ${plural(c.completed_same_role, 'turno', 'turni')} come ${roleName(job.role_code).toLowerCase()} · ${plural(c.no_shows, 'no-show', 'no-show')} · ${plural(c.lates, 'ritardo', 'ritardi')}</div></div>
      <span class="score" title="Punteggio di adeguatezza">${c.score}</span></div>
    <div class="mini">${bar('Città', bd.citta || 0, 25)}${bar('Esperienza', bd.esperienza || 0, 25)}${bar('Affidabilità', bd.affidabilita || 0, 30)}${bar('Interesse', bd.interesse || 0, 10)}${bar('Fiducia', bd.fiducia || 0, 10)}</div>
    ${job.min_verification && job.min_verification !== 'nessuna' && LEVEL[(c.trust || {}).livello || 'nessuna'] < LEVEL[job.min_verification] ? html`<p class="small-note">Non ha ancora il livello richiesto (${MIN_LABEL[job.min_verification]}): per accettare dovrà prima verificarsi.</p>` : ''}
    ${c.bio ? html`<p class="sm" style="margin-top:8px">${c.bio}</p>` : ''}${c.annotation_note ? html`<p class="small-note">Tua nota: ${c.annotation_note}</p>` : ''}
    <div class="acts">${canInvite ? html`<button class="btn s" data-act="${reserveG ? 'inviteRes' : 'invite'}" data-job="${job.id}" data-worker="${c.worker_id}" ${attr('data-g', reserveG)}>Invita${reserveG ? ' come riserva' : ''}</button>` : ''}
      ${c.offer_status ? badge(OFFER, c.offer_status) : ''}${off ? html`<button class="btn s ghost" data-act="withdrawOffer" data-id="${off.id}">Ritira</button>` : ''}
      ${c.annotation === 'preferito' ? html`<button class="btn s ghost" data-act="unnote" data-worker="${c.worker_id}">Togli preferito</button>` : html`<button class="btn s ghost" data-act="note" data-kind="preferito" data-worker="${c.worker_id}">Preferito</button>`}
      ${c.annotation === 'da_evitare' ? html`<button class="btn s ghost" data-act="unnote" data-worker="${c.worker_id}">Togli "da evitare"</button>` : html`<button class="btn s ghost" data-act="note" data-kind="da_evitare" data-worker="${c.worker_id}">Da evitare</button>`}</div></div>`;
}
async function panelCandidates(j, offers) {
  const { data, error } = await sb.rpc('match_workers', { p_job: j.id, p_limit: 30 });
  if (error) return html`<p class="err">${HERR(error)}</p>`;
  return html`<div class="sep"></div><b>Candidati consigliati</b><p class="muted sm">Ordinati per adeguatezza. Preferiti in cima, "da evitare" in fondo. Il punteggio usa città, esperienza, affidabilità e identità verificata: mai foto, età o genere.</p>
    ${data.length ? data.map(c => candCard(c, j, offers, null)) : empty('Nessun candidato trovato per questo ruolo. Condividi il link dell\'evento su altri canali dalla scheda "Canali".')}`;
}
async function panelReserves(j, gs, offers) {
  const g = gs.find(x => x.job_id === j.id && x.status === 'aperta' && !offers.some(o => o.guarantee_id === x.id && o.status === 'inviata'));
  const { data } = await sb.rpc('match_reserves', { p_job: j.id, p_limit: 30 });
  return html`<div class="sep"></div><b>Riserve consigliate</b><p class="muted sm">Persone che hanno dichiarato disponibilità come riserva per questo ruolo, zona e orario.</p>
    ${!g ? html`<p class="muted">Ogni garanzia scoperta ha già una proposta in attesa.</p>` : ''}
    ${(data || []).length ? data.map(c => candCard(c, j, offers, g ? g.id : null)) : empty('Nessuna riserva disponibile al momento.')}`;
}
async function panelApps(j) {
  const { data: apps } = await sb.from('applications').select('id,seeker_id,message,created_at').eq('job_id', j.id);
  const ids = (apps || []).map(a => a.seeker_id);
  const ps = ids.length ? (await sb.from('profiles').select('id,full_name,city,bio,verified_until').in('id', ids)).data || [] : [];
  const shifts = ids.length ? (await sb.from('shifts').select('worker_id,status').eq('job_id', j.id)).data || [] : [];
  return html`<div class="sep"></div><b>Candidature ricevute</b>${(apps || []).length ? apps.map(a => { const p = ps.find(x => x.id === a.seeker_id) || {}; const hired = shifts.some(s => s.worker_id === a.seeker_id && s.status !== 'annullato');
    return html`<div class="card flat"><div class="row"><div class="grow"><b>${p.full_name || 'Candidato'}</b> ${p.verified_until && D(p.verified_until) > new Date() ? html`<span class="badge good">Identità certificata</span>` : ''}<div class="muted sm">${p.city || ''} · ${fShort(a.created_at)}</div></div>
      ${hired ? html`<span class="badge good">Assegnato</span>` : html`<button class="btn s" data-act="accept" data-id="${a.id}">Accetta</button>`}</div>
      ${a.message ? html`<p class="sm">"${a.message}"</p>` : ''}${p.bio ? html`<p class="muted sm">${p.bio}</p>` : ''}</div>`; }) : empty('Nessuna candidatura ricevuta.')}`;
}

async function evPresenze(ev) {
  const { data: rows } = await sb.rpc('event_roster', { p_event: ev.id });
  const list = rows || [];
  if (!list.length) return empty('Nessuno è ancora assegnato a questo evento. Quando i lavoratori accettano, li gestisci da qui.');
  const jobs = {}; list.forEach(r => { (jobs[r.job_title] = jobs[r.job_title] || []).push(r); });
  return html`${Object.entries(jobs).map(([t, arr]) => html`<h3 style="margin:16px 0 6px">${t}</h3>${arr.map(r => {
    if (r.kind === 'riserva') return html`<div class="card flat row"><div><b>${r.worker_name}</b> <span class="badge fav">Riserva</span><div class="muted sm">A disposizione</div></div></div>`;
    return html`<div class="card"><div class="row"><div class="grow"><b>${r.worker_name}</b> ${r.is_replacement ? html`<span class="badge fav">Sostituta</span>` : ''}
        <div class="muted sm">Atteso alle ${fTime(r.expected_at)}</div></div>${badge(SHIFT, r.status)}</div>
      ${r.check_in_at ? html`<p class="sm">Check-in alle <b>${fTime(r.check_in_at)}</b>${r.minutes_late ? html` <span class="badge warn">${r.minutes_late} min di ritardo</span>` : ''} · selfie ricevuto · ${r.check_in_confirmed_at ? 'confermato' : html`<b>in attesa della tua conferma</b>`}</p>` : r.status === 'assegnato' ? html`<p class="sm muted">Nessun check-in ancora.</p>` : ''}
      ${r.check_out_at ? html`<p class="sm">Check-out alle ${fTime(r.check_out_at)} · ${r.check_out_confirmed_at ? 'confermato' : html`<b>in attesa della tua conferma</b>`}</p>` : ''}
      ${r.identity_outcome === 'non_corrisponde' ? html`<p><span class="badge bad">Segnalato: in verifica</span> <span class="muted sm">Il check-in resta non confermato.</span></p>` : r.identity_outcome === 'foto_datata' ? html`<p><span class="badge warn">Foto datata</span> <span class="muted sm">La persona è stata invitata ad aggiornarla.</span></p>` : ''}
      ${r.check_in_id && !r.check_in_confirmed_at && !r.identity_outcome ? html`<div class="card flat" style="margin-top:8px"><b>Confronta la persona</b>
        <div class="two" style="margin-top:8px"><div><div class="muted sm">Foto del profilo</div>${photoImg(r.worker_photo, r.worker_name, 'profilo')}</div><div><div class="muted sm">Selfie di oggi</div>${photoImg(r.selfie_path, r.worker_name, 'selfie')}</div></div>
        ${DEMO ? html`<p class="small-note">In demo le immagini sono segnaposto: online vedi le foto vere.</p>` : ''}
        <div class="acts"><button class="btn s" data-act="identity" data-id="${r.check_in_id}" data-o="ok">È la persona</button><button class="btn s sec" data-act="identity" data-id="${r.check_in_id}" data-o="foto_datata">È lei/lui, foto datata</button><button class="btn s bad" data-act="identity" data-id="${r.check_in_id}" data-o="non_corrisponde">Non corrisponde</button></div></div>` : ''}
      <div class="acts">
        ${r.check_out_id && !r.check_out_confirmed_at ? html`<button class="btn s" data-act="confirmCheck" data-id="${r.check_out_id}">Conferma check-out</button>` : ''}
        ${r.can_report_no_show ? html`<button class="btn s bad" data-act="noshow" data-id="${r.shift_id}" data-name="${r.worker_name}">Segnala no-show</button>` : ''}</div></div>`; })}`)}
    <p class="small-note">Puoi segnalare un no-show solo dopo 15 minuti dall'orario atteso e se non c'è un check-in. Se esiste una riserva, subentra subito.</p>`;
}

async function evCanali(ev) {
  const [links, stats] = await Promise.all([sb.from('event_links').select('*').eq('event_id', ev.id).order('created_at'), sb.rpc('link_stats', { p_event: ev.id })]);
  const st = stats.data || [];
  return html`<p class="muted">Pubblica l'annuncio sui siti che preferisci con un link per ciascuno. Chi lo apre vede l'evento e si candida qui: le risposte arrivano tutte su un unico canale e vedi quale funziona meglio.</p>
    ${(links.data || []).length ? links.data.map(l => { const s = st.find(x => x.code === l.code) || {}; const url = location.href.split('#')[0] + '#e-' + l.code;
      return html`<div class="card"><div class="row"><h3>${l.channel}</h3><button class="btn s sec" data-act="share" data-code="${l.code}" data-ch="${l.channel}">Link e testo</button></div>
        <div class="row sm" style="margin-top:8px"><span>Nuovi iscritti <b>${s.nuovi_iscritti ?? 0}</b></span><span>Candidature <b>${s.candidature ?? 0}</b></span><span>Assunti <b>${s.assunti ?? 0}</b></span></div></div>`; }) : empty('Nessun canale ancora.')}
    <button class="btn block" data-act="newLink" data-ev="${ev.id}">Nuovo canale</button>`;
}

VIEWS.orgprofile = async () => {
  if (!isOrg()) return VIEWS.profile();
  const p = S.profile;
  const [fb, notes] = await Promise.all([sb.rpc('my_organizer_feedback'), sb.rpc('my_worker_notes')]);
  const f = fb.data || {}, r = f.riepilogo || {};
  return html`<h2>Il tuo profilo</h2>
    <form class="card" data-form="saveOrg"><label class="f" for="nm">Nome o ragione sociale</label><input id="nm" value="${p.full_name}" maxlength="100" required>
      <label class="f" for="ci">Città</label><input id="ci" value="${p.city || ''}" maxlength="100"><div class="acts"><button class="btn" type="submit">Salva</button></div></form>
    <div class="card"><h3>Come ti giudicano i lavoratori</h3>
      ${r.nuovo ? html`<p class="muted">Sei un organizzatore nuovo: il punteggio compare dopo ${S.settings ? S.settings.min_reviews_to_show : 3} giudizi (finora ${r.n || 0}).</p>` : html`<div class="row"><span class="score">${num1(r.overall)}/5</span><span class="muted">${plural(r.n, 'giudizio', 'giudizi')}</span></div>
        <dl class="kv" style="margin-top:8px"><dt>Pagamenti</dt><dd>${num1(r.pagamenti)}</dd><dt>Trasparenza</dt><dd>${num1(r.trasparenza)}</dd><dt>Rispetto degli accordi</dt><dd>${num1(r.affidabilita)}</dd><dt>Pagato puntuale</dt><dd>${r.pagato_puntuale_pct ?? '-'}%</dd><dt>Annullamenti tardivi (12 mesi)</dt><dd>${r.annullamenti_tardivi_12m}</dd></dl>`}
      ${(f.commenti || []).length ? html`<div class="sep"></div><b>Commenti anonimi</b>${f.commenti.map(c => html`<p class="sm">"${c.testo}" <span class="muted">${c.mese}</span></p>`)}` : ''}
      <p class="small-note">Chi ti giudica ha lavorato davvero ai tuoi eventi. I commenti sono anonimi e compaiono con almeno ${S.settings ? S.settings.min_reviews_to_show : 3} giudizi. I lavoratori possono scegliere di ricevere proposte solo da organizzatori con un certo punteggio.</p></div>
    <div class="card"><h3>Le tue note private</h3><p class="muted">Preferiti e persone da evitare. Le vedi solo tu, ma una persona può chiederne l'accesso: scrivi fatti di lavoro.</p>
      ${(notes.data || []).length ? notes.data.map(n => html`<div class="row" style="padding:6px 0"><div><b>${n.display_name}</b> ${n.kind === 'preferito' ? html`<span class="badge fav">Preferito</span>` : html`<span class="badge bad">Da evitare</span>`}<div class="muted sm">${n.note || ''}</div></div><button class="btn ghost s" data-act="unnote" data-worker="${n.worker_id}">Togli</button></div>`) : html`<p class="muted">Nessuna nota.</p>`}</div>
    ${accountCard()}`;
};

VIEWS.notifs = async () => {
  const { data } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(60);
  return html`<div class="row"><h2>Notifiche</h2>${S.unread ? html`<button class="btn s sec" data-act="readAll">Segna tutte come lette</button>` : ''}</div>
    ${(data || []).length ? data.map(n => html`<div class="card ${n.read_at ? 'flat' : ''}" data-act="notif" data-id="${n.id}" style="cursor:pointer;${n.read_at ? '' : 'border-color:var(--brand)'}">
      <div class="row"><b>${n.title}</b><span class="muted sm">${fDT(n.created_at)}</span></div><p class="sm" style="margin:4px 0 0">${n.body}</p></div>`) : empty('Nessuna notifica.')}`;
};

/* =====================================================================
   AZIONI
   ===================================================================== */
const A = {};
A.home = () => go(home());
A.goto = el => go(el.dataset.v);
A.tab = el => { S.search = ''; return go(el.dataset.v); };
A.bell = () => go('notifs');
A.privacy = () => modal({ title: 'Informativa privacy', body: html`<pre class="sel">${INFORMATIVA}</pre>`, hideOk: true, cancel: 'Chiudi' });
A.pickrole = el => { $$('#rolechips .chip').forEach(c => c.classList.toggle('on', c === el)); };
A.demoLogin = async el => { S.demo.loginAs(el.dataset.id); await loadSession(); await go(home()); };
A.demoTools = async () => {
  const users = await S.demo.users();
  const r = await modal({ title: 'Strumenti demo', intro: 'Per provare l\'app da più punti di vista e far scorrere il tempo.', hideOk: true, cancel: 'Chiudi',
    body: html`<label class="f">Cambia utente</label><div class="chips">${users.filter(u => u.ord < 100).map(u => html`<button type="button" class="chip ${S.uid === u.id ? 'on' : ''}" data-dt="login" data-id="${u.id}">${u.label}</button>`)}</div>
      ${users.some(u => u.ord >= 100) ? html`<select data-dtsel style="margin-top:8px" aria-label="Altri utenti di prova"><option value="">Altri utenti di prova (${users.filter(u => u.ord >= 100).length})…</option>${users.filter(u => u.ord >= 100).map(u => html`<option value="${u.id}">${u.label}: ${u.descr}</option>`)}</select>` : ''}
      <label class="f">Utenti finti per i test</label><div class="acts" style="margin-top:0"><button type="button" class="btn s sec" data-dt="gen">Aggiungi 20 lavoratori di prova</button><button type="button" class="btn s sec" data-dt="purge">Rimuovi i lavoratori di prova</button></div>
      <label class="f">Far scorrere il tempo</label><div class="acts" style="margin-top:0">
        <button type="button" class="btn s sec" data-dt="start">Fai iniziare il prossimo evento (30 min fa)</button>
        <button type="button" class="btn s sec" data-dt="end">Fai finire gli eventi in corso</button>
        <button type="button" class="btn s sec" data-dt="h1">Avanza di 1 ora</button>
        <button type="button" class="btn s sec" data-dt="expire">Fai scadere gli inviti</button>
        <button type="button" class="btn s sec" data-dt="cron">Esegui i controlli automatici</button>
        <button type="button" class="btn s bad" data-dt="reset">Ricomincia da capo</button></div>
      <p class="small-note">Online i controlli automatici girano da soli ogni pochi minuti.</p>` });
  return r;
};
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-dt]'); if (!b) return;
  const k = b.dataset.dt, ov = b.closest('.ov');
  try {
    if (k === 'gen') { toast(`Creati ${await S.demo.generateWorkers(20)} lavoratori di prova.`); ov.remove(); await render(); return; }
    if (k === 'purge') { toast(`Rimossi ${await S.demo.purgeTest()} utenti di prova.`); ov.remove(); await render(); return; }
    if (k === 'login') { S.demo.loginAs(b.dataset.id); await loadSession(); ov.remove(); await go(home()); return; }
    if (k === 'start') toast((await S.demo.startNextEvent()) ? 'Il prossimo evento è iniziato da 30 minuti.' : 'Nessun evento in arrivo.');
    if (k === 'end') { await S.demo.endRunningEvents(); toast('Gli eventi in corso sono finiti.'); }
    if (k === 'h1') { await S.demo.advance(3600); toast('Un\'ora dopo.'); }
    if (k === 'expire') { await S.demo.expireOffers(); toast('Inviti scaduti: esegui i controlli automatici.'); }
    if (k === 'cron') { await S.demo.cron(); toast('Controlli eseguiti.'); }
    if (k === 'reset') { S.demo.loginAs(null); await S.demo.reset(); S.uid = null; S.profile = null; ov.remove(); toast('Demo ricominciata.'); await go('welcome'); return; }
    await render();
  } catch (err) { toast(err.message, true); }
});

async function strongFlow(reason = '') {
  const info = (await sb.rpc('my_verification')).data || {};
  if (info.verificato) return true;
  const go_ = await modal({ title: 'Certifica la tua identità', intro: reason,
    body: html`<dl class="kv" style="margin:8px 0"><dt>Costo</dt><dd><b>${eur(info.prezzo_cents)}</b> una tantum, a tuo carico</dd><dt>Validità</dt><dd>${info.mesi} mesi, poi si rinnova</dd><dt>Cosa serve</dt><dd>un documento e un selfie, con un fornitore specializzato</dd></dl>
      <p class="small-note">Non conserviamo documenti né foto di identificazione: restano al fornitore. Noi sappiamo solo che sei certificato e fino a quando.</p>`,
    ok: `Paga ${eur(info.prezzo_cents)} e certifica` });
  if (!go_) return false;
  const st = await call(sb.rpc('start_verification')); if (!st.ok) return false;
  if (!DEMO) { await modal({ title: 'Richiesta registrata', intro: 'Il collegamento con il fornitore di identità non è ancora attivo: vedi la guida (Edge Function e webhook).', hideOk: true, cancel: 'Chiudi' }); return false; }
  const r = await modal({ title: 'Fornitore di identità (simulazione)', intro: 'In produzione qui il lavoratore paga, scatta il selfie e fotografa il documento. In demo scegli tu l\'esito.', ok: 'Invia esito',
    fields: [{ name: 'o', type: 'select', label: 'Esito della verifica', options: [['ok', 'Documento valido'], ['rifiutata', 'Documento non valido']] }] });
  if (!r) return false;
  await S.demo.completeVerification(st.data, r.o); await loadSession();
  return myLevel() >= LEVEL.forte;
}
async function phoneFlow() {
  const r = await modal({ title: 'Verifica il telefono', intro: 'Ti mandiamo un SMS con un codice. Serve a dimostrare che il numero è tuo; ogni numero vale per un solo account.', ok: 'Invia il codice',
    fields: [{ name: 'tel', label: 'Cellulare con prefisso (es. +39 347 1234567)', type: 'tel', required: true, max: 20 }] });
  if (!r) return false;
  const phone = r.tel.replace(/[^+0-9]/g, '');
  if (!DEMO) { const u = await sb.auth.updateUser({ phone }); if (u.error) { toast('SMS non inviato: ' + HERR(u.error), true); return false; } }
  for (let tentativo = 0; tentativo < 3; tentativo++) {
    const c = await modal({ title: 'Inserisci il codice', ok: 'Conferma',
      intro: (tentativo ? 'Codice errato: riprova. ' : '') + (DEMO ? 'Demo: nessun SMS vero. Il codice è 123456.' : `Abbiamo inviato un SMS al ${phone}.`),
      fields: [{ name: 'c', label: 'Codice a 6 cifre', required: true, max: 6 }] });
    if (!c) return false;
    if (DEMO) { if (c.c.trim() === '123456') { await S.demo.confirmPhone(phone); return true; } continue; }
    const v = await sb.auth.verifyOtp({ phone, token: c.c.trim(), type: 'phone_change' });
    if (!v.error) return true;
  }
  toast('Troppi tentativi: richiedi un nuovo codice.', true); return false;
}
async function cfFlow() {
  const parts = (S.profile.full_name || '').trim().split(/\s+/);
  const r = await modal({ title: 'Controlla il codice fiscale', intro: 'Verifichiamo che sia coerente con nome, cognome e data di nascita. La data serve solo per il controllo e non viene salvata. Un codice fiscale può essere usato da un solo account.', ok: 'Controlla',
    fields: [{ name: 'f', label: 'Nome', value: parts[0] || '', required: true, max: 60 }, { name: 'l', label: 'Cognome', value: parts.slice(1).join(' '), required: true, max: 60 },
      { name: 'b', type: 'date', label: 'Data di nascita', required: true }, { name: 'c', label: 'Codice fiscale', required: true, max: 16 }] });
  if (!r) return false;
  const x = await sb.rpc('verify_tax_code', { p_first: r.f, p_last: r.l, p_birth: r.b, p_code: r.c });
  if (x.error) { toast(HERR(x.error), true); return false; }
  const d = x.data; if (d.ok) return true;
  const row = (ok, t) => html`<p class="sm">${ok ? 'OK' : 'NON TORNA'}: ${t}</p>`;
  await modal({ title: 'Il codice non torna', hideOk: true, cancel: 'Chiudi', intro: 'Controlla di aver scritto bene i dati e il codice.',
    body: html`${row(d.formato, 'formato del codice')}${row(d.controllo, 'carattere di controllo')}${row(d.cognome, 'cognome')}${row(d.nome, 'nome')}${row(d.nascita, 'data di nascita')}` });
  return false;
}
async function baseFlow(reason = '') {
  let t = (await sb.rpc('my_trust')).data || {};
  const go_ = await modal({ title: 'Verifica di base', intro: reason, ok: 'Cominciamo',
    body: html`<p>È gratuita e ci vogliono pochi minuti: conferma del telefono con un SMS e controllo del codice fiscale. Serve anche l'email confermata.</p>` });
  if (!go_) return false;
  if (!t.email) { toast('Prima conferma l\'email: controlla la posta.', true); return false; }
  if (!t.telefono && !(await phoneFlow())) return false;
  if (!t.codice_fiscale && !(await cfFlow())) return false;
  await loadSession(); return myLevel() >= LEVEL.base;
}
async function verifyFlow(reason = '', min = 'forte') {
  if (myLevel() >= (LEVEL[min] ?? LEVEL.forte)) return true;
  return min === 'base' ? baseFlow(reason) : strongFlow(reason);
}
A.verify = async () => { if (await strongFlow()) { toast('Identità certificata.'); } render(); };
A.verifyPhone = async () => { if (await phoneFlow()) { await loadSession(); toast('Telefono confermato.'); } render(); };
A.verifyCf = async () => { if (await cfFlow()) { await loadSession(); toast('Codice fiscale congruo.'); } render(); };
A.uploadPhoto = async () => {
  const r = await modal({ title: 'Foto del profilo', intro: 'Una foto recente, dove si vede bene il viso. La vedono solo gli organizzatori con cui hai un turno, che la confrontano con il selfie del check-in. Vale 12 mesi.', ok: 'Salva la foto',
    fields: DEMO ? [] : [{ name: 'f', type: 'file', label: 'Foto', capture: true, required: true }], body: DEMO ? html`<p class="small-note">In demo non conserviamo foto: useremo un'immagine di esempio.</p>` : '' });
  if (!r) return;
  const path = `${S.uid}/${Date.now()}.jpg`;
  if (!DEMO) { const up = await sb.storage.from('profili').upload(path, r.f, { upsert: true }); if (up.error) return toast('Foto non caricata: ' + up.error.message, true); }
  if ((await call(sb.rpc('set_profile_photo', { p_path: path }), 'Foto salvata.')).ok) { await loadSession(); render(); }
};
A.identity = async el => {
  const o = el.dataset.o; let note = '';
  if (o === 'non_corrisponde') {
    const r = await modal({ title: 'Non corrisponde?', danger: true, ok: 'Segnala', intro: 'Il check-in non viene confermato e la segnalazione va al nostro controllo. Usalo solo se la persona è chiaramente diversa da quella del profilo.', fields: [{ name: 'n', type: 'textarea', label: 'Cosa hai notato (facoltativo)', max: 300 }] });
    if (!r) return; note = r.n;
  }
  const msg = { ok: 'Confermato: la persona corrisponde.', foto_datata: 'Confermato. Chiediamo alla persona di aggiornare la foto.', non_corrisponde: 'Segnalato: lo verifichiamo noi.' }[o];
  if ((await call(sb.rpc('confirm_check_identity', { p_check: el.dataset.id, p_outcome: o, p_note: note }), msg)).ok) render();
};
const needsVerify = m => /verific/i.test(m || '');
async function withVerify(makeCall, reason, min) {
  let x = await makeCall();
  if (x.error && needsVerify(x.error.message)) {
    if (!(await verifyFlow(reason, min || 'forte'))) { toast('Senza la verifica richiesta non puoi accettare questo ruolo.', true); return { ok: false, data: null }; }
    x = await makeCall();
  }
  if (x.error) { toast(HERR(x.error), true); return { ok: false, data: null }; }
  return { ok: true, data: x.data };
}

A.logout = async () => { await sb.auth.signOut(); S.uid = null; S.profile = null; await go('welcome'); };
A.deleteAccount = async () => {
  const r = await modal({ title: 'Eliminare l\'account?', intro: 'Cancelliamo in modo definitivo profilo, turni, candidature e giudizi. Non si può annullare.', ok: 'Elimina per sempre', danger: true });
  if (!r) return; const x = await call(sb.rpc('delete_my_account'), 'Account eliminato.');
  if (x.ok) { await sb.auth.signOut(); S.uid = null; S.profile = null; await go('welcome'); }
};

/* lavoratore */
A.respond = async el => {
  const yes = el.dataset.yes === '1';
  let x = await call(sb.rpc('respond_offer', { p_offer: el.dataset.id, p_accept: yes })); if (!x.ok) return;
  if (x.data === 'serve_verifica') {
    if (!(await verifyFlow('Questo ruolo richiede una verifica prima di accettare.', el.dataset.min))) return toast('La proposta resta in attesa: puoi accettarla dopo la verifica.');
    x = await call(sb.rpc('respond_offer', { p_offer: el.dataset.id, p_accept: yes })); if (!x.ok) return;
  }
  const msg = { accettata: 'Fatto: è nel tuo calendario.', rifiutata: 'Proposta rifiutata.', scaduta: 'La proposta era scaduta.', posti_esauriti: 'Troppo tardi: i posti sono già coperti.', non_piu_necessaria: 'La riserva non serve più.', non_disponibile: 'Hai già un impegno in quella fascia.' }[x.data] || x.data;
  toast(msg, ['scaduta', 'posti_esauriti', 'non_disponibile', 'non_piu_necessaria'].includes(x.data)); render();
};
A.block = async el => {
  const r = await modal({ title: `Bloccare ${el.dataset.name}?`, intro: 'Non riceverai più proposte da questo organizzatore e la proposta in corso viene rifiutata. Lui non verrà avvisato. Puoi sbloccarlo dal Profilo.', ok: 'Blocca', danger: true });
  if (r && (await call(sb.rpc('block_organizer', { p_employer: el.dataset.emp }), 'Organizzatore bloccato.')).ok) render();
};
A.unblock = async el => { if ((await call(sb.rpc('unblock_organizer', { p_employer: el.dataset.emp }), 'Sbloccato.')).ok) render(); };
A.withdrawApp = async el => { if ((await call(sb.from('applications').delete().eq('id', el.dataset.id), 'Candidatura ritirata.')).ok) render(); };
A.claim = async el => { const x = await withVerify(() => sb.rpc('claim_standby', { p_guarantee: el.dataset.id }), 'Questo ruolo richiede una verifica prima di accettare.', el.dataset.min); if (x.ok) { toast('Sei riserva per questo evento.'); render(); } };
A.job = el => go('job', el.dataset.id);
A.applyJob = async el => {
  const r = await modal({ title: 'Candidati', fields: [{ name: 'm', type: 'textarea', label: 'Messaggio per l\'organizzatore (facoltativo)', max: 500 }], ok: 'Invia candidatura' }); if (!r) return;
  const x = await withVerify(() => sb.rpc('apply_to_job', { p_job: el.dataset.job, p_message: r.m, p_link_code: null }), 'Questo ruolo richiede una verifica prima di candidarti.', el.dataset.min);
  if (x.ok) { toast('Candidatura inviata.'); render(); }
};
A.applyLink = async el => {
  if (!S.uid) { toast('Accedi o registrati per candidarti.'); return go('register'); }
  if (!isSeeker()) return toast('Solo chi cerca lavoro può candidarsi.', true);
  const r = await modal({ title: 'Candidati', fields: [{ name: 'm', type: 'textarea', label: 'Messaggio per l\'organizzatore (facoltativo)', max: 500 }], ok: 'Invia candidatura' }); if (!r) return;
  const x = await withVerify(() => sb.rpc('apply_to_job', { p_job: el.dataset.job, p_message: r.m, p_link_code: S.linkCode }), 'Questo ruolo richiede una verifica prima di candidarti.', el.dataset.min);
  if (x.ok) { toast('Candidatura inviata.'); go('offers'); }
};
A.checkin = async el => {
  const r = await modal({ title: 'Check-in', intro: 'Scatta un selfie: l\'organizzatore lo vede per confermare che sei tu.', fields: [{ name: 'f', type: 'file', label: 'Selfie', capture: true, required: !DEMO }], ok: 'Invia check-in' }); if (!r) return;
  const pos = await new Promise(ok => { if (!navigator.geolocation) return ok(null); navigator.geolocation.getCurrentPosition(p => ok(p.coords), () => ok(null), { timeout: 4000 }); });
  const path = `${S.uid}/${el.dataset.id}-in-${Date.now()}.jpg`;
  if (r.f && !DEMO) { const up = await sb.storage.from('checkins').upload(path, r.f, { upsert: true }); if (up.error) return toast('Selfie non caricato: ' + up.error.message, true); }
  const x = await call(sb.rpc('worker_check', { p_shift: el.dataset.id, p_kind: 'in', p_lat: pos ? pos.latitude : null, p_lng: pos ? pos.longitude : null, p_selfie: path }), 'Check-in inviato: attendi la conferma dell\'organizzatore.');
  if (x.ok) render();
};
A.checkout = async el => {
  const r = await modal({ title: 'Check-out', intro: 'Confermi di aver finito il turno?', ok: 'Check-out' }); if (!r) return;
  const x = await call(sb.rpc('worker_check', { p_shift: el.dataset.id, p_kind: 'out', p_lat: null, p_lng: null, p_selfie: null }), 'Check-out inviato.'); if (x.ok) render();
};
A.review = async el => {
  const sc = [[5, '5 · Ottimo'], [4, '4'], [3, '3'], [2, '2'], [1, '1 · Pessimo']];
  const r = await modal({ title: 'Come è andata?', intro: 'Il tuo giudizio è anonimo per l\'organizzatore e aiuta gli altri lavoratori.', ok: 'Invia giudizio', fields: [
    { name: 'pay', type: 'select', label: 'Pagamenti', options: sc, value: 5 }, { name: 'tr', type: 'select', label: 'Trasparenza (cose dette e fatte)', options: sc, value: 5 },
    { name: 're', type: 'select', label: 'Rispetto degli accordi', options: sc, value: 5 },
    { name: 'paid', type: 'select', label: 'Sei stato pagato?', options: [['puntuale', 'Sì, puntuale'], ['in_ritardo', 'Sì, in ritardo'], ['non_pagato', 'No'], ['non_ancora', 'Non ancora']], value: 'puntuale' },
    { name: 'c', type: 'textarea', label: 'Commento (facoltativo, solo fatti di lavoro)', max: 300 }] }); if (!r) return;
  await call(sb.rpc('review_organizer', { p_shift: el.dataset.id, p_pay: +r.pay, p_transparency: +r.tr, p_reliability: +r.re, p_paid: r.paid, p_comment: r.c }), 'Grazie per il giudizio.');
};
A.addUnav = async () => {
  const s = new Date(); s.setDate(s.getDate() + 1); s.setHours(9, 0, 0, 0); const e = new Date(s); e.setHours(18);
  const r = await modal({ title: 'Quando non sei disponibile', ok: 'Salva', fields: [{ name: 'a', type: 'datetime-local', label: 'Dal', value: toLocalInput(s), required: true }, { name: 'b', type: 'datetime-local', label: 'Al', value: toLocalInput(e), required: true }, { name: 'n', label: 'Nota (facoltativa)', max: 200 }] }); if (!r) return;
  if ((await call(sb.from('worker_unavailability').insert({ worker_id: S.uid, from_at: D(r.a).toISOString(), to_at: D(r.b).toISOString(), note: r.n || '' }), 'Segnato: non riceverai proposte in quella fascia.')).ok) render();
};
A.delUnav = async el => { if ((await call(sb.from('worker_unavailability').delete().eq('id', el.dataset.id))).ok) render(); };
A.ics = async () => {
  const { data } = await sb.rpc('calendar_ics'); const txt = data || '';
  await modal({ title: 'Esporta il calendario', intro: 'Copia questo testo o scarica il file e importalo nel calendario del telefono (turni e riserve confermati).', hideOk: true, cancel: 'Chiudi', body: html`<pre class="sel" id="icsbox">${txt}</pre><div class="acts"><button type="button" class="btn s" data-act="copyIcs">Copia</button>${DEMO ? '' : html`<button type="button" class="btn s sec" data-act="dlIcs">Scarica .ics</button>`}</div>` });
};
A.copyIcs = async () => { const t = $('#icsbox').textContent; try { await navigator.clipboard.writeText(t); toast('Copiato.'); } catch (e) { const r = document.createRange(); r.selectNodeContents($('#icsbox')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Seleziona e copia il testo.'); } };
/*__DL_START__*/A.dlIcs = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('#icsbox').textContent], { type: 'text/calendar' })); a.download = 'lavoro-facile.ics'; a.click(); };/*__DL_END__*/
A.toggleRole = async el => {
  const on = el.classList.contains('on');
  const q = on ? sb.from('worker_roles').delete().eq('worker_id', S.uid).eq('role_code', el.dataset.code) : sb.from('worker_roles').insert({ worker_id: S.uid, role_code: el.dataset.code });
  if ((await call(q)).ok) render();
};
A.toggleDisc = async el => { const x = await call(sb.from('profiles').update({ discoverable: el.checked }).eq('id', S.uid), el.checked ? 'Ora gli organizzatori possono trovarti.' : 'Non compari più nelle ricerche.'); if (x.ok) { S.profile.discoverable = el.checked; } };
A.savePref = async () => {
  const v = $('#minr').value; await call(sb.rpc('set_offer_preferences', { p_min_rating: v === '' ? null : Number(v), p_allow_new: $('#newo').checked }), 'Preferenze salvate.');
};
A.addAvail = async () => {
  const mine = ((await sb.from('worker_roles').select('role_code')).data || []).map(r => r.role_code);
  if (!mine.length) return toast('Scegli prima almeno un ruolo.', true);
  const s = new Date(); s.setHours(8, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 14);
  const r = await modal({ title: 'Disponibilità come riserva', ok: 'Salva', fields: [
    { name: 'r', type: 'select', label: 'Ruolo', options: mine.map(c => [c, roleName(c)]) }, { name: 'c', label: 'Città', value: S.profile.city || '', required: true },
    { name: 'a', type: 'datetime-local', label: 'Dal', value: toLocalInput(s), required: true }, { name: 'b', type: 'datetime-local', label: 'Al', value: toLocalInput(e), required: true }] }); if (!r) return;
  if ((await call(sb.from('standby_availability').insert({ worker_id: S.uid, role_code: r.r, city: r.c, from_at: D(r.a).toISOString(), to_at: D(r.b).toISOString() }), 'Disponibilità salvata.')).ok) render();
};
A.delAvail = async el => { if ((await call(sb.from('standby_availability').delete().eq('id', el.dataset.id))).ok) render(); };

/* organizzatore */
A.newEvent = async () => {
  const d = new Date(); d.setDate(d.getDate() + 7);
  const r = await modal({ title: 'Nuovo evento', ok: 'Crea evento', fields: [{ name: 'n', label: 'Nome', required: true, max: 120 }, { name: 'c', label: 'Città', value: S.profile.city || '', required: true }, { name: 'd', type: 'date', label: 'Data', value: d.toISOString().slice(0, 10), required: true }] }); if (!r) return;
  const x = await call(sb.from('events').insert({ organizer_id: S.uid, name: r.n, city: r.c, event_date: r.d }).select('id'));
  if (x.ok) { S.tab = 'ruoli'; go('event', x.data[0].id); }
};
A.openEvent = el => { S.tab = 'ruoli'; S.open = {}; go('event', el.dataset.id); };
A.evtab = el => { S.tab = el.dataset.v; render(); };
A.panel = el => { const j = el.dataset.job, p = el.dataset.p; S.open[j] = S.open[j] === p ? null : p; render(); };
A.newRole = async el => {
  const ev = (await sb.from('events').select('*').eq('id', el.dataset.ev).maybeSingle()).data;
  const s = D(ev.event_date + 'T19:00'); const e = new Date(s.getTime() + 6 * 3600e3);
  const r = await modal({ title: 'Nuovo ruolo', ok: 'Pubblica il ruolo', fields: [
    { name: 'role', type: 'select', label: 'Ruolo', options: S.roles.map(x => [x.code, x.label]) }, { name: 't', label: 'Titolo dell\'annuncio', required: true, max: 120 },
    { name: 'd', type: 'textarea', label: 'Descrizione', required: true, max: 2000 },
    { name: 'h', type: 'number', label: 'Persone richieste', value: 2, min: 1, max: 100, required: true }, { name: 'p', type: 'number', label: 'Paga a persona per il turno (€)', value: 80, min: 1, step: '0.5', required: true },
    { name: 'a', type: 'datetime-local', label: 'Inizio', value: toLocalInput(s), required: true }, { name: 'b', type: 'datetime-local', label: 'Fine', value: toLocalInput(e), required: true },
    { name: 'minv', type: 'select', label: 'Verifica richiesta a chi accetta', value: 'nessuna', options: [['nessuna', 'Nessuna: aperto a tutti, conta la classifica'], ['base', 'Verifica di base (gratuita: telefono, email, codice fiscale)'], ['forte', 'Identità certificata con documento (a carico del lavoratore)']] },
    { name: 'auto', type: 'checkbox', label: 'Scelta automatica: il sistema propone il ruolo ai migliori candidati' }] }); if (!r) return;
  if (D(r.b) <= D(r.a)) return toast('La fine deve essere dopo l\'inizio.', true);
  const x = await call(sb.from('jobs').insert({ employer_id: S.uid, company_name: S.profile.full_name, title: r.t, description: r.d, city: ev.city, event_id: ev.id, role_code: r.role,
    headcount: Number(r.h), shift_pay_cents: Math.round(Number(r.p) * 100), starts_at: D(r.a).toISOString(), ends_at: D(r.b).toISOString(), min_verification: r.minv }).select('id'), 'Ruolo pubblicato.');
  if (!x.ok) return;
  if (r.auto) await call(sb.rpc('enable_auto_select', { p_job: x.data[0].id }), 'Scelta automatica attiva: inviti partiti.');
  S.open[x.data[0].id] = 'cand'; render();
};
A.invite = async el => { if ((await call(sb.rpc('invite_worker', { p_job: el.dataset.job, p_worker: el.dataset.worker }), 'Invito inviato: la persona riceve una notifica.')).ok) render(); };
A.inviteRes = async el => { if ((await call(sb.rpc('invite_reserve', { p_guarantee: el.dataset.g, p_worker: el.dataset.worker }), 'Proposta come riserva inviata.')).ok) render(); };
A.withdrawOffer = async el => { if ((await call(sb.rpc('withdraw_offer', { p_offer: el.dataset.id }), 'Invito ritirato.')).ok) render(); };
A.accept = async el => { if ((await call(sb.rpc('accept_application', { p_application: el.dataset.id }), 'Assegnato: la persona ha il turno in calendario.')).ok) render(); };
A.buyG = async el => {
  const r = await modal({ title: 'Garanzia no-show', intro: `Prenoti una sostituzione per questo ruolo. Costo: ${el.dataset.cost}, dovuto anche se nessuno manca. Se serve la sostituta, prende la paga piena al posto di chi non si presenta.`, ok: 'Aggiungi garanzia' }); if (!r) return;
  if ((await call(sb.rpc('buy_guarantee', { p_job: el.dataset.job }), 'Garanzia aggiunta: ora serve coprirla con una riserva.')).ok) { S.open[el.dataset.job] = 'ris'; render(); }
};
A.auto = async el => {
  const r = await modal({ title: 'Scelta automatica', intro: 'Il sistema invia le proposte ai migliori candidati in ordine di punteggio, e passa al successivo se qualcuno rifiuta o non risponde. Nessuno viene assegnato senza aver accettato. Vale anche per le riserve.', ok: 'Attiva' }); if (!r) return;
  const x = await call(sb.rpc('enable_auto_select', { p_job: el.dataset.job })); if (x.ok) { toast(x.data ? `Inviti partiti: ${x.data}.` : 'Attiva. Nessun candidato idoneo per ora.'); render(); }
};
A.cancelJob = async el => {
  const r = await modal({ title: 'Annullare il ruolo?', intro: 'Avvisiamo chi aveva accettato e le riserve. Se mancano meno di 48 ore all\'inizio conta come annullamento tardivo e abbassa il tuo punteggio.', danger: true, ok: 'Annulla il ruolo', cancel: 'Indietro', fields: [{ name: 'm', type: 'textarea', label: 'Motivo (lo vedono i lavoratori)', max: 300 }] }); if (!r) return;
  const x = await call(sb.rpc('cancel_job', { p_job: el.dataset.job, p_reason: r.m })); if (x.ok) { toast(`Ruolo annullato. Persone avvisate: ${x.data}.`); render(); }
};
A.note = async el => {
  const evita = el.dataset.kind === 'da_evitare';
  const r = await modal({ title: evita ? 'Segna come da evitare' : 'Segna come preferito', intro: evita ? 'Non riceverà più inviti automatici da te e l\'invito manuale è bloccato. La nota è privata, ma la persona può chiederne l\'accesso: scrivi solo fatti di lavoro.' : 'Comparirà in cima ai tuoi candidati.', ok: 'Salva', fields: [
    ...(evita ? [{ name: 'r', type: 'select', label: 'Motivo', options: [['puntualita', 'Puntualità'], ['comportamento', 'Comportamento'], ['qualita', 'Qualità del lavoro'], ['altro', 'Altro']] }] : []), { name: 'n', type: 'textarea', label: 'Nota (facoltativa)', max: 300 }] }); if (!r) return;
  if ((await call(sb.rpc('set_worker_note', { p_worker: el.dataset.worker, p_kind: el.dataset.kind, p_reason: evita ? r.r : null, p_note: r.n }), 'Nota salvata.')).ok) render();
};
A.unnote = async el => { if ((await call(sb.rpc('clear_worker_note', { p_worker: el.dataset.worker }), 'Nota tolta.')).ok) render(); };
A.confirmCheck = async el => { if ((await call(sb.rpc('employer_confirm_check', { p_check: el.dataset.id }), 'Confermato.')).ok) render(); };
A.noshow = async el => {
  const r = await modal({ title: `Segnalare il no-show di ${el.dataset.name}?`, intro: 'Se c\'è una riserva, subentra subito e riceve una notifica. La persona perde punti di affidabilità.', danger: true, ok: 'Segnala no-show' }); if (!r) return;
  const x = await call(sb.rpc('report_no_show', { p_shift: el.dataset.id })); if (!x.ok) return;
  toast({ sostituita: 'No-show segnalato: la riserva è stata attivata.', garanzia_non_mantenuta: 'No-show segnalato. Nessuna riserva era disponibile.', nessuna_riserva: 'No-show segnalato. Non c\'era una garanzia.' }[x.data] || x.data); render();
};
A.selfie = async el => {
  const { data, error } = await sb.storage.from('checkins').createSignedUrl(el.dataset.path, 300);
  await modal({ title: 'Selfie di check-in', hideOk: true, cancel: 'Chiudi', body: data ? html`<img src="${data.signedUrl}" alt="Selfie" style="width:100%;border-radius:12px">` : html`<p class="muted">${error ? error.message : 'Non disponibile.'}</p>` });
};
A.newLink = async el => {
  const r = await modal({ title: 'Nuovo canale', intro: 'Dai un nome al sito o gruppo dove pubblicherai l\'annuncio (es. Subito, Facebook, Indeed).', ok: 'Crea link', fields: [{ name: 'c', label: 'Canale', required: true, max: 40 }] }); if (!r) return;
  if ((await call(sb.rpc('create_event_link', { p_event: el.dataset.ev, p_channel: r.c }), 'Link creato.')).ok) render();
};
A.share = async el => {
  const ev = (await sb.from('events').select('*').eq('id', S.arg).maybeSingle()).data;
  const jobs = (await sb.from('jobs').select('title,role_code,headcount,shift_pay_cents,starts_at').eq('event_id', S.arg).eq('is_open', true)).data || [];
  const url = location.href.split('#')[0] + '#e-' + el.dataset.code;
  const txt = `${ev.name}, ${ev.city}, ${fDay(ev.event_date)}\nCerchiamo:\n${jobs.map(j => `- ${j.title}: ${j.headcount} ${j.headcount === 1 ? 'persona' : 'persone'}, ${eur(j.shift_pay_cents)} a turno`).join('\n')}\n\nCandidati qui: ${url}`;
  await modal({ title: `Annuncio per ${el.dataset.ch}`, intro: 'Copia il testo e incollalo sul sito. Evita di indicare genere o età: la legge non lo consente.', hideOk: true, cancel: 'Chiudi', body: html`<pre class="sel" id="sharebox">${txt}</pre><div class="acts"><button type="button" class="btn s" data-act="copyShare">Copia testo e link</button></div>` });
};
A.copyShare = async () => { try { await navigator.clipboard.writeText($('#sharebox').textContent); toast('Copiato.'); } catch (e) { toast('Seleziona il testo e copialo.'); } };
A.readAll = async () => { await call(sb.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)); render(); };
A.notif = async el => {
  const { data: n } = await sb.from('notifications').select('*').eq('id', el.dataset.id).maybeSingle(); if (!n) return;
  if (!n.read_at) await sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
  const k = n.kind;
  if (/^(verifica_|foto_da_aggiornare)/.test(k)) return go('profile');
  if (/^proposta_(turno|riserva|in_scadenza|scaduta|ritirata)$/.test(k)) return go('offers');
  if (/^(turno_assegnato|sostituzione_attivata|turno_annullato|riserva_annullata)$/.test(k)) return go('calendar');
  let evId = n.payload && n.payload.event_id;
  if (!evId && n.job_id) { const j = (await sb.from('jobs').select('event_id').eq('id', n.job_id).maybeSingle()).data; evId = j && j.event_id; }
  if (evId && isOrg()) { S.tab = /^evento/.test(k) ? 'ruoli' : 'ruoli'; return go('event', evId); }
  render();
};

/* ---------- moduli ---------- */
const FORMS = {};
FORMS.login = async f => {
  const r = await sb.auth.signInWithPassword({ email: $('#em', f).value.trim(), password: $('#pw', f).value });
  if (r.error) return toast(HERR(r.error), true);
  await loadSession(); await go(home());
};
FORMS.register = async f => {
  if (!$('#pr', f).checked) return toast('Devi accettare l\'informativa privacy.', true);
  const role = $('#rolechips .on', f).dataset.v;
  const data = { role, full_name: $('#nm', f).value.trim() }; if (S.linkCode) data.link_code = S.linkCode;
  const r = await sb.auth.signUp({ email: $('#em', f).value.trim(), password: $('#pw', f).value, options: { data } });
  if (r.error) return toast(HERR(r.error), true);
  if (!r.data.session) return toast('Controlla la posta e conferma l\'indirizzo, poi accedi.');
  await loadSession();
  const city = $('#ci', f).value.trim(); if (city) { await sb.from('profiles').update({ city }).eq('id', S.uid); S.profile.city = city; }
  if (S.view === 'register' && S.linkCode && role === 'seeker' && location.hash) return go('public', S.linkCode);
  await go(role === 'seeker' ? 'profile' : 'events');
  toast(role === 'seeker' ? 'Benvenuto. Scegli i tuoi ruoli e attiva la visibilità per ricevere proposte.' : 'Benvenuto. Crea il tuo primo evento.');
};
FORMS.saveProfile = async f => {
  const x = await call(sb.from('profiles').update({ full_name: $('#nm', f).value.trim(), city: $('#ci', f).value.trim(), phone: $('#ph', f).value.trim(), bio: $('#bio', f).value }).eq('id', S.uid), 'Profilo salvato.');
  if (x.ok) await loadSession();
};
FORMS.saveOrg = async f => {
  const x = await call(sb.from('profiles').update({ full_name: $('#nm', f).value.trim(), city: $('#ci', f).value.trim() }).eq('id', S.uid), 'Profilo salvato.');
  if (x.ok) await loadSession();
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el || ['INPUT', 'SELECT', 'OPTION'].includes(el.tagName)) return;
  if (el.tagName === 'A') e.preventDefault();
  const fn = A[el.dataset.act]; if (!fn) return;
  try { await fn(el); } catch (err) { toast(err.message || String(err), true); }
});
document.addEventListener('change', async e => {
  const sel = e.target.closest('select[data-dtsel]');
  if (sel && sel.value) { S.demo.loginAs(sel.value); await loadSession(); sel.closest('.ov').remove(); await go(home()); return; }
  const el = e.target.closest('input[data-act],select[data-act]'); if (!el) return;
  try { await A[el.dataset.act](el); } catch (err) { toast(err.message || String(err), true); }
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault();
  const btn = $('button[type=submit]', f); if (btn) btn.disabled = true;
  try { await FORMS[f.dataset.form](f); } catch (err) { toast(err.message || String(err), true); }
  if (btn) btn.disabled = false;
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') { S.search = e.target.value; clearTimeout(S.st); S.st = setTimeout(async () => { const pos = e.target.selectionStart; await render(); const i = $('#search'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }, 250); }
});

boot();
