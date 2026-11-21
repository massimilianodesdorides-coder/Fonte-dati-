-- Dati di esempio SOLO per la demo (nome, storie e date sono inventati)

create table public.demo_users (id uuid primary key, label text, descr text, ord int);
grant select on public.demo_users to authenticated, anon;

insert into auth.users (id, email, raw_user_meta_data) values
 ('a0000000-0000-4000-8000-000000000001', 'org@demo.it',     '{"role":"employer","full_name":"Evento Srl"}'),
 ('a0000000-0000-4000-8000-000000000002', 'agenzia@demo.it', '{"role":"employer","full_name":"Agenzia Nuova"}'),
 ('b0000000-0000-4000-8000-000000000001', 'marco@demo.it',   '{"role":"seeker","full_name":"Marco Esperto"}'),
 ('b0000000-0000-4000-8000-000000000002', 'nina@demo.it',    '{"role":"seeker","full_name":"Nina Nuova"}'),
 ('b0000000-0000-4000-8000-000000000003', 'nico@demo.it',    '{"role":"seeker","full_name":"Nico Ritardatario"}'),
 ('b0000000-0000-4000-8000-000000000004', 'remo@demo.it',    '{"role":"seeker","full_name":"Remo Romano"}'),
 ('b0000000-0000-4000-8000-000000000005', 'hilda@demo.it',   '{"role":"seeker","full_name":"Hilda Hostess"}'),
 ('b0000000-0000-4000-8000-000000000006', 'giulia@demo.it',  '{"role":"seeker","full_name":"Giulia Garbata"}'),
 ('b0000000-0000-4000-8000-000000000007', 'luca@demo.it',    '{"role":"seeker","full_name":"Luca Libero"}'),
 ('b0000000-0000-4000-8000-000000000008', 'paolo@demo.it',   '{"role":"seeker","full_name":"Paolo Privato"}');

update profiles set city = 'Milano', phone = '333 100 2000' where role = 'employer';
update profiles set city = 'Milano', phone = '347 555 0101', discoverable = true where role = 'seeker';
update profiles set city = 'Roma' where full_name = 'Remo Romano';
update profiles set discoverable = false where full_name = 'Paolo Privato';
update profiles set bio = 'Barman da sei anni: cocktail, banco eventi e catering.' where full_name = 'Marco Esperto';
update profiles set bio = 'Appena diplomata alla scuola alberghiera, tanta voglia di imparare.' where full_name = 'Nina Nuova';
update profiles set bio = 'Barman con esperienza in locali e matrimoni.' where full_name = 'Nico Ritardatario';
update profiles set bio = 'Barman a Roma, disponibile a trasferte.' where full_name = 'Remo Romano';
update profiles set bio = 'Hostess e accoglienza per fiere e congressi, inglese e francese.' where full_name = 'Hilda Hostess';
update profiles set bio = 'Accoglienza e servizio ai tavoli, anche eventi aziendali.' where full_name = 'Giulia Garbata';
update profiles set bio = 'Barman e camerierie di sala, disponibile nei weekend.' where full_name = 'Luca Libero';
update profiles set bio = 'Barman, preferisco non comparire nelle ricerche.' where full_name = 'Paolo Privato';

insert into worker_roles (worker_id, role_code) values
 ('b0000000-0000-4000-8000-000000000001','barman'),
 ('b0000000-0000-4000-8000-000000000002','barman'),
 ('b0000000-0000-4000-8000-000000000003','barman'),
 ('b0000000-0000-4000-8000-000000000004','barman'),
 ('b0000000-0000-4000-8000-000000000005','hostess_steward'),
 ('b0000000-0000-4000-8000-000000000006','hostess_steward'),
 ('b0000000-0000-4000-8000-000000000006','servizio_tavoli'),
 ('b0000000-0000-4000-8000-000000000007','barman'),
 ('b0000000-0000-4000-8000-000000000007','servizio_tavoli'),
 ('b0000000-0000-4000-8000-000000000008','barman');

-- disponibilità come riserva, a Milano, nei prossimi 15 giorni
insert into standby_availability (worker_id, role_code, city, from_at, to_at)
select w, r, 'Milano', now(), now() + interval '15 days' from (values
 ('b0000000-0000-4000-8000-000000000001'::uuid,'barman'),
 ('b0000000-0000-4000-8000-000000000002'::uuid,'barman'),
 ('b0000000-0000-4000-8000-000000000003'::uuid,'barman'),
 ('b0000000-0000-4000-8000-000000000007'::uuid,'barman'),
 ('b0000000-0000-4000-8000-000000000005'::uuid,'hostess_steward'),
 ('b0000000-0000-4000-8000-000000000006'::uuid,'hostess_steward'),
 ('b0000000-0000-4000-8000-000000000006'::uuid,'servizio_tavoli'),
 ('b0000000-0000-4000-8000-000000000007'::uuid,'servizio_tavoli')) v(w, r);

-- STORIA: un evento passato di Evento Srl con cinque turni già svolti
insert into events (id, organizer_id, name, city, event_date)
values ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'Aperitivo di Primavera', 'Milano', current_date - 25);

insert into jobs (id, employer_id, company_name, title, description, city, event_id, role_code,
                  headcount, shift_pay_cents, starts_at, ends_at, is_open)
select ('c0000000-0000-4000-8000-00000000000' || g)::uuid, 'a0000000-0000-4000-8000-000000000001', 'Evento Srl',
       case when g <= 3 then 'Barman aperitivo ' || g else 'Hostess aperitivo ' || (g - 3) end,
       'Servizio del passato, già concluso.', 'Milano', 'e0000000-0000-4000-8000-000000000001',
       case when g <= 3 then 'barman' else 'hostess_steward' end, 3, 8000,
       now() - make_interval(days => 20 + g), now() - make_interval(days => 20 + g) + interval '5 hours', false
from generate_series(1, 5) g;

insert into shifts (id, job_id, worker_id, status) values
 ('d0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','completato'),
 ('d0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001','completato'),
 ('d0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000001','completato'),
 ('d0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000003','completato'),
 ('d0000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000003','completato'),
 ('d0000000-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000003','completato'),
 ('d0000000-0000-4000-8000-000000000007','c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000004','completato'),
 ('d0000000-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000004','b0000000-0000-4000-8000-000000000005','completato'),
 ('d0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000005','b0000000-0000-4000-8000-000000000005','completato'),
 ('d0000000-0000-4000-8000-00000000000a','c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000007','completato');

insert into trust_events (user_id, kind) values
 ('b0000000-0000-4000-8000-000000000003', 'no_show'),
 ('b0000000-0000-4000-8000-000000000003', 'ritardo');

-- tre giudizi su Evento Srl: l'organizzatore ha già un punteggio
insert into organizer_reviews (shift_id, worker_id, employer_id, pay_score, transparency_score, reliability_score, paid, comment) values
 ('d0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',5,5,5,'puntuale','Organizzazione chiara, pagato il giorno dopo.'),
 ('d0000000-0000-4000-8000-000000000005','b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001',4,4,4,'in_ritardo','Pagamento arrivato dopo tre settimane.'),
 ('d0000000-0000-4000-8000-000000000007','b0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001',5,4,5,'puntuale','');

-- EVENTI DA PROVARE
insert into events (id, organizer_id, name, city, event_date) values
 ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Gala Aziendale', 'Milano', current_date + 3),
 ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'Sagra di Quartiere', 'Milano', current_date + 5);

insert into jobs (id, employer_id, company_name, title, description, city, event_id, role_code,
                  headcount, shift_pay_cents, starts_at, ends_at) values
 ('c1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Evento Srl', 'Barman per il Gala',
  'Banco bar per cena di gala di 200 persone. Divisa nera fornita da noi.', 'Milano', 'e0000000-0000-4000-8000-000000000002', 'barman',
  2, 10000, date_trunc('day', now()) + interval '3 days 17 hours', date_trunc('day', now()) + interval '3 days 23 hours'),
 ('c1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Evento Srl', 'Hostess per il Gala',
  'Accoglienza ospiti e gestione ingressi. Richiesto inglese.', 'Milano', 'e0000000-0000-4000-8000-000000000002', 'hostess_steward',
  2, 9000, date_trunc('day', now()) + interval '3 days 16 hours', date_trunc('day', now()) + interval '3 days 23 hours'),
 ('c1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Evento Srl', 'Servizio ai tavoli per il Gala',
  'Servizio ai tavoli, tre portate.', 'Milano', 'e0000000-0000-4000-8000-000000000002', 'servizio_tavoli',
  3, 8000, date_trunc('day', now()) + interval '3 days 18 hours', date_trunc('day', now()) + interval '3 days 23 hours'),
 ('c1000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', 'Agenzia Nuova', 'Barman per la Sagra',
  'Banco bar alla sagra di quartiere, due giorni.', 'Milano', 'e0000000-0000-4000-8000-000000000003', 'barman',
  1, 8500, date_trunc('day', now()) + interval '5 days 15 hours', date_trunc('day', now()) + interval '5 days 22 hours');

insert into demo_users (id, label, descr, ord) values
 ('a0000000-0000-4000-8000-000000000001', 'Evento Srl', 'Organizzatore con 3 giudizi: gestisce il Gala', 1),
 ('a0000000-0000-4000-8000-000000000002', 'Agenzia Nuova', 'Organizzatore nuovo, senza giudizi', 2),
 ('b0000000-0000-4000-8000-000000000001', 'Marco Esperto', 'Barman con tre turni alle spalle', 3),
 ('b0000000-0000-4000-8000-000000000002', 'Nina Nuova', 'Barman alla prima esperienza', 4),
 ('b0000000-0000-4000-8000-000000000003', 'Nico Ritardatario', 'Barman con un no-show e un ritardo', 5),
 ('b0000000-0000-4000-8000-000000000005', 'Hilda Hostess', 'Hostess con due eventi fatti', 6),
 ('b0000000-0000-4000-8000-000000000006', 'Giulia Garbata', 'Hostess e servizio ai tavoli', 7),
 ('b0000000-0000-4000-8000-000000000007', 'Luca Libero', 'Barman e sala', 8);

-- bollino di identità: alcuni lavoratori sono già verificati; il ruolo di hostess del Gala lo richiede
update profiles set verified_until = now() + interval '12 months', verification_level = 'forte'
 where full_name in ('Marco Esperto', 'Hilda Hostess', 'Luca Libero');
update jobs set require_verified = true where id = 'c1000000-0000-4000-8000-000000000002';

delete from notifications;
