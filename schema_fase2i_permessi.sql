-- =====================================================================
-- FASE 2i: difesa in profondità sui permessi
--
-- Da eseguire per ULTIMA, dopo tutti gli altri schemi.
--
-- Perché serve: Supabase concede di default tutti i permessi sulle tabelle ai ruoli
-- "anon" e "authenticated"; la sicurezza dipende quindi solo dalle regole di riga (RLS).
-- Una regola dimenticata o scritta male esporrebbe i dati. Qui togliamo i permessi che
-- nessuna funzione dell'app usa: serve una seconda chiave per aprire qualcosa.
-- =====================================================================

-- anonimo: può solo leggere ruoli, eventi e annunci pubblici
revoke all on all tables in schema public from anon;
grant select on public.jobs, public.events, public.job_roles to anon;

-- utenti collegati: via i permessi che non hanno una regola corrispondente
revoke insert, delete on public.profiles from authenticated;     -- il profilo nasce dal trigger e si cancella con delete_my_account()
revoke update on public.applications from authenticated;         -- lo stato delle candidature non si modifica dai client

-- da ora, ogni tabella o funzione nuova nasce CHIUSA: i permessi vanno concessi di proposito
alter default privileges in schema public revoke all on tables from anon, authenticated;
-- (PostgreSQL concede di serie l'esecuzione a tutti: si toglie senza "in schema")
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
