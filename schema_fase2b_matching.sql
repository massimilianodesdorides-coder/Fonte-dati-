-- =====================================================================
-- FASE 2b: abbinamento (matching), schede, inviti e scelta automatica
--
-- Da eseguire DOPO schema.sql e schema_fase2.sql.
--
-- FLUSSO
--  1) l'organizzatore pubblica un annuncio per ruolo (evento + posizione)
--  2) match_workers(annuncio) mostra subito i più adatti, con punteggio spiegato
--  3) l'organizzatore consulta le schede e invita chi preferisce (invite_worker)
--     oppure attiva la scelta automatica (enable_auto_select): il sistema
--     invia gli inviti ai primi in classifica, e passa al successivo se
--     qualcuno rifiuta o non risponde
--  4) il lavoratore accetta o rifiuta (respond_offer): solo se accetta nasce il turno
--
-- PRIVACY
--  * Un lavoratore compare nelle ricerche solo se ha attivato "discoverable".
--  * La scheda contiene nome abbreviato, città, presentazione, ruoli e
--    statistiche: MAI telefono o email. Il profilo completo si apre solo
--    dopo un turno accettato (regola già presente nella Fase 2).
--  * Il punteggio non usa foto, età, genere, nome o altri dati sensibili.
--  * La scelta automatica non assegna turni senza il consenso del lavoratore.
--
-- PUNTEGGIO (0-100), tutto visibile nel campo "breakdown":
--   città uguale a quella dell'evento ......... 30
--   esperienza nello stesso ruolo (max 10 turni) 30
--   affidabilità (completati / no-show / ritardi) 30  (chi è nuovo parte da 24)
--   si è candidato all'annuncio ............... 10
-- =====================================================================

-- 1) CAMPI NUOVI ---------------------------------------------------------

alter table public.profiles add column discoverable boolean not null default false;
grant update (discoverable) on public.profiles to authenticated;

alter table public.jobs add column auto_select boolean not null default false;

alter table public.platform_settings
  add column offer_ttl_min int not null default 120,   -- durata di un invito
  add column offer_overbook int not null default 2;    -- inviti manuali: fino a N volte i posti

create table public.offers (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  worker_id    uuid not null references public.profiles(id) on delete cascade,
  mode         text not null check (mode in ('manuale','automatico')),
  status       text not null default 'inviata'
    check (status in ('inviata','accettata','rifiutata','scaduta','ritirata')),
  score        int,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  unique (job_id, worker_id)
);
create index on public.offers (worker_id, status);
create index on public.offers (job_id, status);

alter table public.offers enable row level security;
revoke all on public.offers from anon, authenticated;
grant select on public.offers to authenticated;
create policy "inviti: li vedono lavoratore e datore" on public.offers
  for select to authenticated using (worker_id = auth.uid() or public.is_job_employer(job_id));

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

-- 2) CLASSIFICA (interna, non chiamabile dai client) -----------------------

create function public.rank_candidates(p_job uuid)
returns table (worker_id uuid, display_name text, city text, bio text, roles text[],
               completed_shifts int, completed_same_role int, no_shows int, lates int,
               applied boolean, offer_status text, score int, breakdown jsonb)
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
      and ( (p.discoverable
             and exists (select 1 from public.worker_roles r
                         where r.worker_id = p.id and r.role_code = j.role_code))
            or exists (select 1 from public.applications a where a.job_id = j.id and a.seeker_id = p.id) )
      and public.worker_is_free(p.id, j.starts_at, j.ends_at)
      and not exists (select 1 from public.shifts s where s.job_id = j.id and s.worker_id = p.id)
  ),
  stats as (
    select c.*,
      (select count(*) from public.shifts s
        where s.worker_id = c.id and s.status = 'completato')::int as done,
      (select count(*) from public.shifts s join public.jobs jj on jj.id = s.job_id
        where s.worker_id = c.id and s.status = 'completato' and jj.role_code = (select role_code from j))::int as done_role,
      (select count(*) from public.trust_events t
        where t.user_id = c.id and t.kind = 'no_show' and not t.disputed)::int as ns,
      (select count(*) from public.trust_events t
        where t.user_id = c.id and t.kind = 'ritardo' and not t.disputed)::int as lt
    from cand c
  ),
  scored as (
    select s.*, j.ev_city,
      case when lower(s.city) = lower(j.ev_city) then 30 else 0 end as p_city,
      round(30 * least(s.done_role, 10) / 10.0)::int as p_exp,
      round(30 * (s.done + 4.0) / (s.done + 5.0 + 3 * s.ns + 0.5 * s.lt))::int as p_rel,
      case when s.applied then 10 else 0 end as p_int
    from stats s cross join j
  )
  select sc.id,
         case when position(' ' in btrim(sc.full_name)) > 0
              then split_part(btrim(sc.full_name), ' ', 1) || ' ' || left(split_part(btrim(sc.full_name), ' ', 2), 1) || '.'
              else btrim(sc.full_name) end,
         sc.city, sc.bio,
         coalesce((select array_agg(r.role_code order by r.role_code)
                   from public.worker_roles r where r.worker_id = sc.id), '{}'),
         sc.done, sc.done_role, sc.ns, sc.lt, sc.applied,
         (select o.status from public.offers o where o.job_id = p_job and o.worker_id = sc.id),
         sc.p_city + sc.p_exp + sc.p_rel + sc.p_int,
         jsonb_build_object('citta', sc.p_city, 'esperienza', sc.p_exp,
                            'affidabilita', sc.p_rel, 'interesse', sc.p_int)
  from scored sc
$$;

-- Vista per l'organizzatore: i migliori per il suo annuncio, con punteggio spiegato
create function public.match_workers(p_job uuid, p_limit int default 50)
returns table (worker_id uuid, display_name text, city text, bio text, roles text[],
               completed_shifts int, completed_same_role int, no_shows int, lates int,
               applied boolean, offer_status text, score int, breakdown jsonb)
language sql stable security definer set search_path = public as $$
  select * from public.rank_candidates(p_job)
  where public.is_job_employer(p_job)
  order by score desc, md5(worker_id::text || p_job::text)
  limit least(greatest(p_limit, 1), 200)
$$;

-- 3) INVITI ---------------------------------------------------------------

create function public._send_offer(p_job uuid, p_worker uuid, p_mode text, p_score int)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_s public.platform_settings; v_id uuid; v_exp timestamptz;
begin
  select * into v_j from public.jobs where id = p_job;
  select * into v_s from public.platform_settings;
  v_exp := greatest(now() + interval '15 minutes',
                    least(now() + make_interval(mins => v_s.offer_ttl_min),
                          v_j.starts_at - interval '1 hour'));
  insert into public.offers (job_id, worker_id, mode, score, expires_at)
  values (p_job, p_worker, p_mode, p_score, v_exp) returning id into v_id;
  return v_id;
end $$;

-- Invito manuale dopo aver consultato la scheda
create function public.invite_worker(p_job uuid, p_worker uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_s public.platform_settings; v_c record; v_act int; v_pend int;
begin
  select * into v_j from public.jobs where id = p_job and employer_id = auth.uid() for update;
  if not found then raise exception 'annuncio non trovato'; end if;
  if v_j.event_id is null then raise exception 'solo gli annunci collegati a un evento'; end if;
  if v_j.starts_at <= now() then raise exception 'il turno è già iniziato'; end if;
  select * into v_c from public.rank_candidates(p_job) where worker_id = p_worker;
  if not found then raise exception 'persona non idonea o non disponibile per questo annuncio'; end if;
  if v_c.offer_status is not null then raise exception 'già invitato (stato: %)', v_c.offer_status; end if;
  select * into v_s from public.platform_settings;
  select count(*) into v_act from public.shifts
   where job_id = p_job and not is_replacement and status in ('assegnato','confermato','completato');
  select count(*) into v_pend from public.offers where job_id = p_job and status = 'inviata';
  if v_act + v_pend >= v_j.headcount * v_s.offer_overbook then
    raise exception 'troppi inviti in attesa per i posti disponibili';
  end if;
  return public._send_offer(p_job, p_worker, 'manuale', v_c.score);
end $$;

create function public.withdraw_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.offers o set status = 'ritirata', responded_at = now()
   where o.id = p_offer and o.status = 'inviata' and public.is_job_employer(o.job_id);
  if not found then raise exception 'invito non trovato o non più ritirabile'; end if;
end $$;

-- Il lavoratore risponde. Restituisce: accettata | rifiutata | scaduta | posti_esauriti | non_disponibile
create function public.respond_offer(p_offer uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_o public.offers; v_j public.jobs; v_n int;
begin
  select * into v_o from public.offers where id = p_offer and worker_id = auth.uid() for update;
  if not found then raise exception 'invito non trovato'; end if;
  if v_o.status <> 'inviata' then raise exception 'invito non più valido (stato: %)', v_o.status; end if;

  if not p_accept then
    update public.offers set status = 'rifiutata', responded_at = now() where id = v_o.id;
    perform public.fill_job(v_o.job_id);            -- se è automatico, passa al successivo
    return 'rifiutata';
  end if;

  if v_o.expires_at < now() then
    update public.offers set status = 'scaduta', responded_at = now() where id = v_o.id;
    return 'scaduta';
  end if;

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
  if v_n + 1 >= v_j.headcount then               -- posti completi: gli altri inviti decadono
    update public.offers set status = 'scaduta', responded_at = now()
     where job_id = v_j.id and status = 'inviata';
  end if;
  return 'accettata';
end $$;

-- 4) SCELTA AUTOMATICA -------------------------------------------------------

-- Invia inviti ai primi in classifica per coprire i posti scoperti (nessun overbooking)
create function public.fill_job(p_job uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_j public.jobs; v_act int; v_pend int; v_missing int; r record; n int := 0;
begin
  select * into v_j from public.jobs where id = p_job for update;
  if not found or not v_j.auto_select or not v_j.is_open
     or v_j.event_id is null or v_j.starts_at <= now() then
    return 0;
  end if;
  select count(*) into v_act from public.shifts
   where job_id = p_job and not is_replacement and status in ('assegnato','confermato','completato');
  select count(*) into v_pend from public.offers where job_id = p_job and status = 'inviata';
  v_missing := v_j.headcount - v_act - v_pend;
  if v_missing <= 0 then return 0; end if;
  for r in
    select worker_id, score from public.rank_candidates(p_job)
    where offer_status is null
    order by score desc, md5(worker_id::text || p_job::text)
    limit v_missing
  loop
    perform public._send_offer(p_job, r.worker_id, 'automatico', r.score);
    n := n + 1;
  end loop;
  return n;
end $$;

-- L'organizzatore attiva la scelta automatica per un annuncio
create function public.enable_auto_select(p_job uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  update public.jobs set auto_select = true where id = p_job and employer_id = auth.uid();
  if not found then raise exception 'annuncio non trovato'; end if;
  return public.fill_job(p_job);
end $$;

-- Da pianificare ogni 5 minuti con pg_cron: scade gli inviti e riempie i posti
--   select cron.schedule('scelta-automatica', '*/5 * * * *', 'select public.run_auto_selection()');
create function public.run_auto_selection() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  update public.offers set status = 'scaduta' where status = 'inviata' and expires_at < now();
  for r in select id from public.jobs
           where auto_select and is_open and event_id is not null and starts_at > now()
  loop
    n := n + public.fill_job(r.id);
  end loop;
  return n;
end $$;

-- 5) PERMESSI ---------------------------------------------------------------

revoke all on function public.rank_candidates(uuid), public.match_workers(uuid, int),
  public._send_offer(uuid, uuid, text, int), public.invite_worker(uuid, uuid),
  public.withdraw_offer(uuid), public.respond_offer(uuid, boolean), public.fill_job(uuid),
  public.enable_auto_select(uuid), public.run_auto_selection()
  from public, anon, authenticated;

grant execute on function public.match_workers(uuid, int), public.invite_worker(uuid, uuid),
  public.withdraw_offer(uuid), public.respond_offer(uuid, boolean),
  public.enable_auto_select(uuid) to authenticated;
-- rank_candidates, _send_offer, fill_job e run_auto_selection: solo server (pg_cron / service_role)
