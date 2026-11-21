#!/usr/bin/env python3
"""Assembla l'app in pagine singole.

  python3 tools/build.py

Produce (nella cartella del progetto):
  app.html            versione ONLINE: collega Supabase (inserisci URL e chiave in CFG)
  demo.html           versione DEMO standalone: database PostgreSQL nel browser, si apre da file
  demo.fragment.html  la stessa demo senza <html>/<head>, per la pubblicazione come artefatto

La demo incorpora PGlite (PostgreSQL compilato in WebAssembly). Serve una volta:
  cd tools && npm install @electric-sql/pglite@0.2.17 esbuild
oppure imposta PGLITE_DIR su una cartella che li contiene.
"""
import base64, gzip, json, os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PG = os.environ.get('PGLITE_DIR', os.path.join(ROOT, 'tools'))
rd = lambda *p: open(os.path.join(ROOT, *p), encoding='utf-8').read()

css, appjs, backend, seed = rd('app/style.css'), rd('app/app.js'), rd('app/demo_backend.js'), rd('app/demo_seed.sql')
FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap">'
HEAD = '<title>Lavoro Facile</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n' + FONTS + '\n<style>\n' + css + '\n</style>\n'
safe = lambda s: s.replace('</script', '<\\/script')

# --- versione online -------------------------------------------------
online_js = appjs.replace('/*__DEMO__*/false', 'false')
online_body = '<div id="app"></div>\n<script>\n' + safe(online_js) + '\n</script>\n'

# --- versione demo -----------------------------------------------------
def b64gz(path):
    return base64.b64encode(gzip.compress(open(path, 'rb').read(), 9)).decode()
dist = os.path.join(PG, 'node_modules', '@electric-sql', 'pglite', 'dist')
iife = os.path.join(PG, 'pglite.iife.js')
if not os.path.exists(iife):
    entry = os.path.join(PG, 'entry.js')
    open(entry, 'w').write("export { PGlite } from '@electric-sql/pglite';\n")
    subprocess.check_call(['npx', 'esbuild', 'entry.js', '--bundle', '--format=iife', '--global-name=PGliteLib',
                           '--minify', '--platform=browser', '--outfile=pglite.iife.js'], cwd=PG)
STUB = """
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
"""
files = ['schema.sql', 'schema_fase2.sql', 'schema_fase2b_matching.sql', 'schema_fase2c_calendario.sql',
         'schema_fase2d_evento_completo.sql', 'schema_fase2e_canali_scheda.sql', 'schema_fase2f_rating_organizzatori.sql',
         'schema_fase2g_verifica_identita.sql', 'tools/test_utenti.sql']
sqls = [{'name': 'stub', 'sql': STUB}] + [{'name': f, 'sql': rd(f)} for f in files] + [{'name': 'seed', 'sql': seed}]
sqljson = json.dumps(sqls).replace('<', '\\u003c')

demo_js = re.sub(r'/\*__DL_START__\*/.*?/\*__DL_END__\*/', '', appjs.replace('/*__DEMO__*/false', 'true'), flags=re.S)
demo_body = ('<div id="app"></div>\n'
    '<script id="pg-wasm" type="application/octet-stream">' + b64gz(os.path.join(dist, 'postgres.wasm')) + '</script>\n'
    '<script id="pg-data" type="application/octet-stream">' + b64gz(os.path.join(dist, 'postgres.data')) + '</script>\n'
    '<script id="demo-sql" type="application/json">' + sqljson + '</script>\n'
    '<script>\n' + safe(open(iife, encoding='utf-8').read()) + '\n</script>\n'
    '<script>\n' + safe(backend) + '\n' + safe(demo_js) + '\n</script>\n')

def full(head, body):
    m = re.search(r'<title>.*?</title>', head)
    return ('<!doctype html>\n<html lang="it"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            + head + '</head><body>\n' + body + '</body></html>\n')

out = {'app.html': full(HEAD, online_body), 'demo.html': full(HEAD, demo_body), 'demo.fragment.html': HEAD + demo_body}
for name, text in out.items():
    open(os.path.join(ROOT, name), 'w', encoding='utf-8').write(text)
    print(f'{name}: {len(text) // 1024} KB')
