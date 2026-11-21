// Percorsi completi dell'interfaccia sulla demo (database vero nel browser).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, session, axe, makeCf, IDS } from './lib.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); await server.close(); });

const noErrors = s => assert.deepEqual(s.errors, [], 'errori nella console del browser');

test('avvio: elenco utenti demo e nessun errore', async () => {
  const s = await session(browser, server.url);
  const names = await s.page.$$eval('.card h3', e => e.map(x => x.textContent));
  assert.deepEqual(names.slice(0, 3), ['Evento Srl', 'Agenzia Nuova', 'Marco Esperto']);
  noErrors(s); await s.close();
});

test('organizzatore → lavoratore: candidati consigliati, invito, accettazione, riserva', async () => {
  const s = await session(browser, server.url);
  await s.enter(IDS.org1); await s.openGala();
  await s.role('Barman per il Gala').locator('text=Candidati consigliati').click();
  await s.page.waitForSelector('.score');
  const names = await s.page.$$eval('.card.flat b', e => e.map(x => x.textContent));
  assert.equal(names[0], 'Marco E.', 'il più adatto è in cima');
  assert.ok(!names.includes('Paolo P.'), 'chi non è visibile non compare');
  for (const n of ['Marco E.', 'Nina N.']) { await s.role('Barman per il Gala').locator(`.card.flat:has(b:has-text("${n}")) >> text=Invita`).first().click(); await s.wait(); }
  await s.role('Barman per il Gala').locator('text=Aggiungi garanzia no-show').click(); await s.submit();
  assert.match(await s.toast(), /Garanzia aggiunta/);
  await s.role('Barman per il Gala').locator('.card.flat:has(b:has-text("Luca L.")) >> text=Invita come riserva').click();
  assert.match(await s.toast(), /riserva inviata/);
  await s.as(IDS.marco);
  await s.page.click('.card:has-text("Barman per il Gala") >> button:text-is("Accetta")');
  assert.match(await s.toast(), /calendario/);
  await s.as(IDS.luca);
  await s.page.click('.card:has-text("Riserva") >> button:text-is("Accetta")');
  assert.match(await s.toast(), /calendario/);
  await s.tab('Calendario');
  assert.ok((await s.page.textContent('.tl')).includes('Barman per il Gala'));
  noErrors(s); await s.close();
});

test('giorno dell\'evento: check-in, confronto foto/selfie, no-show e riserva che subentra', async () => {
  const s = await session(browser, server.url);
  // prepara: Marco e Nina assegnati, Luca riserva
  await s.enter(IDS.org1); await s.openGala();
  await s.role('Barman per il Gala').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score');
  for (const n of ['Marco E.', 'Nina N.']) { await s.role('Barman per il Gala').locator(`.card.flat:has(b:has-text("${n}")) >> text=Invita`).first().click(); await s.wait(); }
  await s.role('Barman per il Gala').locator('text=Aggiungi garanzia no-show').click(); await s.submit();
  await s.role('Barman per il Gala').locator('.card.flat:has(b:has-text("Luca L.")) >> text=Invita come riserva').click(); await s.wait();
  for (const id of [IDS.marco, IDS.nina]) { await s.as(id); await s.page.click('.card:has-text("Barman per il Gala") >> button:text-is("Accetta")'); await s.wait(); }
  await s.as(IDS.luca); await s.page.click('.card:has-text("Riserva") >> button:text-is("Accetta")'); await s.wait();
  // l'evento inizia; Marco fa il check-in
  await s.tool('start');
  await s.as(IDS.marco); await s.tab('Calendario');
  await s.page.click('text=Check-in con selfie'); await s.submit();
  assert.match(await s.toast(), /Check-in inviato/);
  // l'organizzatore confronta e conferma; segnala il no-show di Nina
  await s.as(IDS.org1); await s.openGala(); await s.page.click('[data-act=evtab][data-v=presenze]'); await s.page.waitForSelector('text=Confronta la persona');
  assert.equal(await s.page.$$eval('img.avatar', e => e.length), 2, 'foto del profilo e selfie affiancati');
  await s.page.click('[data-o=ok]'); assert.match(await s.toast(), /corrisponde/);
  await s.page.locator('.card:has(b:has-text("Nina Nuova")) >> text=Segnala no-show').click(); await s.page.click('.sheet button.bad');
  assert.match(await s.toast(), /riserva è stata attivata/);
  assert.ok((await s.page.textContent('body')).includes('Sostituta'));
  await s.as(IDS.luca); await s.page.click('.bell'); await s.page.waitForSelector('.card');
  assert.ok((await s.page.textContent('body')).includes('Sei stata attivata come sostituta'));
  noErrors(s); await s.close();
});

test('"Non corrisponde": il check-in resta non confermato e la persona viene avvisata', async () => {
  const s = await session(browser, server.url);
  await s.enter(IDS.org1); await s.openGala();
  await s.role('Barman per il Gala').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score');
  await s.role('Barman per il Gala').locator('.card.flat:has(b:has-text("Marco E.")) >> text=Invita').first().click(); await s.wait();
  await s.as(IDS.marco); await s.page.click('.card:has-text("Barman per il Gala") >> button:text-is("Accetta")'); await s.wait();
  await s.tool('start'); await s.tab('Calendario'); await s.page.click('text=Check-in con selfie'); await s.submit();
  await s.as(IDS.org1); await s.openGala(); await s.page.click('[data-act=evtab][data-v=presenze]'); await s.page.waitForSelector('text=Confronta la persona');
  await s.page.click('[data-o=non_corrisponde]'); await s.page.fill('#m_n', 'persona diversa'); await s.page.click('.sheet button.bad'); await s.wait();
  assert.ok((await s.page.textContent('body')).includes('Segnalato: in verifica'));
  assert.equal(await s.page.locator('[data-o=ok]').count(), 0, 'non si può più confermare');
  await s.as(IDS.marco); await s.page.click('.bell'); await s.page.waitForSelector('.card');
  assert.ok((await s.page.textContent('body')).includes('Controllo sulla tua foto'));
  noErrors(s); await s.close();
});

test('requisito "verifica di base": accettando parte la verifica guidata (SMS + codice fiscale)', async () => {
  const s = await session(browser, server.url);
  await s.enter(IDS.org1); await s.openGala();
  await s.role('Hostess per il Gala').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score');
  assert.ok((await s.role('Hostess per il Gala').textContent()).includes('Richiede verifica di base'));
  await s.role('Hostess per il Gala').locator('.card.flat:has(b:has-text("Giulia G.")) >> text=Invita').click(); await s.wait();
  await s.as(IDS.giulia);
  assert.ok((await s.page.textContent('.card')).includes('Dovrai verificarti'));
  await s.page.click('.card:has-text("Hostess per il Gala") >> button:text-is("Accetta")');
  await s.page.waitForSelector('text=Verifica di base'); await s.submit();                       // introduzione
  await s.page.fill('#m_tel', '+39 347 1234567'); await s.submit();                              // telefono
  await s.page.fill('#m_c', '000000'); await s.submit();                                         // codice sbagliato
  assert.ok((await s.page.textContent('.sheet')).includes('Codice errato: riprova'), 'resta nella stessa schermata con il messaggio');
  await s.page.fill('#m_c', '123456'); await s.submit();                                         // secondo tentativo giusto
  await s.page.fill('#m_f', 'Giulia'); await s.page.fill('#m_l', 'Garbata'); await s.page.fill('#m_b', '1995-05-05');
  await s.page.fill('#m_c', 'ABCDEF12G34H567I'); await s.submit();                              // codice fiscale sbagliato
  assert.ok((await s.page.textContent('.sheet')).includes('Il codice non torna'));
  await s.page.click('[data-cancel]'); await s.wait();
  await s.page.click('.card:has-text("Hostess per il Gala") >> button:text-is("Accetta")');
  await s.page.waitForSelector('text=Verifica di base'); await s.submit();
  await s.page.fill('#m_f', 'Giulia'); await s.page.fill('#m_l', 'Garbata'); await s.page.fill('#m_b', '1995-05-05');
  await s.page.fill('#m_c', makeCf('Giulia', 'Garbata', 1995, 5, 5, true)); await s.submit();
  assert.match(await s.toast(), /calendario/);
  await s.tab('Profilo');
  assert.ok((await s.page.textContent('.card:has-text("Fiducia e verifiche")')).includes('Verifica di base'));
  noErrors(s); await s.close();
});

test('requisito "documento": la verifica di base non basta; il fornitore può rifiutare', async () => {
  const s = await session(browser, server.url);
  await s.enter(IDS.org2); await s.page.click('[data-act=openEvent]:has-text("Sagra")'); await s.page.waitForSelector('text=Barman per la Sagra');
  await s.role('Barman per la Sagra').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score');
  await s.role('Barman per la Sagra').locator('.card.flat:has(b:has-text("Luca L.")) >> text=Invita').first().click(); await s.wait();
  await s.as(IDS.luca);
  await s.page.click('.card:has-text("Barman per la Sagra") >> button:text-is("Accetta")');
  await s.page.waitForSelector('text=Certifica la tua identità'); await s.submit();
  await s.page.waitForSelector('text=Fornitore di identità'); await s.page.selectOption('#m_o', 'rifiutata'); await s.submit();
  assert.match(await s.toast(), /Senza la verifica richiesta|resta in attesa/);
  await s.page.click('.card:has-text("Barman per la Sagra") >> button:text-is("Accetta")');
  await s.page.waitForSelector('text=Certifica la tua identità'); await s.submit();
  await s.page.waitForSelector('text=Fornitore di identità'); await s.submit();
  assert.match(await s.toast(), /calendario/);
  noErrors(s); await s.close();
});

test('lavoratore: bacheca, candidatura, preferenze, indisponibilità e calendario', async () => {
  const s = await session(browser, server.url);
  await s.enter(IDS.hilda); await s.tab('Bacheca');
  await s.page.fill('#search', 'hostess'); await s.wait();
  assert.equal(await s.page.$$eval('#joblist h3', e => e.length), 1);
  await s.page.click('#joblist .card'); await s.page.waitForSelector('text=Candidati');
  await s.page.click('.btn.block'); await s.page.fill('#m_m', 'Disponibile'); await s.submit();
  assert.match(await s.toast(), /Candidatura inviata/);
  await s.tab('Profilo'); await s.page.selectOption('#minr', '4.5'); assert.match(await s.toast(), /Preferenze salvate/);
  await s.tab('Calendario'); await s.page.click('text=Non sono disponibile'); await s.submit();
  assert.match(await s.toast(), /Segnato/);
  assert.ok((await s.page.textContent('.tl.nd')).includes('Non disponibile'));
  await s.page.click('text=Esporta'); await s.page.waitForSelector('#icsbox');
  assert.match(await s.page.textContent('#icsbox'), /BEGIN:VCALENDAR/);
  noErrors(s); await s.close();
});

test('canali: link per canale, pagina pubblica, registrazione dal link e candidatura', async () => {
  const s = await session(browser, server.url);
  await s.enter(IDS.org1); await s.openGala(); await s.page.click('[data-act=evtab][data-v=canali]');
  await s.page.click('text=Nuovo canale'); await s.page.fill('#m_c', 'Facebook'); await s.submit();
  await s.page.click('text=Link e testo'); const code = /#e-([a-z0-9]+)/.exec(await s.page.textContent('#sharebox'))[1];
  await s.page.keyboard.press('Escape');
  await s.tab('Profilo'); await s.page.click('text=Esci'); await s.page.waitForSelector('.hero');
  await s.page.evaluate(c => { location.hash = 'e-' + c; }, code); await s.page.waitForSelector('text=Ruoli aperti');
  await s.page.click('text=Accedi per candidarti >> nth=0'); await s.page.waitForSelector('text=Crea il tuo account');
  await s.page.fill('#nm', 'Sara Nuova'); await s.page.fill('#ci', 'Milano'); await s.page.fill('#em', 'sara@test.it'); await s.page.fill('#pw', 'password123'); await s.page.check('#pr');
  await s.page.click('button[type=submit]'); await s.page.waitForSelector('text=Ruoli aperti');
  await s.page.click('.card:has-text("Servizio ai tavoli") >> text=Candidati'); await s.page.fill('#m_m', 'Ciao'); await s.submit();   // ruolo senza requisiti
  assert.match(await s.toast(), /Candidatura inviata/);
  await s.page.evaluate(() => { location.hash = ''; }); await s.as(IDS.org1); await s.openGala(); await s.page.click('[data-act=evtab][data-v=canali]'); await s.wait();
  const t = (await s.page.textContent('.card')).replace(/\s+/g, ' ');
  assert.match(t, /Nuovi iscritti 1.*Candidature 1/);
  noErrors(s); await s.close();
});

test('sicurezza: il testo inserito dagli utenti non esegue codice (XSS)', async () => {
  const s = await session(browser, server.url);
  await s.page.evaluate(() => { window.__xss = 0; });
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await s.page.click('text=Registrati');
  await s.page.click('[data-v=employer]'); await s.page.fill('#nm', evil); await s.page.fill('#ci', evil); await s.page.fill('#em', 'xss@test.it'); await s.page.fill('#pw', 'password123'); await s.page.check('#pr');
  await s.page.click('button[type=submit]'); await s.wait(1000);
  await s.page.click('text=Nuovo evento'); await s.page.fill('#m_n', evil); await s.page.fill('#m_c', 'Milano'); await s.submit(); await s.wait(800);
  await s.page.click('text=Aggiungi un ruolo'); await s.page.fill('#m_t', evil); await s.page.fill('#m_d', evil); await s.submit(); await s.wait(800);
  await s.tab('Profilo'); await s.tab('Eventi'); await s.wait();
  assert.equal(await s.page.evaluate(() => window.__xss), 0, 'nessun codice del testo inserito è stato eseguito');
  assert.ok((await s.page.textContent('body')).includes('<img src=x'), 'il testo compare in chiaro');
  await s.close();
});

test('accessibilità: nessuna violazione grave sulle schermate principali', async () => {
  const s = await session(browser, server.url);
  const found = {};
  const check = async name => { const v = await axe(s.page); if (v.length) found[name] = v; };
  await check('benvenuto');
  await s.enter(IDS.marco); await check('proposte'); await s.tab('Bacheca'); await check('bacheca'); await s.tab('Calendario'); await check('calendario'); await s.tab('Profilo'); await check('profilo');
  await s.as(IDS.org1); await check('eventi'); await s.openGala(); await check('scheda evento');
  await s.role('Barman per il Gala').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score'); await check('candidati');
  assert.deepEqual(found, {}, 'violazioni di accessibilità: ' + JSON.stringify(found, null, 1).slice(0, 1500));
  await s.close();
});

test('telefono stretto (360 px): nessuno scorrimento orizzontale', async () => {
  const s = await session(browser, server.url, { width: 360, height: 800 });
  const wide = [];
  const check = async name => { const w = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (w > 1) wide.push(`${name}: +${w}px`); };
  await check('benvenuto'); await s.enter(IDS.marco); await check('proposte'); await s.tab('Profilo'); await check('profilo'); await s.tab('Calendario'); await check('calendario');
  await s.as(IDS.org1); await s.openGala(); await check('scheda'); await s.role('Hostess per il Gala').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score'); await check('candidati');
  assert.deepEqual(wide, []); await s.close();
});

test('accessibilità: tema scuro senza violazioni gravi', async () => {
  const s = await session(browser, server.url);
  await s.page.emulateMedia({ colorScheme: 'dark' }); await s.wait(300);
  const found = {};
  const check = async name => { const v = await axe(s.page); if (v.length) found[name] = v; };
  await check('benvenuto'); await s.enter(IDS.marco); await check('proposte'); await s.tab('Profilo'); await check('profilo');
  await s.as(IDS.org1); await s.openGala(); await check('scheda evento');
  await s.role('Barman per il Gala').locator('text=Candidati consigliati').click(); await s.page.waitForSelector('.score'); await check('candidati');
  await s.page.click('text=Annulla il ruolo >> nth=0'); await s.page.waitForSelector('.sheet'); await check('finestra di dialogo');
  assert.deepEqual(found, {}, JSON.stringify(found, null, 1).slice(0, 1500)); await s.close();
});
