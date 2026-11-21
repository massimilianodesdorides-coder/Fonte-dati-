// REGOLE DI FUNZIONAMENTO: classifica, inviti, garanzie, soldi registrati, presenze, annullamenti, giudizi.
import test from 'node:test';
import { newDb, U, J, EV, assert } from '../lib/db.mjs';

// ---- aiuti ----
async function mkJob(db, org, { headcount = 1, pay = 10000, days = 2, role = 'barman', min = 'nessuna', city = 'Milano' } = {}) {
  const ev = (await db.as(org, `insert into events (organizer_id, name, city, event_date) values ($1,'Evento prova',$2,current_date + 3) returning id`, [org, city]))[0].id;
  const job = (await db.as(org, `insert into jobs (employer_id, company_name, title, description, city, event_id, role_code, headcount, shift_pay_cents, starts_at, ends_at, min_verification)
    values ($1,'Azienda prova','Ruolo prova','Descrizione del ruolo',$2,$3,$4,$5,$6, now() + make_interval(days => $7), now() + make_interval(days => $7) + interval '6 hours', $8) returning id`,
    [org, city, ev, role, headcount, pay, days, min]))[0].id;
  return { ev, job };
}
const invite = (db, org, job, w) => db.as(org, `select invite_worker($1,$2) as id`, [job, w]).then(r => r[0].id);
const offerOf = (db, w, job) => db.admin(`select id from offers where worker_id = $1 and job_id = $2 order by created_at desc limit 1`, [w, job]).then(r => r[0].id);
const accept = async (db, w, job) => db.val(w, `select respond_offer($1,true)`, [await offerOf(db, w, job)]);
const shiftOf = (db, w, job) => db.admin(`select id, status, is_replacement from shifts where worker_id = $1 and job_id = $2 order by created_at desc limit 1`, [w, job]).then(r => r[0]);
const notif = (db, user, kind) => db.admin(`select count(*)::int as n from notifications where user_id = $1 and kind = $2`, [user, kind]).then(r => r[0].n);
const ledger = (db, job) => db.admin(`select kind, amount_cents, payee_id from ledger where job_id = $1 order by kind, amount_cents`, [job]);
const names = rows => rows.map(r => r.display_name);

// ---------------------------------------------------------------------------------------------
test('classifica: chi non è idoneo non compare; ordine per punteggio; la somma torna', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 2 });
  const rows = await db.as(U.org1, `select display_name, score, breakdown from match_workers($1)`, [job]);
  const n = names(rows);
  for (const ok of ['Marco E.', 'Nico R.', 'Nina N.', 'Luca L.', 'Remo R.']) assert.ok(n.includes(ok), `${ok} deve comparire`);
  for (const no of ['Paolo P.', 'Hilda H.', 'Giulia G.']) assert.ok(!n.includes(no), `${no} non deve comparire`);
  const sc = rows.map(r => r.score); assert.deepEqual(sc, [...sc].sort((a, b) => b - a), 'ordinata per punteggio');
  rows.forEach(r => assert.equal(r.score, Object.values(r.breakdown).reduce((a, b) => a + b, 0)));
  assert.equal(rows.find(r => r.display_name === 'Remo R.').breakdown.citta, 0, 'Remo è a Roma');
  assert.ok(rows.find(r => r.display_name === 'Marco E.').breakdown.esperienza > 0);
});

test('classifica: preferiti in cima, "da evitare" in fondo e mai invitati', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 2 });
  await db.as(U.org1, `select set_worker_note($1,'preferito',null,'')`, [U.remo]);
  await db.as(U.org1, `select set_worker_note($1,'da_evitare','qualita','')`, [U.marco]);
  const n = names(await db.as(U.org1, `select display_name from match_workers($1)`, [job]));
  assert.equal(n[0], 'Remo R.'); assert.equal(n[n.length - 1], 'Marco E.');
  await db.fails(U.org1, `select invite_worker($1,$2)`, [job, U.marco], /da evitare/);
  await db.as(U.org1, `select enable_auto_select($1)`, [job]);
  assert.equal((await db.admin(`select count(*)::int as n from offers where worker_id = $1`, [U.marco]))[0].n, 0, 'l\'automatico non lo invita');
});

test('classifica: indisponibilità, blocchi e soglie dei lavoratori escludono dalla ricerca', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 2 });
  await db.as(U.luca, `insert into worker_unavailability (worker_id, from_at, to_at) values ($1, now() + interval '1 day', now() + interval '3 days')`, [U.luca]);
  await db.as(U.nina, `select block_organizer($1)`, [U.org1]);
  await db.as(U.nico, `select set_offer_preferences(4.5, true)`);          // org1 ha 3,9
  await db.as(U.remo, `select set_offer_preferences(null, false)`);        // org1 non è nuovo: resta
  const n = names(await db.as(U.org1, `select display_name from match_workers($1)`, [job]));
  assert.ok(!n.includes('Luca L.') && !n.includes('Nina N.') && !n.includes('Nico R.'));
  assert.ok(n.includes('Marco E.') && n.includes('Remo R.'));
  // per un organizzatore NUOVO (org2) chi non accetta nuovi sparisce
  const j2 = await mkJob(db, U.org2, { headcount: 1 });
  const n2 = names(await db.as(U.org2, `select display_name from match_workers($1)`, [j2.job]));
  assert.ok(!n2.includes('Remo R.'));
});

test('inviti: limite agli inviti in attesa, primo che accetta vince, gli altri decadono', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1 });
  await invite(db, U.org1, job, U.marco); await invite(db, U.org1, job, U.nina);
  await db.fails(U.org1, `select invite_worker($1,$2)`, [job, U.luca], /troppi inviti/);
  await db.fails(U.org1, `select invite_worker($1,$2)`, [job, U.marco], /già invitato/);
  assert.equal(await accept(db, U.nina, job), 'accettata');
  assert.equal((await shiftOf(db, U.nina, job)).status, 'assegnato');
  await db.fails(U.marco, `select respond_offer($1,true)`, [await offerOf(db, U.marco, job)], /non più valido/);
  assert.equal(await notif(db, U.org1, 'proposta_accettata'), 1);
});

test('inviti: rifiuto, scadenza e promemoria con notifiche', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1 });
  const o1 = await invite(db, U.org1, job, U.marco);
  assert.equal(await db.val(U.marco, `select respond_offer($1,false)`, [o1]), 'rifiutata');
  assert.equal(await notif(db, U.org1, 'proposta_rifiutata'), 1);
  assert.equal(await notif(db, U.org1, 'altri_candidati'), 1, 'avviso con la lista aggiuntiva');
  await invite(db, U.org1, job, U.nina);
  await db.admin(`update offers set expires_at = now() + interval '20 minutes' where status = 'inviata'`);
  await db.admin(`select run_offer_maintenance()`);
  assert.equal(await notif(db, U.nina, 'proposta_in_scadenza'), 1, 'promemoria');
  await db.admin(`update offers set expires_at = now() - interval '1 minute' where status = 'inviata'`);
  await db.admin(`select run_offer_maintenance()`);
  assert.equal(await notif(db, U.nina, 'proposta_scaduta'), 1);
  assert.equal((await db.admin(`select status from offers where worker_id = $1`, [U.nina]))[0].status, 'scaduta');
});

test('scelta automatica: passa al successivo se rifiuta o non risponde, avvisa quando i candidati finiscono', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.org1, `select enable_auto_select($1)`, [job]);
  const pending = async () => (await db.admin(`select worker_id from offers where job_id = $1 and status = 'inviata'`, [job])).map(r => r.worker_id);
  let tried = [];
  for (let i = 0; i < 5; i++) {
    const p = await pending(); if (!p.length) break;
    assert.equal(p.length, 1, 'una sola proposta alla volta per un posto');
    tried.push(p[0]);
    if (i % 2 === 0) await db.as(p[0], `select respond_offer($1,false)`, [await offerOf(db, p[0], job)]);
    else { await db.admin(`update offers set expires_at = now() - interval '1 minute' where status = 'inviata'`); await db.admin(`select run_offer_maintenance()`); }
  }
  assert.equal(new Set(tried).size, tried.length, 'nessuno viene contattato due volte');
  assert.equal(tried.length, 5, 'ha provato tutti i cinque barman idonei');
  assert.equal(await notif(db, U.org1, 'candidati_esauriti'), 1);
});

test('garanzia: prezzo 20% + 10%, tetto, riserve insufficienti', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1, pay: 12345 });
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  const g = (await db.admin(`select standby_fee_cents as s, platform_fee_cents as p from guarantees where job_id = $1`, [job]))[0];
  assert.deepEqual(g, { s: 2469, p: 1235 }, '20% e 10% arrotondati');
  await db.fails(U.org1, `select buy_guarantee($1)`, [job], /non possono superare/);
  const far = await mkJob(db, U.org1, { headcount: 1, city: 'Torino' });                    // nessuna riserva a Torino
  await db.fails(U.org1, `select buy_guarantee($1)`, [far.job], /riserve insufficienti/);
});

test('garanzia: riserva non usata → 20% a lei e 10% alla piattaforma a fine evento', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1, pay: 10000 });
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [job]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); assert.equal(await accept(db, U.luca, job), 'accettata');
  assert.equal((await db.admin(`select status from guarantees where id = $1`, [g]))[0].status, 'coperta');
  await db.advance(4 * 86400); await db.admin(`select close_guarantees()`);
  const led = await ledger(db, job);
  assert.deepEqual(led.map(l => [l.kind, l.amount_cents]), [['garanzia_piattaforma', 1000], ['garanzia_riserva', 2000]]);
  assert.equal(led.find(l => l.kind === 'garanzia_riserva').payee_id, U.luca);
  assert.equal((await db.admin(`select status from guarantees where id = $1`, [g]))[0].status, 'chiusa');
  // chiusura ripetuta: nessun doppione
  await db.admin(`select close_guarantees()`); assert.equal((await ledger(db, job)).length, 2);
});

test('garanzia mai coperta da una riserva: nulla è dovuto', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  await db.advance(4 * 86400); await db.admin(`select close_guarantees()`);
  assert.deepEqual(await ledger(db, job), []);
  assert.equal((await db.admin(`select status from guarantees where job_id = $1`, [job]))[0].status, 'non_mantenuta');
});

test('no-show con riserva: sostituta con paga piena, la piattaforma incassa solo il 10%', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 1, pay: 10000 });
  await invite(db, U.org1, job, U.marco); await accept(db, U.marco, job);
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [job]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); await accept(db, U.luca, job);
  await db.startEvent(ev);
  const sMarco = await shiftOf(db, U.marco, job);
  assert.equal(await db.val(U.org1, `select report_no_show($1)`, [sMarco.id]), 'sostituita');
  assert.equal((await shiftOf(db, U.marco, job)).status, 'no_show');
  const rep = await shiftOf(db, U.luca, job); assert.equal(rep.is_replacement, true);
  assert.equal(await notif(db, U.luca, 'sostituzione_attivata'), 1);
  assert.deepEqual((await ledger(db, job)).map(l => [l.kind, l.amount_cents]), [['garanzia_piattaforma', 1000]], 'niente 20%: prende la paga piena');
  // la sostituta lavora e viene pagata per intero
  const c = await db.as(U.luca, `select worker_check($1,'in',0,0,$2) as id`, [rep.id, `${U.luca}/s.jpg`]);
  await db.as(U.org1, `select employer_confirm_check($1)`, [c[0].id]);
  const o = await db.as(U.luca, `select worker_check($1,'out',null,null,null) as id`, [rep.id]);
  await db.as(U.org1, `select employer_confirm_check($1)`, [o[0].id]);
  const led = await ledger(db, job);
  assert.deepEqual(led.map(l => [l.kind, l.amount_cents]), [['garanzia_piattaforma', 1000], ['paga_turno', 10000]]);
  assert.equal(led.find(l => l.kind === 'paga_turno').payee_id, U.luca);
  // chiusura dopo l'evento: la garanzia attivata non genera altro
  await db.advance(2 * 86400); await db.admin(`select close_guarantees()`);
  assert.equal((await ledger(db, job)).length, 2);
  // punteggio di Marco: no-show registrato; Luca: riserva attivata e turno completato
  assert.equal((await db.admin(`select count(*)::int as n from trust_events where user_id = $1 and kind = 'no_show'`, [U.marco]))[0].n, 1);
});

test('no-show: regole (attesa di 15 minuti, check-in presente, solo il datore, una volta sola)', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 2 });
  await invite(db, U.org1, job, U.marco); await accept(db, U.marco, job);
  await invite(db, U.org1, job, U.nina); await accept(db, U.nina, job);
  const sM = await shiftOf(db, U.marco, job), sN = await shiftOf(db, U.nina, job);
  await db.fails(U.org1, `select report_no_show($1)`, [sM.id], /troppo presto/);
  await db.startEvent(ev);
  await db.as(U.marco, `select worker_check($1,'in',0,0,$2)`, [sM.id, `${U.marco}/s.jpg`]);
  await db.fails(U.org1, `select report_no_show($1)`, [sM.id], /ha fatto check-in/);
  await db.fails(U.org2, `select report_no_show($1)`, [sN.id], /non autorizzato/);
  await db.fails(U.nina, `select report_no_show($1)`, [sN.id], /non autorizzato/);
  assert.equal(await db.val(U.org1, `select report_no_show($1)`, [sN.id]), 'nessuna_riserva');
  await db.fails(U.org1, `select report_no_show($1)`, [sN.id], /non segnalabile/);
});

test('check-in e check-out: finestra, selfie nella propria cartella, ordine, ritardo, completamento', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 1 });
  await invite(db, U.org1, job, U.marco); await accept(db, U.marco, job);
  const s = await shiftOf(db, U.marco, job);
  await db.fails(U.marco, `select worker_check($1,'in',0,0,$2)`, [s.id, `${U.marco}/s.jpg`], /finestra/);
  await db.startEvent(ev);
  await db.fails(U.marco, `select worker_check($1,'in',0,0,null)`, [s.id], /selfie obbligatorio/);
  await db.fails(U.marco, `select worker_check($1,'in',0,0,$2)`, [s.id, `${U.nina}/s.jpg`], /selfie obbligatorio/);
  await db.fails(U.marco, `select worker_check($1,'out',0,0,null)`, [s.id], /dopo il check-in confermato/);
  await db.fails(U.marco, `select worker_check($1,'ciao',0,0,null)`, [s.id], /tipo non valido/);
  const c = (await db.as(U.marco, `select worker_check($1,'in',45.4,9.1,$2) as id`, [s.id, `${U.marco}/s.jpg`]))[0].id;
  await db.fails(U.marco, `select worker_check($1,'in',0,0,$2)`, [s.id, `${U.marco}/s.jpg`], /già inviato il check-in/);
  await db.fails(U.org2, `select employer_confirm_check($1)`, [c], /non autorizzato/);
  await db.as(U.org1, `select employer_confirm_check($1)`, [c]);
  await db.fails(U.org1, `select employer_confirm_check($1)`, [c], /già confermato/);
  assert.equal((await shiftOf(db, U.marco, job)).status, 'confermato');
  assert.equal(await db.val('admin', `select count(*)::int from trust_events where user_id = '${U.marco}' and kind = 'ritardo'`), 1, 'arrivato 30 minuti dopo l\'inizio: ritardo');
  const o = (await db.as(U.marco, `select worker_check($1,'out',null,null,null) as id`, [s.id]))[0].id;
  await db.as(U.org1, `select employer_confirm_check($1)`, [o]);
  assert.equal((await shiftOf(db, U.marco, job)).status, 'completato');
  assert.equal((await db.admin(`select count(*)::int as n from trust_events where user_id = $1 and kind = 'completato'`, [U.marco]))[0].n, 1);
  assert.deepEqual((await ledger(db, job)).map(l => [l.kind, l.amount_cents]), [['paga_turno', 10000]]);
});

test('ritardo entro la tolleranza non viene registrato', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 1 });
  await invite(db, U.org1, job, U.nina); await accept(db, U.nina, job);
  await db.pg.exec('set session_replication_role = replica');
  await db.pg.query(`update jobs set starts_at = now() - interval '5 minutes', ends_at = now() + interval '5 hours' where id = $1`, [job]);
  await db.pg.exec('set session_replication_role = origin');
  const s = await shiftOf(db, U.nina, job);
  const c = (await db.as(U.nina, `select worker_check($1,'in',0,0,$2) as id`, [s.id, `${U.nina}/s.jpg`]))[0].id;
  await db.as(U.org1, `select employer_confirm_check($1)`, [c]);
  assert.equal((await db.admin(`select count(*)::int as n from trust_events where user_id = $1 and kind = 'ritardo'`, [U.nina]))[0].n, 0);
});

test('evento completo: avviso solo quando lo è davvero, nessun falso allarme sulla sostituzione', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 1 });
  await invite(db, U.org1, job, U.marco);
  assert.equal(await notif(db, U.org1, 'evento_completo'), 0);
  await accept(db, U.marco, job);
  assert.equal(await notif(db, U.org1, 'evento_completo'), 1);
  assert.equal((await db.admin(`select complete from events where id = $1`, [ev]))[0].complete, true);
  // aggiungere un ruolo lo rende incompleto
  await db.as(U.org1, `insert into jobs (employer_id, company_name, title, description, city, event_id, role_code, headcount, shift_pay_cents, starts_at, ends_at)
    values ($1,'Azienda prova','Altro ruolo','descrizione lunga','Milano',$2,'servizio_tavoli',2,5000, now() + interval '2 days', now() + interval '2 days 5 hours')`, [U.org1, ev]);
  assert.equal(await notif(db, U.org1, 'evento_non_completo'), 1);
  assert.equal((await db.admin(`select complete from events where id = $1`, [ev]))[0].complete, false);
});

test('evento con garanzia: completo solo con la riserva; il no-show sostituito non fa rumore', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  await invite(db, U.org1, job, U.marco); await accept(db, U.marco, job);
  assert.equal(await notif(db, U.org1, 'evento_completo'), 0, 'posto coperto ma garanzia senza riserva: non è completo');
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [job]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); await accept(db, U.luca, job);
  assert.equal(await notif(db, U.org1, 'evento_completo'), 1);
  await db.startEvent(ev);
  await db.as(U.org1, `select report_no_show($1)`, [(await shiftOf(db, U.marco, job)).id]);
  assert.equal(await notif(db, U.org1, 'evento_non_completo'), 0, 'la sostituta copre il posto: nessun allarme');
  assert.equal(await notif(db, U.org1, 'evento_completo'), 1, 'e nessun secondo "completo"');
});

test('annullamento: avvisa tutti, libera riserve, tardivo se mancano meno di 48 ore e abbassa il punteggio', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1, days: 1 });
  await invite(db, U.org1, job, U.marco); await accept(db, U.marco, job);
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [job]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); await accept(db, U.luca, job);
  await invite(db, U.org1, job, U.nina).catch(() => {});
  const before = (await db.as(U.nico, `select organizer_profile($1) as p`, [U.org1]))[0].p.overall;
  assert.equal(await db.val(U.org1, `select cancel_job($1,'sede non disponibile')`, [job]), 1, 'una persona assegnata avvisata');
  assert.equal(await notif(db, U.marco, 'turno_annullato'), 1);
  assert.equal(await notif(db, U.luca, 'riserva_annullata'), 1);
  assert.equal((await shiftOf(db, U.marco, job)).status, 'annullato');
  const ev = (await db.admin(`select late, round(hours_before) as h from organizer_events where job_id = $1`, [job]))[0];
  assert.equal(ev.late, true); assert.equal(Number(ev.h), 24);
  assert.equal((await db.admin(`select status from guarantees where job_id = $1`, [job]))[0].status, 'chiusa');
  assert.equal((await db.admin(`select count(*)::int as n from offers where job_id = $1 and status = 'inviata'`, [job]))[0].n, 0, 'proposte in attesa ritirate');
  const after = (await db.as(U.nico, `select organizer_profile($1) as p`, [U.org1]))[0].p;
  assert.equal(Number((before - 0.3).toFixed(1)), after.overall, 'punteggio -0,3');
  assert.equal(after.annullamenti_tardivi_12m, 1);
  const started = await mkJob(db, U.org1, { headcount: 1 }); await db.startEvent(started.ev);
  await db.fails(U.org1, `select cancel_job($1,'ancora')`, [started.job], /già iniziato/);
});

test('annullamento con largo anticipo non è tardivo', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1, days: 5 });
  await db.as(U.org1, `select cancel_job($1,'')`, [job]);
  assert.equal((await db.admin(`select late from organizer_events where job_id = $1`, [job]))[0].late, false);
});

test('giudizi: media ponderata, nuovo senza punteggio, una sola volta per turno, finestra di 30 giorni', async () => {
  const db = await newDb();
  const p = async o => (await db.as(U.marco, `select organizer_profile($1) as p`, [o]))[0].p;
  const base = await p(U.org1);
  assert.equal(base.nuovo, false); assert.equal(base.n, 3); assert.equal(base.overall, 3.9);
  const nuovo = await p(U.org2); assert.equal(nuovo.nuovo, true); assert.equal(nuovo.overall, null, 'sotto i 3 giudizi: nessun numero');
  // giudizio su un evento concluso
  const { ev, job } = await mkJob(db, U.org2, { headcount: 1 });
  await invite(db, U.org2, job, U.marco); await accept(db, U.marco, job);
  const s = await shiftOf(db, U.marco, job);
  await db.fails(U.marco, `select review_organizer($1,5,5,5,'puntuale','')`, [s.id], /partecipato/);
  await db.startEvent(ev);
  const c = (await db.as(U.marco, `select worker_check($1,'in',0,0,$2) as id`, [s.id, `${U.marco}/s.jpg`]))[0].id;
  await db.as(U.org2, `select employer_confirm_check($1)`, [c]);
  await db.fails(U.marco, `select review_organizer($1,5,5,5,'puntuale','')`, [s.id], /dopo la fine/);
  await db.advance(8 * 3600);
  await db.fails(U.marco, `select review_organizer($1,6,5,5,'puntuale','')`, [s.id], /voti vanno da 1 a 5/);
  await db.fails(U.marco, `select review_organizer($1,5,5,5,'boh','')`, [s.id], /come sei stato pagato/);
  await db.as(U.marco, `select review_organizer($1,5,5,5,'non_ancora','')`, [s.id]);
  await db.as(U.marco, `select review_organizer($1,4,4,4,'puntuale','corretto')`, [s.id]);   // correzione
  assert.equal((await db.admin(`select count(*)::int as n from organizer_reviews where shift_id = $1`, [s.id]))[0].n, 1, 'una sola riga per turno');
  assert.equal((await p(U.org2)).n, 1);
  await db.advance(31 * 86400);
  await db.fails(U.marco, `select review_organizer($1,1,1,1,'non_pagato','tardi')`, [s.id], /scaduto/);
});

test('candidature: doppie, posti esauriti, ruoli sbagliati, annunci chiusi', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.nina, `select apply_to_job($1,'ciao',null)`, [job]);
  await db.fails(U.nina, `select apply_to_job($1,'ancora',null)`, [job], /già candidato/);
  await db.as(U.marco, `select apply_to_job($1,'',null)`, [job]);
  await db.fails(U.org2, `select apply_to_job($1,'',null)`, [job], /solo chi cerca lavoro/);
  const a1 = (await db.admin(`select id from applications where seeker_id = $1`, [U.nina]))[0].id;
  const a2 = (await db.admin(`select id from applications where seeker_id = $1`, [U.marco]))[0].id;
  await db.as(U.org1, `select accept_application($1)`, [a1]);
  await db.fails(U.org1, `select accept_application($1)`, [a2], /posti esauriti/);
  await db.admin(`update jobs set is_open = false where id = $1`, [job]);
  await db.fails(U.luca, `select apply_to_job($1,'',null)`, [job], /non disponibile/);
});

test('conflitti di orario: non si accetta due volte la stessa fascia, né ci si dichiara indisponibili sopra un impegno', async () => {
  const db = await newDb(); const a = await mkJob(db, U.org1, { headcount: 1 }); const b = await mkJob(db, U.org2, { headcount: 1 });
  await invite(db, U.org1, a.job, U.marco); await invite(db, U.org2, b.job, U.marco);      // due proposte già in attesa
  assert.equal(await accept(db, U.marco, a.job), 'accettata');
  assert.equal(await accept(db, U.marco, b.job), 'non_disponibile', 'stessa fascia: la seconda non passa');
  const c = await mkJob(db, U.org2, { headcount: 1 });
  await db.fails(U.org2, `select invite_worker($1,$2)`, [c.job, U.marco], /non idonea o non disponibile/);   // e non si invita chi è già impegnato
  await db.fails(U.marco, `insert into worker_unavailability (worker_id, from_at, to_at) values ($1, now() + interval '1 day', now() + interval '3 days')`, [U.marco], /già un impegno/);
  const ics = await db.val(U.marco, `select calendar_ics()`);
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*SUMMARY:Ruolo prova/); assert.match(ics, /\r\n/);
});

test('riserva che rinuncia: la garanzia torna scoperta; a meno di 24 ore perde affidabilità', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1, days: 1 });
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [job]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); await accept(db, U.luca, job);
  const a = (await db.admin(`select id from standby_assignments where worker_id = $1`, [U.luca]))[0].id;
  await db.as(U.luca, `select withdraw_standby($1)`, [a]);
  assert.equal((await db.admin(`select status from guarantees where id = $1`, [g]))[0].status, 'aperta');
  assert.equal((await db.admin(`select count(*)::int as n from trust_events where user_id = $1 and kind = 'rinuncia_tardiva'`, [U.luca]))[0].n, 1);
});

test('canali: statistiche per link; il link attribuisce solo candidature dello stesso evento', async () => {
  const db = await newDb();
  const code = (await db.as(U.org1, `select create_event_link($1,'Subito') as c`, [EV.gala]))[0].c;
  await db.as(U.giulia, `select apply_to_job($1,'',$2)`, [J.tavoli, code]);
  const other = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.nina, `select apply_to_job($1,'',$2)`, [other.job, code]);                 // altro evento: nessuna attribuzione
  const st = (await db.as(U.org1, `select channel, candidature from link_stats($1)`, [EV.gala]))[0];
  assert.deepEqual(st, { channel: 'Subito', candidature: 1 });
  assert.equal((await db.as(U.org1, `select count(*)::int as n from link_stats($1)`, [EV.gala]))[0].n, 1);
  assert.equal(await db.val(null, `select public_event_page('codice-falso') is null`), true);
  const page = await db.val(null, `select public_event_page($1)`, [code]);
  assert.equal(page.canale, 'Subito'); assert.ok(page.ruoli.length >= 3);
  assert.ok(!JSON.stringify(page).includes(U.org1), 'la pagina pubblica non espone identificativi di utenti');
  await db.fails(U.org1, `select create_event_link($1,'x')`, [EV.sagra], /non trovato/);
});

test('blocco di un organizzatore: la proposta in attesa viene rifiutata e l\'automatico passa al successivo', async () => {
  const db = await newDb(); const { job } = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.org1, `select enable_auto_select($1)`, [job]);
  const first = (await db.admin(`select worker_id from offers where job_id = $1 and status = 'inviata'`, [job]))[0].worker_id;
  await db.as(first, `select block_organizer($1)`, [U.org1]);
  assert.equal((await db.admin(`select status from offers where worker_id = $1 and job_id = $2`, [first, job]))[0].status, 'rifiutata');
  const next = (await db.admin(`select worker_id from offers where job_id = $1 and status = 'inviata'`, [job]));
  assert.equal(next.length, 1); assert.notEqual(next[0].worker_id, first);
  await db.as(first, `select unblock_organizer($1)`, [U.org1]);
});

test('registrazione: il ruolo si sceglie solo tra quelli ammessi e il profilo nasce coerente', async () => {
  const db = await newDb();
  const mk = async (meta) => (await db.admin(`insert into auth.users (email, raw_user_meta_data) values ($1,$2) returning id`, [`r${Math.random()}@t.test`, JSON.stringify(meta)]))[0].id;
  const a = await mk({ role: 'seeker', full_name: 'Persona Normale' });
  assert.equal((await db.admin(`select role, discoverable, verified_until from profiles where id = $1`, [a]))[0].discoverable, false, 'visibilità spenta di default');
  await assert.rejects(() => mk({ role: 'amministratore', full_name: 'Furbo Furbetti' }), 'un ruolo inventato è rifiutato');
  const long = await mk({ role: 'seeker', full_name: 'X'.repeat(300) });
  assert.equal((await db.admin(`select length(full_name)::int as n from profiles where id = $1`, [long]))[0].n, 100, 'nome troncato a 100');
});

test('dopo una sostituzione il posto è coperto: non si può assegnare una terza persona', async () => {
  const db = await newDb(); const { ev, job } = await mkJob(db, U.org1, { headcount: 1 });
  await db.as(U.nina, `select apply_to_job($1,'ci sono',null)`, [job]);
  await invite(db, U.org1, job, U.marco); await accept(db, U.marco, job);
  await db.as(U.org1, `select buy_guarantee($1)`, [job]);
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [job]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]); await accept(db, U.luca, job);
  await db.startEvent(ev);
  await db.as(U.org1, `select report_no_show($1)`, [(await shiftOf(db, U.marco, job)).id]);          // Luca sostituisce Marco
  const app = (await db.admin(`select id from applications where seeker_id = $1`, [U.nina]))[0].id;
  await db.fails(U.org1, `select accept_application($1)`, [app], /posti esauriti/);
  const active = (await db.admin(`select count(*)::int as n from shifts where job_id = $1 and status in ('assegnato','confermato','completato')`, [job]))[0].n;
  assert.equal(active, 1, 'un solo turno attivo per un solo posto');
});
