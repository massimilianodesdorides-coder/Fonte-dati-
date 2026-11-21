-- =====================================================================
-- UTENTI DI PROVA: SOLO PER GLI AMBIENTI DI TEST, MAI IN PRODUZIONE
--
-- Crea lavoratori finti con storie diverse (turni fatti, no-show, ritardi,
-- disponibilità come riserva, qualcuno già verificato) per riempire le classifiche.
-- Non hanno password: non possono accedere. Per provare l'app "da dentro" registra
-- a mano due o tre account veri (organizzatore e lavoratore).
--
-- Si esegue DOPO tutti gli schemi (anche 2g):
--   select public.test_generate_workers(30);                -- 30 lavoratori a Milano
--   select public.test_generate_workers(20, 'Roma', 50);    -- 20 a Roma, metà verificati
--   select public.test_purge();                              -- toglie tutti gli utenti di prova
-- Le email di prova finiscono tutte con @test.invalid.
-- =====================================================================

create or replace function public.test_generate_workers(p_count int default 20,
                                                        p_city text default 'Milano',
                                                        p_verified_pct int default 30)
returns int
language plpgsql security definer set search_path = public as $$
declare
  firsts text[] := array['Luca','Marta','Paolo','Sara','Giorgio','Elena','Davide','Chiara','Matteo','Francesca','Andrea','Valentina','Simone','Alice','Federico','Giulia','Stefano','Martina','Alessio','Silvia'];
  lasts  text[] := array['Rossi','Bianchi','Ferrari','Esposito','Romano','Colombo','Ricci','Marino','Greco','Bruno','Gallo','Conti','De Luca','Costa','Fontana','Caruso','Mancini','Rizzo','Lombardi','Moretti'];
  all_roles text[] := array['barman','hostess_steward','servizio_tavoli'];
  bios text[] := array['Esperienza in locali e catering.','Disponibile nei weekend e la sera.','Lavoro volentieri a eventi aziendali e fiere.','Preciso e puntuale, anche inglese.','Prima esperienza ma tanta voglia di fare.','Ho lavorato a matrimoni e feste private.'];
  v_hist uuid; v_ev uuid; v_id uuid; v_name text; v_nroles int; v_k int; v_role text; v_my text[];
  v_made int := 0; i int; r text; v_ids uuid[] := '{}'; v_verified boolean;
begin
  -- organizzatore "storico" con molti turni passati, creato una sola volta
  select id into v_hist from auth.users where email = 'storico@test.invalid';
  if v_hist is null then
    insert into auth.users (id, email, raw_user_meta_data)
    values (gen_random_uuid(), 'storico@test.invalid', '{"role":"employer","full_name":"Storico di prova"}')
    returning id into v_hist;
    insert into public.events (organizer_id, name, city, event_date)
    values (v_hist, 'Eventi passati (prova)', p_city, current_date - 60) returning id into v_ev;
    insert into public.jobs (employer_id, company_name, title, description, city, event_id, role_code,
                             headcount, shift_pay_cents, starts_at, ends_at, is_open)
    select v_hist, 'Storico di prova', 'Turno passato ' || rc || ' ' || g, 'Turno concluso, solo per le statistiche.', p_city, v_ev, rc,
           500, 8000, now() - make_interval(days => 20 + g), now() - make_interval(days => 20 + g) + interval '5 hours', false
    from unnest(all_roles) rc, generate_series(1, 8) g;
  end if;

  for i in 1..p_count loop
    v_name := firsts[1 + floor(random() * array_length(firsts, 1))::int] || ' ' || lasts[1 + floor(random() * array_length(lasts, 1))::int];
    insert into auth.users (id, email, raw_user_meta_data)
    values (gen_random_uuid(), 'test-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10) || '@test.invalid',
            jsonb_build_object('role', 'seeker', 'full_name', v_name))
    returning id into v_id;
    v_ids := v_ids || v_id;
    v_verified := random() * 100 < p_verified_pct;
    update public.profiles
       set city = p_city, phone = '3' || (300000000 + floor(random() * 99999999)::int)::text,
           bio = bios[1 + floor(random() * array_length(bios, 1))::int], discoverable = true,
           verified_until = case when v_verified then now() + interval '12 months' end,
           verification_level = case when v_verified then 'forte' end
     where id = v_id;

    -- 1 o 2 ruoli
    v_nroles := 1 + (random() < 0.4)::int;
    v_my := (select array_agg(x) from (select x from unnest(all_roles) x order by random() limit v_nroles) q);
    foreach r in array v_my loop
      insert into public.worker_roles (worker_id, role_code) values (v_id, r);
      if random() < 0.7 then   -- disponibile come riserva nei prossimi 30 giorni
        insert into public.standby_availability (worker_id, role_code, city, from_at, to_at)
        values (v_id, r, p_city, now(), now() + interval '30 days');
      end if;
      -- esperienza: da 0 a 6 turni passati in quel ruolo (più spesso pochi)
      v_k := floor(power(random(), 2) * 7)::int;
      insert into public.shifts (job_id, worker_id, status)
      select j.id, v_id, 'completato' from public.jobs j
       where j.employer_id = v_hist and j.role_code = r order by random() limit v_k;
    end loop;
    if random() < 0.15 then insert into public.trust_events (user_id, kind) values (v_id, 'no_show'); end if;
    if random() < 0.25 then insert into public.trust_events (user_id, kind) values (v_id, 'ritardo'); end if;

    if to_regclass('public.demo_users') is not null then
      execute 'insert into public.demo_users (id, label, descr, ord) values ($1, $2, $3, $4)'
        using v_id, v_name, array_to_string(v_my, ', ') || case when v_verified then ' · verificato' else '' end, 100 + i;
    end if;
    v_made := v_made + 1;
  end loop;

  delete from public.notifications where user_id = any(v_ids) or user_id = v_hist;   -- niente rumore
  return v_made;
end $$;

create or replace function public.test_purge() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from auth.users where email like '%@test.invalid';
  get diagnostics n = row_count;
  if to_regclass('public.demo_users') is not null then
    execute 'delete from public.demo_users where ord >= 100';
  end if;
  return n;
end $$;

revoke all on function public.test_generate_workers(int, text, int), public.test_purge() from public, anon, authenticated;
