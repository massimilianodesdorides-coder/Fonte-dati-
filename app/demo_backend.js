/* =====================================================================
   MOTORE DEMO: un vero PostgreSQL (PGlite) nel browser, con gli stessi file SQL
   del progetto e le stesse regole di sicurezza. Espone la stessa interfaccia
   di supabase-js (auth, from, rpc) così l'app non sa se è in demo o online.
   ===================================================================== */
async function makeDemoBackend() {
  const { PGlite } = PGliteLib;
  const ident = s => { if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) throw new Error('nome non valido: ' + s); return s; };

  async function unz(id) {
    const bin = Uint8Array.from(atob(document.getElementById(id).textContent.trim()), c => c.charCodeAt(0));
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }
  const wasm = await WebAssembly.compile(await unz('pg-wasm'));
  const dataBlob = new Blob([await unz('pg-data')]);
  const sqls = JSON.parse(document.getElementById('demo-sql').textContent);

  let pg, uid = null, procs = {};
  async function boot() {
    pg = await PGlite.create({ wasmModule: wasm, fsBundle: dataBlob });
    for (const s of sqls) await pg.exec(s.sql);
    const r = await pg.query(`select p.proname, p.proretset from pg_proc p
                              join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
    procs = {}; r.rows.forEach(x => procs[x.proname] = x.proretset);
  }
  await boot();

  const norm = res => res.rows.map(r => {
    const o = {};
    res.fields.forEach(f => {
      let v = r[f.name];
      if (v instanceof Date) v = f.dataTypeID === 1082 ? v.toISOString().slice(0, 10) : v.toISOString();
      else if (typeof v === 'bigint') v = Number(v);
      else if (f.dataTypeID === 1700 && v != null) v = Number(v);
      o[f.name] = v;
    });
    return o;
  });
  const asUser = fn => pg.transaction(async tx => {
    await tx.exec(uid ? 'set local role authenticated' : 'set local role anon');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || '']);
    return fn(tx);
  });
  const fail = e => ({ data: null, error: { message: (e && e.message) || String(e) } });

  /* ---- costruttore di query in stile supabase-js ---- */
  class QB {
    constructor(t) { this.t = ident(t); this.op = 'select'; this.cols = '*'; this.f = []; this.ord = []; this.lim = null; this.pay = null; this.ret = null; this.one = null; }
    select(c = '*') { if (this.op === 'select') this.cols = c; else this.ret = c; return this; }
    insert(o) { this.op = 'insert'; this.pay = o; return this; }
    update(o) { this.op = 'update'; this.pay = o; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push([c, '=', v]); return this; }
    neq(c, v) { this.f.push([c, '<>', v]); return this; }
    gt(c, v) { this.f.push([c, '>', v]); return this; }
    gte(c, v) { this.f.push([c, '>=', v]); return this; }
    lt(c, v) { this.f.push([c, '<', v]); return this; }
    lte(c, v) { this.f.push([c, '<=', v]); return this; }
    in(c, a) { this.f.push([c, 'in', a]); return this; }
    is(c, v) { this.f.push([c, 'is', v]); return this; }
    order(c, o = {}) { this.ord.push(`${ident(c)} ${o.ascending === false ? 'desc' : 'asc'}`); return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    then(res, rej) { return this.exec().then(res, rej); }
    cols_(c) { if (c === '*') return '*'; return c.split(',').map(x => ident(x.trim())).join(', '); }
    async exec() {
      try {
        const p = []; const bind = v => { p.push(v); return '$' + p.length; };
        let where = '';
        if (this.f.length) {
          where = ' where ' + this.f.map(([c, o, v]) => {
            ident(c);
            if (o === 'in') return v.length ? `${c} in (${v.map(bind).join(',')})` : 'false';
            if (o === 'is') return `${c} is ${v === null ? 'null' : v ? 'true' : 'false'}`;
            return `${c} ${o} ${bind(v)}`;
          }).join(' and ');
        }
        let sql, ret = this.ret ? ` returning ${this.cols_(this.ret)}` : '';
        if (this.op === 'select') {
          sql = `select ${this.cols_(this.cols)} from public.${this.t}${where}` +
                (this.ord.length ? ' order by ' + this.ord.join(', ') : '') + (this.lim ? ` limit ${Number(this.lim)}` : '');
        } else if (this.op === 'insert') {
          const rows = Array.isArray(this.pay) ? this.pay : [this.pay];
          const keys = Object.keys(rows[0]).map(ident);
          sql = `insert into public.${this.t} (${keys.join(',')}) values ` +
                rows.map(r => '(' + keys.map(k => bind(r[k])).join(',') + ')').join(',') + ret;
        } else if (this.op === 'update') {
          const keys = Object.keys(this.pay).map(ident);
          sql = `update public.${this.t} set ${keys.map(k => `${k} = ${bind(this.pay[k])}`).join(', ')}${where}${ret}`;
        } else {
          sql = `delete from public.${this.t}${where}${ret}`;
        }
        const res = await asUser(tx => tx.query(sql, p));
        const rows = norm(res);
        if (this.one === 'single') {
          if (rows.length !== 1) return fail(new Error('JSON object requested, multiple (or no) rows returned'));
          return { data: rows[0], error: null };
        }
        if (this.one === 'maybe') return { data: rows[0] || null, error: null };
        return { data: this.op === 'select' || this.ret ? rows : null, error: null };
      } catch (e) { return fail(e); }
    }
  }

  const sb = {
    from: t => new QB(t),
    async rpc(name, args = {}) {
      try {
        ident(name);
        const keys = Object.keys(args);
        const sql = `select * from public.${name}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
        const res = await asUser(tx => tx.query(sql, keys.map(k => args[k])));
        const rows = norm(res);
        if (procs[name]) return { data: rows, error: null };
        if (!rows.length || res.fields[0].dataTypeID === 2278) return { data: null, error: null };
        const v = Object.values(rows[0])[0];
        return { data: v === undefined ? null : v, error: null };
      } catch (e) { return fail(e); }
    },
    auth: {
      async getSession() { return { data: { session: uid ? { user: { id: uid } } : null } }; },
      async signUp({ email, options }) {
        try {
          const ex = await pg.query('select 1 from auth.users where lower(email) = lower($1)', [email]);
          if (ex.rows.length) return { data: null, error: { message: 'User already registered' } };
          const r = await pg.query('insert into auth.users(email, raw_user_meta_data) values ($1, $2) returning id',
                                   [email, JSON.stringify((options && options.data) || {})]);
          uid = r.rows[0].id;
          return { data: { user: { id: uid }, session: { user: { id: uid } } }, error: null };
        } catch (e) { return fail(e); }
      },
      async signInWithPassword({ email }) {
        const r = await pg.query('select id from auth.users where lower(email) = lower($1)', [email]);
        if (!r.rows.length) return { data: null, error: { message: 'Invalid login credentials' } };
        uid = r.rows[0].id; return { data: { session: { user: { id: uid } } }, error: null };
      },
      async signOut() { uid = null; return { error: null }; },
      async resetPasswordForEmail() { return { data: {}, error: null }; },
    },
    storage: { from: () => ({
      upload: async () => ({ data: {}, error: null }),
      createSignedUrl: async () => ({ data: null, error: { message: 'In demo i selfie non vengono conservati.' } }),
    }) },
  };

  /* ---- strumenti per provare l'app ---- */
  const demo = {
    async users() {
      const r = await pg.query(`select d.id, d.label, d.descr, d.ord, p.role from demo_users d
                                join profiles p on p.id = d.id order by d.ord`);
      return r.rows;
    },
    loginAs(id) { uid = id; },
    currentId() { return uid; },
    async advance(seconds) {
      await pg.exec('set session_replication_role = replica');
      await pg.query(`update jobs set starts_at = starts_at - make_interval(secs => $1), ends_at = ends_at - make_interval(secs => $1)`, [seconds]);
      await pg.query(`update offers set expires_at = expires_at - make_interval(secs => $1) where status = 'inviata'`, [seconds]);
      await pg.exec('set session_replication_role = origin');
    },
    async startNextEvent() {
      // tutti i ruoli del prossimo evento risultano iniziati da 30 minuti
      const r = await pg.query(`select event_id from jobs where starts_at > now() order by starts_at limit 1`);
      if (!r.rows.length) return false;
      await pg.exec('set session_replication_role = replica');
      await pg.query(`update jobs set ends_at = ends_at - (starts_at - (now() - interval '30 minutes')),
                                      starts_at = now() - interval '30 minutes'
                      where event_id = $1 and starts_at > now()`, [r.rows[0].event_id]);
      await pg.exec('set session_replication_role = origin');
      return true;
    },
    async endRunningEvents() {
      await pg.exec('set session_replication_role = replica');
      await pg.exec(`update jobs set ends_at = now() - interval '1 hour', starts_at = least(starts_at, now() - interval '7 hours')
                     where starts_at <= now() and ends_at > now()`);
      await pg.exec('set session_replication_role = origin');
    },
    async expireOffers() { await pg.exec(`update offers set expires_at = now() - interval '1 minute' where status = 'inviata'`); },
    async completeVerification(requestId, outcome) { await pg.query(`select complete_verification($1, $2, 'demo')`, [requestId, outcome]); },
    async generateWorkers(n) { const r = await pg.query(`select test_generate_workers($1, 'Milano', 30) as n`, [n]); return r.rows[0].n; },
    async purgeTest() { const r = await pg.query(`select test_purge() as n`); return r.rows[0].n; },
    async cron() {
      await pg.exec('select run_offer_maintenance()');
      await pg.exec('select close_guarantees()');
    },
    async reset() { const keep = null; uid = keep; await pg.close(); await boot(); },
  };
  sb.demo = demo;
  return sb;
}
