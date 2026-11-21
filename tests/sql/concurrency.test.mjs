// CONCORRENZA REALE: più persone che agiscono nello stesso istante su un PostgreSQL vero.
// Si esegue solo se è impostata PG_URL (un server PostgreSQL di prova, es. un contenitore in CI):
//   PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:concurrency
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ROOT, SCHEMA_FILES, U, J } from '../lib/db.mjs';

const URL = process.env.PG_URL;
const skip = !URL && 'impostare PG_URL per eseguire i test di concorrenza';
let admin, pool, tplName;
const urlOf = name => URL.replace(/\/[^/]*$/, '/' + name);

const STUB = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}',
  email_confirmed_at timestamptz default now(), phone text, phone_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;`;

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: URL }); await admin.connect();
  tplName = 'lf_tpl_' + Math.random().toString(36).slice(2, 8);
  await admin.query(`create database ${tplName}`);
  const c = new pg.Client({ connectionString: urlOf(tplName) }); await c.connect();
  await c.query(STUB);
  for (const f of SCHEMA_FILES) await c.query(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  await c.query(fs.readFileSync(path.join(ROOT, 'tools/test_utenti.sql'), 'utf8'));
  await c.query(fs.readFileSync(path.join(ROOT, 'app/demo_seed.sql'), 'utf8'));
  await c.end();
});
after(async () => { if (skip) return; await admin.query(`drop database ${tplName} with (force)`); await admin.end(); });

// ogni prova parte da una copia pulita del database
async function withDb(fn) {
  const name = 'lf_c_' + Math.random().toString(36).slice(2, 8);
  await admin.query(`create database ${name} template ${tplName}`);
  pool = new pg.Pool({ connectionString: urlOf(name), max: 30 });
  pool.on('error', () => {});                       // collegamenti inattivi chiusi durante la pulizia: non sono errori del test
  try { await fn(); } finally { await pool.end().catch(() => {}); await admin.query(`drop database ${name} with (force)`); }
}

// una chiamata come utente: transazione propria, ruolo "authenticated"
async function as(uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    const r = await c.query(sql, params); await c.query('commit'); return { ok: true, rows: r.rows };
  } catch (e) { await c.query('rollback').catch(() => {}); return { ok: false, error: e.message }; }
  finally { c.release(); }
}
const q = async (sql, p) => (await pool.query(sql, p)).rows;
async function newJob(org, headcount) {
  const ev = (await as(org, `insert into events (organizer_id, name, city, event_date) values ($1,'Concorrenza','Milano',current_date + 3) returning id`, [org])).rows[0].id;
  return (await as(org, `insert into jobs (employer_id, company_name, title, description, city, event_id, role_code, headcount, shift_pay_cents, starts_at, ends_at)
    values ($1,'Azienda prova','Ruolo prova','Descrizione del ruolo','Milano',$2,'barman',$3,8000, now() + interval '2 days', now() + interval '2 days 6 hours') returning id`, [org, ev, headcount])).rows[0].id;
}

test('due persone accettano contemporaneamente l\'ultimo posto: ne passa una sola', { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    await withDb(async () => {
      const job = await newJob(U.org1, 1);
      await as(U.org1, `select invite_worker($1,$2)`, [job, U.marco]); await as(U.org1, `select invite_worker($1,$2)`, [job, U.nina]);
      const offers = await q(`select id, worker_id from offers where job_id = $1`, [job]);
      assert.equal(offers.length, 2);
      const res = await Promise.all(offers.map(o => as(o.worker_id, `select respond_offer($1,true) as esito`, [o.id])));
      const ok = res.filter(r => r.ok && r.rows[0].esito === 'accettata');
      assert.equal(ok.length, 1, `giro ${round}: ${JSON.stringify(res)}`);
      assert.equal((await q(`select count(*)::int as n from shifts where job_id = $1 and status in ('assegnato','confermato')`, [job]))[0].n, 1);
    });
  }
});

test('venti persone accettano insieme 3 posti: esattamente 3 turni', { skip }, async () => {
  await withDb(async () => {
    await q(`select test_generate_workers(20, 'Milano', 0, 0)`);
    const workers = (await q(`select p.id from profiles p join worker_roles r on r.worker_id = p.id where r.role_code = 'barman' and p.discoverable
                              and p.id in (select id from auth.users where email like '%@test.invalid') limit 20`)).map(r => r.id);
    const job = await newJob(U.org1, 3);
      const c = await pool.connect();
    try {                                                                  // più inviti in attesa del normale: per stressare l'accettazione
      await c.query(`insert into offers (job_id, worker_id, mode, expires_at) select $1, id, 'manuale', now() + interval '1 hour' from profiles where id = any($2)`, [job, workers]);
    } finally { c.release(); }
    const offers = await q(`select id, worker_id from offers where job_id = $1`, [job]);
    const res = await Promise.all(offers.map(o => as(o.worker_id, `select respond_offer($1,true) as esito`, [o.id])));
    const accepted = res.filter(r => r.ok && r.rows[0].esito === 'accettata').length;
    const internal = res.filter(r => !r.ok && /deadlock|violates|serialize/i.test(r.error));
    assert.deepEqual([...new Set(internal.map(r => r.error))], [], 'nessun errore tecnico (' + internal.length + ' su ' + res.length + ')');
    assert.equal(accepted, 3);
    assert.equal((await q(`select count(*)::int as n from shifts where job_id = $1`, [job]))[0].n, 3);
  });
});

test('due riserve prendono lo stesso slot insieme: ne passa una sola', { skip }, async () => {
  await withDb(async () => {
    for (let round = 0; round < 3; round++) {
      const job = await newJob(U.org1, 1);
      await as(U.org1, `select buy_guarantee($1)`, [job]);
      const g = (await q(`select id from guarantees where job_id = $1`, [job]))[0].id;
      const res = await Promise.all([U.luca, U.nina, U.nico].map(w => as(w, `select claim_standby($1)`, [g])));
      assert.equal(res.filter(r => r.ok).length, 1, JSON.stringify(res));
      assert.equal((await q(`select count(*)::int as n from standby_assignments where guarantee_id = $1 and status = 'riservata'`, [g]))[0].n, 1);
    }
  });
});

test('no-show segnalato due volte insieme: una sola sostituzione', { skip }, async () => {
  await withDb(async () => {
    const job = await newJob(U.org1, 1);
    await as(U.org1, `select invite_worker($1,$2)`, [job, U.marco]);
    await as(U.marco, `select respond_offer(id, true) from offers where job_id = $1`, [job]);
    await as(U.org1, `select buy_guarantee($1)`, [job]);
    const g = (await q(`select id from guarantees where job_id = $1`, [job]))[0].id;
    await as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); await as(U.luca, `select respond_offer(id, true) from offers where job_id = $1 and worker_id = $2`, [job, U.luca]);
      { const c = await pool.connect();
    try { await c.query('begin'); await c.query('set local session_replication_role = replica');
          await c.query(`update jobs set starts_at = now() - interval '30 minutes', ends_at = now() + interval '5 hours' where id = $1`, [job]); await c.query('commit'); }
    finally { c.release(); } }
    const shift = (await q(`select id from shifts where job_id = $1 and worker_id = $2`, [job, U.marco]))[0].id;
    const res = await Promise.all([1, 2, 3].map(() => as(U.org1, `select report_no_show($1) as esito`, [shift])));
    assert.equal(res.filter(r => r.ok).length, 1, JSON.stringify(res));
    assert.equal((await q(`select count(*)::int as n from shifts where job_id = $1 and is_replacement`, [job]))[0].n, 1);
    assert.equal((await q(`select count(*)::int as n from ledger where job_id = $1 and kind = 'garanzia_piattaforma'`, [job]))[0].n, 1, 'commissione registrata una volta');
  });
});

test('due candidature accettate insieme per un solo posto', { skip }, async () => {
  await withDb(async () => {
    const job = await newJob(U.org1, 1);
    await as(U.nina, `select apply_to_job($1,'',null)`, [job]); await as(U.marco, `select apply_to_job($1,'',null)`, [job]);
    const apps = await q(`select id from applications where job_id = $1`, [job]);
    const res = await Promise.all(apps.map(a => as(U.org1, `select accept_application($1)`, [a.id])));
    assert.equal(res.filter(r => r.ok).length, 1, JSON.stringify(res));
    assert.equal((await q(`select count(*)::int as n from shifts where job_id = $1`, [job]))[0].n, 1);
  });
});
