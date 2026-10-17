-- Jalankan sekali di Neon (SQL Editor). Aman diulang: memakai IF NOT EXISTS.

-- Satu baris = satu versi dataset hasil impor. Jumlah peserta bebas (row_count berbeda tiap versi).
CREATE TABLE IF NOT EXISTS datasets (
  id              bigserial PRIMARY KEY,
  version         integer     NOT NULL UNIQUE,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  source_filename text        NOT NULL,
  row_count       integer     NOT NULL CHECK (row_count >= 0),
  checksum        text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Kolom A-K Excel apa adanya (semua teks agar isi sumber tidak berubah). Kunci = (versi, IDPPS).
CREATE TABLE IF NOT EXISTS participants (
  dataset_id  bigint NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  no          text   NOT NULL,                                   -- A  No
  idpps       text   NOT NULL CHECK (idpps ~ '^[0-9]{8}$'),      -- B  IDPPS
  nama        text   NOT NULL,                                   -- C  NAMA
  dom         text   NOT NULL,                                   -- D  DOM
  kelas_baru  text   NOT NULL,                                   -- E  KELAS BARU
  guru_baru   text   NOT NULL,                                   -- F  GURU BARU
  pos         text   NOT NULL,                                   -- G  POS
  kelas_pagi  text   NOT NULL,                                   -- H  KELAS PAGI
  ruang_ujian text   NOT NULL,                                   -- I  RUANG UJIAN
  juri        text   NOT NULL,                                   -- J  JURI
  ket_tes     text   NOT NULL,                                   -- K  KET TES
  PRIMARY KEY (dataset_id, idpps)
);

-- Penunjuk dataset aktif. Publikasi = mengubah satu baris ini dalam satu pernyataan atomik.
CREATE TABLE IF NOT EXISTS app_state (
  id                int PRIMARY KEY CHECK (id = 1),
  active_dataset_id bigint REFERENCES datasets(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Riwayat impor (terpisah dari dataset aktif).
CREATE TABLE IF NOT EXISTS import_logs (
  id            bigserial PRIMARY KEY,
  dataset_id    bigint REFERENCES datasets(id) ON DELETE SET NULL,
  file_name     text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('berhasil','ditolak')),
  source_rows   integer     NOT NULL DEFAULT 0,
  valid_rows    integer     NOT NULL DEFAULT 0,
  rejected_rows integer     NOT NULL DEFAULT 0,
  errors        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Pembatas percobaan login.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial PRIMARY KEY,
  ip         text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_time ON login_attempts (ip, created_at);

