-- =====================================================================
-- FASE 2h: fiducia a livelli (verifiche leggere, conferma sul campo, documento facoltativo)
--
-- Da eseguire DOPO schema.sql, fase2, 2b, 2c, 2d, 2e, 2f, 2g.
--
-- LIVELLI
--   nessuna : solo registrato
--   base    : email confermata + telefono confermato (SMS) + codice fiscale congruo
--   forte   : identità certificata con documento (Fase 2g, a pagamento, facoltativa)
--
-- SEGNALI AGGIUNTIVI (non sostituiscono i livelli)
--   * conferma sul campo: al check-in l'organizzatore confronta la foto del profilo con il
--     selfie e sceglie "È la persona", "Foto datata" oppure "Non corrisponde".
--     Vale se la foto è valida (non segnalata, non più vecchia di 12 mesi).
--   * foto del profilo: l'organizzatore la vede solo dopo che il lavoratore ha un turno
--     con lui (mai nelle liste di candidati: niente scelte per aspetto).
--
-- PUNTEGGIO DI FIDUCIA (0-10, entra in classifica)
--   forte = 10; altrimenti: email+telefono 2, codice fiscale 3, conferma sul campo 5 (max 10)
--
-- COSA NON FA, E VA DETTO CHIARAMENTE
--   * il codice fiscale si può calcolare da nome, data e luogo di nascita: il controllo di
--     congruità scova errori e furbate banali, non una frode decisa. Impedisce però che lo
--     stesso codice sia usato da due account;
--   * la conferma sul campo dice "la persona corrisponde alla foto", non "il nome è quello
--     legale": è coerenza, non identità di legge. Una persona può anche avere solo foto e
--     selfie dell'impostore. Per l'identità di legge serve il documento (livello forte).
-- =====================================================================

-- 1) FOTO DEL PROFILO -----------------------------------------------------------

alter table public.profiles
  add column photo_path       text,
  add column photo_set_at     timestamptz,
  add column photo_checked_at timestamptz,      -- ultima conferma di un organizzatore
  add column photo_flagged_at timestamptz;      -- ultima segnalazione ("datata" o "non corrisponde")
-- nessuna di queste colonne è scrivibile dai client: si passa da set_profile_photo()

create function public.set_profile_photo(p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'seeker' then raise exception 'solo chi cerca lavoro'; end if;
  if p_path is null or p_path not like auth.uid()::text || '/%' then
    raise exception 'la foto deve stare nella tua cartella';
  end if;
  update public.profiles
     set photo_path = p_path, photo_set_at = now(), photo_checked_at = null, photo_flagged_at = null
   where id = auth.uid();
end $$;

-- 2) CODICE FISCALE ---------------------------------------------------------------

create table public.worker_identity (
  worker_id          uuid primary key references public.profiles(id) on delete cascade,
  tax_code           text not null unique,         -- un codice fiscale = un solo account
  tax_code_checked_at timestamptz not null default now()
);
alter table public.worker_identity enable row level security;
revoke all on public.worker_identity from anon, authenticated;
grant select on public.worker_identity to authenticated;
create policy "identità: la mia" on public.worker_identity
  for select to authenticated using (worker_id = auth.uid());

create function public._cf_clean(s text) returns text
language sql immutable as $$
  select regexp_replace(translate(upper(coalesce(s, '')), 'ÀÁÂÄÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜÇÑ', 'AAAAEEEEIIIIOOOOUUUUCN'), '[^A-Z]', '', 'g')
$$;
create function public._cf_consonants(s text) returns text
language sql immutable as $$ select regexp_replace(public._cf_clean(s), '[AEIOU]', '', 'g') $$;
create function public._cf_vowels(s text) returns text
language sql immutable as $$ select regexp_replace(public._cf_clean(s), '[^AEIOU]', '', 'g') $$;
create function public._cf_surname_code(s text) returns text
language sql immutable as $$ select left(rpad(public._cf_consonants(s) || public._cf_vowels(s), 3, 'X'), 3) $$;
create function public._cf_name_code(s text) returns text
language sql immutable as $$
  select case when length(public._cf_consonants(s)) >= 4
              then substr(public._cf_consonants(s), 1, 1) || substr(public._cf_consonants(s), 3, 2)
              else left(rpad(public._cf_consonants(s) || public._cf_vowels(s), 3, 'X'), 3) end
$$;
create function public._cf_checksum(p15 text) returns text
language plpgsql immutable as $$
declare odd_v int[] := array[1,0,5,7,9,13,15,17,19,21,2,4,18,20,11,3,6,8,12,14,16,10,22,25,24,23];
        i int; ch text; tot int := 0; idx int;
begin
  for i in 1..15 loop
    ch := substr(p15, i, 1);
    if ch ~ '[0-9]' then idx := ch::int; else idx := ascii(ch) - 65; end if;
    if i % 2 = 1 then tot := tot + odd_v[idx + 1]; else tot := tot + idx; end if;
  end loop;
  return chr(65 + tot % 26);
end $$;

-- Controlla la congruità del codice fiscale con nome, cognome e data di nascita dichiarati.
-- La data di nascita serve solo per il controllo e NON viene salvata.
create function public.verify_tax_code(p_first text, p_last text, p_birth date, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v text; v_fmt boolean; v_ctl boolean := false; v_sur boolean := false; v_nam boolean := false;
        v_dt boolean := false; v_ok boolean; d2 text; y int; m int; dd int;
begin
  if public.my_role() is distinct from 'seeker' then raise exception 'solo chi cerca lavoro'; end if;
  v := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_fmt := v ~ '^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$';
  if v_fmt then
    v_ctl := substr(v, 16, 1) = public._cf_checksum(substr(v, 1, 15));
    v_sur := substr(v, 1, 3) = public._cf_surname_code(p_last);
    v_nam := substr(v, 4, 3) = public._cf_name_code(p_first);
    d2 := translate(substr(v, 7, 2), 'LMNPQRSTUV', '0123456789');
    y := d2::int;
    m := position(substr(v, 9, 1) in 'ABCDEHLMPRST');
    dd := translate(substr(v, 10, 2), 'LMNPQRSTUV', '0123456789')::int;
    if dd > 40 then dd := dd - 40; end if;
    v_dt := p_birth is not null and y = extract(year from p_birth)::int % 100
            and m = extract(month from p_birth)::int and dd = extract(day from p_birth)::int;
  end if;
  v_ok := v_fmt and v_ctl and v_sur and v_nam and v_dt;
  if v_ok then
    begin
      insert into public.worker_identity (worker_id, tax_code) values (auth.uid(), v)
      on conflict (worker_id) do update set tax_code = excluded.tax_code, tax_code_checked_at = now();
    exception when unique_violation then
      raise exception 'questo codice fiscale risulta già associato a un altro account';
    end;
  end if;
  return jsonb_build_object('ok', v_ok, 'formato', v_fmt, 'controllo', v_ctl,
                            'cognome', v_sur, 'nome', v_nam, 'nascita', v_dt);
end $$;

-- 3) CONFERMA SUL CAMPO ---------------------------------------------------------------

create table public.identity_confirmations (
  id          uuid primary key default gen_random_uuid(),
  shift_id    uuid not null unique references public.shifts(id) on delete cascade,
  worker_id   uuid not null references public.profiles(id) on delete cascade,
  employer_id uuid not null references public.profiles(id) on delete cascade,
  outcome     text not null check (outcome in ('ok','foto_datata','non_corrisponde')),
  note        text not null default '' check (char_length(note) <= 300),
  created_at  timestamptz not null default now()
);
create index on public.identity_confirmations (worker_id);

create table public.identity_flags (        -- da gestire da un moderatore (non visibile ai client)
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references public.profiles(id) on delete cascade,
  shift_id    uuid references public.shifts(id) on delete set null,
  employer_id uuid references public.profiles(id) on delete set null,
  status      text not null default 'aperta' check (status in ('aperta','chiusa')),
  note        text not null default '',
  created_at  timestamptz not null default now()
);

alter table public.identity_confirmations enable row level security;
alter table public.identity_flags enable row level security;
revoke all on public.identity_confirmations, public.identity_flags from anon, authenticated;
grant select on public.identity_confirmations to authenticated;
create policy "conferme: le mie come organizzatore" on public.identity_confirmations
  for select to authenticated using (employer_id = auth.uid());

-- Al check-in l'organizzatore confronta foto del profilo e selfie e decide:
--   ok              la persona corrisponde: check-in confermato, foto riconfermata
--   foto_datata     è la persona ma la foto è vecchia: check-in confermato, foto da aggiornare
--   non_corrisponde NON è la persona: check-in NON confermato, segnalazione per la verifica
create function public.confirm_check_identity(p_check uuid, p_outcome text, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare v_ce public.check_events; v_sh public.shifts; v_j public.jobs;
begin
  if p_outcome not in ('ok','foto_datata','non_corrisponde') then raise exception 'esito non valido'; end if;
  select * into v_ce from public.check_events where id = p_check and kind = 'in';
  if not found then raise exception 'check-in non trovato'; end if;
  select * into v_sh from public.shifts where id = v_ce.shift_id;
  select * into v_j from public.jobs where id = v_sh.job_id;
  if v_j.employer_id is distinct from auth.uid() then raise exception 'non autorizzato'; end if;
  perform 1 from public.jobs where id = v_j.id for update;           -- ordine dei blocchi: prima l'annuncio
  if v_ce.confirmed_at is not null then raise exception 'già confermato'; end if;
  if exists (select 1 from public.identity_confirmations where shift_id = v_sh.id) then
    raise exception 'hai già valutato questa persona';
  end if;

  insert into public.identity_confirmations (shift_id, worker_id, employer_id, outcome, note)
  values (v_sh.id, v_sh.worker_id, auth.uid(), p_outcome, coalesce(p_note, ''));

  if p_outcome = 'non_corrisponde' then
    insert into public.identity_flags (worker_id, shift_id, employer_id, note)
    values (v_sh.worker_id, v_sh.id, auth.uid(), coalesce(p_note, ''));
    update public.profiles set photo_flagged_at = now() where id = v_sh.worker_id;
    perform public._notify(v_sh.worker_id, 'foto_da_aggiornare', 'Controllo sulla tua foto',
      'L''organizzatore ha segnalato che il selfie non corrisponde alla foto del profilo. Aggiorna la foto: se è un errore ci pensa il nostro controllo.', null, '{}');
    return;
  end if;

  perform public.employer_confirm_check(p_check);
  if p_outcome = 'ok' then
    update public.profiles set photo_checked_at = now(), photo_flagged_at = null where id = v_sh.worker_id;
  else
    update public.profiles set photo_flagged_at = now() where id = v_sh.worker_id;
    perform public._notify(v_sh.worker_id, 'foto_da_aggiornare', 'Aggiorna la foto del profilo',
      'L''organizzatore ti ha riconosciuto ma la foto del profilo è datata. Caricane una recente per mantenere la fiducia.', null, '{}');
  end if;
end $$;

-- 4) LIVELLI E PUNTEGGIO DI FIDUCIA -----------------------------------------------------

create or replace function public.verification_level(p_worker uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.is_verified(p_worker) then 'forte'
    when coalesce((select email_confirmed_at is not null and phone_confirmed_at is not null from auth.users where id = p_worker), false)
         and exists (select 1 from public.worker_identity where worker_id = p_worker) then 'base'
    else 'nessuna' end
$$;

create or replace function public.trust_info(p_worker uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email',      coalesce((select email_confirmed_at is not null from auth.users where id = p_worker), false),
    'telefono',   coalesce((select phone_confirmed_at is not null from auth.users where id = p_worker), false),
    'codice_fiscale', exists (select 1 from public.worker_identity where worker_id = p_worker),
    'forte',      public.is_verified(p_worker),
    'foto',       p.photo_path is not null,
    'foto_segnalata', coalesce(p.photo_flagged_at > coalesce(p.photo_set_at, '-infinity'::timestamptz), false),
    'foto_valida', p.photo_path is not null
                   and not coalesce(p.photo_flagged_at > coalesce(p.photo_set_at, '-infinity'::timestamptz), false)
                   and greatest(p.photo_set_at, p.photo_checked_at) > now() - interval '12 months',
    'conferme_sul_campo', (select count(distinct c.employer_id) from public.identity_confirmations c
                           where c.worker_id = p_worker and c.outcome = 'ok' and c.created_at > now() - interval '12 months'),
    'livello',    public.verification_level(p_worker),
    'punti',      public.trust_points(p_worker))
  from public.profiles p where p.id = p_worker
$$;

create or replace function public.trust_points(p_worker uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when public.is_verified(p_worker) then 10 else least(10,
      case when coalesce((select email_confirmed_at is not null and phone_confirmed_at is not null
                          from auth.users where id = p_worker), false) then 2 else 0 end
    + case when exists (select 1 from public.worker_identity where worker_id = p_worker) then 3 else 0 end
    + case when exists (select 1 from public.identity_confirmations c
                        where c.worker_id = p_worker and c.outcome = 'ok' and c.created_at > now() - interval '12 months')
                and exists (select 1 from public.profiles p where p.id = p_worker and p.photo_path is not null
                            and not coalesce(p.photo_flagged_at > coalesce(p.photo_set_at, '-infinity'::timestamptz), false)
                            and greatest(p.photo_set_at, p.photo_checked_at) > now() - interval '12 months')
           then 5 else 0 end) end
$$;

-- Ganci usati dalla scheda presenze
create or replace function public.identity_outcome_of(p_shift uuid) returns text
language sql stable security definer set search_path = public as $$
  select outcome from public.identity_confirmations where shift_id = p_shift
$$;

-- La foto del profilo la vede solo il proprietario o un organizzatore con cui ha un turno
create or replace function public.profile_photo_of(p_worker uuid) returns text
language sql stable security definer set search_path = public as $$
  select photo_path from public.profiles
  where id = p_worker and (id = auth.uid() or public.employer_of_worker(id))
$$;

-- Riepilogo per il lavoratore collegato
create function public.my_trust() returns jsonb
language sql stable security definer set search_path = public as $$
  select public.trust_info(auth.uid()) || jsonb_build_object(
    'foto_path', (select photo_path from public.profiles where id = auth.uid()),
    'foto_aggiornata_il', (select greatest(photo_set_at, photo_checked_at) from public.profiles where id = auth.uid()))
  where auth.uid() is not null
$$;

revoke all on function public.set_profile_photo(text), public.verify_tax_code(text, text, date, text),
  public.confirm_check_identity(uuid, text, text), public.my_trust(),
  public._cf_clean(text), public._cf_consonants(text), public._cf_vowels(text),
  public._cf_surname_code(text), public._cf_name_code(text), public._cf_checksum(text),
  public.verification_level(uuid), public.trust_info(uuid), public.trust_points(uuid),
  public.identity_outcome_of(uuid), public.profile_photo_of(uuid)
  from public, anon, authenticated;
grant execute on function public.set_profile_photo(text), public.verify_tax_code(text, text, date, text),
  public.confirm_check_identity(uuid, text, text), public.my_trust() to authenticated;
-- le altre sono interne (usate dalle classifiche e dalla scheda presenze)

-- 5) FOTO E SELFIE: regole di accesso allo storage (dopo aver creato i bucket PRIVATI "profili" e "checkins")
-- create function public.can_view_profile_photo(p_path text) returns boolean
-- language sql stable security definer set search_path = public as $$
--   select exists (select 1 from public.profiles p
--                  where p.photo_path = p_path and (p.id = auth.uid() or public.employer_of_worker(p.id)))
-- $$;
-- create policy "foto profilo: carico nella mia cartella" on storage.objects for insert to authenticated
--   with check (bucket_id = 'profili' and (storage.foldername(name))[1] = auth.uid()::text);
-- create policy "foto profilo: la vedo io o chi ha un turno con me" on storage.objects for select to authenticated
--   using (bucket_id = 'profili' and public.can_view_profile_photo(name));
