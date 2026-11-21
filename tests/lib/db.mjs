// Strumenti comuni per i test sul database: un vero PostgreSQL (PGlite) con gli stessi
// file SQL del progetto, ruoli anon/authenticated e sicurezza a livello di riga attiva.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCHEMA_FILES = [
  'schema.sql', 'schema_fase2.sql', 'schema_fase2b_matching.sql', 'schema_fase2c_calendario.sql',
  'schema_fase2d_evento_completo.sql', 'schema_fase2e_canali_scheda.sql',
  'schema_fase2f_rating_organizzatori.sql', 'schema_fase2g_verifica_identita.sql',
  'schema_fase2h_fiducia.sql', 'schema_fase2i_permessi.sql',
];

// Imita lo schema "auth" di Supabase (utenti e funzione auth.uid())
const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}',
  email_confirmed_at timestamptz default now(), phone text, phone_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;`;

// Persone di prova con identificatori fissi (stessi del seed della demo)
export const U = {
  org1: 'a0000000-0000-4000-8000-000000000001',   // Evento Srl (3 giudizi)
  org2: 'a0000000-0000-4000-8000-000000000002',   // Agenzia Nuova (nuovo)
  marco: 'b0000000-0000-4000-8000-000000000001',  // barman esperto, documento
  nina: 'b0000000-0000-4000-8000-000000000002',   // barman nuova, solo telefono
  nico: 'b0000000-0000-4000-8000-000000000003',   // barman con no-show e ritardo
  remo: 'b0000000-0000-4000-8000-000000000004',   // barman a Roma
  hilda: 'b0000000-0000-4000-8000-000000000005',  // hostess, verifica di base
  giulia: 'b0000000-0000-4000-8000-000000000006', // hostess e tavoli, nessuna verifica
  luca: 'b0000000-0000-4000-8000-000000000007',   // barman e sala, verifica di base
  paolo: 'b0000000-0000-4000-8000-000000000008',  // non visibile agli organizzatori
};
export const J = {
  hostess: 'c1000000-0000-4000-8000-000000000002', // Gala, richiede verifica di base
  barman: 'c1000000-0000-4000-8000-000000000001',  // Gala, 2 posti
  tavoli: 'c1000000-0000-4000-8000-000000000003',
  sagra: 'c1000000-0000-4000-8000-000000000004',   // Agenzia Nuova, richiede il documento
};
export const EV = { gala: 'e0000000-0000-4000-8000-000000000002', sagra: 'e0000000-0000-4000-8000-000000000003' };

export async function newDb({ seed = true } = {}) {
  const pg = new PGlite();
  await pg.exec(STUB);
  for (const f of SCHEMA_FILES) await pg.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  await pg.exec(fs.readFileSync(path.join(ROOT, 'tools/test_utenti.sql'), 'utf8'));
  if (seed) await pg.exec(fs.readFileSync(path.join(ROOT, 'app/demo_seed.sql'), 'utf8'));
  return makeApi(pg);
}

export function makeApi(pg) {
  // esegue come utente collegato (ruolo "authenticated"), anon (uid nullo) oppure amministratore ('admin')
  async function run(who, sql, params = []) {
    if (who === 'admin') return (await pg.query(sql, params)).rows;
    return pg.transaction(async tx => {
      await tx.exec(who ? 'set local role authenticated' : 'set local role anon');
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [who || '']);
      return (await tx.query(sql, params)).rows;
    });
  }
  const api = {
    pg,
    run,
    as: (uid, sql, p) => run(uid, sql, p),
    admin: (sql, p) => run('admin', sql, p),
    anon: (sql, p) => run(null, sql, p),
    // restituisce il valore della prima colonna della prima riga
    async val(who, sql, params) { const r = await run(who, sql, params); return r.length ? Object.values(r[0])[0] : null; },
    // l'operazione DEVE fallire, con un messaggio che corrisponde al criterio
    async fails(who, sql, params, pattern = /./) {
      try { await run(who, sql, params); } catch (e) { assert.match(e.message, pattern, `messaggio inatteso: ${e.message}`); return e.message; }
      assert.fail(`doveva fallire ma è riuscito: ${sql.slice(0, 80)}`);
    },
    // gli utenti non vedono righe (RLS) oppure non hanno permesso
    async hidden(who, sql, params) {
      try { const r = await run(who, sql, params); assert.equal(r.length, 0, `righe visibili ma non dovevano: ${JSON.stringify(r).slice(0, 120)}`); }
      catch (e) { if (e.code === 'ERR_ASSERTION') throw e; assert.match(e.message, /permission denied|row-level security/); }
    },
    // sposta il tempo: gli annunci (e gli inviti in attesa) risultano più vecchi di N secondi
    async advance(seconds) {
      await pg.exec('set session_replication_role = replica');
      await pg.query(`update jobs set starts_at = starts_at - make_interval(secs => $1), ends_at = ends_at - make_interval(secs => $1)`, [seconds]);
      await pg.query(`update offers set expires_at = expires_at - make_interval(secs => $1) where status = 'inviata'`, [seconds]);
      await pg.exec('set session_replication_role = origin');
    },
    // tutti i ruoli di un evento iniziati da 30 minuti
    async startEvent(eventId) {
      await pg.exec('set session_replication_role = replica');
      await pg.query(`update jobs set ends_at = ends_at - (starts_at - (now() - interval '30 minutes')), starts_at = now() - interval '30 minutes' where event_id = $1`, [eventId]);
      await pg.exec('set session_replication_role = origin');
    },
    async newWorker(name, { city = 'Milano', roles = ['barman'], discoverable = true } = {}) {
      const id = (await pg.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
        [`${name.replace(/\W/g, '').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@t.test`, JSON.stringify({ role: 'seeker', full_name: name })])).rows[0].id;
      await pg.query(`update profiles set city = $2, discoverable = $3 where id = $1`, [id, city, discoverable]);
      for (const r of roles) await pg.query(`insert into worker_roles values ($1, $2)`, [id, r]);
      return id;
    },
  };
  return api;
}

export { assert };
