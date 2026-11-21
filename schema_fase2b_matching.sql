-- =====================================================================
-- FASE 2b: abbinamento, schede, inviti, notifiche, scelta automatica
--          (valido sia per i turni sia per le RISERVE della copertura no-show)
--
-- Da eseguire DOPO schema.sql e schema_fase2.sql.
--
-- FLUSSO
--  1) l'organizzatore pubblica un annuncio per ruolo (evento + posizione)
--  2) match_workers(annuncio) mostra subito i più adatti, con punteggio spiegato
--  3) MANUALE: l'organizzatore consulta le schede e invita chi preferisce
--     (invite_worker; per le riserve invite_reserve). Ogni invito arriva come
--     notifica in app e ha un tempo limite per rispondere.
--     Se i posti restano scoperti e non ci sono più inviti in attesa, il
--     sistema avvisa l'organizzatore e gli propone altri candidati.
--     AUTOMATICO: enable_auto_select. Il sistema invia le notifiche in ordine
--     di classifica fino alla soglia necessaria e continua con i successivi
--     quando qualcuno rifiuta o non risponde.
--  4) il lavoratore accetta o rifiuta (respond_offer). Solo se accetta nasce
--     il turno (o la riserva). Nessuno viene assegnato senza consenso.
--
-- RISERVE: se l'annuncio ha garanzie no-show acquistate, ogni garanzia scoperta
-- riceve proposte alle riserve con lo stesso meccanismo (ranking, scadenza,
-- lista aggiuntiva, automatico). Una riserva deve aver dichiarato disponibilità.
--
-- PRIVACY
--  * Compare nelle ricerche solo chi ha attivato "discoverable".
--  * La scheda mostra nome abbreviato, città, presentazione, ruoli e statistiche:
--    MAI telefono o email, che si aprono solo dopo un turno accettato.
--  * Il punteggio non usa foto, età, genere, nome o altri dati sensibili.
--
-- PUNTEGGIO (0-100), visibile nel campo "breakdown":
--   città uguale a quella dell'evento ......... 30
--   esperienza nello stesso ruolo (max 10 turni) 30
--   affidabilità (completati / no-show / ritardi) 30  (chi è nuovo parte da 24)
--   si è candidato all'annuncio (solo turni) .. 10
-- =====================================================================

-- 1) CAMPI NUOVI ---------------------------------------------------------

alter table public.profiles add column discoverable boolean not null default false;
grant update (discoverable) on public.profiles to authenticated;

alter table public.jobs add column auto_select boolean not null default false;

alter table public.platform_settings
  add column offer_ttl_min int not null default 120,   -- durata di un invito
  add column offer_overbook int not null default 2,    -- inviti manuali: fino a N volte i posti
  add column reminder_min  int not null default 30;    -- promemoria N minuti prima della scadenza

create table public.offers (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  worker_id    uuid not null references public.profiles(id) on delete cascade,
  kind         text not null default 'turno' check (kind in ('turno','riserva')),
  guarantee_id uuid references public.guarantees(id) on delete cascade,
  mode         text not null check (mode in ('manuale','automatico')),
  status       text not null default 'inviata'
    check (status in ('inviata','accettata','rifiutata','scaduta','ritirata')),
  score        int,
  reminded     boolean not null default false,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  unique (job_id, worker_id),
  check ((kind = 'riserva') = (guarantee_id is not null))
);
create index on public.offers (worker_id, status);
create index on public.offers (job_id, status);
-- una sola proposta in attesa per ogni garanzia (a prova di concorrenza)
create unique index offers_one_pending_per_guarantee on public.offers (guarantee_id)
  where status = 'inviata' and kind = 'riserva';

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  job_id     uuid references public.jobs(id) on delete cascade,
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);
-- Per ricevere le notifiche in tempo reale nell'app (Supabase Realtime):
--   alter publication supabase_realtime add table public.notifications;

alter table public.offers        enable row level security;
alter table public.notifications enable row level security;
revoke all on public.offers, public.notifications from anon, authenticated;
grant select on public.offers to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy "inviti: li vedono lavoratore e datore" on public.offers
  for select to authenticated using (worker_id = auth.uid() or public.is_job_employer(job_id));
create policy "notifiche: le mie" on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy "notifiche: segno come lette le mie" on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ANNOTAZIONI PRIVATE DELL'ORGANIZZATORE: "preferito" / "da evitare"
-- * Le vede solo chi le ha scritte: mai il lavoratore, mai altri organizzatori,
--   e non entrano nel punteggio degli altri.
-- * "preferito" passa in cima alla classifica dell'organizzatore.
-- * "da evitare" richiede un motivo a scelta e non viene mai invitato in
--   automatico; l'invito manuale è bloccato finché la nota non viene tolta.
-- * Sono dati personali: il lavoratore può chiederne l'accesso (GDPR art. 15).
--   La nota libera va tenuta ai fatti di lavoro, mai a caratteristiche personali.
create table public.worker_notes (
  id          uuid primary key default gen_random_uuid(),
  employer_id uuid not null references public.profiles(id) on delete cascade,
  worker_id   uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('preferito','da_evitare')),
  reason      text check (reason in ('puntualita','comportamento','qualita','altro')),
  note        text not null default '' check (char_length(note) <= 300),
  updated_at  timestamptz not null default now(),
  unique (employer_id, worker_id),
  check (kind = 'preferito' or reason is not null)
);
create index on public.worker_notes (worker_id);

alter table public.worker_notes enable row level security;
revoke all on public.worker_notes from anon, authenticated;
grant select on public.worker_notes to authenticated;
create policy "note: le mie" on public.worker_notes
  for select to authenticated using (employer_id = auth.uid());

-- Chi ha un invito aperto o accettato vede l'annuncio (anche se chiuso)
create or replace function public.involved_in_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shifts s where s.job_id = p_job and s.worker_id = auth.uid())
      or exists (select 1 from public.standby_assignments a
                 where a.job_id = p_job and a.worker_id = auth.uid()
                   and a.status in ('riservata','attivata'))
      or exists (select 1 from public.offers o
                 where o.job_id = p_job and o.worker_id = auth.uid()
                   and o.status in ('inviata','accettata'))
$$;

-- 2) FUNZIONI INTERNE -------------------------------------------------------

create function public._display_name(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when position(' ' in btrim(full_name)) > 0
              then split_part(btrim(full_name), ' ', 1) || ' ' || left(split_part(btrim(full_name), ' ', 2), 1) || '.'
              else btrim(full_name) end
  from public.profiles where id = p_id
$$;

create function public._notify(p_user uuid, p_kind text, p_title text, p_body text,
                               p_job uuid default null, p_payload jsonb default '{}')
returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, title, body, job_id, payload)
  values (p_user, p_kind, p_title, p_body, p_job, coalesce(p_payload, '{}'))
$$;

create function public.set_worker_note(p_worker uuid, p_kind text, p_reason text default null,
                                       p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'employer' then raise exception 'solo gli organizzatori'; end if;
  if p_kind not in ('preferito','da_evitare') then raise exception 'tipo non valido'; end if;
  if p_kind = 'da_evitare' and p_reason is null then raise exception 'indica il motivo'; end if;
  if p_reason is not null and p_reason not in ('puntualita','comportamento','qualita','altro') then
    raise exception 'motivo non valido';
  end if;
  -- si annotano solo persone che l'organizzatore conosce o può vedere nelle ricerche
  if not ( public.employer_of_worker(p_worker)
           or exists (select 1 from public.applications a join public.jobs j on j.id = a.job_id
                      where a.seeker_id = p_worker and j.employer_id = auth.uid())
           or exists (select 1 from public.offers o join public.jobs j on j.id = o.job_id
                      where o.worker_id = p_worker and j.employer_id = auth.uid())
           or exists (select 1 from public.profiles p
                      where p.id = p_worker and p.role = 'seeker' and p.discoverable) ) then
    raise exception 'persona non trovata';
  end if;
  insert into public.worker_notes (employer_id, worker_id, kind, reason, note)
  values (auth.uid(), p_worker, p_kind, case when p_kind = 'da_evitare' then p_reason else null end,
          coalesce(p_note, ''))
  on conflict (employer_id, worker_id)
  do update set kind = excluded.kind, reason = excluded.reason, note = excluded.note, updated_at = now();
end $$;

create function public.clear_worker_note(p_worker uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.worker_notes where employer_id = auth.uid() and worker_id = p_worker
$$;

create function public.my_worker_notes()
returns table (worker_id uuid, display_name text, kind text, reason text, note text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select n.worker_id, public._display_name(n.worker_id), n.kind, n.reason, n.note, n.updated_at
  from public.worker_notes n where n.employer_id = auth.uid()
  order by n.updated_at desc
$$;

-- Classifica interna. p_reserve = true: candidati come RISERVA (serve disponibilità dichiarata)
create function public.rank_candidates(p_job uuid, p_reserve boolean default false)
returns table (worker_id uuid, display_name text, city text, bio text, roles text[],
               completed_shifts int, completed_same_role int, no_shows int, lates int,
               applied boolean, offer_status text, score int, breakdown jsonb,
               annotation text, annotation_note text)
language sql stable security definer set search_path = public as $$
  with j as (
    select jb.id, jb.role_code, jb.starts_at, jb.ends_at, e.city as ev_city
    from public.jobs jb join public.events e on e.id = jb.event_id
    where jb.id = p_job
  ),
  cand as (
    select p.id, p.full_name, p.city, p.bio,
           exists (select 1 from public.applications a where a.job_id = j.id and a.seeker_id = p.id) as applied
    from public.profiles p cross join j
    where p.role = 'seeker'
      and ( ( p.discoverable
              and exists (select 1 from public.worker_roles r
                          where r.worker_id = p.id and r.role_code = j.role_code)
              and ( not p_reserve
                    or exists (select 1 from public.standby_availability a
                               where a.worker_id = p.id and a.role_code = j.role_code
                                 and lower(a.city) = lower(j.ev_city)
                                 and a.from_at <= j.starts_at and a.to_at >= j.ends_at) ) )
            or ( not p_reserve
                 and exists (select 1 from public.applications a where a.job_id = j.id and a.seeker_id = p.id) ) )
      and public.worker_is_free(p.id, j.starts_at, j.ends_at)
      and not exists (select 1 from public.shifts s where s.job_id = j.id and s.worker_id = p.id)
  ),
  stats as (
    select c.*,
      (select count(*) from public.shifts s
        where s.worker_id = c.id and s.status = 'completato')::int as done,
      (select count(*) from public.shifts s join public.jobs jj on jj.id = s.job_id
        where s.worker_id = c.id and s.status = 'completato'
          and jj.role_code = (select role_code from j))::int as done_role,
      (select count(*) from public.trust_events t
        where t.user_id = c.id and t.kind = 'no_show' and not t.disputed)::int as ns,
      (select count(*) from public.trust_events t
        where t.user_id = c.id and t.kind = 'ritardo' and not t.disputed)::int as lt
    from cand c
  ),
  scored as (
    select s.*,
      case when lower(s.city) = lower(j.ev_city) then 30 else 0 end as p_city,
      round(30 * least(s.done_role, 10) / 10.0)::int as p_exp,
      round(30 * (s.done + 4.0) / (s.done + 5.0 + 3 * s.ns + 0.5 * s.lt))::int as p_rel,
      case when s.applied then 10 else 0 end as p_int
    from stats s cross join j
  )
  select sc.id, public._display_name(sc.id), sc.city, sc.bio,
         coalesce((select array_agg(r.role_code order by r.role_code)
                   from public.worker_roles r where r.worker_id = sc.id), '{}'),
         sc.done, sc.done_role, sc.ns, sc.lt, sc.applied,
         (select o.status from public.offers o where o.job_id = p_job and o.worker_id = sc.id),
         sc.p_city + sc.p_exp + sc.p_rel + sc.p_int,
         jsonb_build_object('citta', sc.p_city, 'esperienza', sc.p_exp,
                            'affidabilita', sc.p_rel, 'interesse', sc.p_int),
         n.kind, n.note
  from scored sc
  left join public.worker_notes n
         on n.worker_id = sc.id
        and n.employer_id = (select employer_id from public.jobs where id = p_job)
$$;

-- Invio di una proposta + notifica al lavoratore
create function public._send_offer(p_job uuid, p_worker uuid, p_mode text, p_score int,
                                   p_kind text default 'turno', p_guarantee uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_e public.events; v_s public.platform_settings; v_g public.guarantees;
        v_id uuid; v_exp timestamptz; v_body text; v_payload jsonb;
begin
  select * into v_j from public.jobs where id = p_job;
  select * into v_e from public.events where id = v_j.event_id;
  select * into v_s from public.platform_settings;
  v_exp := greatest(now() + interval '15 minutes',
                    least(now() + make_interval(mins => v_s.offer_ttl_min),
                          v_j.starts_at - interval '1 hour'));
  insert into public.offers (job_id, worker_id, kind, guarantee_id, mode, score, expires_at)
  values (p_job, p_worker, p_kind, p_guarantee, p_mode, p_score, v_exp) returning id into v_id;

  v_body := v_j.title || ' · ' || v_e.name || ' (' || v_e.city || '), '
            || to_char(v_j.starts_at at time zone 'Europe/Rome', 'DD/MM HH24:MI')
            || '. Rispondi entro le ' || to_char(v_exp at time zone 'Europe/Rome', 'DD/MM HH24:MI') || '.';
  v_payload := jsonb_build_object('offer_id', v_id, 'tipo', p_kind, 'scade', v_exp,
                                  'paga_turno_cents', v_j.shift_pay_cents);
  if p_kind = 'riserva' then
    select * into v_g from public.guarantees where id = p_guarantee;
    v_payload := v_payload || jsonb_build_object('compenso_se_non_usata_cents', v_g.standby_fee_cents);
    v_body := v_body || ' Compenso: ' || (v_g.standby_fee_cents / 100.0)::numeric(10,2)
              || ' € se non serve, paga piena (' || (v_j.shift_pay_cents / 100.0)::numeric(10,2) || ' €) se vieni attivata.';
  else
    v_body := v_body || ' Paga: ' || (v_j.shift_pay_cents / 100.0)::numeric(10,2) || ' €.';
  end if;
  perform public._notify(p_worker,
    case p_kind when 'riserva' then 'proposta_riserva' else 'proposta_turno' end,
    case p_kind when 'riserva' then 'Proposta come riserva' else 'Nuova proposta di lavoro' end,
    v_body, p_job, v_payload);
  return v_id;
end $$;

-- 3) VISTE PER L'ORGANIZZATORE ----------------------------------------------

create function public.match_workers(p_job uuid, p_limit int default 50)
returns table (worker_id uuid, display_name text, city text, bio text, roles text[],
               completed_shifts int, completed_same_role int, no_shows int, lates int,
               applied boolean, offer_status text, score int, breakdown jsonb,
               annotation text, annotation_note text)
language sql stable security definer set search_path = public as $$
  select * from public.rank_candidates(p_job, false)
  where public.is_job_employer(p_job)
  order by case annotation when 'preferito' then 0 when 'da_evitare' then 2 else 1 end, score desc, md5(worker_id::text || p_job::text)
  limit least(greatest(p_limit, 1), 200)
$$;

create function public.match_reserves(p_job uuid, p_limit int default 50)
returns table (worker_id uuid, display_name text, city text, bio text, roles text[],
               completed_shifts int, completed_same_role int, no_shows int, lates int,
               applied boolean, offer_status text, score int, breakdown jsonb,
               annotation text, annotation_note text)
language sql stable security definer set search_path = public as $$
  select * from public.rank_candidates(p_job, true)
  where public.is_job_employer(p_job)
  order by case annotation when 'preferito' then 0 when 'da_evitare' then 2 else 1 end, score desc, md5(worker_id::text || p_job::text)
  limit least(greatest(p_limit, 1), 200)
$$;

-- 4) INVITI --------------------------------------------------------------------

create function public.invite_worker(p_job uuid, p_worker uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_s public.platform_settings; v_c record; v_act int; v_pend int;
begin
  select * into v_j from public.jobs where id = p_job and employer_id = auth.uid() for update;
  if not found then raise exception 'annuncio non trovato'; end if;
  if v_j.event_id is null then raise exception 'solo gli annunci collegati a un evento'; end if;
  if v_j.starts_at <= now() then raise exception 'il turno è già iniziato'; end if;
  select * into v_c from public.rank_candidates(p_job, false) where worker_id = p_worker;
  if not found then raise exception 'persona non idonea o non disponibile per questo annuncio'; end if;
  if v_c.annotation = 'da_evitare' then
    raise exception 'persona segnata come "da evitare": togli la nota per invitarla';
  end if;
  if v_c.offer_status is not null then raise exception 'già invitato (stato: %)', v_c.offer_status; end if;
  select * into v_s from public.platform_settings;
  select count(*) into v_act from public.shifts
   where job_id = p_job and not is_replacement and status in ('assegnato','confermato','completato');
  select count(*) into v_pend from public.offers where job_id = p_job and status = 'inviata' and kind = 'turno';
  if v_act + v_pend >= v_j.headcount * v_s.offer_overbook then
    raise exception 'troppi inviti in attesa per i posti disponibili';
  end if;
  return public._send_offer(p_job, p_worker, 'manuale', v_c.score);
end $$;

-- Invito manuale a una riserva per una garanzia ancora scoperta
create function public.invite_reserve(p_guarantee uuid, p_worker uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_g public.guarantees; v_j public.jobs; v_c record;
begin
  select g.* into v_g from public.guarantees g join public.jobs j on j.id = g.job_id
   where g.id = p_guarantee and j.employer_id = auth.uid() for update of g;
  if not found then raise exception 'garanzia non trovata'; end if;
  if v_g.status <> 'aperta' then raise exception 'la garanzia è già coperta'; end if;
  select * into v_j from public.jobs where id = v_g.job_id;
  if v_j.starts_at <= now() then raise exception 'il turno è già iniziato'; end if;
  if exists (select 1 from public.offers where guarantee_id = p_guarantee and status = 'inviata') then
    raise exception 'c''è già una proposta in attesa per questa garanzia';
  end if;
  select * into v_c from public.rank_candidates(v_j.id, true) where worker_id = p_worker;
  if not found then raise exception 'persona non idonea come riserva'; end if;
  if v_c.annotation = 'da_evitare' then
    raise exception 'persona segnata come "da evitare": togli la nota per invitarla';
  end if;
  if v_c.offer_status is not null then raise exception 'già contattato (stato: %)', v_c.offer_status; end if;
  return public._send_offer(v_j.id, p_worker, 'manuale', v_c.score, 'riserva', p_guarantee);
end $$;

create function public.withdraw_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_o public.offers;
begin
  update public.offers o set status = 'ritirata', responded_at = now()
   where o.id = p_offer and o.status = 'inviata' and public.is_job_employer(o.job_id)
   returning * into v_o;
  if not found then raise exception 'proposta non trovata o non più ritirabile'; end if;
  perform public._notify(v_o.worker_id, 'proposta_ritirata', 'Proposta ritirata',
                         'L''organizzatore ha ritirato la proposta.', v_o.job_id, jsonb_build_object('offer_id', v_o.id));
end $$;

-- Il lavoratore risponde. Restituisce:
-- accettata | rifiutata | scaduta | posti_esauriti | non_piu_necessaria | non_disponibile
create function public.respond_offer(p_offer uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_o public.offers; v_j public.jobs; v_g public.guarantees; v_n int; v_name text;
begin
  select * into v_o from public.offers where id = p_offer and worker_id = auth.uid() for update;
  if not found then raise exception 'invito non trovato'; end if;
  if v_o.status <> 'inviata' then raise exception 'invito non più valido (stato: %)', v_o.status; end if;
  select * into v_j from public.jobs where id = v_o.job_id;
  v_name := public._display_name(auth.uid());

  if not p_accept then
    update public.offers set status = 'rifiutata', responded_at = now() where id = v_o.id;
    perform public._notify(v_j.employer_id, 'proposta_rifiutata', 'Proposta rifiutata',
      v_name || ' ha rifiutato: ' || v_j.title, v_j.id, jsonb_build_object('offer_id', v_o.id, 'tipo', v_o.kind));
    perform public.check_coverage(v_o.job_id);
    return 'rifiutata';
  end if;

  if v_o.expires_at < now() then
    update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
    return 'scaduta';
  end if;

  if v_o.kind = 'turno' then
    select * into v_j from public.jobs where id = v_o.job_id for update;
    select count(*) into v_n from public.shifts
     where job_id = v_j.id and not is_replacement and status in ('assegnato','confermato','completato');
    if v_n >= v_j.headcount then
      update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
      return 'posti_esauriti';
    end if;
    if not public.worker_is_free(auth.uid(), v_j.starts_at, v_j.ends_at) then
      update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
      return 'non_disponibile';
    end if;
    insert into public.shifts (job_id, worker_id) values (v_j.id, auth.uid());
    update public.offers set status = 'accettata', responded_at = now() where id = v_o.id;
    if v_n + 1 >= v_j.headcount then             -- posti completi: gli altri inviti per turno decadono
      update public.offers set status = 'scaduta', responded_at = now()
       where job_id = v_j.id and status = 'inviata' and kind = 'turno';
    end if;
  else
    select * into v_g from public.guarantees where id = v_o.guarantee_id for update;
    if v_g.status <> 'aperta' then
      update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
      return 'non_piu_necessaria';
    end if;
    if not public.worker_is_free(auth.uid(), v_j.starts_at, v_j.ends_at) then
      update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
      return 'non_disponibile';
    end if;
    begin
      insert into public.standby_assignments (guarantee_id, job_id, worker_id)
      values (v_g.id, v_j.id, auth.uid());
    exception when unique_violation then
      update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
      return 'non_piu_necessaria';
    end;
    update public.guarantees set status = 'coperta' where id = v_g.id;
    update public.offers set status = 'accettata', responded_at = now() where id = v_o.id;
  end if;

  perform public._notify(v_j.employer_id, 'proposta_accettata', 'Proposta accettata',
    v_name || ' ha accettato' || case v_o.kind when 'riserva' then ' come riserva: ' else ': ' end || v_j.title,
    v_j.id, jsonb_build_object('offer_id', v_o.id, 'tipo', v_o.kind));
  return 'accettata';
end $$;

-- Conferma in calendario quando nasce un turno (anche sostituzioni)
create function public.notify_shift_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs;
begin
  select * into v_j from public.jobs where id = new.job_id;
  perform public._notify(new.worker_id,
    case when new.is_replacement then 'sostituzione_attivata' else 'turno_assegnato' end,
    case when new.is_replacement then 'Sei stata attivata come sostituta' else 'Turno in calendario' end,
    v_j.title || ', ' || to_char(v_j.starts_at at time zone 'Europe/Rome', 'DD/MM HH24:MI')
      || case when new.is_replacement
              then '. Presentati entro le ' || to_char(new.expected_by at time zone 'Europe/Rome', 'HH24:MI') || '.'
              else '.' end,
    new.job_id, jsonb_build_object('shift_id', new.id));
  return new;
end $$;
create trigger shifts_notify after insert on public.shifts
  for each row execute function public.notify_shift_created();

-- 5) COPERTURA E SCELTA AUTOMATICA -----------------------------------------

-- Riempie i posti scoperti (turni e riserve) in ordine di classifica, solo se auto_select
create function public.fill_job(p_job uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_act int; v_pend int; v_missing int; r record; g record; c record; n int := 0;
begin
  select * into v_j from public.jobs where id = p_job for update;
  if not found or not v_j.auto_select or not v_j.is_open
     or v_j.event_id is null or v_j.starts_at <= now() then
    return 0;
  end if;
  -- turni
  select count(*) into v_act from public.shifts
   where job_id = p_job and not is_replacement and status in ('assegnato','confermato','completato');
  select count(*) into v_pend from public.offers where job_id = p_job and status = 'inviata' and kind = 'turno';
  v_missing := v_j.headcount - v_act - v_pend;
  if v_missing > 0 then
    for r in
      select worker_id, score from public.rank_candidates(p_job, false)
      where offer_status is null and annotation is distinct from 'da_evitare'
      order by case annotation when 'preferito' then 0 when 'da_evitare' then 2 else 1 end, score desc, md5(worker_id::text || p_job::text)
      limit v_missing
    loop
      perform public._send_offer(p_job, r.worker_id, 'automatico', r.score);
      n := n + 1;
    end loop;
  end if;
  -- riserve: una proposta per ogni garanzia scoperta senza proposta in attesa
  for g in
    select gu.id from public.guarantees gu
    where gu.job_id = p_job and gu.status = 'aperta'
      and not exists (select 1 from public.offers o where o.guarantee_id = gu.id and o.status = 'inviata')
    order by gu.created_at
  loop
    select worker_id, score into c from public.rank_candidates(p_job, true)
     where offer_status is null and annotation is distinct from 'da_evitare'
     order by case annotation when 'preferito' then 0 when 'da_evitare' then 2 else 1 end, score desc, md5(worker_id::text || g.id::text) limit 1;
    exit when not found;
    perform public._send_offer(p_job, c.worker_id, 'automatico', c.score, 'riserva', g.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Dopo ogni risposta o scadenza: se qualcosa resta scoperto, prosegue (automatico)
-- oppure avvisa l'organizzatore e gli propone altri candidati (manuale)
create function public.check_coverage(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_act int; v_pend int; v_ms int; v_mr int; v_more int; v_morer int;
        v_kind text; v_body text;
begin
  select * into v_j from public.jobs where id = p_job;
  if not found or not v_j.is_open or v_j.event_id is null or v_j.starts_at <= now() then return; end if;
  if v_j.auto_select then perform public.fill_job(p_job); end if;

  select count(*) into v_act from public.shifts
   where job_id = p_job and not is_replacement and status in ('assegnato','confermato','completato');
  select count(*) into v_pend from public.offers where job_id = p_job and status = 'inviata' and kind = 'turno';
  v_ms := greatest(v_j.headcount - v_act - v_pend, 0);
  select count(*) into v_mr from public.guarantees g
   where g.job_id = p_job and g.status = 'aperta'
     and not exists (select 1 from public.offers o where o.guarantee_id = g.id and o.status = 'inviata');
  if v_ms = 0 and v_mr = 0 then return; end if;
  -- manuale: si attende che le proposte in corso si chiudano
  if not v_j.auto_select and exists (select 1 from public.offers where job_id = p_job and status = 'inviata') then
    return;
  end if;

  select count(*) into v_more  from public.rank_candidates(p_job, false) where offer_status is null and annotation is distinct from 'da_evitare';
  select count(*) into v_morer from public.rank_candidates(p_job, true)  where offer_status is null and annotation is distinct from 'da_evitare';
  v_kind := case when v_j.auto_select then 'candidati_esauriti' else 'altri_candidati' end;
  if exists (select 1 from public.notifications
             where user_id = v_j.employer_id and kind = v_kind and job_id = p_job and read_at is null) then
    return;
  end if;
  v_body := '"' || v_j.title || '": posti scoperti ' || v_ms
            || case when v_mr > 0 then ', riserve scoperte ' || v_mr else '' end || '. '
            || case when v_j.auto_select
                    then 'Il sistema ha esaurito i candidati idonei: valuta di ampliare la richiesta.'
                    else 'Altri candidati disponibili: ' || v_more
                         || case when v_mr > 0 then ' (riserve: ' || v_morer || ')' else '' end || '.' end;
  v_body := v_body || ' Puoi cercare anche su altri canali condividendo il link dell''evento.';
  perform public._notify(v_j.employer_id, v_kind,
    case when v_j.auto_select then 'Candidati esauriti' else 'Servono altri candidati' end,
    v_body, p_job, jsonb_build_object('mancanti', v_ms, 'riserve_mancanti', v_mr,
                                      'altri_candidati', v_more, 'altre_riserve', v_morer));
end $$;

create function public.enable_auto_select(p_job uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  update public.jobs set auto_select = true where id = p_job and employer_id = auth.uid();
  if not found then raise exception 'annuncio non trovato'; end if;
  return public.fill_job(p_job);
end $$;

-- Da pianificare ogni 5 minuti con pg_cron: scade gli inviti, manda i promemoria,
-- continua la scelta automatica e avvisa gli organizzatori:
--   select cron.schedule('inviti', '*/5 * * * *', 'select public.run_offer_maintenance()');
create function public.run_offer_maintenance() returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_s public.platform_settings; v_jobs uuid[] := '{}'; n int := 0;
begin
  select * into v_s from public.platform_settings;
  for r in
    with u as (update public.offers set status = 'scaduta', responded_at = now()
               where status = 'inviata' and expires_at < now()
               returning id, job_id, worker_id)
    select * from u
  loop
    perform public._notify(r.worker_id, 'proposta_scaduta', 'Proposta scaduta',
                           'Non hai risposto in tempo: la proposta non è più valida.', r.job_id,
                           jsonb_build_object('offer_id', r.id));
    v_jobs := v_jobs || r.job_id;
    n := n + 1;
  end loop;
  for r in
    with u as (update public.offers set reminded = true
               where status = 'inviata' and not reminded
                 and expires_at < now() + make_interval(mins => v_s.reminder_min)
               returning id, job_id, worker_id, expires_at)
    select * from u
  loop
    perform public._notify(r.worker_id, 'proposta_in_scadenza', 'Proposta in scadenza',
      'Hai tempo fino alle ' || to_char(r.expires_at at time zone 'Europe/Rome', 'HH24:MI') || ' per rispondere.',
      r.job_id, jsonb_build_object('offer_id', r.id));
  end loop;
  for r in
    select id from (select unnest(v_jobs) as id
                    union
                    select id from public.jobs
                    where auto_select and is_open and event_id is not null and starts_at > now()) x
  loop
    perform public.check_coverage(r.id);
  end loop;
  return n;
end $$;

-- Slot di riserva consultabili dal lavoratore (bacheca): esclusi quelli con una proposta in attesa
create or replace function public.open_standby_slots()
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
    and not exists (select 1 from public.offers o where o.guarantee_id = g.id and o.status = 'inviata')
    and not exists (select 1 from public.worker_notes wn
                    where wn.employer_id = j.employer_id and wn.worker_id = auth.uid() and wn.kind = 'da_evitare')
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

-- 6) PERMESSI ---------------------------------------------------------------

revoke all on function public._display_name(uuid), public._notify(uuid, text, text, text, uuid, jsonb),
  public.rank_candidates(uuid, boolean), public._send_offer(uuid, uuid, text, int, text, uuid),
  public.match_workers(uuid, int), public.match_reserves(uuid, int),
  public.invite_worker(uuid, uuid), public.invite_reserve(uuid, uuid), public.withdraw_offer(uuid),
  public.respond_offer(uuid, boolean), public.notify_shift_created(), public.fill_job(uuid),
  public.check_coverage(uuid), public.enable_auto_select(uuid), public.run_offer_maintenance(),
  public.open_standby_slots(), public.set_worker_note(uuid, text, text, text),
  public.clear_worker_note(uuid), public.my_worker_notes()
  from public, anon, authenticated;

grant execute on function public.match_workers(uuid, int), public.match_reserves(uuid, int),
  public.invite_worker(uuid, uuid), public.invite_reserve(uuid, uuid), public.withdraw_offer(uuid),
  public.respond_offer(uuid, boolean), public.enable_auto_select(uuid),
  public.open_standby_slots(), public.set_worker_note(uuid, text, text, text),
  public.clear_worker_note(uuid), public.my_worker_notes() to authenticated;
-- Solo server (pg_cron / service_role): rank_candidates, _send_offer, _notify, fill_job,
-- check_coverage, run_offer_maintenance
