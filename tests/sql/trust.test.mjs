// Fiducia a livelli: codice fiscale, telefono, conferma sul campo, foto, requisiti dei ruoli.
import test from 'node:test';
import { newDb, U, J, EV, assert } from '../lib/db.mjs';

// ---- riferimento indipendente per il codice fiscale (scritto in JavaScript, non copiato dall'SQL) ----
const ODD = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };
const clean = s => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z]/g, '');
const cons = s => clean(s).replace(/[AEIOU]/g, ''), vow = s => clean(s).replace(/[^AEIOU]/g, '');
const surnameCode = s => (cons(s) + vow(s) + 'XXX').slice(0, 3);
const nameCode = s => { const c = cons(s); return c.length >= 4 ? c[0] + c[2] + c[3] : (c + vow(s) + 'XXX').slice(0, 3); };
function checksum(p) {
  let t = 0;
  [...p].forEach((ch, i) => { t += i % 2 === 0 ? ODD[ch] : (/\d/.test(ch) ? +ch : ch.charCodeAt(0) - 65); });
  return String.fromCharCode(65 + t % 26);
}
function makeCf(first, last, y, m, d, female, place = 'H501') {
  const body = surnameCode(last) + nameCode(first) + String(y).slice(-2) + 'ABCDEHLMPRST'[m - 1] + String(female ? d + 40 : d).padStart(2, '0') + place;
  return body + checksum(body);
}
const RNG = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

test('codice fiscale di esempio noto è valido', async () => {
  assert.equal(makeCf('Mario', 'Rossi', 1985, 12, 10, false, 'A562'), 'RSSMRA85T10A562S');   // esempio ufficiale diffuso
  const db = await newDb();
  const id = await db.newWorker('Mario Rossi');
  const r = (await db.as(id, `select verify_tax_code('Mario','Rossi','1985-12-10','RSSMRA85T10A562S') as r`))[0].r;
  assert.deepEqual(r, { ok: true, formato: true, controllo: true, cognome: true, nome: true, nascita: true });
});

test('proprietà: il controllo SQL coincide con il riferimento su 300 persone casuali', async () => {
  const db = await newDb({ seed: false });
  const rnd = RNG(42);
  const firsts = ['Mario', 'Anna', 'Giuseppe', 'Francesca', 'Luca', 'Elena', "Nicolò", 'Ginevra', 'Jo', 'Maria Luisa', 'Zoe', 'Alessandro'];
  const lasts = ['Rossi', 'De Luca', "D'Angelo", 'Bianchi', 'Esposito', 'Fo', 'Li', 'Müller', 'Dall\'Olio', 'Ricci', 'Gallo', 'Bruno'];
  for (let i = 0; i < 300; i++) {
    const f = firsts[Math.floor(rnd() * firsts.length)], l = lasts[Math.floor(rnd() * lasts.length)];
    const y = 1950 + Math.floor(rnd() * 55), m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28), fem = rnd() < 0.5;
    const cf = makeCf(f, l, y, m, d, fem);
    const sql = (await db.admin(`select public._cf_surname_code($1) as s, public._cf_name_code($2) as n, public._cf_checksum($3) as c`, [l, f, cf.slice(0, 15)]))[0];
    assert.equal(sql.s, cf.slice(0, 3), `cognome ${l}`); assert.equal(sql.n, cf.slice(3, 6), `nome ${f}`); assert.equal(sql.c, cf[15], `checksum ${cf}`);
  }
});

test('codice fiscale: errori tipici vengono scoperti e indicati', async () => {
  const db = await newDb();
  const id = await db.newWorker('Anna Verdi');
  const cf = makeCf('Anna', 'Verdi', 1990, 3, 15, true);
  const check = (first, last, birth, code) => db.as(id, `select verify_tax_code($1,$2,$3,$4) as r`, [first, last, birth, code]).then(r => r[0].r);
  assert.equal((await check('Anna', 'Verdi', '1990-03-15', cf)).ok, true, 'femmina: giorno +40');
  await db.admin('delete from worker_identity');
  assert.equal((await check('Anna', 'Neri', '1990-03-15', cf)).cognome, false, 'cognome diverso');
  assert.equal((await check('Anna', 'Verdi', '1990-03-16', cf)).nascita, false, 'giorno diverso');
  assert.equal((await check('Anna', 'Verdi', '1991-03-15', cf)).nascita, false, 'anno diverso');
  assert.equal((await check('Anna', 'Verdi', '1990-03-15', cf.slice(0, 15) + (cf[15] === 'A' ? 'B' : 'A'))).controllo, false, 'carattere di controllo');
  assert.equal((await check('Anna', 'Verdi', '1990-03-15', 'ABC')).formato, false, 'formato');
  assert.equal((await check('Anna', 'Verdi', '1990-03-15', '')).ok, false, 'vuoto');
  assert.equal((await db.admin('select count(*)::int as n from worker_identity'))[0].n, 0, 'nessun salvataggio se il controllo fallisce');
});

test('un codice fiscale può appartenere a un solo account', async () => {
  const db = await newDb();
  const a = await db.newWorker('Anna Verdi'), b = await db.newWorker('Anna Verdi');
  const cf = makeCf('Anna', 'Verdi', 1990, 3, 15, true);
  assert.equal((await db.as(a, `select verify_tax_code('Anna','Verdi','1990-03-15',$1) as r`, [cf]))[0].r.ok, true);
  await db.fails(b, `select verify_tax_code('Anna','Verdi','1990-03-15',$1)`, [cf], /già associato a un altro account/);
  // ripetere con lo stesso account è lecito
  assert.equal((await db.as(a, `select verify_tax_code('Anna','Verdi','1990-03-15',$1) as r`, [cf]))[0].r.ok, true);
});

test('la data di nascita non viene salvata e il codice fiscale è privato', async () => {
  const db = await newDb();
  const a = await db.newWorker('Anna Verdi'), emp = U.org1;
  await db.as(a, `select verify_tax_code('Anna','Verdi','1990-03-15',$1)`, [makeCf('Anna', 'Verdi', 1990, 3, 15, true)]);
  const cols = (await db.admin(`select column_name from information_schema.columns where table_name = 'worker_identity'`)).map(r => r.column_name);
  assert.deepEqual(cols.sort(), ['tax_code', 'tax_code_checked_at', 'worker_id']);
  assert.equal((await db.as(a, 'select count(*)::int as n from worker_identity'))[0].n, 1);
  await db.hidden(emp, 'select * from worker_identity');
  await db.hidden(null, 'select * from worker_identity');
  await db.fails(a, `update worker_identity set tax_code = 'X'`, [], /permission denied/);
});

test('livelli: nessuna → base (email+telefono+codice fiscale) → forte (documento)', async () => {
  const db = await newDb();
  const id = await db.newWorker('Livello Prova');
  await db.admin(`update auth.users set email_confirmed_at = null where id = $1`, [id]);
  const level = () => db.admin(`select verification_level($1) as l, trust_points($1) as p`, [id]).then(r => r[0]);
  assert.deepEqual(await level(), { l: 'nessuna', p: 0 });
  await db.admin(`update auth.users set email_confirmed_at = now(), phone = '+390000', phone_confirmed_at = now() where id = $1`, [id]);
  assert.deepEqual(await level(), { l: 'nessuna', p: 2 }, 'solo contatti: 2 punti');
  await db.as(id, `select verify_tax_code('Livello','Prova','1990-03-15',$1)`, [makeCf('Livello', 'Prova', 1990, 3, 15, false)]);
  assert.deepEqual(await level(), { l: 'base', p: 5 }, 'contatti + codice: livello base, 5 punti');
  await db.admin(`update profiles set verified_until = now() + interval '12 months' where id = $1`, [id]);
  assert.deepEqual(await level(), { l: 'forte', p: 10 });
  await db.admin(`update profiles set verified_until = now() - interval '1 day' where id = $1`, [id]);
  assert.equal((await level()).l, 'base', 'il documento scaduto fa tornare al livello base');
});

test('telefono non confermato: niente livello base anche con codice fiscale', async () => {
  const db = await newDb();
  const id = await db.newWorker('Senza Telefono');
  await db.as(id, `select verify_tax_code('Senza','Telefono','1990-03-15',$1)`, [makeCf('Senza', 'Telefono', 1990, 3, 15, false)]);
  assert.equal((await db.admin(`select verification_level($1) as l`, [id]))[0].l, 'nessuna');
});

test('requisito del ruolo: chi non ha il livello non può accettare, candidarsi né prendere slot', async () => {
  const db = await newDb();
  // il ruolo di hostess chiede la verifica di base; Giulia non ce l'ha, Hilda sì
  await db.as(U.org1, `select invite_worker($1,$2)`, [J.hostess, U.giulia]);
  const off = (await db.admin(`select id from offers where worker_id = $1`, [U.giulia]))[0].id;
  assert.equal(await db.val(U.giulia, `select respond_offer($1,true)`, [off]), 'serve_verifica');
  assert.equal((await db.admin(`select status from offers where id = $1`, [off]))[0].status, 'inviata', 'la proposta resta in attesa');
  await db.fails(U.giulia, `select apply_to_job($1,'',null)`, [J.hostess], /verific/);
  // diventa "base" e può accettare
  await db.admin(`update auth.users set phone = '+39111', phone_confirmed_at = now() where id = $1`, [U.giulia]);
  await db.as(U.giulia, `select verify_tax_code('Giulia','Garbata','1995-05-05',$1)`, [makeCf('Giulia', 'Garbata', 1995, 5, 5, true)]);
  assert.equal(await db.val(U.giulia, `select respond_offer($1,true)`, [off]), 'accettata');
});

test('requisito "forte": la verifica di base non basta', async () => {
  const db = await newDb();
  // la Sagra richiede il documento; Luca ha solo la verifica di base
  const off = await db.as(U.org2, `select invite_worker($1,$2) as id`, [J.sagra, U.luca]);
  assert.equal(await db.val(U.luca, `select respond_offer($1,true)`, [off[0].id]), 'serve_verifica');
  // Marco ha il documento
  const off2 = await db.as(U.org2, `select invite_worker($1,$2) as id`, [J.sagra, U.marco]);
  assert.equal(await db.val(U.marco, `select respond_offer($1,true)`, [off2[0].id]), 'accettata');
});

test('la classifica premia la fiducia e la mostra senza dati personali', async () => {
  const db = await newDb();
  const rows = await db.as(U.org1, `select display_name, score, breakdown, trust from match_workers($1)`, [J.barman]);
  const marco = rows.find(r => r.display_name === 'Marco E.'), nina = rows.find(r => r.display_name === 'Nina N.');
  assert.equal(marco.breakdown.fiducia, 10, 'documento = 10');
  assert.equal(marco.trust.livello, 'forte');
  assert.equal(nina.breakdown.fiducia, 2, 'Nina ha solo i contatti confermati');
  assert.deepEqual(Object.keys(marco.trust).sort(), ['codice_fiscale', 'conferme_sul_campo', 'email', 'foto', 'foto_segnalata', 'foto_valida', 'forte', 'livello', 'punti', 'telefono'].sort(), 'solo esiti, nessun numero o codice');
  const sum = r => r.breakdown.citta + r.breakdown.esperienza + r.breakdown.affidabilita + r.breakdown.interesse + r.breakdown.fiducia;
  rows.forEach(r => assert.equal(r.score, sum(r), `punteggio coerente per ${r.display_name}`));
  assert.ok(rows.every(r => r.score >= 0 && r.score <= 100));
});

// ---- conferma sul campo ----
async function setupCheckin(db, worker = U.marco) {
  // l'evento è iniziato; il lavoratore ha un turno e fa il check-in con selfie
  await db.as(U.org1, `select invite_worker($1,$2)`, [J.barman, worker]);
  const off = (await db.admin(`select id from offers where worker_id = $1 and job_id = $2`, [worker, J.barman]))[0].id;
  await db.as(worker, `select respond_offer($1,true)`, [off]);
  await db.startEvent(EV.gala);
  const sh = (await db.admin(`select id from shifts where worker_id = $1 and job_id = $2`, [worker, J.barman]))[0].id;
  const chk = await db.as(worker, `select worker_check($1,'in',45.4,9.1,$2) as id`, [sh, `${worker}/selfie.jpg`]);
  return { shift: sh, check: chk[0].id };
}

test('conferma sul campo "È la persona": conferma il check-in e riconferma la foto', async () => {
  const db = await newDb();
  const { shift, check } = await setupCheckin(db, U.nico);
  await db.admin(`update profiles set photo_flagged_at = now() - interval '1 day' where id = $1`, [U.nico]);
  await db.as(U.org1, `select confirm_check_identity($1,'ok')`, [check]);
  const p = (await db.admin(`select photo_checked_at is not null as c, photo_flagged_at is null as f from profiles where id = $1`, [U.nico]))[0];
  assert.deepEqual(p, { c: true, f: true });
  assert.equal((await db.admin(`select status from shifts where id = $1`, [shift]))[0].status, 'confermato');
  assert.equal((await db.admin(`select outcome from identity_confirmations where shift_id = $1`, [shift]))[0].outcome, 'ok');
});

test('"Foto datata": check-in confermato, la persona deve aggiornare la foto', async () => {
  const db = await newDb();
  const { shift, check } = await setupCheckin(db, U.marco);
  await db.as(U.org1, `select confirm_check_identity($1,'foto_datata','foto di dieci anni fa')`, [check]);
  assert.equal((await db.admin(`select status from shifts where id = $1`, [shift]))[0].status, 'confermato');
  assert.equal((await db.admin(`select trust_info($1)->>'foto_segnalata' as f`, [U.marco]))[0].f, 'true');
  assert.equal((await db.admin(`select count(*)::int as n from notifications where user_id = $1 and kind = 'foto_da_aggiornare'`, [U.marco]))[0].n, 1);
  // la conferma sul campo non conta finché la foto è segnalata
  assert.equal((await db.admin(`select trust_info($1)->>'foto_valida' as v`, [U.marco]))[0].v, 'false');
  // caricando una nuova foto la segnalazione si azzera
  await db.as(U.marco, `select set_profile_photo($1)`, [`${U.marco}/nuova.jpg`]);
  assert.equal((await db.admin(`select trust_info($1)->>'foto_segnalata' as f, trust_info($1)->>'foto_valida' as v`, [U.marco]))[0].f, 'false');
});

test('"Non corrisponde": il check-in NON viene confermato e nasce una segnalazione privata', async () => {
  const db = await newDb();
  const { shift, check } = await setupCheckin(db, U.marco);
  await db.as(U.org1, `select confirm_check_identity($1,'non_corrisponde','la persona è diversa dalla foto')`, [check]);
  assert.equal((await db.admin(`select status from shifts where id = $1`, [shift]))[0].status, 'assegnato');
  assert.equal((await db.admin(`select count(*)::int as n from identity_flags where worker_id = $1 and status = 'aperta'`, [U.marco]))[0].n, 1);
  await db.hidden(U.marco, 'select * from identity_flags');
  await db.hidden(U.org1, 'select * from identity_flags');
  await db.fails(U.org1, `select confirm_check_identity($1,'ok')`, [check], /già valutato/);
});

test('conferma sul campo: solo il datore del turno, una volta sola, esiti validi', async () => {
  const db = await newDb();
  const { check } = await setupCheckin(db, U.marco);
  await db.fails(U.org2, `select confirm_check_identity($1,'ok')`, [check], /non autorizzato/);
  await db.fails(U.marco, `select confirm_check_identity($1,'ok')`, [check], /non autorizzato/);
  await db.fails(U.org1, `select confirm_check_identity($1,'bravo')`, [check], /esito non valido/);
  await db.fails(U.org1, `select confirm_check_identity(gen_random_uuid(),'ok')`, [], /non trovato/);
  await db.as(U.org1, `select confirm_check_identity($1,'ok')`, [check]);
  await db.fails(U.org1, `select confirm_check_identity($1,'ok')`, [check], /già confermato/);
});

test('punti di fiducia da conferma sul campo: servono foto valida e almeno un organizzatore', async () => {
  const db = await newDb();
  const id = await db.newWorker('Campo Prova');
  const pts = () => db.admin(`select trust_points($1) as p`, [id]).then(r => r[0].p);
  assert.equal(await pts(), 0);
  await db.admin(`update profiles set photo_path = 'x/y.jpg', photo_set_at = now() - interval '1 month' where id = $1`, [id]);
  const sh = (await db.admin(`insert into shifts (job_id, worker_id, status) values ('c0000000-0000-4000-8000-000000000001', $1, 'completato') returning id`, [id]))[0].id;
  await db.admin(`insert into identity_confirmations (shift_id, worker_id, employer_id, outcome) values ($1, $2, $3, 'ok')`, [sh, id, U.org1]);
  assert.equal(await pts(), 5, 'conferma sul campo = 5');
  await db.admin(`update profiles set photo_set_at = now() - interval '13 months' where id = $1`, [id]);
  assert.equal(await pts(), 0, 'foto più vecchia di 12 mesi: non conta');
  await db.admin(`update profiles set photo_checked_at = now() where id = $1`, [id]);
  assert.equal(await pts(), 5, 'riconfermata di recente: conta di nuovo');
  await db.admin(`update auth.users set phone_confirmed_at = now() where id = $1`, [id]);
  await db.admin(`insert into worker_identity (worker_id, tax_code) values ($1, 'ZZZ')`, [id]);
  assert.equal(await pts(), 10, 'tetto a 10');
});

test('la foto del profilo la vede solo il proprietario e il datore con cui ha un turno', async () => {
  const db = await newDb();
  const { } = await setupCheckin(db, U.marco);
  // il datore del turno la vede nella scheda presenze
  const roster = await db.as(U.org1, `select worker_name, worker_photo from event_roster($1)`, [EV.gala]);
  assert.equal(roster.find(r => r.worker_name === 'Marco Esperto').worker_photo, `demo/${U.marco}.jpg`);
  // un altro organizzatore non vede nulla di quell'evento
  assert.equal((await db.as(U.org2, `select * from event_roster($1)`, [EV.gala])).length, 0);
  // il lavoratore vede la propria
  assert.equal((await db.as(U.marco, `select my_trust()->>'foto_path' as p`))[0].p, `demo/${U.marco}.jpg`);
  // la funzione interna non è chiamabile dai client, e i profili altrui non espongono la foto
  await db.fails(U.org1, `select profile_photo_of($1)`, [U.nico], /permission denied/);
  await db.hidden(U.org1, `select photo_path from profiles where id = $1`, [U.giulia]);   // mai lavorato insieme: invisibile
  await db.hidden(null, `select photo_path from profiles`);
});

test('set_profile_photo: solo nella propria cartella e solo per chi cerca lavoro', async () => {
  const db = await newDb();
  await db.fails(U.marco, `select set_profile_photo($1)`, [`${U.nico}/x.jpg`], /tua cartella/);
  await db.fails(U.marco, `select set_profile_photo(null)`, [], /tua cartella/);
  await db.fails(U.org1, `select set_profile_photo($1)`, [`${U.org1}/x.jpg`], /solo chi cerca lavoro/);
  await db.fails(U.marco, `update profiles set photo_path = 'x' where id = $1`, [U.marco], /permission denied/);
  await db.fails(U.marco, `update profiles set photo_checked_at = now() where id = $1`, [U.marco], /permission denied/);
});

test('un lavoratore non può autocertificarsi né chiudere la propria verifica', async () => {
  const db = await newDb();
  await db.fails(U.nina, `update profiles set verified_until = now() + interval '5 years' where id = $1`, [U.nina], /permission denied/);
  await db.fails(U.nina, `select complete_verification(gen_random_uuid(),'ok')`, [], /permission denied/);
  await db.fails(U.nina, `insert into worker_identity (worker_id, tax_code) values ($1,'X')`, [U.nina], /permission denied/);
  await db.fails(U.nina, `insert into identity_confirmations (shift_id, worker_id, employer_id, outcome) values (gen_random_uuid(), $1, $2, 'ok')`, [U.nina, U.org1], /permission denied/);
  await db.fails(U.nina, `update auth.users set phone_confirmed_at = now() where id = $1`, [U.nina], /permission denied/);
});
