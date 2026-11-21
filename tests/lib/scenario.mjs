// Scenario "ricco": popola quasi ogni tabella passando dalle funzioni vere dell'app,
// così i test di sicurezza possono verificare cosa vede ciascun utente.
import { newDb, U, J, EV } from './db.mjs';

export async function richDb() {
  const db = await newDb();
  const ids = {};
  // turni, riserva e garanzia sul barman del Gala
  await db.as(U.org1, `select invite_worker($1,$2)`, [J.barman, U.marco]);
  await db.as(U.org1, `select invite_worker($1,$2)`, [J.barman, U.nina]);
  await db.as(U.org1, `select buy_guarantee($1)`, [J.barman]);
  const g = (await db.admin(`select id from guarantees where job_id = $1`, [J.barman]))[0].id;
  await db.as(U.org1, `select invite_reserve($1,$2)`, [g, U.luca]);
  for (const w of [U.marco, U.nina]) {
    const off = (await db.admin(`select id from offers where worker_id = $1 and job_id = $2`, [w, J.barman]))[0].id;
    await db.as(w, `select respond_offer($1,true)`, [off]);
  }
  const loff = (await db.admin(`select id from offers where worker_id = $1 and kind = 'riserva'`, [U.luca]))[0].id;
  await db.as(U.luca, `select respond_offer($1,true)`, [loff]);
  // candidatura accettata (Hilda ha la verifica di base)
  await db.as(U.hilda, `select apply_to_job($1,'ciao',null)`, [J.hostess]);
  await db.as(U.org1, `select accept_application(id) from applications where seeker_id = $1`, [U.hilda]);
  // preferenze, blocchi, indisponibilità, note, verifica avviata
  await db.as(U.giulia, `select set_offer_preferences(4, false)`);
  await db.as(U.giulia, `select block_organizer($1)`, [U.org2]);
  await db.as(U.giulia, `insert into worker_unavailability (worker_id, from_at, to_at, note) values ($1, now() + interval '20 days', now() + interval '21 days', 'viaggio')`, [U.giulia]);
  await db.as(U.org1, `select set_worker_note($1,'preferito',null,'ottima')`, [U.nina]);
  await db.as(U.org1, `select set_worker_note($1,'da_evitare','puntualita','tardi')`, [U.nico]);
  await db.as(U.nina, `select start_verification()`);
  // link di canale e candidatura attribuita
  const code = (await db.as(U.org1, `select create_event_link($1,'Subito') as c`, [EV.gala]))[0].c;
  await db.as(U.giulia, `select apply_to_job($1,'dal link',$2)`, [J.tavoli, code]);
  // giorno dell'evento: check-in, conferma con confronto foto, check-out, conferma → paga registrata
  await db.startEvent(EV.gala);
  const sh = (await db.admin(`select id from shifts where worker_id = $1 and job_id = $2`, [U.marco, J.barman]))[0].id;
  const chk = (await db.as(U.marco, `select worker_check($1,'in',45,9,$2) as id`, [sh, `${U.marco}/s.jpg`]))[0].id;
  await db.as(U.org1, `select confirm_check_identity($1,'ok')`, [chk]);
  const out = (await db.as(U.marco, `select worker_check($1,'out',null,null,null) as id`, [sh]))[0].id;
  await db.as(U.org1, `select employer_confirm_check($1)`, [out]);
  // no-show segnalato per Nina: la riserva Luca subentra (genera sostituzione, registro e notifiche)
  await db.as(U.org1, `select report_no_show(id) from shifts where worker_id = $1 and job_id = $2`, [U.nina, J.barman]);
  // una "non corrisponde" per Hilda: segnalazione privata
  const hs = (await db.admin(`select id from shifts where worker_id = $1 and job_id = $2`, [U.hilda, J.hostess]))[0].id;
  const hchk = (await db.as(U.hilda, `select worker_check($1,'in',45,9,$2) as id`, [hs, `${U.hilda}/s.jpg`]))[0].id;
  await db.as(U.org1, `select confirm_check_identity($1,'non_corrisponde','prova')`, [hchk]);
  // giudizio di Marco sull'organizzatore (evento finito)
  await db.advance(10 * 3600);
  await db.as(U.marco, `select review_organizer($1,4,4,4,'puntuale','bene')`, [sh]);
  return { db, ids, code, sh, g };
}
