// INVARIANTI: operazioni casuali (ripetibili con lo stesso "seme") e, dopo ognuna, controllo delle regole
// che non devono mai essere violate, qualunque sia la sequenza di azioni.
import test from 'node:test';
import { newDb, U, assert } from '../lib/db.mjs';

const RNG = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
// errori "interni": segnalano un difetto del sistema, non un rifiuto normale di un'operazione non consentita
const INTERNAL = /violates (check|unique|foreign|not-null)|null value|does not exist|invalid input|syntax error|division by zero|out of range|operator does not|ambiguous|undefined|is not assigned|stack depth|deadlock|could not serialize|too many|relation .* does not/i;

const INVARIANTS = {
  'più persone dei posti (turni attivi > posti richiesti)':
    `select s.job_id from shifts s join jobs j on j.id = s.job_id where s.status in ('assegnato','confermato','completato')
     group by s.job_id, j.headcount having count(*) > j.headcount`,
  'persona con due turni attivi sovrapposti':
    `select a.worker_id from shifts a join jobs ja on ja.id = a.job_id join shifts b on b.worker_id = a.worker_id and b.id < a.id join jobs jb on jb.id = b.job_id
     where a.status in ('assegnato','confermato') and b.status in ('assegnato','confermato') and tstzrange(ja.starts_at, ja.ends_at) && tstzrange(jb.starts_at, jb.ends_at)`,
  'riserva attiva sovrapposta a un turno attivo':
    `select sa.worker_id from standby_assignments sa join jobs ja on ja.id = sa.job_id join shifts s on s.worker_id = sa.worker_id and s.job_id <> sa.job_id join jobs jb on jb.id = s.job_id
     where sa.status in ('riservata','attivata') and s.status in ('assegnato','confermato') and tstzrange(ja.starts_at, ja.ends_at) && tstzrange(jb.starts_at, jb.ends_at)`,
  'garanzia "coperta" senza esattamente una riserva':
    `select g.id from guarantees g where g.status = 'coperta' and (select count(*) from standby_assignments a where a.guarantee_id = g.id and a.status = 'riservata') <> 1`,
  'garanzia "attivata" senza esattamente una riserva attivata':
    `select g.id from guarantees g where g.status = 'attivata' and (select count(*) from standby_assignments a where a.guarantee_id = g.id and a.status = 'attivata') <> 1`,
  'garanzia "aperta" con una riserva viva':
    `select g.id from guarantees g where g.status = 'aperta' and exists (select 1 from standby_assignments a where a.guarantee_id = g.id and a.status in ('riservata','attivata'))`,
  'più sostitute delle garanzie acquistate':
    `select s.job_id from shifts s where s.is_replacement group by s.job_id having count(*) > (select count(*) from guarantees g where g.job_id = s.job_id)`,
  'sostituta che non sostituisce un no-show':
    `select s.id from shifts s where s.is_replacement and not exists (select 1 from shifts o where o.id = s.replaces_shift_id and o.status = 'no_show')`,
  'paga registrata due volte o per un turno non completato':
    `select l.shift_id from ledger l where l.kind = 'paga_turno' group by l.shift_id having count(*) > 1
     union select l.shift_id from ledger l join shifts s on s.id = l.shift_id where l.kind = 'paga_turno' and s.status <> 'completato'`,
  'commissione di garanzia registrata più volte per la stessa garanzia':
    `select guarantee_id from ledger where kind in ('garanzia_riserva','garanzia_piattaforma') and guarantee_id is not null group by guarantee_id, kind having count(*) > 1`,
  'importi negativi nel registro': `select id from ledger where amount_cents < 0`,
  'proposta accettata senza turno o riserva corrispondente':
    `select o.id from offers o where o.status = 'accettata' and o.kind = 'turno' and not exists (select 1 from shifts s where s.job_id = o.job_id and s.worker_id = o.worker_id)
     union select o.id from offers o where o.status = 'accettata' and o.kind = 'riserva' and not exists (select 1 from standby_assignments a where a.guarantee_id = o.guarantee_id and a.worker_id = o.worker_id)`,
  'proposta in attesa su un annuncio chiuso':
    `select o.id from offers o join jobs j on j.id = o.job_id where o.status = 'inviata' and not j.is_open`,
  'più proposte in attesa per la stessa garanzia':
    `select guarantee_id from offers where status = 'inviata' and kind = 'riserva' group by guarantee_id having count(*) > 1`,
  'turno "confermato" senza check-in confermato':
    `select s.id from shifts s where s.status = 'confermato' and not exists (select 1 from check_events c where c.shift_id = s.id and c.kind = 'in' and c.confirmed_at is not null)`,
  'turno "completato" senza check-out confermato (turni creati dall\'app)':
    `select s.id from shifts s where s.status = 'completato' and s.id not in (select id from fuzz_base_shifts) and not exists (select 1 from check_events c where c.shift_id = s.id and c.kind = 'out' and c.confirmed_at is not null)`,
  'no-show registrati diversi dai turni in no-show':
    `select 1 where (select count(*) from trust_events where kind = 'no_show' and id not in (select id from fuzz_base_trust)) <> (select count(*) from shifts where status = 'no_show' and id not in (select id from fuzz_base_shifts))`,
  'ruolo con requisito di verifica assegnato a chi non lo soddisfa':
    `select s.id from shifts s where s.status in ('assegnato','confermato') and not public.job_allows_worker(s.job_id, s.worker_id)
     union select a.id from standby_assignments a where a.status in ('riservata','attivata') and not public.job_allows_worker(a.job_id, a.worker_id)`,
  'stato "completo" dell\'evento incoerente con i posti':
    `select e.id from events e where e.complete is distinct from (
       coalesce((select sum(j.headcount) from jobs j where j.event_id = e.id and (j.is_open or exists (select 1 from shifts s where s.job_id = j.id and s.status in ('assegnato','confermato','completato')))), 0) > 0
       and not exists (select 1 from jobs j where j.event_id = e.id and (j.is_open or exists (select 1 from shifts s where s.job_id = j.id and s.status in ('assegnato','confermato','completato')))
                       and (select count(*) from shifts s where s.job_id = j.id and s.status in ('assegnato','confermato','completato')) < j.headcount)
       and not exists (select 1 from guarantees g join jobs j on j.id = g.job_id where j.event_id = e.id and g.status not in ('coperta','attivata','chiusa')
                       and (j.is_open or exists (select 1 from shifts s where s.job_id = j.id and s.status in ('assegnato','confermato','completato')))))`,
};

async function setup(seed) {
  const db = await newDb();
  const rnd = RNG(seed);
  await db.admin(`select test_generate_workers(10, 'Milano', 40, 30)`);
  const workers = (await db.admin(`select id from profiles where role = 'seeker' order by id`)).map(r => r.id);
  const orgs = [U.org1, U.org2];
  const jobs = [];
  for (const org of orgs) for (let i = 0; i < 3; i++) {
    const role = ['barman', 'barman', 'hostess_steward', 'servizio_tavoli'][Math.floor(rnd() * 4)];
    const ev = (await db.as(org, `insert into events (organizer_id, name, city, event_date) values ($1,'Evento fuzz','Milano',current_date + 3) returning id`, [org]))[0].id;
    const job = (await db.as(org, `insert into jobs (employer_id, company_name, title, description, city, event_id, role_code, headcount, shift_pay_cents, starts_at, ends_at, min_verification)
      values ($1,'Azienda fuzz','Ruolo fuzz','Descrizione del ruolo','Milano',$2,$3,$4,8000, now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 6), $6) returning id`,
      [org, ev, role, 1 + Math.floor(rnd() * 3), 20 + Math.floor(rnd() * 80), ['nessuna', 'nessuna', 'base'][Math.floor(rnd() * 3)]]))[0].id;
    jobs.push({ job, org, ev });
  }
  await db.pg.exec(`create table fuzz_base_shifts as select id from shifts; create table fuzz_base_trust as select id from trust_events`);   // istantanea: i dati iniziali non passano dall'app
  return { db, rnd, workers, orgs, jobs };
}

async function check(db, ctx) {
  for (const [name, sql] of Object.entries(INVARIANTS)) {
    const bad = await db.admin(sql);
    assert.equal(bad.length, 0, `INVARIANTE VIOLATA: ${name}\n  dopo: ${ctx.join(' → ')}\n  righe: ${JSON.stringify(bad).slice(0, 300)}`);
  }
  // i punteggi restano sempre tra 0 e 100
  const j = (await db.admin(`select id, employer_id from jobs where event_id is not null limit 1`))[0];
  const sc = await db.as(j.employer_id, `select score from match_workers($1, 200)`, [j.id]);
  assert.ok(sc.every(r => r.score >= 0 && r.score <= 100), `punteggio fuori scala dopo: ${ctx.join(' → ')}`);
}

async function step(db, rnd, workers, orgs, trace) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const op = pick(['invite', 'invite', 'invite', 'respond', 'respond', 'respond', 'guarantee', 'reserve', 'reserve', 'auto', 'maintenance', 'advance',
    'checkin', 'checkin', 'confirm', 'confirm', 'noshow', 'cancel', 'withdraw', 'block', 'apply', 'accept']);
  const run = async (who, sql, p) => {
    try { await db.as(who, sql, p); trace.push(`${op}:ok`); }
    catch (e) { trace.push(`${op}:no`); assert.doesNotMatch(e.message, INTERNAL, `ERRORE INTERNO (${op}): ${e.message}\n  sql: ${sql}\n  dopo: ${trace.slice(-12).join(' → ')}`); }
  };
  switch (op) {
    case 'invite': {
      const j = pick(await db.admin(`select id, employer_id from jobs where is_open and starts_at > now() and event_id is not null`)); if (!j) return;
      const c = (await db.as(j.employer_id, `select worker_id from match_workers($1, 50) where offer_status is null`, [j.id]));
      if (c.length) await run(j.employer_id, `select invite_worker($1,$2)`, [j.id, pick(c).worker_id]); break;
    }
    case 'respond': {
      const o = pick(await db.admin(`select id, worker_id from offers where status = 'inviata'`)); if (!o) return;
      await run(o.worker_id, `select respond_offer($1,$2)`, [o.id, rnd() < 0.75]); break;
    }
    case 'guarantee': { const j = pick(await db.admin(`select id, employer_id from jobs where is_open and starts_at > now() and event_id is not null`)); if (j) await run(j.employer_id, `select buy_guarantee($1)`, [j.id]); break; }
    case 'reserve': {
      const g = pick(await db.admin(`select g.id, g.job_id, j.employer_id from guarantees g join jobs j on j.id = g.job_id where g.status = 'aperta' and j.starts_at > now()`)); if (!g) return;
      const c = await db.as(g.employer_id, `select worker_id from match_reserves($1, 50) where offer_status is null`, [g.job_id]);
      if (c.length) await run(g.employer_id, `select invite_reserve($1,$2)`, [g.id, pick(c).worker_id]); break;
    }
    case 'auto': { const j = pick(await db.admin(`select id, employer_id from jobs where is_open and starts_at > now() and event_id is not null`)); if (j) await run(j.employer_id, `select enable_auto_select($1)`, [j.id]); break; }
    case 'maintenance': {
      await db.admin(`update offers set expires_at = now() - interval '1 minute' where status = 'inviata' and random() < 0.5`);
      try { await db.admin(`select run_offer_maintenance()`); await db.admin(`select close_guarantees()`); trace.push('maintenance:ok'); }
      catch (e) { assert.doesNotMatch(e.message, INTERNAL, `ERRORE INTERNO (manutenzione): ${e.message}`); } break;
    }
    case 'advance': { await db.advance(pick([3600, 6 * 3600, 20 * 3600, 40 * 3600])); trace.push('advance'); break; }
    case 'checkin': {
      const s = pick(await db.admin(`select s.id, s.worker_id, s.status from shifts s where s.status in ('assegnato','confermato')`)); if (!s) return;
      await run(s.worker_id, `select worker_check($1,$2,0,0,$3)`, [s.id, s.status === 'assegnato' ? 'in' : 'out', s.status === 'assegnato' ? `${s.worker_id}/s.jpg` : null]); break;
    }
    case 'confirm': {
      const c = pick(await db.admin(`select c.id, c.kind, j.employer_id from check_events c join shifts s on s.id = c.shift_id join jobs j on j.id = s.job_id where c.confirmed_at is null`)); if (!c) return;
      if (c.kind === 'in' && rnd() < 0.7) await run(c.employer_id, `select confirm_check_identity($1,$2)`, [c.id, pick(['ok', 'ok', 'foto_datata', 'non_corrisponde'])]);
      else await run(c.employer_id, `select employer_confirm_check($1)`, [c.id]); break;
    }
    case 'noshow': { const s = pick(await db.admin(`select s.id, j.employer_id from shifts s join jobs j on j.id = s.job_id where s.status = 'assegnato'`)); if (s) await run(s.employer_id, `select report_no_show($1)`, [s.id]); break; }
    case 'cancel': { if (rnd() < 0.5) return; const j = pick(await db.admin(`select id, employer_id from jobs where is_open and starts_at > now() and event_id is not null`)); if (j) await run(j.employer_id, `select cancel_job($1,'prova')`, [j.id]); break; }
    case 'withdraw': { const a = pick(await db.admin(`select id, worker_id from standby_assignments where status = 'riservata'`)); if (a) await run(a.worker_id, `select withdraw_standby($1)`, [a.id]); break; }
    case 'block': { const w = pick(workers), o = pick(orgs); await run(w, rnd() < 0.7 ? `select block_organizer($1)` : `select unblock_organizer($1)`, [o]); break; }
    case 'apply': { const w = pick(workers), j = pick(await db.admin(`select id from jobs where is_open and starts_at > now() and event_id is not null`)); if (j) await run(w, `select apply_to_job($1,'',null)`, [j.id]); break; }
    case 'accept': { const a = pick(await db.admin(`select a.id, j.employer_id from applications a join jobs j on j.id = a.job_id where j.is_open`)); if (a) await run(a.employer_id, `select accept_application($1)`, [a.id]); break; }
  }
}

for (const seed of [1, 7, 42, 2024]) {
  test(`invarianti: 250 operazioni casuali (seme ${seed})`, { timeout: 280000 }, async () => {
    const { db, rnd, workers, orgs } = await setup(seed);
    const trace = [];
    let executed = 0;
    for (let i = 0; i < 250; i++) {
      await step(db, rnd, workers, orgs, trace);
      await check(db, trace.slice(-10));
      executed = trace.filter(t => t.endsWith(':ok')).length;
    }
    assert.ok(executed > 40, `il fuzzer deve compiere operazioni riuscite (riuscite: ${executed})`);
    const kinds = new Set(trace.filter(t => t.endsWith(':ok')).map(t => t.split(':')[0]));
    assert.ok(kinds.size >= 6, `varietà di operazioni riuscite: ${[...kinds].join(', ')}`);
  });
}
