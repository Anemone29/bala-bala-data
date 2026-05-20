# IHSG 15-minute intraday scraper

Self-hosted scraper di Supabase yang ngegantiin sistem lama. Tiap 15 menit (jam dagang BEI), Supabase Edge Function ngambil bulk trading summary dari IDX, normalize ke schema `intraday/<YYYY-MM-DD>.json` yang udah dipake repo ini, lalu commit lewat GitHub Git Data API — 1 commit per cycle, 3 file kena update (`intraday/...json`, `daily/index.json`, `events/latest.json`).

## Arsitektur

```
[pg_cron @ Supabase Postgres]
  └── HTTP POST -> [Edge Function: scrape-intraday]
                     ├── GET  https://www.idx.co.id/primary/TradingSummary/GetStockSummary
                     ├── normalize (join with embedded ticker_master.json)
                     └── GitHub Git Data API:
                           GET  /git/ref + /git/commits         (read current head)
                           GET  /contents/intraday/<date>.json  (append snapshot)
                           POST /git/trees                      (3 files inline)
                           POST /git/commits
                           PATCH /git/refs/heads/<branch>
```

5 GitHub API calls per scrape, ~25 scrapes/hari = 125 req/hari (limit 5000/jam, jauh dari mentok).

## File

```
scraper/
├── .env.example                              # contoh env var
├── data/ticker_master.json                   # 510 ticker + metadata (sektor, indeks)
├── supabase/
│   ├── functions/scrape-intraday/
│   │   ├── index.ts                          # main edge function (Deno)
│   │   └── ticker_master.json                # embedded master (sama dgn data/)
│   └── migrations/
│       └── 20260520000000_setup_cron.sql     # pg_cron schedule + helper fn
└── README.md                                 # ini
```

## Deploy

### 1. Setup Supabase project
Buat project di https://supabase.com kalo belum ada. Install CLI lokal:
```bash
npm i -g supabase
supabase login
```

### 2. Link & deploy function
Dari root repo ini:
```bash
cd scraper
supabase link --project-ref <YOUR_PROJECT_REF>
supabase functions deploy scrape-intraday --no-verify-jwt
```

### 3. Set function secrets
```bash
supabase secrets set \
  GITHUB_TOKEN=<fine-grained-PAT-with-contents:rw-on-this-repo> \
  GITHUB_REPO=Anemone29/bala-bala-data \
  GITHUB_BRANCH=main
```
PAT scope minimal: **Contents: Read & Write** untuk repo `Anemone29/bala-bala-data`. Pakai fine-grained PAT, expiry ≤ 90 hari.

### 4. Test manual sekali
```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/scrape-intraday" \
  -H "Authorization: Bearer <anon-or-service-key>"
```
Sukses kalo response berisi `{ ok: true, commit: "...", stocks: 510, ... }` dan ada commit baru di branch.

### 5. Apply cron migration
Edit nilai di SQL biar match project kamu, lalu apply:
```bash
# Set 2 settings ini DULU sebelum apply migration:
supabase db query "
  alter database postgres set \"app.settings.edge_function_url\"
    = 'https://<project-ref>.supabase.co/functions/v1/scrape-intraday';
  alter database postgres set \"app.settings.edge_function_key\"
    = '<service-role-key>';
"
supabase db push
```
Atau jalanin SQL-nya langsung lewat dashboard SQL editor.

### 6. Verify cron jalan
```sql
select jobname, schedule, active from cron.job where jobname like 'scrape-intraday-%';
select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'scrape-intraday-%') order by start_time desc limit 5;
```

### 7. Matiin scraper lama
Setelah verify sistem baru udah commit beneran tiap 15 menit, matiin scraper lama yg jalan di tempat lain (GitHub Action / server / dll) supaya nggak double-commit. Cek `git log --author='Anemone29' -5` setelah disable — semua commit baru harusnya dari token yg dipakai Edge Function (atau dari nama bot lain tergantung token type).

## Schedule (UTC)

```
Senin-Kamis:
  02:00-05:00 UTC = 09:00-12:00 WIB (sesi I)
  06:30-08:30 UTC = 13:30-15:30 WIB (sesi II)

Jumat:
  02:00-05:00 UTC = 09:00-12:00 WIB (sesi I)
  07:00-08:30 UTC = 14:00-15:30 WIB (sesi II)
```

## Update ticker master

Kalo ada saham baru listing / delisting:
```bash
# Regenerate dari snapshot terbaru di repo
python3 -c "
import json
with open('intraday/$(date -u +%Y-%m-%d).json') as f: d=json.load(f)
snap = d['snapshots'][-1]
master = {s['ticker']: {k: s[k] for k in ('name','yahoo_ticker','sector','industry','indices')} for s in snap['stocks']}
out = {'updated_from': snap['generated_at'], 'count': len(master), 'tickers': {k: master[k] for k in sorted(master)}}
json.dump(out, open('scraper/data/ticker_master.json','w'), indent=2)
"
cp scraper/data/ticker_master.json scraper/supabase/functions/scrape-intraday/ticker_master.json
supabase functions deploy scrape-intraday --no-verify-jwt
```

## Known gaps (defer)

- **`daily/<date>.json` end-of-day rollup**: belum dihandle. Sistem lama kayaknya nge-generate file ini di akhir hari (jam 15:30 WIB+). Bisa ditambahin sebagai second edge function (`finalize-daily`) yang trigger 1x sehari.
- **`history.json` append**: belum dihandle. Sistem lama nge-append snapshot harian ke file global ini. Sama, defer ke job harian.
- **`size_score` formula**: pakai `ln(volume) - 3` (di-reverse-engineer dari data lama, match ke 3 desimal). Kalo ternyata sistem lama pake formula lain yang lebih kompleks (mis. volume_ratio-aware), tinggal ganti di `buildSnapshot()`.
- **`open` field**: data lama selalu 0 (jelek di scraper lama atau IDX-nya ga return). Versi baru ini coba parse `OpenPrice` kalo ada — jadi mungkin akan ada nilai non-0 di file baru. Itu fitur, bukan bug.
- **`volume_ratio` & `tier`**: selalu `null` di sistem lama, kemungkinan diisi di rollup harian. Kita ikut: set `null`.
- **IDX response shape**: ditebak berdasarkan dokumentasi & nama field umum (`StockCode`, `Close`, `Previous`, `Volume`, dst). Kalo deploy pertama gagal parsing, log error dari Edge Function akan nampilin shape sebenernya — tinggal sesuaikan di `pick()` / `num()`.

## Cost

- Supabase free tier: 500K Edge Function invocations/bulan, jauh dari kepake (~625/bulan).
- pg_cron + pg_net: included free.
- GitHub API: 5000 req/jam authenticated, kita pake ~5 req/scrape × 4 scrape/jam = 20/jam.

Praktis $0/bulan.
