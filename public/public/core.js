// Logika murni (tanpa DOM). Dipakai browser, Worker, dan tes Node.
export const COLS = ['NO', 'IDPPS', 'NAMA', 'DOM', 'KELAS BARU', 'GURU BARU', 'POS', 'KELAS PAGI', 'RUANG UJIAN', 'JURI', 'KET TES'];
export const HEADER = ['No', 'IDPPS', 'NAMA', 'DOM', 'KELAS BARU', 'GURU BARU', 'POS', 'KELAS PAGI', 'RUANG UJIAN', 'JURI', 'KET TES']; // persis seperti di Excel
export const ID_RE = /^\d{8}$/;

const txt = v => (v == null ? '' : String(v).trim());

// matrix: baris pertama = header, kolom A-K. Jumlah baris bebas. Isi sumber tidak diubah selain trim spasi tepi.
export function validate(matrix) {
  const out = { fatal: null, rows: [], rejected: [], emptyCells: 0, source: 0 };
  if (!Array.isArray(matrix) || !matrix.length) { out.fatal = 'File kosong.'; return out; }
  const head = (Array.isArray(matrix[0]) ? matrix[0] : []).slice(0, 11).map(x => txt(x).toUpperCase());
  const bad = COLS.filter((c, i) => head[i] !== c);
  if (bad.length) { out.fatal = 'Header kolom A–K tidak sesuai. Periksa kolom: ' + bad.join(', ') + '.'; return out; }

  const count = {}, lines = [];
  for (let r = 1; r < matrix.length; r++) {
    const line = Array.isArray(matrix[r]) ? matrix[r] : [];
    const v = COLS.map((_, i) => txt(line[i]));
    if (v.every(x => x === '')) continue;
    out.source++;
    lines.push({ n: r + 1, v });
    count[v[1]] = (count[v[1]] || 0) + 1;
  }
  for (const l of lines) {
    const id = l.v[1];
    let why = null;
    if (!ID_RE.test(id)) why = 'IDPPS harus 8 digit angka (isi: "' + id + '")';
    else if (count[id] > 1) why = 'IDPPS ' + id + ' ganda (' + count[id] + ' baris), semua barisnya ditolak';
    if (why) { out.rejected.push({ line: l.n, reason: why }); continue; }
    const o = {};
    COLS.forEach((c, i) => { o[c] = l.v[i]; if (l.v[i] === '') out.emptyCells++; });
    out.rows.push(o);
  }
  return out;
}

// Aturan SEMENTARA untuk hasil scan: IDPPS 8 digit, utuh atau satu-satunya angka 8 digit dalam teks.
export function extractId(raw) {
  const s = txt(raw);
  if (ID_RE.test(s)) return s;
  const found = [], re = /(^|\D)(\d{8})(?=\D|$)/g;
  let m;
  while ((m = re.exec(s))) if (!found.includes(m[2])) found.push(m[2]);
  return found.length === 1 ? found[0] : null;
}

// Teks baku untuk checksum: urut IDPPS, nilai kolom A-K sebagai teks. Server dan perangkat memakai fungsi yang sama.
export function checksumText(rows) {
  return JSON.stringify(
    rows.slice().sort((a, b) => (a.IDPPS < b.IDPPS ? -1 : a.IDPPS > b.IDPPS ? 1 : 0))
      .map(r => COLS.map(c => String(r[c])))
  );
}

export async function sha256(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
