-- =====================================================================
-- SCHEMA DATABASE: app incontro domanda/offerta di lavoro
-- Da incollare nel "SQL Editor" di Supabase e premere RUN (una sola volta)
-- =====================================================================

-- 1) TIPI E TABELLE ---------------------------------------------------

create type public.user_role as enum ('seeker', 'employer');
-- seeker = cerca lavoro, employer = offre lavoro

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        public.user_role not null,
  full_name   text not null check (char_length(full_name) between 2 and 100),
  email       text,
  city        text check (char_length(city) <= 100),
  phone       text check (char_length(phone) <= 30),
  bio         text check (char_length(bio) <= 2000),
  consent_at  timestamptz not null default now(),   -- quando ha accettato la privacy
  created_at  timestamptz not null default now()
);

create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  employer_id   uuid not null references public.profiles(id) on delete cascade,
  company_name  text not null check (char_length(company_name) between 2 and 120),
  title         text not null check (char_length(title) between 3 and 120),
  description   text not null check (char_length(description) between 10 and 5000),
  city          text not null check (char_length(city) between 2 and 100),
  contract_type text check (char_length(contract_type) <= 60),
  is_open       boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.applications (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  seeker_id   uuid not null references public.profiles(id) on delete cascade,
  message     text check (char_length(message) <= 2000),
  created_at  timestamptz not null default now(),
  unique (job_id, seeker_id)          -- una sola candidatura per annuncio
);

create index on public.jobs (created_at desc);
create index on public.jobs (employer_id);
create index on public.applications (job_id);
create index on public.applications (seeker_id);

-- 2) CREAZIONE AUTOMATICA DEL PROFILO ALLA REGISTRAZIONE ---------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'seeker')::public.user_role,
    left(coalesce(new.raw_user_meta_data->>'full_name', 'Utente'), 100),
    new.email
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) CANCELLAZIONE ACCOUNT (diritto all'oblio, GDPR) -------------------

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  delete from auth.users where id = auth.uid();   -- cancella a cascata tutto
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Ruolo dell'utente collegato. Funzione "security definer": legge profiles
-- senza passare dalle regole di sicurezza, ed evita il ciclo
-- profiles -> applications -> profiles ("infinite recursion detected in policy").
create or replace function public.my_role()
returns public.user_role
language sql stable security definer
set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;

-- 4) SICUREZZA: ROW LEVEL SECURITY -------------------------------------
-- Regola base: tutto è CHIUSO, poi apriamo solo ciò che serve.

alter table public.profiles     enable row level security;
alter table public.jobs         enable row level security;
alter table public.applications enable row level security;

-- Permessi a livello di colonna: nessuno può cambiare il ruolo o l'email
revoke update on public.profiles from authenticated, anon;
grant  update (full_name, city, phone, bio) on public.profiles to authenticated;

-- PROFILI -------------------------------------------------------------
-- Ognuno vede il proprio profilo
create policy "profilo: leggo il mio"
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Un datore di lavoro vede SOLO i profili di chi si è candidato ai suoi annunci
create policy "profilo: datore vede i candidati"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1
      from public.applications a
      join public.jobs j on j.id = a.job_id
      where a.seeker_id = profiles.id
        and j.employer_id = auth.uid()
    )
  );

create policy "profilo: modifico il mio"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- (nessuna policy di insert/delete: il profilo nasce dal trigger
--  e si cancella con delete_my_account())

-- ANNUNCI -------------------------------------------------------------
-- Gli annunci aperti sono pubblici (visibili anche senza login)
create policy "annunci: aperti visibili a tutti"
  on public.jobs for select to anon, authenticated
  using (is_open = true or employer_id = auth.uid());

create policy "annunci: solo datori creano i propri"
  on public.jobs for insert to authenticated
  with check (
    employer_id = auth.uid()
    and public.my_role() = 'employer'
  );

create policy "annunci: modifico i miei"
  on public.jobs for update to authenticated
  using (employer_id = auth.uid())
  with check (employer_id = auth.uid());

create policy "annunci: cancello i miei"
  on public.jobs for delete to authenticated
  using (employer_id = auth.uid());

-- CANDIDATURE ---------------------------------------------------------
create policy "candidature: le vede chi le ha inviate o il datore dell'annuncio"
  on public.applications for select to authenticated
  using (
    seeker_id = auth.uid()
    or exists (select 1 from public.jobs j
               where j.id = applications.job_id and j.employer_id = auth.uid())
  );

create policy "candidature: solo chi cerca lavoro, solo su annunci aperti"
  on public.applications for insert to authenticated
  with check (
    seeker_id = auth.uid()
    and public.my_role() = 'seeker'
    and exists (select 1 from public.jobs j
                where j.id = job_id and j.is_open = true)
  );

create policy "candidature: ritiro la mia"
  on public.applications for delete to authenticated
  using (seeker_id = auth.uid());
