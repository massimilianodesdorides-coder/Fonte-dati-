-- =====================================================================
-- FASE 2c: calendario dentro l'app e indisponibilità
--
-- Da eseguire DOPO schema.sql, schema_fase2.sql e schema_fase2b_matching.sql.
--
--  * Il lavoratore inserisce le fasce in cui NON è disponibile
--    (worker_unavailability): chi è indisponibile non riceve proposte e non
--    compare nelle classifiche (worker_is_free le considera come impegni).
--  * my_calendar() restituisce in un'unica lista turni, riserve, proposte in
--    attesa (con scadenza) e indisponibilità. Per l'organizzatore: i suoi annunci.
--  * calendar_ics() produce un file .ics per chi vuole copiare i turni nel
--    calendario del telefono. Il calendario principale resta quello dell'app.
-- =====================================================================

create table public.worker_unavailability (
  id         uuid primary key default gen_random_uuid(),
  worker_id  uuid not null references public.profiles(id) on delete cascade,
  from_at    timestamptz not null,
  to_at      timestamptz not null,
  note       text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  check (to_at > from_at)
);
create index on public.worker_unavailability (worker_id, from_at);

-- Non si può dichiararsi indisponibili sopra un impegno già preso
create function public.unavailability_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.shifts sh join public.jobs j on j.id = sh.job_id
             where sh.worker_id = new.worker_id and sh.status in ('assegnato','confermato')
               and tstzrange(j.starts_at, j.ends_at) && tstzrange(new.from_at, new.to_at))
     or exists (select 1 from public.standby_assignments sa join public.jobs j on j.id = sa.job_id
                where sa.worker_id = new.worker_id and sa.status in ('riservata','attivata')
                  and tstzrange(j.starts_at, j.ends_at) && tstzrange(new.from_at, new.to_at)) then
    raise exception 'hai già un impegno in quella fascia: annullalo prima di dichiararti indisponibile';
  end if;
  return new;
end $$;
create trigger unavailability_guard_trg before insert or update on public.worker_unavailability
  for each row execute function public.unavailability_guard();

alter table public.worker_unavailability enable row level security;
revoke all on public.worker_unavailability from anon, authenticated;
grant select, insert, update, delete on public.worker_unavailability to authenticated;
create policy "indisponibilità: le mie" on public.worker_unavailability
  for select to authenticated using (worker_id = auth.uid());
create policy "indisponibilità: aggiungo le mie" on public.worker_unavailability
  for insert to authenticated with check (worker_id = auth.uid() and public.my_role() = 'seeker');
create policy "indisponibilità: modifico le mie" on public.worker_unavailability
  for update to authenticated using (worker_id = auth.uid()) with check (worker_id = auth.uid());
create policy "indisponibilità: tolgo le mie" on public.worker_unavailability
  for delete to authenticated using (worker_id = auth.uid());

-- Le indisponibilità contano come impegni in ogni controllo di disponibilità
create or replace function public.worker_is_free(w uuid, s timestamptz, e timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
           select 1 from public.shifts sh join public.jobs j on j.id = sh.job_id
           where sh.worker_id = w and sh.status in ('assegnato','confermato')
             and tstzrange(j.starts_at, j.ends_at) && tstzrange(s, e))
     and not exists (
           select 1 from public.standby_assignments sa join public.jobs j on j.id = sa.job_id
           where sa.worker_id = w and sa.status in ('riservata','attivata')
             and tstzrange(j.starts_at, j.ends_at) && tstzrange(s, e))
     and not exists (
           select 1 from public.worker_unavailability u
           where u.worker_id = w and tstzrange(u.from_at, u.to_at) && tstzrange(s, e))
$$;

-- Calendario unico dell'utente collegato
create function public.my_calendar(p_from timestamptz default now() - interval '1 day',
                                   p_to   timestamptz default now() + interval '120 days')
returns table (kind text, ref_id uuid, title text, city text,
               starts_at timestamptz, ends_at timestamptz, status text, detail jsonb)
language sql stable security definer set search_path = public as $$
  -- lavoratore: turni
  select 'turno', s.id, j.title || ' · ' || e.name, e.city, j.starts_at, j.ends_at, s.status,
         jsonb_build_object('ruolo', j.role_code, 'paga_cents', j.shift_pay_cents,
                            'sostituzione', s.is_replacement, 'presentarsi_entro', s.expected_by)
  from public.shifts s join public.jobs j on j.id = s.job_id join public.events e on e.id = j.event_id
  where s.worker_id = auth.uid() and s.status in ('assegnato','confermato','completato')
    and j.starts_at < p_to and j.ends_at > p_from
  union all
  -- lavoratore: riserve
  select 'riserva', sa.id, j.title || ' · ' || e.name, e.city, j.starts_at, j.ends_at, sa.status,
         jsonb_build_object('ruolo', j.role_code, 'compenso_se_non_usata_cents', g.standby_fee_cents,
                            'paga_se_attivata_cents', j.shift_pay_cents)
  from public.standby_assignments sa
  join public.jobs j on j.id = sa.job_id join public.events e on e.id = j.event_id
  join public.guarantees g on g.id = sa.guarantee_id
  where sa.worker_id = auth.uid() and sa.status in ('riservata','attivata')
    and j.starts_at < p_to and j.ends_at > p_from
  union all
  -- lavoratore: proposte in attesa di risposta
  select 'proposta', o.id, j.title || ' · ' || e.name, e.city, j.starts_at, j.ends_at, o.status,
         jsonb_build_object('tipo', o.kind, 'scade', o.expires_at, 'ruolo', j.role_code,
                            'paga_cents', j.shift_pay_cents)
  from public.offers o join public.jobs j on j.id = o.job_id join public.events e on e.id = j.event_id
  where o.worker_id = auth.uid() and o.status = 'inviata'
    and j.starts_at < p_to and j.ends_at > p_from
  union all
  -- lavoratore: indisponibilità
  select 'non_disponibile', u.id, coalesce(nullif(u.note, ''), 'Non disponibile'), null, u.from_at, u.to_at,
         'attiva', '{}'::jsonb
  from public.worker_unavailability u
  where u.worker_id = auth.uid() and u.from_at < p_to and u.to_at > p_from
  union all
  -- organizzatore: i suoi annunci con copertura
  select 'annuncio', j.id, j.title || ' · ' || e.name, e.city, j.starts_at, j.ends_at,
         case when j.is_open then 'aperto' else 'chiuso' end,
         jsonb_build_object('ruolo', j.role_code, 'posti', j.headcount,
           'assegnati', (select count(*) from public.shifts s
                         where s.job_id = j.id and not s.is_replacement
                           and s.status in ('assegnato','confermato','completato')),
           'garanzie', (select count(*) from public.guarantees g where g.job_id = j.id),
           'garanzie_coperte', (select count(*) from public.guarantees g
                                where g.job_id = j.id and g.status in ('coperta','attivata','chiusa')))
  from public.jobs j join public.events e on e.id = j.event_id
  where j.employer_id = auth.uid() and j.starts_at < p_to and j.ends_at > p_from
  order by 5
$$;

-- File .ics con turni e riserve confermati, da importare nel calendario del telefono
create function public.calendar_ics() returns text
language sql stable security definer set search_path = public as $$
  select 'BEGIN:VCALENDAR' || E'\r\n' || 'VERSION:2.0' || E'\r\n' || 'PRODID:-//Lavoro Facile//IT' || E'\r\n'
    || coalesce(string_agg(
         'BEGIN:VEVENT' || E'\r\n'
         || 'UID:' || c.ref_id || '@lavorofacile' || E'\r\n'
         || 'DTSTAMP:' || to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || E'\r\n'
         || 'DTSTART:' || to_char(c.starts_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || E'\r\n'
         || 'DTEND:'   || to_char(c.ends_at   at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || E'\r\n'
         || 'SUMMARY:' || case c.kind when 'riserva' then '[RISERVA] ' else '' end
            || replace(replace(replace(c.title, E'\\', E'\\\\'), ',', E'\\,'), ';', E'\\;') || E'\r\n'
         || 'LOCATION:' || replace(coalesce(c.city, ''), ',', E'\\,') || E'\r\n'
         || 'END:VEVENT' || E'\r\n', '' order by c.starts_at), '')
    || 'END:VCALENDAR' || E'\r\n'
  from public.my_calendar(now() - interval '1 day', now() + interval '365 days') c
  where c.kind in ('turno','riserva') and c.status not in ('completato','liberata')
$$;

revoke all on function public.unavailability_guard(), public.my_calendar(timestamptz, timestamptz),
  public.calendar_ics() from public, anon, authenticated;
grant execute on function public.my_calendar(timestamptz, timestamptz), public.calendar_ics() to authenticated;
