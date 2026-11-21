-- =====================================================================
-- FASE 2: eventi, ruoli, garanzia anti no-show, riserve, turni,
--         check-in/out, registro eventi di affidabilità, registro contabile
--
-- Da eseguire nel SQL Editor di Supabase DOPO schema.sql (una sola volta).
--
-- REGOLE DI BUSINESS (modificabili in platform_settings):
--  * Un evento contiene più annunci, uno per ruolo (barman, hostess...).
--  * Ogni annuncio ha: persone richieste, paga per turno, orari.
--  * Garanzia no-show = una sostituzione prenotata per quel ruolo.
--    Prezzo per garanzia: 30% della paga del ruolo garantito
--      - 20% alla riserva  - 10% alla piattaforma
--  * Il 30% è dovuto SEMPRE se la garanzia è coperta da una riserva.
--  * Se la riserva viene attivata (no-show): prende la paga piena
--    (non il 20%); la piattaforma incassa comunque il 10%.
--  * Se nessuna riserva ha preso la garanzia, non si paga nulla.
--  * Tutte le scritture sensibili passano da funzioni: i client non
--    possono scrivere direttamente su turni, check-in, garanzie, ledger.
--
-- NOTE: nessun movimento di denaro reale. Il "ledger" registra solo chi
-- deve cosa a chi, per provare le regole prima di collegare pagamenti.
-- =====================================================================

-- 1) IMPOSTAZIONI E RUOLI -------------------------------------------------

create table public.platform_settings (
  id                      boolean primary key default true check (id),  -- una sola riga
  standby_fee_pct         int not null default 20 check (standby_fee_pct between 0 and 100),
  platform_fee_pct        int not null default 10 check (platform_fee_pct between 0 and 100),
  noshow_grace_min        int not null default 15,   -- minuti dopo l'inizio prima di poter segnalare no-show
  late_tolerance_min      int not null default 10,   -- ritardo tollerato senza penalità
  checkin_window_min      int not null default 60,   -- check-in consentito da X min prima dell'inizio
  replacement_arrival_min int not null default 45,   -- tempo concesso alla riserva per arrivare
  pool_ratio              int not null default 2     -- riserve disponibili richieste per ogni garanzia
);
insert into public.platform_settings default values;

create table public.job_roles (
  code  text primary key,
  label text not null
);
insert into public.job_roles (code, label) values
  ('barman',          'Barman'),
  ('hostess_steward', 'Hostess / Steward'),
  ('servizio_tavoli', 'Servizio ai tavoli'),
  ('altro',           'Altro');

-- 2) EVENTI E ANNUNCI PER RUOLO -------------------------------------------

create table public.events (
  id           uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  name         text not null check (char_length(name) between 3 and 120),
  city         text not null check (char_length(city) between 2 and 100),
  event_date   date not null,
  created_at   timestamptz not null default now()
);
create index on public.events (organizer_id);

alter table public.jobs
  add column event_id        uuid references public.events(id) on delete cascade,
  add column role_code       text references public.job_roles(code),
  add column headcount       int  not null default 1 check (headcount between 1 and 500),
  add column shift_pay_cents int  check (shift_pay_cents > 0),     -- paga per turno, in centesimi
  add column starts_at       timestamptz,
  add column ends_at         timestamptz,
  add constraint jobs_event_fields check (
    event_id is null
    or (role_code is not null and shift_pay_cents is not null
        and starts_at is not null and ends_at > starts_at)
  );
create index on public.jobs (event_id);

-- 3) RISERVE: competenze e disponibilità ----------------------------------

create table public.worker_roles (
  worker_id uuid not null references public.profiles(id) on delete cascade,
  role_code text not null references public.job_roles(code),
  primary key (worker_id, role_code)
);

create table public.standby_availability (
  id        uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete cascade,
  role_code text not null references public.job_roles(code),
  city      text not null check (char_length(city) between 2 and 100),
  from_at   timestamptz not null,
  to_at     timestamptz not null,
  check (to_at > from_at)
);
create index on public.standby_availability (role_code, from_at, to_at);

-- 4) GARANZIE, RISERVE ASSEGNATE, TURNI -----------------------------------

create table public.guarantees (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references public.jobs(id) on delete cascade,
  standby_fee_cents  int not null,          -- 20% della paga del ruolo
  platform_fee_cents int not null,          -- 10% della paga del ruolo
  status             text not null default 'aperta'
    check (status in ('aperta','coperta','attivata','chiusa','non_mantenuta')),
  created_at         timestamptz not null default now()
);
create index on public.guarantees (job_id);

create table public.standby_assignments (
  id           uuid primary key default gen_random_uuid(),
  guarantee_id uuid not null references public.guarantees(id) on delete cascade,
  job_id       uuid not null references public.jobs(id) on delete cascade,
  worker_id    uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'riservata'
    check (status in ('riservata','attivata','liberata','rinunciata')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- una sola riserva "viva" per garanzia, e una persona non occupa due garanzie dello stesso annuncio
create unique index standby_one_live_per_guarantee on public.standby_assignments (guarantee_id)
  where status in ('riservata','attivata');
create unique index standby_one_live_per_worker_job on public.standby_assignments (job_id, worker_id)
  where status in ('riservata','attivata');
create index on public.standby_assignments (worker_id);

create table public.shifts (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.jobs(id) on delete cascade,
  worker_id         uuid not null references public.profiles(id) on delete cascade,
  status            text not null default 'assegnato'
    check (status in ('assegnato','confermato','completato','no_show','annullato')),
  is_replacement    boolean not null default false,
  replaces_shift_id uuid references public.shifts(id) on delete set null,
  expected_by       timestamptz,        -- per le sostitute: entro quando devono arrivare
  created_at        timestamptz not null default now(),
  unique (job_id, worker_id)
);
create index on public.shifts (worker_id);

create table public.check_events (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null references public.shifts(id) on delete cascade,
  kind         text not null check (kind in ('in','out')),
  at           timestamptz not null default now(),     -- ora del SERVER, non del telefono
  lat          double precision check (lat between -90 and 90),
  lng          double precision check (lng between -180 and 180),
  selfie_path  text,                                   -- percorso nel bucket privato 'checkins'
  confirmed_at timestamptz,                            -- conferma del datore
  unique (shift_id, kind)
);

-- Registro eventi: il punteggio di affidabilità si calcola da qui (Fase 3)
create table public.trust_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  shift_id   uuid references public.shifts(id) on delete set null,
  kind       text not null check (kind in
               ('completato','ritardo','no_show','riserva_attivata','rinuncia_tardiva')),
  detail     int,                                      -- es. minuti di ritardo
  disputed   boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.trust_events (user_id, created_at desc);

-- Registro contabile: chi deve cosa a chi (payee null = piattaforma)
create table public.ledger (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid references public.jobs(id) on delete cascade,
  guarantee_id uuid references public.guarantees(id) on delete set null,
  shift_id     uuid references public.shifts(id) on delete set null,
  payer_id     uuid references public.profiles(id) on delete set null,
  payee_id     uuid references public.profiles(id) on delete set null,
  kind         text not null check (kind in
                 ('garanzia_riserva','garanzia_piattaforma','paga_turno')),
  amount_cents int not null check (amount_cents >= 0),
  created_at   timestamptz not null default now()
);
create index on public.ledger (payer_id);
create index on public.ledger (payee_id);

-- 5) FUNZIONI DI SUPPORTO (security definer: evitano ricorsioni nelle policy)

create or replace function public.my_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create function public.is_job_employer(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jobs where id = p_job and employer_id = auth.uid())
$$;

-- vero se l'utente ha un turno o una riserva viva su quell'annuncio
create function public.involved_in_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shifts s where s.job_id = p_job and s.worker_id = auth.uid())
      or exists (select 1 from public.standby_assignments a
                 where a.job_id = p_job and a.worker_id = auth.uid()
                   and a.status in ('riservata','attivata'))
$$;

-- vero se il lavoratore ha un turno su un annuncio del datore collegato
create function public.employer_of_worker(p_worker uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shifts s join public.jobs j on j.id = s.job_id
                 where s.worker_id = p_worker and j.employer_id = auth.uid())
$$;

-- il lavoratore è libero in quella fascia? (nessun turno né riserva sovrapposti)
create function public.worker_is_free(w uuid, s timestamptz, e timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
           select 1 from public.shifts sh join public.jobs j on j.id = sh.job_id
           where sh.worker_id = w and sh.status in ('assegnato','confermato')
             and tstzrange(j.starts_at, j.ends_at) && tstzrange(s, e))
     and not exists (
           select 1 from public.standby_assignments sa join public.jobs j on j.id = sa.job_id
           where sa.worker_id = w and sa.status in ('riservata','attivata')
             and tstzrange(j.starts_at, j.ends_at) && tstzrange(s, e))
$$;

-- quante riserve libere esistono per ruolo, città e fascia dell'annuncio
create function public.standby_pool_size(p_job uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(distinct a.worker_id)::int
  from public.jobs j
  join public.events e on e.id = j.event_id
  join public.standby_availability a
       on a.role_code = j.role_code and lower(a.city) = lower(e.city)
      and a.from_at <= j.starts_at and a.to_at >= j.ends_at
  join public.worker_roles r on r.worker_id = a.worker_id and r.role_code = j.role_code
  where j.id = p_job and j.employer_id = auth.uid()
    and public.worker_is_free(a.worker_id, j.starts_at, j.ends_at)
$$;

-- Punti di aggancio per la certificazione dell'identità (Fase 2g li sostituisce con la logica reale)
create function public.is_verified(p_worker uuid) returns boolean
language sql stable security definer set search_path = public as $$ select false $$;
create function public.job_requires_verification(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$ select false $$;
create function public.job_min_verification(p_job uuid) returns text
language sql stable security definer set search_path = public as $$ select 'nessuna'::text $$;
create function public.verification_level(p_worker uuid) returns text
language sql stable security definer set search_path = public as $$ select 'nessuna'::text $$;
create function public.trust_points(p_worker uuid) returns int
language sql stable security definer set search_path = public as $$ select 0 $$;
create function public.trust_info(p_worker uuid) returns jsonb
language sql stable security definer set search_path = public as $$ select '{}'::jsonb $$;
create function public.identity_outcome_of(p_shift uuid) returns text
language sql stable security definer set search_path = public as $$ select null::text $$;
create function public.profile_photo_of(p_worker uuid) returns text
language sql stable security definer set search_path = public as $$ select null::text $$;
create function public.job_allows_worker(p_job uuid, p_worker uuid) returns boolean
language sql stable security definer set search_path = public as $$ select true $$;

-- controlli di coerenza sugli annunci
create function public.jobs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.event_id is not null
     and not exists (select 1 from public.events where id = new.event_id and organizer_id = new.employer_id) then
    raise exception 'evento non valido per questo datore';
  end if;
  if tg_op = 'UPDATE' then
    if (new.event_id, new.role_code, new.shift_pay_cents, new.starts_at, new.ends_at)
         is distinct from (old.event_id, old.role_code, old.shift_pay_cents, old.starts_at, old.ends_at)
       and (exists (select 1 from public.guarantees where job_id = old.id)
            or exists (select 1 from public.shifts where job_id = old.id)) then
      raise exception 'ruolo, paga e orari non si cambiano dopo garanzie o turni';
    end if;
    if new.headcount < (select count(*) from public.guarantees where job_id = old.id) then
      raise exception 'persone richieste inferiori alle garanzie acquistate';
    end if;
  end if;
  return new;
end $$;

create trigger jobs_guard_trg before insert or update on public.jobs
  for each row execute function public.jobs_guard();

-- 6) AZIONI (tutte le scritture passano da qui) ---------------------------

-- Il datore compra una garanzia per un ruolo: solo se esistono abbastanza riserve
create function public.buy_guarantee(p_job uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_s public.platform_settings; v_total int; v_open int; v_id uuid;
begin
  select * into v_j from public.jobs where id = p_job and employer_id = auth.uid() for update;
  if not found then raise exception 'annuncio non trovato'; end if;
  if v_j.event_id is null then raise exception 'la garanzia richiede un annuncio collegato a un evento'; end if;
  if v_j.starts_at <= now() then raise exception 'il turno è già iniziato'; end if;
  select * into v_s from public.platform_settings;
  select count(*), count(*) filter (where status = 'aperta') into v_total, v_open
    from public.guarantees where job_id = v_j.id;
  if v_total >= v_j.headcount then raise exception 'le garanzie non possono superare le persone richieste'; end if;
  if public.standby_pool_size(v_j.id) < v_s.pool_ratio * (v_open + 1) then
    raise exception 'riserve insufficienti per questo ruolo, zona e orario: garanzia non disponibile';
  end if;
  insert into public.guarantees (job_id, standby_fee_cents, platform_fee_cents)
  values (v_j.id,
          round(v_j.shift_pay_cents * v_s.standby_fee_pct  / 100.0)::int,
          round(v_j.shift_pay_cents * v_s.platform_fee_pct / 100.0)::int)
  returning id into v_id;
  return v_id;
end $$;

-- Slot di riserva che il lavoratore può prendere (senza rivelare il datore)
create function public.open_standby_slots()
returns table (guarantee_id uuid, job_id uuid, event_name text, city text, role_code text,
               starts_at timestamptz, ends_at timestamptz,
               fee_if_unused_cents int, pay_if_activated_cents int)
language sql stable security definer set search_path = public as $$
  select g.id, j.id, e.name, e.city, j.role_code, j.starts_at, j.ends_at,
         g.standby_fee_cents, j.shift_pay_cents
  from public.guarantees g
  join public.jobs j   on j.id = g.job_id
  join public.events e on e.id = j.event_id
  where auth.uid() is not null
    and public.my_role() = 'seeker'
    and g.status = 'aperta' and j.starts_at > now()
    and exists (select 1 from public.worker_roles r
                where r.worker_id = auth.uid() and r.role_code = j.role_code)
    and exists (select 1 from public.standby_availability a
                where a.worker_id = auth.uid() and a.role_code = j.role_code
                  and lower(a.city) = lower(e.city)
                  and a.from_at <= j.starts_at and a.to_at >= j.ends_at)
    and public.worker_is_free(auth.uid(), j.starts_at, j.ends_at)
    and not exists (select 1 from public.applications ap where ap.job_id = j.id and ap.seeker_id = auth.uid())
    and not exists (select 1 from public.shifts s where s.job_id = j.id and s.worker_id = auth.uid())
  order by j.starts_at
$$;

-- Il lavoratore prende uno slot di riserva (il primo che arriva vince)
create function public.claim_standby(p_guarantee uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_slot record; v_id uuid;
begin
  select * into v_slot from public.open_standby_slots() where guarantee_id = p_guarantee;
  if not found then raise exception 'slot non disponibile'; end if;
  if not public.job_allows_worker(v_slot.job_id, auth.uid()) then
    raise exception 'questo ruolo richiede identità verificata: verificati dal tuo profilo';
  end if;
  begin
    insert into public.standby_assignments (guarantee_id, job_id, worker_id)
    values (p_guarantee, v_slot.job_id, auth.uid()) returning id into v_id;
  exception when unique_violation then
    raise exception 'slot già preso da un altro';
  end;
  update public.guarantees set status = 'coperta' where id = p_guarantee and status = 'aperta';
  return v_id;
end $$;

-- La riserva rinuncia: se manca meno di 24h all'inizio, perde affidabilità
create function public.withdraw_standby(p_assignment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  select sa.id, sa.guarantee_id, j.starts_at into v
  from public.standby_assignments sa join public.jobs j on j.id = sa.job_id
  where sa.id = p_assignment and sa.worker_id = auth.uid() and sa.status = 'riservata'
  for update of sa;
  if not found then raise exception 'riserva non trovata'; end if;
  update public.standby_assignments set status = 'rinunciata', updated_at = now() where id = v.id;
  update public.guarantees set status = 'aperta' where id = v.guarantee_id and status = 'coperta';
  if v.starts_at - now() < interval '24 hours' then
    insert into public.trust_events (user_id, kind) values (auth.uid(), 'rinuncia_tardiva');
  end if;
end $$;

-- Il datore accetta una candidatura: nasce il turno
create function public.accept_application(p_application uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_a public.applications; v_j public.jobs; v_n int; v_new uuid;
begin
  select * into v_a from public.applications where id = p_application;
  if not found then raise exception 'candidatura non trovata'; end if;
  select * into v_j from public.jobs where id = v_a.job_id for update;
  if v_j.employer_id is distinct from auth.uid() then raise exception 'non autorizzato'; end if;
  if v_j.event_id is null then raise exception 'solo gli annunci collegati a un evento generano turni'; end if;
  if exists (select 1 from public.shifts where job_id = v_j.id and worker_id = v_a.seeker_id) then
    raise exception 'questa persona è già stata assegnata a questo annuncio';
  end if;
  select count(*) into v_n from public.shifts
   where job_id = v_j.id and status in ('assegnato','confermato','completato');
  if v_n >= v_j.headcount then raise exception 'posti esauriti'; end if;
  if not public.worker_is_free(v_a.seeker_id, v_j.starts_at, v_j.ends_at) then
    raise exception 'il candidato ha già un impegno in quella fascia';
  end if;
  if not public.job_allows_worker(v_j.id, v_a.seeker_id) then
    raise exception 'questo ruolo richiede identità verificata e il candidato non è verificato';
  end if;
  insert into public.shifts (job_id, worker_id) values (v_j.id, v_a.seeker_id) returning id into v_new;
  return v_new;
end $$;

-- Check-in / check-out del lavoratore (ora del server, selfie obbligatorio all'ingresso)
create function public.worker_check(p_shift uuid, p_kind text, p_lat double precision,
                                    p_lng double precision, p_selfie text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_sh public.shifts; v_j public.jobs; v_s public.platform_settings; v_id uuid;
begin
  if p_kind not in ('in','out') then raise exception 'tipo non valido'; end if;
  select * into v_sh from public.shifts where id = p_shift and worker_id = auth.uid() for update;
  if not found then raise exception 'turno non trovato'; end if;
  select * into v_j from public.jobs where id = v_sh.job_id;
  select * into v_s from public.platform_settings;
  if now() < v_j.starts_at - make_interval(mins => v_s.checkin_window_min)
     or now() > v_j.ends_at + interval '2 hours' then
    raise exception 'fuori dalla finestra consentita';
  end if;
  if p_kind = 'in' then
    if v_sh.status <> 'assegnato' then raise exception 'check-in non possibile (stato: %)', v_sh.status; end if;
    if p_selfie is null or p_selfie not like auth.uid()::text || '/%' then
      raise exception 'selfie obbligatorio, nella tua cartella';
    end if;
  elsif not exists (select 1 from public.check_events
                    where shift_id = v_sh.id and kind = 'in' and confirmed_at is not null) then
    raise exception 'check-out possibile solo dopo il check-in confermato';
  end if;
  if exists (select 1 from public.check_events where shift_id = v_sh.id and kind = p_kind) then
    raise exception 'hai già inviato il %: attendi la conferma dell''organizzatore', case p_kind when 'in' then 'check-in' else 'check-out' end;
  end if;
  insert into public.check_events (shift_id, kind, lat, lng, selfie_path)
  values (v_sh.id, p_kind, p_lat, p_lng, p_selfie) returning id into v_id;
  return v_id;
end $$;

-- Il datore conferma check-in o check-out
create function public.employer_confirm_check(p_check uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_ce public.check_events; v_sh public.shifts; v_j public.jobs;
        v_s public.platform_settings; v_expected timestamptz; v_pre uuid;
begin
  -- ordine dei blocchi (evita gli stalli): prima l'annuncio
  select s.job_id into v_pre from public.check_events c join public.shifts s on s.id = c.shift_id where c.id = p_check;
  if found then perform 1 from public.jobs where id = v_pre for update; end if;
  select * into v_ce from public.check_events where id = p_check for update;
  if not found then raise exception 'check non trovato'; end if;
  select * into v_sh from public.shifts where id = v_ce.shift_id for update;
  select * into v_j  from public.jobs   where id = v_sh.job_id;
  if v_j.employer_id is distinct from auth.uid() then raise exception 'non autorizzato'; end if;
  if v_ce.confirmed_at is not null then raise exception 'già confermato'; end if;
  select * into v_s from public.platform_settings;

  if v_ce.kind = 'in' then
    update public.check_events set confirmed_at = now() where id = v_ce.id;
    update public.shifts set status = 'confermato' where id = v_sh.id;
    v_expected := coalesce(v_sh.expected_by, v_j.starts_at);
    if v_ce.at > v_expected + make_interval(mins => v_s.late_tolerance_min) then
      insert into public.trust_events (user_id, shift_id, kind, detail)
      values (v_sh.worker_id, v_sh.id, 'ritardo',
              ceil(extract(epoch from (v_ce.at - v_expected)) / 60)::int);
    end if;
  else
    if v_sh.status <> 'confermato' then raise exception 'conferma prima il check-in'; end if;
    update public.check_events set confirmed_at = now() where id = v_ce.id;
    update public.shifts set status = 'completato' where id = v_sh.id;
    insert into public.trust_events (user_id, shift_id, kind) values (v_sh.worker_id, v_sh.id, 'completato');
    insert into public.ledger (job_id, shift_id, payer_id, payee_id, kind, amount_cents)
    values (v_j.id, v_sh.id, v_j.employer_id, v_sh.worker_id, 'paga_turno', v_j.shift_pay_cents);
  end if;
end $$;

-- Il datore segnala il no-show: scatta la sostituzione con la prima riserva
create function public.report_no_show(p_shift uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_sh public.shifts; v_j public.jobs; v_s public.platform_settings;
        v_sa public.standby_assignments; v_g public.guarantees; v_new uuid; v_pre uuid;
begin
  -- ordine dei blocchi (evita gli stalli): prima l'annuncio, poi il turno
  select job_id into v_pre from public.shifts where id = p_shift;
  if found then perform 1 from public.jobs where id = v_pre for update; end if;
  select * into v_sh from public.shifts where id = p_shift for update;
  if not found then raise exception 'turno non trovato'; end if;
  select * into v_j from public.jobs where id = v_sh.job_id;
  if v_j.employer_id is distinct from auth.uid() then raise exception 'non autorizzato'; end if;
  select * into v_s from public.platform_settings;
  if v_sh.status <> 'assegnato' then raise exception 'turno non segnalabile (stato: %)', v_sh.status; end if;
  if now() < coalesce(v_sh.expected_by, v_j.starts_at) + make_interval(mins => v_s.noshow_grace_min) then
    raise exception 'troppo presto per segnalare un no-show';
  end if;
  if exists (select 1 from public.check_events where shift_id = v_sh.id and kind = 'in') then
    raise exception 'il lavoratore ha fatto check-in: confermalo invece di segnalare il no-show';
  end if;

  update public.shifts set status = 'no_show' where id = v_sh.id;
  insert into public.trust_events (user_id, shift_id, kind) values (v_sh.worker_id, v_sh.id, 'no_show');

  select * into v_sa from public.standby_assignments
   where job_id = v_sh.job_id and status = 'riservata'
   order by created_at limit 1 for update skip locked;
  if not found then
    select * into v_g from public.guarantees
     where job_id = v_sh.job_id and status = 'aperta' order by created_at limit 1 for update;
    if found then
      update public.guarantees set status = 'non_mantenuta' where id = v_g.id;
      return 'garanzia_non_mantenuta';
    end if;
    return 'nessuna_riserva';
  end if;

  select * into v_g from public.guarantees where id = v_sa.guarantee_id;
  update public.standby_assignments set status = 'attivata', updated_at = now() where id = v_sa.id;
  update public.guarantees set status = 'attivata' where id = v_g.id;
  insert into public.shifts (job_id, worker_id, is_replacement, replaces_shift_id, expected_by)
  values (v_sh.job_id, v_sa.worker_id, true, v_sh.id,
          now() + make_interval(mins => v_s.replacement_arrival_min))
  returning id into v_new;
  insert into public.trust_events (user_id, shift_id, kind) values (v_sa.worker_id, v_new, 'riserva_attivata');
  -- la riserva attivata prende la paga piena (registrata al check-out); la piattaforma incassa il 10%
  insert into public.ledger (job_id, guarantee_id, shift_id, payer_id, payee_id, kind, amount_cents)
  values (v_j.id, v_g.id, v_new, v_j.employer_id, null, 'garanzia_piattaforma', v_g.platform_fee_cents);
  return 'sostituita';
end $$;

-- Chiusura a fine evento (da pianificare con pg_cron, NON chiamabile dai client)
create function public.close_guarantees() returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_w uuid; n int := 0;
begin
  for r in
    select g.id, g.status, g.standby_fee_cents, g.platform_fee_cents, g.job_id, j.employer_id
    from public.guarantees g join public.jobs j on j.id = g.job_id
    where j.ends_at < now() and g.status in ('aperta','coperta','attivata')
    for update of g skip locked
  loop
    if r.status = 'coperta' then
      -- riserva non utilizzata: 20% a lei, 10% alla piattaforma
      v_w := null;
      update public.standby_assignments set status = 'liberata', updated_at = now()
       where guarantee_id = r.id and status = 'riservata' returning worker_id into v_w;
      insert into public.ledger (job_id, guarantee_id, payer_id, payee_id, kind, amount_cents)
      values (r.job_id, r.id, r.employer_id, v_w, 'garanzia_riserva', r.standby_fee_cents),
             (r.job_id, r.id, r.employer_id, null, 'garanzia_piattaforma', r.platform_fee_cents);
      update public.guarantees set status = 'chiusa' where id = r.id;
    elsif r.status = 'attivata' then
      update public.guarantees set status = 'chiusa' where id = r.id;
    else  -- mai coperta da nessuna riserva: nulla è dovuto
      update public.guarantees set status = 'non_mantenuta' where id = r.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
-- Per eseguirla ogni 10 minuti (dopo aver attivato l'estensione pg_cron in Supabase):
--   select cron.schedule('chiudi-garanzie', '*/10 * * * *', 'select public.close_guarantees()');

-- 7) PERMESSI: i client leggono, ma scrivono solo tramite le funzioni -----

revoke all on public.platform_settings, public.job_roles, public.events, public.worker_roles,
              public.standby_availability, public.guarantees, public.standby_assignments,
              public.shifts, public.check_events, public.trust_events, public.ledger
  from anon, authenticated;

grant select on public.job_roles, public.events to anon, authenticated;
grant select on public.platform_settings, public.guarantees, public.standby_assignments,
                public.shifts, public.check_events, public.trust_events, public.ledger to authenticated;
grant select, insert, delete on public.worker_roles to authenticated;
grant select, insert, update, delete on public.standby_availability to authenticated;
grant insert (name, city, event_date, organizer_id), update (name, city, event_date), delete,
      select on public.events to authenticated;

revoke all on function public.my_role(), public.is_job_employer(uuid), public.involved_in_job(uuid),
  public.employer_of_worker(uuid), public.worker_is_free(uuid, timestamptz, timestamptz),
  public.standby_pool_size(uuid), public.buy_guarantee(uuid), public.open_standby_slots(),
  public.claim_standby(uuid), public.withdraw_standby(uuid), public.accept_application(uuid),
  public.worker_check(uuid, text, double precision, double precision, text),
  public.employer_confirm_check(uuid), public.report_no_show(uuid), public.close_guarantees(),
  public.is_verified(uuid), public.job_requires_verification(uuid), public.job_allows_worker(uuid, uuid),
  public.job_min_verification(uuid), public.verification_level(uuid), public.trust_points(uuid),
  public.trust_info(uuid), public.identity_outcome_of(uuid), public.profile_photo_of(uuid)
  from public, anon, authenticated;

grant execute on function public.my_role(), public.is_job_employer(uuid), public.involved_in_job(uuid),
  public.employer_of_worker(uuid), public.buy_guarantee(uuid), public.open_standby_slots(),
  public.claim_standby(uuid), public.withdraw_standby(uuid), public.accept_application(uuid),
  public.worker_check(uuid, text, double precision, double precision, text),
  public.employer_confirm_check(uuid), public.report_no_show(uuid),
  public.standby_pool_size(uuid)
  to authenticated;
-- worker_is_free e close_guarantees restano riservate al server (service_role / pg_cron).

-- 8) SICUREZZA A LIVELLO DI RIGA -------------------------------------------

alter table public.platform_settings   enable row level security;
alter table public.job_roles           enable row level security;
alter table public.events              enable row level security;
alter table public.worker_roles        enable row level security;
alter table public.standby_availability enable row level security;
alter table public.guarantees          enable row level security;
alter table public.standby_assignments enable row level security;
alter table public.shifts              enable row level security;
alter table public.check_events        enable row level security;
alter table public.trust_events        enable row level security;
alter table public.ledger              enable row level security;

create policy "impostazioni: leggibili" on public.platform_settings
  for select to authenticated using (true);
create policy "ruoli: leggibili" on public.job_roles
  for select to anon, authenticated using (true);

-- Eventi: li vede il datore, e chiunque veda un annuncio collegato (le regole su jobs filtrano)
create policy "eventi: visibili se ne vedo un annuncio" on public.events
  for select to anon, authenticated using (
    organizer_id = auth.uid()
    or exists (select 1 from public.jobs j where j.event_id = events.id)
  );
create policy "eventi: solo datori ne creano" on public.events
  for insert to authenticated
  with check (organizer_id = auth.uid() and public.my_role() = 'employer');
create policy "eventi: modifico i miei" on public.events
  for update to authenticated using (organizer_id = auth.uid()) with check (organizer_id = auth.uid());
create policy "eventi: cancello i miei" on public.events
  for delete to authenticated using (organizer_id = auth.uid());

-- Annunci: chi ha un turno o una riserva viva continua a vederli anche se chiusi
create policy "annunci: li vede chi è coinvolto" on public.jobs
  for select to authenticated using (public.involved_in_job(id));

-- Profili: il datore vede i lavoratori che hanno un turno sui suoi annunci (comprese le sostitute)
create policy "profilo: datore vede i suoi lavoratori" on public.profiles
  for select to authenticated using (public.employer_of_worker(id));

create policy "competenze: le mie" on public.worker_roles
  for select to authenticated using (worker_id = auth.uid());
create policy "competenze: aggiungo le mie" on public.worker_roles
  for insert to authenticated with check (worker_id = auth.uid() and public.my_role() = 'seeker');
create policy "competenze: tolgo le mie" on public.worker_roles
  for delete to authenticated using (worker_id = auth.uid());

create policy "disponibilità: le mie" on public.standby_availability
  for select to authenticated using (worker_id = auth.uid());
create policy "disponibilità: aggiungo le mie" on public.standby_availability
  for insert to authenticated with check (worker_id = auth.uid() and public.my_role() = 'seeker');
create policy "disponibilità: modifico le mie" on public.standby_availability
  for update to authenticated using (worker_id = auth.uid()) with check (worker_id = auth.uid());
create policy "disponibilità: tolgo le mie" on public.standby_availability
  for delete to authenticated using (worker_id = auth.uid());

create policy "garanzie: le vede il datore" on public.guarantees
  for select to authenticated using (public.is_job_employer(job_id));
create policy "riserve: le mie" on public.standby_assignments
  for select to authenticated using (worker_id = auth.uid());
create policy "turni: li vedono lavoratore e datore" on public.shifts
  for select to authenticated using (worker_id = auth.uid() or public.is_job_employer(job_id));
create policy "check: li vedono lavoratore e datore" on public.check_events
  for select to authenticated using (exists (select 1 from public.shifts s where s.id = shift_id));
create policy "affidabilità: i miei eventi" on public.trust_events
  for select to authenticated using (user_id = auth.uid());
create policy "registro: lo vedono le parti" on public.ledger
  for select to authenticated using (payer_id = auth.uid() or payee_id = auth.uid());

-- 9) SELFIE (da fare DOPO aver creato il bucket PRIVATO "checkins" in Storage)
-- Il lavoratore carica in checkins/<suo-id>/...; il datore vede solo i selfie dei suoi turni.
--
-- create function public.can_view_selfie(p_path text) returns boolean
-- language sql stable security definer set search_path = public as $$
--   select exists (select 1 from public.check_events ce
--                  join public.shifts s on s.id = ce.shift_id
--                  join public.jobs j on j.id = s.job_id
--                  where ce.selfie_path = p_path and j.employer_id = auth.uid())
-- $$;
-- create policy "selfie: carico nella mia cartella" on storage.objects for insert to authenticated
--   with check (bucket_id = 'checkins' and (storage.foldername(name))[1] = auth.uid()::text);
-- create policy "selfie: vedo i miei o quelli dei miei turni" on storage.objects for select to authenticated
--   using (bucket_id = 'checkins' and ((storage.foldername(name))[1] = auth.uid()::text
--                                       or public.can_view_selfie(name)));
