-- =====================================================================
-- FASE 2g: certificazione dell'identità, OPZIONALE e a carico di chi la vuole
--
-- Da eseguire DOPO schema.sql, fase2, 2b, 2c, 2d, 2e, 2f.
--
-- COME FUNZIONA
--  * L'organizzatore può chiedere, ruolo per ruolo, "solo persone con identità
--    verificata" (jobs.require_verified). A lui non costa nulla.
--  * Un lavoratore non verificato che riceve una proposta su quel ruolo (o si
--    candida) deve prima verificarsi: parte il servizio di identificazione, che
--    paga lui una volta sola. Se non vuole, la proposta resta senza effetto.
--  * La verifica vale 12 mesi (verification_months), poi va rinnovata.
--  * Chi è verificato mostra il bollino e sale in classifica di 10 punti.
--  * Qui conserviamo SOLO "verificato fino al...". Documenti e selfie di
--    identificazione restano al fornitore (es. Stripe Identity, Onfido, Veriff):
--    nessun documento passa dal nostro database.
--
-- COLLEGARE UN FORNITORE REALE
--  1. il lavoratore chiama start_verification(): nasce una richiesta con importo;
--  2. una Edge Function (non inclusa) apre pagamento + sessione di verifica del fornitore;
--  3. quando il fornitore conferma, il suo webhook chiama, con la chiave di
--     servizio, complete_verification(richiesta, 'ok' | 'rifiutata', riferimento).
--  complete_verification NON è chiamabile dall'app: solo dal server.
-- =====================================================================

alter table public.platform_settings
  add column verification_price_cents int not null default 1500,   -- segnaposto: dipende dal fornitore
  add column verification_months      int not null default 12;

alter table public.profiles
  add column verified_until      timestamptz,
  add column verification_level  text check (verification_level in ('forte'));
-- verified_until e verification_level non sono scrivibili dai client (permessi a colonna in schema.sql)

alter table public.jobs add column require_verified boolean not null default false;

create table public.verification_requests (
  id           uuid primary key default gen_random_uuid(),
  worker_id    uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'avviata'
    check (status in ('avviata','completata','rifiutata','scaduta')),
  amount_cents int not null,
  provider     text,
  provider_ref text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.verification_requests (worker_id, created_at desc);

alter table public.verification_requests enable row level security;
revoke all on public.verification_requests from anon, authenticated;
grant select on public.verification_requests to authenticated;
create policy "verifiche: le mie" on public.verification_requests
  for select to authenticated using (worker_id = auth.uid());

-- Sostituiscono gli agganci della Fase 2
create or replace function public.is_verified(p_worker uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select verified_until > now() from public.profiles where id = p_worker), false)
$$;

create or replace function public.job_requires_verification(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select require_verified from public.jobs where id = p_job), false)
$$;

create or replace function public.job_allows_worker(p_job uuid, p_worker uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not public.job_requires_verification(p_job) or public.is_verified(p_worker)
$$;

-- Stato della certificazione del lavoratore collegato
create function public.my_verification() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'verificato', public.is_verified(auth.uid()),
    'valida_fino_al', (select verified_until from public.profiles where id = auth.uid()),
    'richiesta_in_corso', (select id from public.verification_requests
                           where worker_id = auth.uid() and status = 'avviata'
                           order by created_at desc limit 1),
    'prezzo_cents', (select verification_price_cents from public.platform_settings),
    'mesi', (select verification_months from public.platform_settings))
  where auth.uid() is not null
$$;

-- Il lavoratore avvia la verifica (e accetta di pagarne il costo)
create function public.start_verification() returns uuid
language plpgsql security definer set search_path = public as $$
declare v_s public.platform_settings; v_id uuid; v_until timestamptz;
begin
  if public.my_role() is distinct from 'seeker' then raise exception 'solo chi cerca lavoro può verificarsi'; end if;
  select verified_until into v_until from public.profiles where id = auth.uid();
  if v_until is not null and v_until > now() + interval '30 days' then
    raise exception 'sei già verificato fino al %', to_char(v_until, 'DD/MM/YYYY');
  end if;
  select id into v_id from public.verification_requests
   where worker_id = auth.uid() and status = 'avviata' and created_at > now() - interval '24 hours'
   order by created_at desc limit 1;
  if v_id is not null then return v_id; end if;
  select * into v_s from public.platform_settings;
  insert into public.verification_requests (worker_id, amount_cents)
  values (auth.uid(), v_s.verification_price_cents) returning id into v_id;
  return v_id;
end $$;

-- SOLO SERVER (webhook del fornitore): chiude la richiesta e assegna il bollino
create function public.complete_verification(p_request uuid, p_outcome text, p_provider_ref text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_r public.verification_requests; v_s public.platform_settings;
begin
  select * into v_r from public.verification_requests where id = p_request for update;
  if not found then raise exception 'richiesta non trovata'; end if;
  if v_r.status <> 'avviata' then return; end if;                 -- idempotente
  select * into v_s from public.platform_settings;
  if p_outcome = 'ok' then
    update public.verification_requests set status = 'completata', provider_ref = p_provider_ref, updated_at = now() where id = v_r.id;
    update public.profiles
       set verified_until = greatest(coalesce(verified_until, now()), now()) + make_interval(months => v_s.verification_months),
           verification_level = 'forte'
     where id = v_r.worker_id;
    perform public._notify(v_r.worker_id, 'verifica_completata', 'Identità verificata',
      'Hai il bollino fino al ' || to_char((select verified_until from public.profiles where id = v_r.worker_id), 'DD/MM/YYYY')
      || '. Puoi accettare anche i ruoli riservati a persone verificate.', null, '{}');
  else
    update public.verification_requests set status = 'rifiutata', provider_ref = p_provider_ref, updated_at = now() where id = v_r.id;
    perform public._notify(v_r.worker_id, 'verifica_rifiutata', 'Verifica non riuscita',
      'Il fornitore non ha potuto confermare la tua identità. Puoi riprovare dal profilo.', null, '{}');
  end if;
end $$;

revoke all on function public.is_verified(uuid), public.job_requires_verification(uuid),
  public.job_allows_worker(uuid, uuid), public.complete_verification(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.my_verification(), public.start_verification() from public, anon;
grant execute on function public.my_verification(), public.start_verification() to authenticated;
-- complete_verification, is_verified, job_*: solo server
