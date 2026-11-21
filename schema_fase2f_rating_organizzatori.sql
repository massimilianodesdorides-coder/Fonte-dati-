-- =====================================================================
-- FASE 2f: rating degli organizzatori, annullamenti, preferenze dei lavoratori
--
-- Da eseguire DOPO schema.sql, fase2, 2b, 2c, 2d, 2e.
--
-- GIUDIZI
--  * Solo chi ha lavorato davvero a un evento (turno confermato o completato,
--    evento finito da meno di 30 giorni) può giudicare l'organizzatore, una volta
--    per turno. Si può correggere il proprio giudizio entro quella finestra.
--  * Tre voti da 1 a 5: pagamenti, trasparenza, rispetto degli accordi
--    (annullamenti compresi), più "come sei stato pagato" (puntuale / in ritardo /
--    non pagato / non ancora) e un commento breve.
--  * L'organizzatore NON vede chi ha scritto cosa: solo medie e commenti anonimi,
--    e solo quando i giudizi sono almeno 3.
--
-- PUNTEGGIO ORGANIZZATORE (1-5)
--  * media ponderata: pochi giudizi pesano meno, per non gonfiare i primi voti
--    (5 giudizi "virtuali" a 3,5);
--  * -0,3 per ogni annullamento tardivo (meno di 48 ore) negli ultimi 12 mesi, max -1,5;
--  * sotto i 3 giudizi l'organizzatore risulta "nuovo" e non ha un punteggio.
--
-- PREFERENZE DEL LAVORATORE
--  * soglia minima di rating (e se accettare anche organizzatori nuovi): chi non
--    rispetta la soglia non gli manda proposte; il lavoratore sparisce dalle sue ricerche;
--  * blocco di un organizzatore specifico: nessuna ulteriore proposta.
--  Chi si è candidato di sua iniziativa a un annuncio non viene escluso dalla soglia.
--  L'organizzatore non viene avvisato di soglie e blocchi.
-- =====================================================================

alter table public.platform_settings
  add column late_cancel_hours     int     not null default 48,
  add column organizer_prior_n     int     not null default 5,
  add column organizer_prior_mean  numeric not null default 3.5,
  add column min_reviews_to_show   int     not null default 3,
  add column late_cancel_penalty   numeric not null default 0.3;

-- 1) TABELLE ------------------------------------------------------------------

create table public.organizer_reviews (
  id                 uuid primary key default gen_random_uuid(),
  shift_id           uuid not null unique references public.shifts(id) on delete cascade,
  worker_id          uuid not null references public.profiles(id) on delete cascade,
  employer_id        uuid not null references public.profiles(id) on delete cascade,
  pay_score          int not null check (pay_score between 1 and 5),
  transparency_score int not null check (transparency_score between 1 and 5),
  reliability_score  int not null check (reliability_score between 1 and 5),
  overall            numeric generated always as
                       ((pay_score + transparency_score + reliability_score) / 3.0) stored,
  paid               text not null check (paid in ('puntuale','in_ritardo','non_pagato','non_ancora')),
  comment            text not null default '' check (char_length(comment) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on public.organizer_reviews (employer_id);

create table public.organizer_events (
  id           uuid primary key default gen_random_uuid(),
  employer_id  uuid not null references public.profiles(id) on delete cascade,
  job_id       uuid references public.jobs(id) on delete set null,
  kind         text not null check (kind in ('annullamento')),
  hours_before numeric,
  late         boolean not null default false,
  reason       text not null default '' check (char_length(reason) <= 300),
  affected     int not null default 0,
  created_at   timestamptz not null default now()
);
create index on public.organizer_events (employer_id, created_at desc);

create table public.worker_blocks (
  worker_id   uuid not null references public.profiles(id) on delete cascade,
  employer_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (worker_id, employer_id)
);

create table public.worker_preferences (
  worker_id            uuid primary key references public.profiles(id) on delete cascade,
  min_organizer_rating numeric check (min_organizer_rating between 1 and 5),
  allow_new_organizers boolean not null default true,
  updated_at           timestamptz not null default now()
);

alter table public.organizer_reviews   enable row level security;
alter table public.organizer_events    enable row level security;
alter table public.worker_blocks       enable row level security;
alter table public.worker_preferences  enable row level security;
revoke all on public.organizer_reviews, public.organizer_events,
              public.worker_blocks, public.worker_preferences from anon, authenticated;

-- I giudizi li legge solo chi li ha scritti; l'organizzatore passa da funzioni anonimizzate
grant select on public.organizer_reviews to authenticated;
create policy "giudizi: i miei" on public.organizer_reviews
  for select to authenticated using (worker_id = auth.uid());
-- blocchi e preferenze: privati del lavoratore
grant select on public.worker_blocks, public.worker_preferences to authenticated;
create policy "blocchi: i miei" on public.worker_blocks
  for select to authenticated using (worker_id = auth.uid());
create policy "preferenze: le mie" on public.worker_preferences
  for select to authenticated using (worker_id = auth.uid());

-- 2) PUNTEGGIO ORGANIZZATORE ----------------------------------------------------

create or replace function public.organizer_summary(p_employer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_s public.platform_settings; n int; v_avg numeric; a_pay numeric; a_tr numeric; a_rel numeric;
        v_pct numeric; v_late int; v_done int; v_bayes numeric; v_final numeric;
begin
  select * into v_s from public.platform_settings;
  select count(*), coalesce(avg(overall), 0), avg(pay_score), avg(transparency_score), avg(reliability_score),
         case when count(*) filter (where paid in ('puntuale','in_ritardo','non_pagato')) = 0 then null
              else round(100.0 * count(*) filter (where paid = 'puntuale')
                         / count(*) filter (where paid in ('puntuale','in_ritardo','non_pagato')), 0) end
    into n, v_avg, a_pay, a_tr, a_rel, v_pct
    from public.organizer_reviews where employer_id = p_employer;
  select count(*) into v_late from public.organizer_events
   where employer_id = p_employer and late and created_at > now() - interval '12 months';
  select count(distinct j.event_id) into v_done
    from public.jobs j join public.shifts s on s.job_id = j.id
   where j.employer_id = p_employer and s.status = 'completato';

  if n < v_s.min_reviews_to_show then
    return jsonb_build_object('n', n, 'overall', null, 'nuovo', true,
                              'annullamenti_tardivi_12m', v_late, 'eventi_completati', v_done);
  end if;
  v_bayes := (v_avg * n + v_s.organizer_prior_n * v_s.organizer_prior_mean) / (n + v_s.organizer_prior_n);
  v_final := greatest(1, v_bayes - least(v_s.late_cancel_penalty * v_late, 1.5));
  return jsonb_build_object(
    'n', n, 'nuovo', false, 'overall', round(v_final, 1),
    'pagamenti', round(a_pay, 1), 'trasparenza', round(a_tr, 1), 'affidabilita', round(a_rel, 1),
    'pagato_puntuale_pct', v_pct, 'annullamenti_tardivi_12m', v_late, 'eventi_completati', v_done);
end $$;

-- Sostituisce l'aggancio della Fase 2b: blocchi e soglie dei lavoratori
create or replace function public.worker_allows_offers_from(p_worker uuid, p_employer uuid, p_applied boolean)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_pref public.worker_preferences; v_rating numeric;
begin
  if exists (select 1 from public.worker_blocks where worker_id = p_worker and employer_id = p_employer) then
    return false;
  end if;
  if p_applied then return true; end if;          -- si è candidato di sua iniziativa
  select * into v_pref from public.worker_preferences where worker_id = p_worker;
  if not found then return true; end if;
  v_rating := nullif(public.organizer_summary(p_employer)->>'overall', '')::numeric;
  if v_rating is null then return v_pref.allow_new_organizers; end if;
  return v_pref.min_organizer_rating is null or v_rating >= v_pref.min_organizer_rating;
end $$;

-- Scheda pubblica dell'organizzatore, consultabile da chi è registrato
create function public.organizer_profile(p_employer uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.organizer_summary(p_employer) || jsonb_build_object(
           'azienda', (select j.company_name from public.jobs j where j.employer_id = p_employer
                       order by j.created_at desc limit 1))
  where auth.uid() is not null
$$;

-- 3) GIUDIZI -------------------------------------------------------------------

create function public.review_organizer(p_shift uuid, p_pay int, p_transparency int, p_reliability int,
                                        p_paid text, p_comment text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_sh public.shifts; v_j public.jobs; v_id uuid;
begin
  if p_pay not between 1 and 5 or p_transparency not between 1 and 5 or p_reliability not between 1 and 5 then
    raise exception 'i voti vanno da 1 a 5';
  end if;
  if p_paid not in ('puntuale','in_ritardo','non_pagato','non_ancora') then
    raise exception 'indica come sei stato pagato';
  end if;
  select * into v_sh from public.shifts where id = p_shift and worker_id = auth.uid();
  if not found then raise exception 'turno non trovato'; end if;
  select * into v_j from public.jobs where id = v_sh.job_id;
  if v_sh.status not in ('confermato','completato') then
    raise exception 'puoi giudicare solo un evento a cui hai partecipato';
  end if;
  if v_j.ends_at > now() then raise exception 'puoi giudicare dopo la fine dell''evento'; end if;
  if v_j.ends_at < now() - interval '30 days' then raise exception 'il tempo per giudicare è scaduto'; end if;
  insert into public.organizer_reviews (shift_id, worker_id, employer_id, pay_score, transparency_score,
                                        reliability_score, paid, comment)
  values (p_shift, auth.uid(), v_j.employer_id, p_pay, p_transparency, p_reliability, p_paid, coalesce(p_comment, ''))
  on conflict (shift_id) do update
    set pay_score = excluded.pay_score, transparency_score = excluded.transparency_score,
        reliability_score = excluded.reliability_score, paid = excluded.paid,
        comment = excluded.comment, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- L'organizzatore vede il proprio riepilogo e commenti ANONIMI (solo con almeno 3 giudizi)
create function public.my_organizer_feedback() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sum jsonb; v_s public.platform_settings;
begin
  if public.my_role() is distinct from 'employer' then raise exception 'solo gli organizzatori'; end if;
  select * into v_s from public.platform_settings;
  v_sum := public.organizer_summary(auth.uid());
  return jsonb_build_object('riepilogo', v_sum,
    'commenti', case when (v_sum->>'n')::int < v_s.min_reviews_to_show then '[]'::jsonb else
      coalesce((select jsonb_agg(jsonb_build_object('testo', r.comment,
                                                    'mese', to_char(r.created_at, 'YYYY-MM'),
                                                    'pagato', r.paid)
                                 order by r.created_at desc)
                from public.organizer_reviews r
                where r.employer_id = auth.uid() and r.comment <> ''), '[]'::jsonb) end);
end $$;

-- 4) ANNULLAMENTO DI UN ANNUNCIO --------------------------------------------------

-- Annulla un ruolo prima dell'inizio: libera lavoratori e riserve, avvisa tutti e
-- registra l'annullamento (tardivo se mancano meno di late_cancel_hours ore)
create function public.cancel_job(p_job uuid, p_reason text default '') returns int
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_s public.platform_settings; v_hours numeric; v_late boolean;
        r record; n int := 0;
begin
  select * into v_j from public.jobs where id = p_job and employer_id = auth.uid() for update;
  if not found then raise exception 'annuncio non trovato'; end if;
  if v_j.starts_at is not null and v_j.starts_at <= now() then
    raise exception 'il turno è già iniziato: gestiscilo dalla scheda evento';
  end if;
  select * into v_s from public.platform_settings;
  v_hours := case when v_j.starts_at is null then null
                  else round(extract(epoch from (v_j.starts_at - now())) / 3600, 1) end;
  v_late := v_hours is not null and v_hours < v_s.late_cancel_hours;

  for r in
    with u as (update public.shifts set status = 'annullato'
               where job_id = p_job and status in ('assegnato','confermato') returning worker_id)
    select * from u
  loop
    perform public._notify(r.worker_id, 'turno_annullato', 'Turno annullato',
      v_j.title || ': l''organizzatore ha annullato.'
        || case when v_late then ' Annullamento a meno di ' || v_s.late_cancel_hours || ' ore dall''inizio.' else '' end
        || case when coalesce(p_reason, '') <> '' then ' Motivo: ' || p_reason else '' end,
      p_job, jsonb_build_object('tardivo', v_late));
    n := n + 1;
  end loop;
  for r in
    with u as (update public.standby_assignments set status = 'liberata', updated_at = now()
               where job_id = p_job and status = 'riservata' returning worker_id)
    select * from u
  loop
    perform public._notify(r.worker_id, 'riserva_annullata', 'Riserva annullata',
      v_j.title || ': l''evento è stato annullato, non devi più restare a disposizione.', p_job, '{}');
  end loop;
  update public.offers set status = 'ritirata', responded_at = now() where job_id = p_job and status = 'inviata';
  update public.guarantees set status = 'chiusa' where job_id = p_job and status in ('aperta','coperta');
  update public.jobs set is_open = false, auto_select = false where id = p_job;

  insert into public.organizer_events (employer_id, job_id, kind, hours_before, late, reason, affected)
  values (auth.uid(), p_job, 'annullamento', v_hours, v_late, left(coalesce(p_reason, ''), 300), n);
  return n;
end $$;

-- 5) PREFERENZE E BLOCCHI DEL LAVORATORE ---------------------------------------------

create function public.set_offer_preferences(p_min_rating numeric default null,
                                             p_allow_new boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'seeker' then raise exception 'solo chi cerca lavoro'; end if;
  insert into public.worker_preferences (worker_id, min_organizer_rating, allow_new_organizers)
  values (auth.uid(), p_min_rating, coalesce(p_allow_new, true))
  on conflict (worker_id) do update
    set min_organizer_rating = excluded.min_organizer_rating,
        allow_new_organizers = excluded.allow_new_organizers, updated_at = now();
end $$;

-- Blocca un organizzatore: nessuna ulteriore proposta; le proposte in attesa vengono rifiutate
create function public.block_organizer(p_employer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if public.my_role() is distinct from 'seeker' then raise exception 'solo chi cerca lavoro'; end if;
  if not exists (select 1 from public.profiles where id = p_employer and role = 'employer') then
    raise exception 'organizzatore non trovato';
  end if;
  insert into public.worker_blocks (worker_id, employer_id) values (auth.uid(), p_employer)
  on conflict do nothing;
  for r in
    with u as (update public.offers o set status = 'rifiutata', responded_at = now()
               from public.jobs j
               where o.job_id = j.id and j.employer_id = p_employer
                 and o.worker_id = auth.uid() and o.status = 'inviata'
               returning o.job_id)
    select distinct job_id from u
  loop
    perform public.check_coverage(r.job_id);      -- se è automatico, passa al successivo
  end loop;
end $$;

create function public.unblock_organizer(p_employer uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.worker_blocks where worker_id = auth.uid() and employer_id = p_employer
$$;

create function public.my_blocks() returns table (employer_id uuid, azienda text, blocked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.employer_id,
         (select j.company_name from public.jobs j where j.employer_id = b.employer_id
          order by j.created_at desc limit 1),
         b.created_at
  from public.worker_blocks b where b.worker_id = auth.uid() order by b.created_at desc
$$;

-- 6) PERMESSI ----------------------------------------------------------------------

revoke all on function public.organizer_profile(uuid), public.review_organizer(uuid, int, int, int, text, text),
  public.my_organizer_feedback(), public.cancel_job(uuid, text),
  public.set_offer_preferences(numeric, boolean), public.block_organizer(uuid),
  public.unblock_organizer(uuid), public.my_blocks(),
  public.organizer_summary(uuid), public.worker_allows_offers_from(uuid, uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.organizer_profile(uuid), public.review_organizer(uuid, int, int, int, text, text),
  public.my_organizer_feedback(), public.cancel_job(uuid, text),
  public.set_offer_preferences(numeric, boolean), public.block_organizer(uuid),
  public.unblock_organizer(uuid), public.my_blocks() to authenticated;
-- organizer_summary e worker_allows_offers_from restano interne (usate dalle altre funzioni)
