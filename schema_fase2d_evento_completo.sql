-- =====================================================================
-- FASE 2d: conferma "evento completo" all'organizzatore
--
-- Da eseguire DOPO schema.sql, fase2, fase2b e fase2c.
--
-- UN EVENTO È COMPLETO quando:
--   * per ogni ruolo (annuncio) i posti sono coperti da turni attivi
--     (assegnato / confermato / completato; una sostituta conta al posto del no-show);
--   * ogni garanzia no-show acquistata ha una riserva (coperta / attivata / chiusa).
--
-- La piattaforma avvisa l'organizzatore:
--   * "Evento completo" quando passa da incompleto a completo;
--   * "Evento non più completo" se poi la copertura si rompe
--     (es. un no-show senza sostituta, una riserva che rinuncia, un nuovo ruolo aggiunto).
-- Il controllo avviene a fine transazione: una sostituzione immediata dopo un
-- no-show non genera falsi allarmi.
-- =====================================================================

alter table public.events
  add column complete     boolean not null default false,
  add column completed_at timestamptz;

-- Stato per ruolo, per mostrare l'avanzamento nell'app (solo l'organizzatore dell'evento)
create function public.event_overview(p_event uuid)
returns table (job_id uuid, role_code text, title text, posti int, coperti int,
               garanzie int, garanzie_coperte int, ruolo_completo boolean)
language sql stable security definer set search_path = public as $$
  select j.id, j.role_code, j.title, j.headcount,
         (select count(*) from public.shifts s
           where s.job_id = j.id and s.status in ('assegnato','confermato','completato'))::int,
         (select count(*) from public.guarantees g where g.job_id = j.id)::int,
         (select count(*) from public.guarantees g
           where g.job_id = j.id and g.status in ('coperta','attivata','chiusa'))::int,
         (select count(*) from public.shifts s
           where s.job_id = j.id and s.status in ('assegnato','confermato','completato')) >= j.headcount
         and not exists (select 1 from public.guarantees g
                         where g.job_id = j.id and g.status not in ('coperta','attivata','chiusa'))
  from public.jobs j
  join public.events e on e.id = j.event_id
  where j.event_id = p_event and e.organizer_id = auth.uid()
  order by j.starts_at, j.title
$$;

-- Ricalcola lo stato dell'evento e avvisa solo se cambia
create function public.refresh_event_status(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_e public.events; v_complete boolean; v_posti int; v_gar int;
        v_missing int; v_missing_g int; v_body text;
begin
  select * into v_e from public.events where id = p_event for update;
  if not found then return; end if;

  select coalesce(sum(j.headcount), 0)::int into v_posti
    from public.jobs j where j.event_id = p_event
    and (j.is_open or exists (select 1 from public.shifts sx
         where sx.job_id = j.id and sx.status in ('assegnato','confermato','completato')));
  -- posti ancora scoperti e garanzie ancora scoperte, su tutto l'evento
  select coalesce(sum(greatest(j.headcount - (
           select count(*) from public.shifts s
            where s.job_id = j.id and s.status in ('assegnato','confermato','completato')), 0)), 0)::int
    into v_missing from public.jobs j where j.event_id = p_event
    and (j.is_open or exists (select 1 from public.shifts sx
         where sx.job_id = j.id and sx.status in ('assegnato','confermato','completato')));
  select count(*)::int,
         count(*) filter (where g.status not in ('coperta','attivata','chiusa'))::int
    into v_gar, v_missing_g
    from public.guarantees g join public.jobs j on j.id = g.job_id where j.event_id = p_event
    and (j.is_open or exists (select 1 from public.shifts sx
         where sx.job_id = j.id and sx.status in ('assegnato','confermato','completato')));

  v_complete := v_posti > 0 and v_missing = 0 and v_missing_g = 0;
  if v_complete = v_e.complete then return; end if;

  update public.events
     set complete = v_complete, completed_at = case when v_complete then now() else null end
   where id = p_event;

  if v_complete then
    v_body := 'Evento "' || v_e.name || '": posti coperti ' || v_posti || '/' || v_posti
              || case when v_gar > 0
                      then '; garanzie no-show coperte ' || v_gar || '/' || v_gar else '' end || '.';
    perform public._notify(v_e.organizer_id, 'evento_completo', 'Evento completo', v_body, null,
      jsonb_build_object('event_id', p_event, 'posti', v_posti, 'garanzie', v_gar));
  else
    v_body := 'Evento "' || v_e.name || '": posti scoperti ' || v_missing
              || case when v_missing_g > 0 then ', garanzie senza riserva ' || v_missing_g else '' end || '.';
    perform public._notify(v_e.organizer_id, 'evento_non_completo', 'Evento non più completo', v_body, null,
      jsonb_build_object('event_id', p_event, 'posti_scoperti', v_missing, 'garanzie_scoperte', v_missing_g));
  end if;
end $$;

create function public.trg_refresh_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_event uuid;
begin
  if tg_table_name = 'jobs' then
    if tg_op = 'DELETE' then
      v_event := old.event_id;
    else
      v_event := new.event_id;
      if tg_op = 'UPDATE' and old.event_id is not null and old.event_id is distinct from new.event_id then
        perform public.refresh_event_status(old.event_id);
      end if;
    end if;
  else
    select event_id into v_event from public.jobs where id = new.job_id;
  end if;
  if v_event is not null then perform public.refresh_event_status(v_event); end if;
  return null;
end $$;

-- A fine transazione (deferrable): una sostituzione immediata dopo un no-show non fa rumore
create constraint trigger event_status_shifts after insert or update of status on public.shifts
  deferrable initially deferred for each row execute function public.trg_refresh_event();
create constraint trigger event_status_guarantees after insert or update of status on public.guarantees
  deferrable initially deferred for each row execute function public.trg_refresh_event();
create constraint trigger event_status_jobs after insert or update of headcount, event_id or delete on public.jobs
  deferrable initially deferred for each row execute function public.trg_refresh_event();

revoke all on function public.event_overview(uuid), public.refresh_event_status(uuid),
  public.trg_refresh_event() from public, anon, authenticated;
grant execute on function public.event_overview(uuid) to authenticated;
