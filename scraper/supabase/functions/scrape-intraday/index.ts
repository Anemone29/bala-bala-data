// IHSG 15-minute intraday scraper.
// Triggered by pg_cron (see ../../migrations/), one HTTP call per scrape.
// Fetches IDX bulk trading summary, normalizes against ticker master,
// then commits a single 3-file change to GitHub via the Git Data API.

import master from "./ticker_master.json" with { type: "json" };

const GITHUB_API = "https://api.github.com";
const GH_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const GH_REPO = Deno.env.get("GITHUB_REPO") ?? "";
const GH_BRANCH = Deno.env.get("GITHUB_BRANCH") ?? "main";
const IDX_URL =
  "https://www.idx.co.id/primary/TradingSummary/GetStockSummary?length=10000&start=0";

type TickerMeta = {
  name: string;
  yahoo_ticker: string;
  sector: string;
  industry: string;
  indices: string[];
};

type IdxRow = Record<string, unknown>;

type Stock = {
  ticker: string;
  yahoo_ticker: string;
  name: string;
  sector: string;
  industry: string;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  change_pct: number;
  size_score: number;
  volume_ratio: null;
  tier: null;
  indices: string[];
};

type Snapshot = { generated_at: string; stocks: Stock[] };

const TICKERS = (master as { tickers: Record<string, TickerMeta> }).tickers;

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/,/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function pick(row: IdxRow, ...keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return undefined;
}

async function fetchIDX(): Promise<IdxRow[]> {
  const res = await fetch(IDX_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Referer: "https://www.idx.co.id/",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`IDX HTTP ${res.status}`);
  const data = await res.json();
  // IDX wraps the rows differently depending on endpoint version.
  const rows = (data?.data ?? data?.Replies ?? data?.recordsTotal ? data?.data : data) as
    | IdxRow[]
    | undefined;
  if (!Array.isArray(rows)) {
    throw new Error(`IDX unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return rows;
}

function buildSnapshot(rows: IdxRow[]): Snapshot {
  const generated_at = new Date().toISOString();
  const stocks: Stock[] = [];
  for (const row of rows) {
    const code = String(pick(row, "StockCode", "Code") ?? "").trim().toUpperCase();
    if (!code) continue;
    const meta = TICKERS[code];
    if (!meta) continue;
    const price = num(pick(row, "Close", "LastPrice", "Last"));
    const prev = num(pick(row, "Previous", "PrevClose", "PreviousClose"));
    const volume = num(pick(row, "Volume", "Vol"));
    const open = num(pick(row, "OpenPrice", "Open"));
    const high = num(pick(row, "High"));
    const low = num(pick(row, "Low"));
    const change_pct = prev > 0
      ? Number((((price - prev) / prev) * 100).toFixed(2))
      : 0;
    const size_score = volume > 0
      ? Number((Math.log(volume) - 3).toFixed(3))
      : 0;
    stocks.push({
      ticker: code,
      yahoo_ticker: meta.yahoo_ticker,
      name: meta.name,
      sector: meta.sector,
      industry: meta.industry,
      price,
      open,
      high,
      low,
      volume,
      change_pct,
      size_score,
      volume_ratio: null,
      tier: null,
      indices: meta.indices,
    });
  }
  stocks.sort((a, b) => b.volume - a.volume);
  return { generated_at, stocks };
}

async function gh(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${GITHUB_API}/repos/${GH_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bala-bala-scraper",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GH ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const res = await gh("GET", `/contents/${encodeURI(path)}?ref=${GH_BRANCH}`);
    const decoded = atob(String(res.content).replace(/\n/g, ""));
    return JSON.parse(decoded) as T;
  } catch (e) {
    if (String(e).includes("404")) return null;
    throw e;
  }
}

async function commitFiles(message: string, files: Record<string, string>): Promise<string> {
  const ref = await gh("GET", `/git/ref/heads/${GH_BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh("GET", `/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const tree = Object.entries(files).map(([path, content]) => ({
    path,
    mode: "100644" as const,
    type: "blob" as const,
    content,
  }));
  const newTree = await gh("POST", `/git/trees`, { base_tree: baseTreeSha, tree });
  const newCommit = await gh("POST", `/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseSha],
  });
  await gh("PATCH", `/git/refs/heads/${GH_BRANCH}`, { sha: newCommit.sha });
  return newCommit.sha;
}

Deno.serve(async (_req) => {
  const t0 = Date.now();
  try {
    if (!GH_TOKEN || !GH_REPO) {
      throw new Error("Missing GITHUB_TOKEN / GITHUB_REPO env vars");
    }
    const today = new Date().toISOString().slice(0, 10);
    const intradayPath = `intraday/${today}.json`;

    const rows = await fetchIDX();
    const snapshot = buildSnapshot(rows);
    if (snapshot.stocks.length === 0) throw new Error("Snapshot empty after normalize");

    type Intraday = { snapshots: Snapshot[] };
    type DailyIndex = { updated_at: string; dates: string[] };
    type EventsLatest = { generated_at: string; events: unknown[] };

    const intraday = (await readJson<Intraday>(intradayPath)) ?? { snapshots: [] };
    intraday.snapshots.push(snapshot);

    const dailyIdx = (await readJson<DailyIndex>("daily/index.json")) ??
      { updated_at: "", dates: [] };
    if (!dailyIdx.dates.includes(today)) {
      dailyIdx.dates.push(today);
      dailyIdx.dates.sort();
    }
    dailyIdx.updated_at = snapshot.generated_at;

    const eventsLatest = (await readJson<EventsLatest>("events/latest.json")) ??
      { generated_at: "", events: [] };
    eventsLatest.generated_at = snapshot.generated_at;

    const sha = await commitFiles(`scrape: ${snapshot.generated_at}`, {
      [intradayPath]: JSON.stringify(intraday),
      "daily/index.json": JSON.stringify(dailyIdx, null, 2),
      "events/latest.json": JSON.stringify(eventsLatest, null, 2),
    });

    return Response.json({
      ok: true,
      commit: sha,
      stocks: snapshot.stocks.length,
      generated_at: snapshot.generated_at,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("scrape failed:", e);
    return Response.json(
      { ok: false, error: String(e), duration_ms: Date.now() - t0 },
      { status: 500 },
    );
  }
});
