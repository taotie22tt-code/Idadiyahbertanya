// Cloudflare Worker: aset PWA + API. Database: Neon PostgreSQL.
// Rahasia (DATABASE_URL, ADMIN_PASSWORD, ACCESS_CODE, SESSION_SECRET) hanya lewat `wrangler secret put`.
import * as Core from './public/core.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
};
const TTL = { admin: 12 * 3600, petugas: 7 * 86400 }; // detik
const MAX_BODY = 3_000_000, MAX_ROWS = 20000, MAX_FAILS = 5;
const KEYS = Core.COLS.map(c => c.toLowerCase().replace(/ /g, '_')); // no, idpps, nama, ... ket_tes

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers }
});
const enc = s => new TextEncoder().encode(s);
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc(data)));
}
async function safeEqual(a, b) { // waktu perbandingan tetap
  const [x, y] = await Promise.all([Core.sha256(String(a)), Core.sha256(String(b))]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
async function roleOf(request, env) {
  const m = /(?:^|;\s*)sess=([^;]+)/.exec(request.headers.get('Cookie') || '');
  if (!m) return null;
  const [role, exp, sig] = m[1].split('.');
  if (!TTL[role] || !sig || !(Number(exp) > Date.now() / 1000)) return null;
  return (await safeEqual(sig, await hmac(env.SESSION_SECRET, role + '.' + exp))) ? role : null;
}
const cookie = (value, maxAge) => `sess=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function neonSql(env) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(env.DATABASE_URL);
  return { query: (text, params) => sql.query(text, params) };
}

// Satu pernyataan atomik: buat versi baru, isi peserta, arsipkan versi lama, pindahkan penunjuk aktif, catat riwayat.
// Jika salah satu bagian gagal, tidak ada yang berubah (dataset lama tetap aktif).
const PUBLISH_SQL = `
WITH nv AS (SELECT COALESCE(MAX(version), 0) + 1 AS v FROM datasets),
old AS (UPDATE datasets SET status = 'archived' WHERE status = 'active' RETURNING 1),
ds AS (
  INSERT INTO datasets (version, status, source_filename, row_count, checksum)
  SELECT v, 'active', $1, $2, $3 FROM nv RETURNING id, version
),
ins AS (
  INSERT INTO participants (dataset_id, no, idpps, nama, dom, kelas_baru, guru_baru, pos, kelas_pagi, ruang_ujian, juri, ket_tes)
  SELECT ds.id, r.no, r.idpps, r.nama, r.dom, r.kelas_baru, r.guru_baru, r.pos, r.kelas_pagi, r.ruang_ujian, r.juri, r.ket_tes
  FROM ds, jsonb_to_recordset($4::jsonb) AS r(no text, idpps text, nama text, dom text, kelas_baru text, guru_baru text, pos text, kelas_pagi text, ruang_ujian text, juri text, ket_tes text)
  RETURNING 1
),
st AS (UPDATE app_state SET active_dataset_id = (SELECT id FROM ds), updated_at = now() WHERE id = 1 RETURNING 1),
lg AS (
  INSERT INTO import_logs (dataset_id, file_name, status, source_rows, valid_rows, rejected_rows, errors)
  SELECT ds.id, $1, 'berhasil', $5, $2, $6, $7::jsonb FROM ds RETURNING 1
)
SELECT (SELECT id FROM ds) AS id, (SELECT version FROM ds) AS version`;

export async function handle(request, env, sqlOverride) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/api/')) {
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    if (path === '/sw.js' || path === '/manifest.webmanifest') headers.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  if (path === '/api/health') return json({ ok: true });
  if (!env.DATABASE_URL || !env.ADMIN_PASSWORD || !env.ACCESS_CODE || !env.SESSION_SECRET) {
    return json({ error: 'Konfigurasi server belum lengkap.' }, 500);
  }
  if (request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Asal permintaan tidak diizinkan.' }, 403);
  }

  try {
    const db = sqlOverride || await neonSql(env);

    if (path === '/api/login' && request.method === 'POST') {
      const body = await readJson(request, 2000);
      const code = body && typeof body.code === 'string' ? body.code : '';
      if (!code || code.length > 200) return json({ error: 'Kode akses wajib diisi.' }, 400);
      const ip = request.headers.get('CF-Connecting-IP') || 'tidak-diketahui';
      const fails = await db.query(`SELECT count(*)::int AS n FROM login_attempts WHERE ip = $1 AND created_at > now() - interval '15 minutes'`, [ip]);
      if ((fails[0] ? fails[0].n : 0) >= MAX_FAILS) return json({ error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' }, 429);
      const role = (await safeEqual(code, env.ADMIN_PASSWORD)) ? 'admin' : (await safeEqual(code, env.ACCESS_CODE)) ? 'petugas' : null;
      if (!role) {
        await db.query('INSERT INTO login_attempts (ip) VALUES ($1)', [ip]);
        await db.query(`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`, []);
        return json({ error: 'Kode akses salah.' }, 401);
      }
      const exp = Math.floor(Date.now() / 1000) + TTL[role];
      const token = `${role}.${exp}.${await hmac(env.SESSION_SECRET, role + '.' + exp)}`;
      return json({ role }, 200, { 'Set-Cookie': cookie(token, TTL[role]) });
    }
    if (path === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });

    const role = await roleOf(request, env);
    if (!role) return json({ error: 'Belum masuk.' }, 401);

    if (path === '/api/me') return json({ role });

    if (path === '/api/dataset/meta') {
      const r = await db.query(`SELECT d.version, d.row_count AS count, d.checksum, d.created_at FROM app_state s JOIN datasets d ON d.id = s.active_dataset_id WHERE s.id = 1`, []);
      return json(r[0] ? { empty: false, ...r[0] } : { empty: true });
    }

    if (path === '/api/dataset') {
      const m = await db.query(`SELECT d.id, d.version, d.row_count AS count, d.checksum FROM app_state s JOIN datasets d ON d.id = s.active_dataset_id WHERE s.id = 1`, []);
      if (!m[0]) return json({ empty: true });
      const p = await db.query(`SELECT ${KEYS.join(', ')} FROM participants WHERE dataset_id = $1 ORDER BY idpps`, [m[0].id]);
      const rows = p.map(x => { const o = {}; Core.COLS.forEach((c, i) => { o[c] = x[KEYS[i]]; }); return o; });
      return json({ empty: false, version: m[0].version, count: m[0].count, checksum: m[0].checksum, rows });
    }

    if (role !== 'admin') return json({ error: 'Hanya admin yang boleh mengakses ini.' }, 403);

    if (path === '/api/admin/imports') {
      const r = await db.query(`SELECT id, file_name, status, source_rows, valid_rows, rejected_rows, created_at FROM import_logs ORDER BY id DESC LIMIT 20`, []);
      return json({ imports: r });
    }

    if (path === '/api/admin/import' && request.method === 'POST') {
      const body = await readJson(request, MAX_BODY);
      if (!body || typeof body.fileName !== 'string' || !Array.isArray(body.matrix)) return json({ error: 'Data impor tidak valid.' }, 400);
      if (body.matrix.length > MAX_ROWS + 1) return json({ error: `Terlalu banyak baris (maksimal ${MAX_ROWS}).` }, 413);
      const fileName = body.fileName.slice(0, 200) || 'tanpa-nama';
      const v = Core.validate(body.matrix);
      const errors = JSON.stringify(v.rejected.slice(0, 100));
      if (v.fatal || v.rows.length === 0) {
        await db.query(`INSERT INTO import_logs (file_name, status, source_rows, valid_rows, rejected_rows, errors) VALUES ($1,'ditolak',$2,0,$3,$4::jsonb)`,
          [fileName, v.source, v.rejected.length, v.fatal ? JSON.stringify([{ line: 1, reason: v.fatal }]) : errors]);
        return json({ error: v.fatal || 'Tidak ada baris valid. Data aktif tidak diganti.' }, 400);
      }
      if (v.rejected.length > 0 && body.confirmRejected !== true) {
        return json({ error: `${v.rejected.length} baris ditolak. Konfirmasi dulu untuk melanjutkan.`, rejected: v.rejected.slice(0, 20) }, 409);
      }
      const checksum = await Core.sha256(Core.checksumText(v.rows));
      const dbRows = JSON.stringify(v.rows.map(r => { const o = {}; Core.COLS.forEach((c, i) => { o[KEYS[i]] = r[c]; }); return o; }));
      const res = await db.query(PUBLISH_SQL, [fileName, v.rows.length, checksum, dbRows, v.source, v.rejected.length, errors]);
      const version = res[0].version;
      await db.query('DELETE FROM datasets WHERE version <= $1', [version - 3]); // simpan 3 versi terakhir
      return json({ ok: true, version, previousVersion: version - 1, count: v.rows.length, rejected: v.rejected.length, checksum });
    }

    return json({ error: 'Endpoint tidak ditemukan.' }, 404);
  } catch (e) {
    console.error('API error:', e && e.name); // jangan catat e.message: bisa memuat alamat database
    return json({ error: 'Terjadi kesalahan di server.' }, e && e.status ? e.status : 500);
  }
}

async function readJson(request, max) {
  const text = await request.text();
  if (text.length > max) { const e = new Error('besar'); e.status = 413; throw e; }
  try { return JSON.parse(text); } catch { const e = new Error('json'); e.status = 400; throw e; }
}

export default { fetch: (request, env) => handle(request, env, null) };

