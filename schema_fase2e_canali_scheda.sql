-- =====================================================================
-- FASE 2e: pubblicazione su altri canali + scheda evento operativa
--
-- Da eseguire DOPO schema.sql, fase2, fase2b, fase2c, fase2d.
--
-- 1) CANALI. Per ogni evento l'organizzatore crea un link per canale
--    (es. "Subito", "Facebook", "Indeed"). Il link porta alla pagina pubblica
--    dell'evento nella nostra app: chi non è iscritto si registra e si candida
--    lì, e tutte le risposte arrivano su un unico canale. Ogni iscrizione e
--    ogni candidatura ricorda da quale link arriva (statistiche per canale).
--    La pubblicazione sui siti esterni la fa l'organizzatore con il testo e il
--    link che prepara l'app: pubblicare in automatico richiede accordi/API con
--    ciascun portale.
--
-- 2) SCHEDA EVENTO. event_roster() restituisce, per ogni ruolo, chi è atteso,
--    chi ha fatto check-in (con selfie e ritardo), cosa si può confermare e
--    quando si può segnalare un no-show; più le riserve in attesa.
--    Le azioni sono quelle già esistenti: employer_confirm_check(check_id),
--    report_no_show(shift_id).
-- =====================================================================

-- 1) LINK PER CANALE --------------------------------------------------------

create table public.event_links (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  channel    text not null check (char_length(btrim(channel)) between 2 and 40),
  code       text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  created_at timestamptz not null default now()
);
create index on public.event_links (event_id);

alter table public.event_links enable row level security;
revoke all on public.event_links from anon, authenticated;
grant select on public.event_links to authenticated;
create policy "link: li vede l'organizzatore" on public.event_links
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.organizer_id = auth.uid()));

-- Attribuzione: iscrizioni e candidature ricordano il link di provenienza
alter table public.profiles     add column signup_link_id uuid references public.event_links(id) on delete set null;
alter table public.applications add column link_id        uuid references public.event_links(id) on delete set null;

-- link_id non è scrivibile dai client: si imposta solo tramite apply_to_job()
revoke insert on public.applications from authenticated;
grant insert (job_id, seeker_id, message) on public.applications to authenticated;

-- La registrazione legge il codice del link dai metadati (options.data.link_code)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link uuid;
begin
  select id into v_link from public.event_links where code = new.raw_user_meta_data->>'link_code';
  insert into public.profiles (id, role, full_name, email, signup_link_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'seeker')::public.user_role,
    left(coalesce(new.raw_user_meta_data->>'full_name', 'Utente'), 100),
    new.email,
    v_link
  );
  return new;
end $$;

create function public.create_event_link(p_event uuid, p_channel text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not exists (select 1 from public.events where id = p_event and organizer_id = auth.uid()) then
    raise exception 'evento non trovato';
  end if;
  if (select count(*) from public.event_links where event_id = p_event) >= 20 then
    raise exception 'massimo 20 link per evento';
  end if;
  insert into public.event_links (event_id, channel) values (p_event, btrim(p_channel))
  returning code into v_code;
  return v_code;
end $$;

-- Pagina pubblica dell'evento, raggiungibile anche senza account: nessun dato personale
create function public.public_event_page(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'evento', jsonb_build_object('nome', e.name, 'citta', e.city, 'data', e.event_date),
    'canale', l.channel,
    'ruoli', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id', j.id, 'ruolo', j.role_code, 'titolo', j.title, 'azienda', j.company_name,
               'paga_cents', j.shift_pay_cents, 'inizio', j.starts_at, 'fine', j.ends_at,
               'richiede_verifica', public.job_requires_verification(j.id),
               'posti_liberi', greatest(j.headcount - (
                  select count(*) from public.shifts s
                  where s.job_id = j.id and s.status in ('assegnato','confermato','completato')), 0))
             order by j.starts_at, j.title)
      from public.jobs j where j.event_id = e.id and j.is_open and j.starts_at > now()), '[]'::jsonb))
  from public.event_links l join public.events e on e.id = l.event_id
  where l.code = p_code
$$;

-- Candidatura con attribuzione al canale (il link vale solo per annunci di quell'evento)
create function public.apply_to_job(p_job uuid, p_message text default '', p_link_code text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_link uuid; v_id uuid;
begin
  if public.my_role() is distinct from 'seeker' then
    raise exception 'solo chi cerca lavoro può candidarsi';
  end if;
  select * into v_j from public.jobs where id = p_job and is_open;
  if not found then raise exception 'annuncio non disponibile'; end if;
  if not public.job_allows_worker(p_job, auth.uid()) then
    raise exception 'questo ruolo richiede identità verificata: verificati dal tuo profilo';
  end if;
  if p_link_code is not null then
    select id into v_link from public.event_links where code = p_link_code and event_id = v_j.event_id;
  end if;
  insert into public.applications (job_id, seeker_id, message, link_id)
  values (p_job, auth.uid(), coalesce(p_message, ''), v_link) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'ti sei già candidato a questo annuncio';
end $$;

-- Rendimento dei canali (solo numeri, nessuna identità)
create function public.link_stats(p_event uuid)
returns table (channel text, code text, nuovi_iscritti int, candidature int, assunti int)
language sql stable security definer set search_path = public as $$
  select l.channel, l.code,
    (select count(*) from public.profiles p where p.signup_link_id = l.id)::int,
    (select count(*) from public.applications a where a.link_id = l.id)::int,
    (select count(*) from public.applications a
       join public.shifts s on s.job_id = a.job_id and s.worker_id = a.seeker_id
      where a.link_id = l.id and s.status in ('assegnato','confermato','completato'))::int
  from public.event_links l join public.events e on e.id = l.event_id
  where l.event_id = p_event and e.organizer_id = auth.uid()
  order by l.created_at
$$;

-- 2) SCHEDA EVENTO ----------------------------------------------------------

create function public.event_roster(p_event uuid)
returns table (job_id uuid, role_code text, job_title text, kind text, shift_id uuid,
               worker_id uuid, worker_name text, status text, is_replacement boolean,
               expected_at timestamptz,
               check_in_id uuid, check_in_at timestamptz, check_in_confirmed_at timestamptz,
               selfie_path text,
               check_out_id uuid, check_out_at timestamptz, check_out_confirmed_at timestamptz,
               minutes_late int, can_report_no_show boolean)
language sql stable security definer set search_path = public as $$
  with st as (select * from public.platform_settings)
  select j.id, j.role_code, j.title, 'turno'::text, s.id, s.worker_id, p.full_name, s.status, s.is_replacement,
         coalesce(s.expected_by, j.starts_at),
         ci.id, ci.at, ci.confirmed_at, ci.selfie_path,
         co.id, co.at, co.confirmed_at,
         case when ci.at is not null
                   and ci.at > coalesce(s.expected_by, j.starts_at)
                               + make_interval(mins => (select late_tolerance_min from st))
              then ceil(extract(epoch from (ci.at - coalesce(s.expected_by, j.starts_at))) / 60)::int
              else 0 end,
         (s.status = 'assegnato' and ci.id is null
          and now() >= coalesce(s.expected_by, j.starts_at)
                       + make_interval(mins => (select noshow_grace_min from st)))
  from public.jobs j
  join public.events e on e.id = j.event_id
  join public.shifts s on s.job_id = j.id and s.status <> 'annullato'
  join public.profiles p on p.id = s.worker_id
  left join public.check_events ci on ci.shift_id = s.id and ci.kind = 'in'
  left join public.check_events co on co.shift_id = s.id and co.kind = 'out'
  where j.event_id = p_event and e.organizer_id = auth.uid()
  union all
  select j.id, j.role_code, j.title, 'riserva'::text, null::uuid, sa.worker_id,
         public._display_name(sa.worker_id), sa.status, false, j.starts_at,
         null::uuid, null::timestamptz, null::timestamptz, null::text,
         null::uuid, null::timestamptz, null::timestamptz, 0, false
  from public.standby_assignments sa
  join public.jobs j on j.id = sa.job_id
  join public.events e on e.id = j.event_id
  where j.event_id = p_event and e.organizer_id = auth.uid() and sa.status = 'riservata'
  order by 10, 2, 7
$$;

-- 3) PERMESSI -----------------------------------------------------------------

revoke all on function public.create_event_link(uuid, text), public.public_event_page(text),
  public.apply_to_job(uuid, text, text), public.link_stats(uuid), public.event_roster(uuid)
  from public, anon, authenticated;

grant execute on function public.public_event_page(text) to anon, authenticated;
grant execute on function public.create_event_link(uuid, text), public.apply_to_job(uuid, text, text),
  public.link_stats(uuid), public.event_roster(uuid) to authenticated;
