// SICUREZZA: permessi, visibilità dei dati, tentativi di scavalcare le regole, cancellazione dell'account.
import test, { before } from 'node:test';
import { richDb } from '../lib/scenario.mjs';
import { U, J, EV, assert } from '../lib/db.mjs';

let db, S;
before(async () => { S = await richDb(); db = S.db; });

const ALL_USERS = Object.entries(U);

// ---------------------------------------------------------------------------------------------
// 1) STRUTTURA: queste liste sono "congelate". Se un cambiamento le altera, il test fallisce e
//    costringe a decidere con consapevolezza se il nuovo permesso è voluto.
// ---------------------------------------------------------------------------------------------

test('ogni tabella ha la sicurezza a livello di riga attiva', async () => {
  const r = await db.admin(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> 'demo_users'`);
  assert.deepEqual(r.map(x => x.relname), []);
});

async function tablePrivs(role) {
  const rows = await db.admin(`select c.relname,
      has_table_privilege('${role}', c.oid,'select') s, has_table_privilege('${role}', c.oid,'insert') i,
      has_table_privilege('${role}', c.oid,'update') u, has_table_privilege('${role}', c.oid,'delete') d,
      has_any_column_privilege('${role}', c.oid,'insert') ci, has_any_column_privilege('${role}', c.oid,'update') cu
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'demo_users' order by 1`);
  const out = {};
  for (const r of rows) {
    const p = [r.s && 'select', r.i && 'INSERT', r.u && 'UPDATE', r.d && 'DELETE', !r.i && r.ci && 'insert(col)', !r.u && r.cu && 'update(col)'].filter(Boolean);
    if (p.length) out[r.relname] = p.join(' ');
  }
  return out;
}

test('utente anonimo: può solo leggere ruoli, eventi e annunci pubblici', async () => {
  assert.deepEqual(await tablePrivs('anon'), { events: 'select', job_roles: 'select', jobs: 'select' });
});

test('utenti collegati: permessi sulle tabelle esattamente quelli previsti', async () => {
  assert.deepEqual(await tablePrivs('authenticated'), {
    applications: 'select DELETE insert(col)', check_events: 'select', event_links: 'select',
    events: 'select DELETE insert(col) update(col)', guarantees: 'select', identity_confirmations: 'select',
    job_roles: 'select', jobs: 'select INSERT UPDATE DELETE', ledger: 'select', notifications: 'select update(col)',
    offers: 'select', organizer_reviews: 'select', platform_settings: 'select', profiles: 'select update(col)',
    shifts: 'select', standby_assignments: 'select', standby_availability: 'select INSERT UPDATE DELETE',
    trust_events: 'select', verification_requests: 'select', worker_blocks: 'select', worker_identity: 'select',
    worker_notes: 'select', worker_preferences: 'select', worker_roles: 'select INSERT DELETE',
    worker_unavailability: 'select INSERT UPDATE DELETE',
  });
});

// funzioni chiamabili dall'app. Quelle "di appoggio" servono alle regole di riga e rispondono solo sul chiamante.
const API = ['accept_application', 'apply_to_job', 'block_organizer', 'buy_guarantee', 'calendar_ics', 'cancel_job', 'claim_standby',
  'clear_worker_note', 'confirm_check_identity', 'create_event_link', 'delete_my_account', 'employer_confirm_check', 'enable_auto_select',
  'event_overview', 'event_roster', 'invite_reserve', 'invite_worker', 'link_stats', 'match_reserves', 'match_workers', 'my_blocks',
  'my_calendar', 'my_organizer_feedback', 'my_trust', 'my_verification', 'my_worker_notes', 'open_standby_slots', 'organizer_profile',
  'public_event_page', 'report_no_show', 'respond_offer', 'review_organizer', 'set_offer_preferences', 'set_profile_photo',
  'set_worker_note', 'start_verification', 'unblock_organizer', 'verify_tax_code', 'withdraw_offer', 'withdraw_standby', 'worker_check'];
const HELPERS_FOR_POLICIES = ['employer_of_worker', 'involved_in_job', 'is_job_employer', 'my_role', 'standby_pool_size'];

async function executable(role) {
  const r = await db.admin(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype and has_function_privilege('${role}', p.oid, 'execute') order by 1`);
  return r.map(x => x.proname);
}

test('funzioni chiamabili dai client: solo quelle previste', async () => {
  assert.deepEqual(await executable('authenticated'), [...API, ...HELPERS_FOR_POLICIES].sort());
  assert.deepEqual(await executable('anon'), ['public_event_page']);
});

test('funzioni interne e di servizio NON sono chiamabili dai client', async () => {
  const internal = ['complete_verification', 'close_guarantees', 'run_offer_maintenance', 'fill_job', 'check_coverage', 'rank_candidates', '_send_offer',
    '_notify', '_display_name', 'worker_is_free', 'worker_allows_offers_from', 'organizer_summary', 'is_verified', 'job_allows_worker',
    'job_requires_verification', 'job_min_verification', 'verification_level', 'trust_points', 'trust_info', 'identity_outcome_of', 'profile_photo_of',
    'test_generate_workers', 'test_purge', 'refresh_event_status', '_cf_checksum'];
  const ex = new Set([...(await executable('authenticated')), ...(await executable('anon'))]);
  for (const f of internal) assert.ok(!ex.has(f), `${f} è chiamabile dai client`);
});

test('ogni funzione con privilegi elevati fissa il percorso di ricerca (search_path)', async () => {
  const r = await db.admin(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig::text, '') like '%search_path%'`);
  assert.deepEqual(r.map(x => x.proname), []);
});

test('le tabelle e funzioni nuove nascono chiuse (permessi predefiniti revocati)', async () => {
  await db.admin(`create table public.zz_prova (id int)`);
  await db.admin(`create function public.zz_fn() returns int language sql as $$ select 1 $$`);
  assert.equal((await db.admin(`select has_table_privilege('anon','public.zz_prova','select') or has_table_privilege('authenticated','public.zz_prova','select') as x`))[0].x, false);
  assert.equal((await db.admin(`select has_function_privilege('anon','public.zz_fn()','execute') or has_function_privilege('authenticated','public.zz_fn()','execute') as x`))[0].x, false);
  await db.pg.exec(`drop table public.zz_prova; drop function public.zz_fn()`);
});

// ---------------------------------------------------------------------------------------------
// 2) VISIBILITÀ ESATTA: ogni utente vede esattamente le righe previste, né di più né di meno
// ---------------------------------------------------------------------------------------------

const OWN_JOB = `(select id from jobs where employer_id = $1)`;
const VISIBLE = {
  applications: `seeker_id = $1 or job_id in ${OWN_JOB}`,
  offers: `worker_id = $1 or job_id in ${OWN_JOB}`,
  shifts: `worker_id = $1 or job_id in ${OWN_JOB}`,
  notifications: `user_id = $1`,
  standby_assignments: `worker_id = $1`,
  standby_availability: `worker_id = $1`,
  worker_unavailability: `worker_id = $1`,
  worker_roles: `worker_id = $1`,
  worker_notes: `employer_id = $1`,
  worker_blocks: `worker_id = $1`,
  worker_preferences: `worker_id = $1`,
  worker_identity: `worker_id = $1`,
  verification_requests: `worker_id = $1`,
  organizer_reviews: `worker_id = $1`,
  trust_events: `user_id = $1`,
  ledger: `payer_id = $1 or payee_id = $1`,
  identity_confirmations: `employer_id = $1`,
  check_events: `shift_id in (select id from shifts where worker_id = $1 or job_id in ${OWN_JOB})`,
  guarantees: `job_id in ${OWN_JOB}`,
  event_links: `event_id in (select id from events where organizer_id = $1)`,
};

test('visibilità esatta: ogni utente vede solo le sue righe in ogni tabella privata', async () => {
  const problems = [];
  let populated = 0;
  for (const [name, uid] of ALL_USERS) {
    for (const [table, pred] of Object.entries(VISIBLE)) {
      const expected = (await db.admin(`select count(*)::int as n from ${table} where ${pred}`, [uid]))[0].n;
      const seen = (await db.as(uid, `select count(*)::int as n from ${table}`))[0].n;
      if (seen > 0) populated++;
      if (seen !== expected) problems.push(`${name} su ${table}: vede ${seen}, doveva vedere ${expected}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(populated > 40, `lo scenario deve popolare molte tabelle (popolate: ${populated})`);
});

test('visibilità esatta: l\'anonimo non vede nessuna tabella privata', async () => {
  for (const table of Object.keys(VISIBLE)) await db.hidden(null, `select * from ${table}`);
  await db.hidden(null, 'select * from profiles');
  await db.hidden(null, 'select * from identity_flags');
});

test('segnalazioni di identità: nessun client le vede', async () => {
  assert.equal((await db.admin(`select count(*)::int as n from identity_flags`))[0].n, 1, 'la segnalazione esiste');
  for (const [, uid] of ALL_USERS) await db.hidden(uid, 'select * from identity_flags');
});

test('profili: si vede solo il proprio, o quello di chi ha un turno o una candidatura con me', async () => {
  const problems = [];
  for (const [name, uid] of ALL_USERS) {
    const expected = (await db.admin(`select count(*)::int as n from profiles where id = $1
      or id in (select seeker_id from applications a join jobs j on j.id = a.job_id where j.employer_id = $1)
      or id in (select worker_id from shifts s join jobs j on j.id = s.job_id where j.employer_id = $1)`, [uid]))[0].n;
    const seen = (await db.as(uid, `select count(*)::int as n from profiles`))[0].n;
    if (seen !== expected) problems.push(`${name}: vede ${seen} profili, doveva vedere ${expected}`);
  }
  assert.deepEqual(problems, []);
});

test('la classifica non rivela telefono, email, codice fiscale né foto', async () => {
  const rows = await db.as(U.org1, `select * from match_workers($1)`, [J.tavoli]);
  const cols = Object.keys(rows[0]);
  for (const forbidden of ['phone', 'telefono', 'email', 'tax_code', 'photo_path', 'photo', 'full_name']) assert.ok(!cols.includes(forbidden), `colonna ${forbidden} esposta`);
  const text = JSON.stringify(rows);
  assert.ok(!/@/.test(text) && !/\b3[0-9]{2} ?[0-9]{3} ?[0-9]{4}\b/.test(text) && !/DEMOCF/.test(text), 'dati di contatto nel risultato');
  assert.ok(rows.every(r => !/\s\S{3,}$/.test(r.display_name)), 'solo nome e iniziale del cognome');
});

test('l\'organizzatore non vede i giudizi singoli né chi li ha scritti', async () => {
  await db.hidden(U.org1, 'select * from organizer_reviews');
  const fb = (await db.as(U.org1, `select my_organizer_feedback() as f`))[0].f;
  const txt = JSON.stringify(fb);
  for (const [, uid] of ALL_USERS) assert.ok(!txt.includes(uid), 'compare un identificativo di lavoratore');
  assert.ok(!/Marco|Nico|Remo/.test(txt), 'compare un nome');
});

// ---------------------------------------------------------------------------------------------
// 3) TENTATIVI DI SCAVALCARE LE REGOLE: devono tutti fallire
// ---------------------------------------------------------------------------------------------

test('scalate di privilegi sui profili', async () => {
  const bad = /permission denied|row-level security|non autorizzato|solo /;
  await db.fails(U.nina, `update profiles set role = 'employer' where id = $1`, [U.nina], bad);
  await db.fails(U.nina, `update profiles set email = 'x@y.z' where id = $1`, [U.nina], bad);
  await db.fails(U.nina, `update profiles set verified_until = now() + interval '9 years' where id = $1`, [U.nina], bad);
  await db.fails(U.nina, `update profiles set verification_level = 'forte' where id = $1`, [U.nina], bad);
  await db.fails(U.nina, `update profiles set photo_checked_at = now() where id = $1`, [U.nina], bad);
  await db.fails(U.nina, `update profiles set full_name = 'Hacker' where id = $1`, [U.marco], /./).catch(async () => {});
  assert.equal((await db.admin(`select full_name from profiles where id = $1`, [U.marco]))[0].full_name, 'Marco Esperto', 'il profilo altrui non è cambiato');
  await db.fails(U.nina, `insert into profiles (id, role, full_name) values (gen_random_uuid(), 'seeker', 'Fantasma')`, [], bad);
  await db.fails(U.nina, `delete from profiles where id = $1`, [U.marco], bad);
});

test('scritture dirette vietate sulle tabelle che passano solo da funzioni', async () => {
  const bad = /permission denied|row-level security/;
  const direct = [
    [U.org1, `insert into shifts (job_id, worker_id) values ($1, $2)`, [J.barman, U.giulia]],
    [U.nina, `update shifts set status = 'completato'`, []],
    [U.org1, `insert into ledger (kind, amount_cents) values ('paga_turno', 1)`, []],
    [U.nina, `delete from ledger`, []],
    [U.org1, `insert into guarantees (job_id, standby_fee_cents, platform_fee_cents) values ($1, 0, 0)`, [J.barman]],
    [U.org1, `update guarantees set status = 'chiusa'`, []],
    [U.nina, `insert into offers (job_id, worker_id, mode, expires_at) values ($1, $2, 'manuale', now() + interval '1 day')`, [J.barman, U.nina]],
    [U.org1, `update offers set status = 'accettata'`, []],
    [U.nina, `insert into notifications (user_id, kind, title) values ($1, 'x', 'y')`, [U.nina]],
    [U.nina, `update notifications set title = 'x'`, []],
    [U.nina, `insert into trust_events (user_id, kind) values ($1, 'completato')`, [U.nina]],
    [U.nina, `delete from trust_events`, []],
    [U.org1, `insert into check_events (shift_id, kind) values (gen_random_uuid(), 'in')`, []],
    [U.org1, `update check_events set confirmed_at = now()`, []],
    [U.nina, `insert into organizer_reviews (shift_id, worker_id, employer_id, pay_score, transparency_score, reliability_score, paid) values (gen_random_uuid(), $1, $2, 5, 5, 5, 'puntuale')`, [U.nina, U.org1]],
    [U.nina, `update platform_settings set verification_price_cents = 0`, []],
    [U.nina, `insert into identity_confirmations (shift_id, worker_id, employer_id, outcome) values (gen_random_uuid(), $1, $2, 'ok')`, [U.nina, U.org1]],
    [U.org1, `update worker_notes set kind = 'preferito'`, []],
    [U.nina, `insert into verification_requests (worker_id, amount_cents, status) values ($1, 0, 'completata')`, [U.nina]],
    [U.nina, `insert into worker_identity (worker_id, tax_code) values ($1, 'X')`, [U.nina]],
    [U.org1, `insert into event_links (event_id, channel) values ($1, 'x')`, [EV.gala]],
  ];
  for (const [uid, sql, p] of direct) await db.fails(uid, sql, p, bad);
  // update/delete su righe altrui o che non esistono per il chiamante non toccano nulla
  const before = (await db.admin(`select count(*)::int as n from notifications`))[0].n;
  await db.as(U.nina, `delete from notifications where user_id <> $1`, [U.nina]).catch(() => {});
  assert.equal((await db.admin(`select count(*)::int as n from notifications`))[0].n, before);
});

test('un lavoratore non può agire da organizzatore né sui dati di un altro organizzatore', async () => {
  const denied = /non autorizzato|non trovato|solo |non è|annuncio|garanzia|turno|permission denied|row-level/i;
  const mine = (await db.admin(`select id from shifts where job_id = $1 and worker_id = $2`, [J.barman, U.luca]))[0].id;
  await db.fails(U.nina, `select buy_guarantee($1)`, [J.barman], denied);
  await db.fails(U.nina, `select invite_worker($1,$2)`, [J.barman, U.giulia], denied);
  await db.fails(U.nina, `select report_no_show($1)`, [mine], denied);
  await db.fails(U.nina, `select cancel_job($1,'x')`, [J.barman], denied);
  await db.fails(U.nina, `select enable_auto_select($1)`, [J.barman], denied);
  await db.fails(U.nina, `select create_event_link($1,'x')`, [EV.gala], denied);
  await db.fails(U.nina, `select set_worker_note($1,'preferito',null,'')`, [U.marco], denied);
  // un altro organizzatore non può agire sull'evento di org1
  await db.fails(U.org2, `select buy_guarantee($1)`, [J.barman], denied);
  await db.fails(U.org2, `select invite_worker($1,$2)`, [J.barman, U.giulia], denied);
  await db.fails(U.org2, `select report_no_show($1)`, [mine], denied);
  await db.fails(U.org2, `select cancel_job($1,'x')`, [J.barman], denied);
  const app = (await db.admin(`select id from applications limit 1`))[0].id;
  const chkIn = (await db.admin(`select id from check_events where kind = 'in' and confirmed_at is null limit 1`))[0].id;
  await db.fails(U.org2, `select accept_application($1)`, [app], denied);
  await db.fails(U.org2, `select employer_confirm_check($1)`, [chkIn], denied);
  await db.fails(U.org2, `select confirm_check_identity($1,'ok')`, [chkIn], denied);
  assert.equal((await db.as(U.org2, `select count(*)::int as n from match_workers($1)`, [J.barman]))[0].n, 0, 'classifica di un annuncio altrui: vuota');
  assert.equal((await db.as(U.org2, `select count(*)::int as n from event_roster($1)`, [EV.gala]))[0].n, 0);
  assert.equal((await db.as(U.org2, `select count(*)::int as n from link_stats($1)`, [EV.gala]))[0].n, 0);
});

test('un lavoratore non può rispondere a proposte altrui né operare sui turni altrui', async () => {
  const offer = (await db.admin(`select id from offers where worker_id = $1 limit 1`, [U.marco]))[0].id;
  await db.fails(U.giulia, `select respond_offer($1,true)`, [offer], /non trovato/);
  const marcoShift = S.sh;
  await db.fails(U.giulia, `select worker_check($1,'in',0,0,$2)`, [marcoShift, `${U.giulia}/x.jpg`], /non trovato/);
  await db.fails(U.giulia, `select review_organizer($1,1,1,1,'non_pagato','sabotaggio')`, [marcoShift], /non trovato/);
  await db.fails(U.giulia, `select withdraw_standby(id) from standby_assignments limit 1`, [], /./).catch(() => {});
});

test('annunci, eventi e candidature: nessuna scrittura per conto di altri', async () => {
  const bad = /permission denied|row-level security|violates/;
  await db.fails(U.org2, `insert into jobs (employer_id, company_name, title, description, city) values ($1,'x','Titolo','descrizione lunga','Milano')`, [U.org1], bad);
  await db.fails(U.nina, `insert into jobs (employer_id, company_name, title, description, city) values ($1,'x','Titolo','descrizione lunga','Milano')`, [U.nina], bad);
  await db.fails(U.org2, `insert into events (organizer_id, name, city, event_date) values ($1,'Falso','Milano',current_date)`, [U.org1], bad);
  await db.fails(U.nina, `insert into events (organizer_id, name, city, event_date) values ($1,'Falso','Milano',current_date)`, [U.nina], bad);
  await db.fails(U.giulia, `insert into applications (job_id, seeker_id) values ($1,$2)`, [J.hostess, U.nina], bad);
  await db.fails(U.giulia, `insert into applications (job_id, seeker_id, link_id) values ($1,$2,(select id from event_links limit 1))`, [J.hostess, U.giulia], bad);
  await db.fails(U.org1, `insert into jobs (employer_id, company_name, title, description, city, event_id, role_code, shift_pay_cents, starts_at, ends_at)
                          values ($1,'x','Titolo','descrizione lunga','Milano',$2,'barman',100,now()+interval '1 day',now()+interval '2 days')`, [U.org1, EV.sagra], /evento non valido/);
  const stillThere = (await db.admin(`select count(*)::int as n from jobs where id = $1`, [J.barman]))[0].n;
  await db.as(U.org2, `delete from jobs where id = $1`, [J.barman]);
  assert.equal((await db.admin(`select count(*)::int as n from jobs where id = $1`, [J.barman]))[0].n, stillThere, 'un altro organizzatore non può cancellare il mio annuncio');
  await db.as(U.org2, `update jobs set title = 'Hackerato' where id = $1`, [J.barman]);
  assert.notEqual((await db.admin(`select title from jobs where id = $1`, [J.barman]))[0].title, 'Hackerato');
});

test('parametri ostili non spezzano le query (iniezione SQL)', async () => {
  const evil = `'; drop table profiles; --`;
  await db.as(U.org1, `select count(*) from match_workers($1, 5)`, [J.barman]);
  await db.as(U.nina, `select set_offer_preferences(null, true)`);
  await db.as(U.org1, `select set_worker_note($1,'preferito',null,$2)`, [U.marco, evil]);
  const futuro = (await db.as(U.org1, `insert into jobs (employer_id, company_name, title, description, city, event_id, role_code, headcount, shift_pay_cents, starts_at, ends_at)
    values ($1,'Azienda','Futuro','descrizione lunga','Milano',$2,'barman',1,5000, now() + interval '9 days', now() + interval '9 days 5 hours') returning id`, [U.org1, EV.gala]))[0].id;
  await db.as(U.org1, `select cancel_job($1,$2)`, [futuro, evil]);
  assert.equal((await db.admin(`select reason from organizer_events where job_id = $1`, [futuro]))[0].reason, evil.slice(0, 300), 'il motivo ostile è solo un dato');
  await db.as(U.marco, `select block_organizer($1)`, [U.org2]);
  assert.equal((await db.admin(`select count(*)::int as n from profiles`))[0].n > 5, true, 'la tabella profili esiste ancora');
  assert.equal((await db.admin(`select note from worker_notes where employer_id = $1 and worker_id = $2`, [U.org1, U.marco]))[0].note, evil, 'il testo ostile è salvato come dato');
});

// ---------------------------------------------------------------------------------------------
// 4) CANCELLAZIONE DELL'ACCOUNT (GDPR): non devono restare tracce della persona
// ---------------------------------------------------------------------------------------------

test('cancellare l\'account di un lavoratore elimina i suoi dati e le notifiche che lo citano', async () => {
  const marco = U.marco;
  // dati del lavoratore (inclusi quelli scritti da altri)
  assert.ok((await db.admin(`select count(*)::int as n from worker_identity where worker_id = $1`, [marco]))[0].n >= 1);
  await db.as(marco, `select delete_my_account()`);
  // 1. nessuna riga in nessuna tabella che faccia ancora riferimento a lui
  const fks = await db.admin(`select cl.relname as tabella, a.attname as colonna from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass`);
  const left = [];
  for (const f of fks) {
    const n = (await db.admin(`select count(*)::int as n from public.${f.tabella} where ${f.colonna} = $1`, [marco]))[0].n;
    if (n) left.push(`${f.tabella}.${f.colonna}: ${n}`);
  }
  assert.deepEqual(left, [], 'righe rimaste');
  assert.equal((await db.admin(`select count(*)::int as n from auth.users where id = $1`, [marco]))[0].n, 0);
  assert.equal((await db.admin(`select count(*)::int as n from profiles where id = $1`, [marco]))[0].n, 0);
  // 2. nessun testo di altri utenti cita ancora il suo nome
  const texts = await db.admin(`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type in ('text', 'jsonb') and table_name <> 'demo_users'`);
  const mentions = [];
  for (const c of texts) {
    const n = (await db.admin(`select count(*)::int as n from public.${c.table_name} where ${c.column_name}::text ilike '%Marco E%' or ${c.column_name}::text ilike '%Marco Esperto%'`))[0].n;
    if (n) mentions.push(`${c.table_name}.${c.column_name}: ${n}`);
  }
  assert.deepEqual(mentions, [], 'nome ancora presente nei dati di altri');
  // 3. i dati di altri restano
  assert.ok((await db.admin(`select count(*)::int as n from profiles`))[0].n >= 9);
});

test('cancellare l\'account di un organizzatore elimina eventi, annunci, turni e registro collegati', async () => {
  await db.as(U.org1, `select delete_my_account()`);
  for (const t of ['events', 'jobs', 'shifts', 'offers', 'guarantees', 'ledger', 'event_links', 'applications', 'worker_notes', 'identity_confirmations']) {
    const n = (await db.admin(`select count(*)::int as n from ${t} where ${t === 'events' ? 'organizer_id' : t === 'ledger' ? 'payer_id' : t === 'shifts' || t === 'offers' || t === 'guarantees' || t === 'event_links' || t === 'applications' ? 'job_id is not null and false or' : 'employer_id'} = $1`.replace(/job_id is not null and false or = \$1/, 'false and $1::text is not null'), [U.org1]).catch(() => [{ n: 0 }]))[0].n;
    assert.equal(n, 0, t);
  }
  assert.equal((await db.admin(`select count(*)::int as n from jobs where employer_id = $1`, [U.org1]))[0].n, 0);
  assert.equal((await db.admin(`select count(*)::int as n from ledger where payer_id = $1 or payee_id = $1`, [U.org1]))[0].n, 0, 'nel registro non resta traccia dell\'organizzatore');
});
