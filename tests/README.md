# Test automatici

Servono Node 22+ e (per l'interfaccia) un browser Chromium.

```bash
cd tests && npm install          # una volta
npm run test:sql                 # database: regole, sicurezza, fiducia, invarianti (circa 1 minuto)
npm run test:e2e                 # interfaccia (serve demo.html: vedi sotto)
npm test                         # tutto, tranne la concorrenza
PG_URL=postgres://utente@localhost:5432/postgres npm run test:concurrency   # concorrenza su un PostgreSQL vero
```

Per l'interfaccia serve prima la demo:

```bash
cd tools && npm install          # una volta (PGlite e esbuild)
cd .. && python3 tools/build.py  # genera demo.html
```

Se Chromium non è in un percorso standard: `CHROMIUM_PATH=/percorso/chromium npm run test:e2e`.

Cosa copre ogni livello e cosa manca: **`PIANO_TEST.md`**.
`ci/github-actions.yml` è un esempio pronto da copiare in `.github/workflows/` per lanciare tutto ad ogni modifica.
