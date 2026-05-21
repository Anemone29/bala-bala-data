# Handoff: bala-bala-data → bala-bala-app

Catatan untuk bootstrap session baru di repo `bala-bala-app` (yang akan dibuat).

---

## Konteks proyek

`bala-bala-data` adalah **data repo** untuk IHSG (Bursa Efek Indonesia). Isinya:

```
intraday/<YYYY-MM-DD>.json   # snapshot 15-menit, append-only per hari
daily/<YYYY-MM-DD>.json      # rollup harian (OHLCV + value/freq)
events/                      # event log (legacy, belum dipakai aktif)
history.json                 # legacy index
latest.json                  # legacy pointer
metadata.json                # legacy {}
scraper/                     # ⚠️ Supabase Edge Function (akan dipindah ke bala-bala-app)
```

Tujuan akhir: split jadi **2 repo**:
- `bala-bala-data` → murni data, di-commit otomatis oleh scraper. Tidak ada kode aplikasi.
- `bala-bala-app` → semua kode: scraper, screener, summary. Read dari `bala-bala-data`, write ke `bala-bala-data`.

---

## Apa yang udah jalan

✅ **Scraper 15-menit** — Supabase Edge Function `scrape-intraday` (Deno + TypeScript)
   - pg_cron trigger tiap 15 menit di jam dagang BEI (Mon–Fri, 09:00–16:00 WIB)
   - Fetch dari `https://www.idx.co.id/primary/TradingSummary/GetStockSummary`
   - Normalize pakai `ticker_master.json` (510 ticker, sektor, indeks)
   - Commit ke `bala-bala-data` via GitHub Git Data API (3 files per commit: `intraday/<date>.json`, `daily/index.json`, `events/latest.json`)
   - Code masih ada di `scraper/` di repo ini — **perlu dipindah ke `bala-bala-app`** sebagai langkah pertama session baru.

✅ **Data sudah masuk** — lihat `intraday/2026-05-19.json`, `intraday/2026-05-20.json`, dll. Pipeline live.

⚠️ **`daily/<date>.json`** — file harian ada (`daily/2026-05-04.json` dst) tapi belum dipakai screener. Belum diputuskan: rollup di scraper end-of-day, atau dihitung on-demand oleh screener.

---

## Keputusan yang udah diambil

1. **Bahasa scraper**: TypeScript di Supabase Edge Function (Deno runtime). Bukan Python, bukan GitHub Actions cron.
2. **Storage**: data tetap di GitHub repo (bukan Supabase Storage / DB) — biar gratis, versioned, dan transparan.
3. **Split 2 repo**: `bala-bala-data` (data) + `bala-bala-app` (kode). User akan bikin `bala-bala-app` manual di GitHub karena harness Claude scoped ke `bala-bala-data` doang.
4. **Screener**: **Breakout candidates** — ticker yang harganya tembus high 5-hari dan/atau 20-hari (multi-timeframe breakout).
5. **Summary**: **Anomaly detection + explanation** — ticker dengan behavior aneh (volume spike, divergence vs sektor, failed breakout, gap reversal, dll) + kenapa.
6. **Summary explanation**: **Plus news scraping** — gabungkan anomaly data + headline IDX/Detik Finance/Bisnis.com biar "kenapa"-nya lebih konkret (bukan cuma TA generic).

---

## Yang harus dibangun di `bala-bala-app`

### 1. Migrate scraper (langkah pertama)
- Copy seluruh `scraper/` dari `bala-bala-data` → `apps/scraper/` (atau root) di `bala-bala-app`.
- Update Supabase Edge Function: target repo tetap `anemone29/bala-bala-data` (data ditulis ke sana), tapi source code-nya di-deploy dari `bala-bala-app`.
- Setelah deploy ulang & verifikasi 1 cycle jalan, **hapus folder `scraper/`** dari `bala-bala-data`.

### 2. Breakout screener
- Schedule: **1× setelah market close** (sekitar 16:30 WIB).
- Logika:
  - Untuk tiap ticker, hitung `high_5d` = max(high) 5 hari trading terakhir (exclude today), `high_20d` = max(high) 20 hari terakhir.
  - Tanda breakout:
    - `breakout_5d`: today's close > high_5d
    - `breakout_20d`: today's close > high_20d (lebih kuat)
  - Tambahan filter: volume > 1.5× avg-volume-20d (biar bukan breakout palsu di stock illiquid).
- Output: commit `screener/breakouts/<YYYY-MM-DD>.json` ke `bala-bala-data`.
- Source data: baca `intraday/<date>.json` untuk last snapshot (atau `daily/<date>.json` kalau sudah ada rollup harian).

### 3. Anomaly + news summary
- Schedule: **1× setelah screener selesai** (atau 17:00 WIB).
- Step A — anomaly detection (deterministic, no LLM):
  - Volume spike: vol_today > 3× avg_vol_20d, tapi |Δprice| < 1%
  - Failed breakout: gap-up at open > 2%, close < open
  - Sector divergence: stock turun > 2% padahal sektor naik > 1% (atau sebaliknya)
  - Wide intraday range: (high − low) / open > 5%
  - Distribution candle: close di 30% bawah range, vol > 1.5× avg
- Step B — news scraping (light):
  - Scrape headline harian dari IDX announcement page, Detik Finance, Bisnis.com (atau RSS feed kalau ada).
  - Match headline → ticker via simple keyword (nama emiten/ticker code).
- Step C — LLM explain (Claude API, `claude-sonnet-4-6` cukup):
  - Input: untuk tiap anomaly ticker, kirim {price action data, anomaly type, matched headlines} ke Claude.
  - Output: 1–3 kalimat penjelasan per ticker.
  - **Pakai prompt caching** (master data ticker + format instruksi di-cache).
- Output: commit `summary/<YYYY-MM-DD>.md` (human-readable) + `summary/<YYYY-MM-DD>.json` (structured) ke `bala-bala-data`.

---

## Arsitektur target

```
bala-bala-app/   (Supabase project + GitHub repo)
├── apps/
│   ├── scraper/                  # Edge Function: scrape-intraday (existing, migrate)
│   ├── screener/                 # Edge Function: run-breakout-screener (new)
│   └── summary/                  # Edge Function: daily-anomaly-summary (new)
├── shared/
│   ├── github.ts                 # commit helper (dipakai semua function)
│   ├── data-loader.ts            # read intraday/daily JSON dari bala-bala-data
│   └── ticker_master.json        # single source of truth
├── supabase/
│   └── migrations/
│       └── setup_cron.sql        # pg_cron schedules untuk 3 function
└── scripts/
    └── update-ticker-master.ts   # refresh ticker list dari IDX (run manual occasionally)

bala-bala-data/   (data-only)
├── intraday/<date>.json
├── daily/<date>.json
├── screener/breakouts/<date>.json
├── summary/<date>.{md,json}
└── ticker_master.json   # mirror (read-only, bala-bala-app yang update)
```

---

## Constraints & catatan teknis

- **GitHub commit budget**: limit 5000 req/jam. Saat ini scraper pakai ~5 req/cycle × 25 cycle/hari = 125/hari. Screener + summary masing-masing ~3-5 req/run × 1/hari. Aman.
- **Supabase Free tier**: cukup untuk pg_cron + Edge Functions di skala ini.
- **News scraping**: simpan headline mentah di `bala-bala-data/news/<date>.json` biar bisa di-replay & audit.
- **Claude API key**: simpan di Supabase secret (`ANTHROPIC_API_KEY`), jangan commit.
- **Branch**: di sesi sebelumnya kerja di `claude/review-folder-contents-OTSRn`. Untuk session baru di `bala-bala-app`, mulai dari `main`.

---

## House-keeping di `bala-bala-data`

- File aneh `a` di root → kayaknya artifact iseng, bisa dihapus.
- `metadata.json` isinya `{}` doang → legacy, bisa dihapus atau dipakai lagi sebagai index.
- Setelah scraper dipindah, **hapus folder `scraper/`** dari sini.

---

## Kata kunci untuk session baru di `bala-bala-app`

Copy-paste prompt ini saat mulai sesi Claude Code baru di repo `bala-bala-app`:

> Halo! Aku lanjutin proyek IHSG data tools. Repo data-nya di `anemone29/bala-bala-data` (sudah punya intraday/, daily/, scraper yang jalan tiap 15 menit). Repo ini (`bala-bala-app`) bakal jadi rumah baru untuk semua kode: scraper, screener, summary.
>
> Baca dulu `HANDOFF.md` di repo `bala-bala-data` (path: `anemone29/bala-bala-data/HANDOFF.md` di branch `claude/review-folder-contents-OTSRn`) untuk konteks lengkap — keputusan yang udah diambil, arsitektur target, dan task list.
>
> Langkah pertama: migrate folder `scraper/` dari `bala-bala-data` ke repo ini (struktur target: `apps/scraper/`). Setelah migrasi & re-deploy Supabase Edge Function jalan, kita lanjut bangun breakout screener (task #2 di HANDOFF).
