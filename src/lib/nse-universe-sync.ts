import fs from "fs/promises";
import path from "path";
import { FNO_SYMBOLS_LIST, NIFTY_500_SYMBOLS_LIST } from "../data/watchlists.js";

const NIFTY_500_CSV_PRIMARY = "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv";
const NIFTY_500_CSV_BACKUP = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv";
const FNO_MKTLOTS_CSV_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv";

const WATCHLIST_CACHE_FILE = path.resolve(process.cwd(), "nse_watchlists_cache.json");
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Preserve the app's canonical index/futures header tickers so all dashboards & TradingView links stay identical
const APP_INDEX_HEADERS = [
  "BANKNIFTY",
  "CNXFINANCE",
  "FINNIFTY1!",
  "MIDCPNIFTY1!",
  "NIFTY",
  "NIFTYNXT501!",
  "NIFTY_MID_SELECT"
];

// Keep legacy underscore app tickers compatible with custom TradingView links & BASE_SYMBOLS
const LEGACY_UNDERSCORE_MAP: Record<string, string> = {
  "BAJAJ-AUTO": "BAJAJ_AUTO",
  "NAM-INDIA": "NAM_INDIA"
};

// Map official NSE Nifty 500 Industry column values to canonical NSE Sectoral Index names
const INDUSTRY_TO_SECTOR_INDEX: Record<string, string> = {
  "financial services": "NIFTY FIN SERVICE",
  "information technology": "NIFTY IT",
  "automobile and auto components": "NIFTY AUTO",
  "healthcare": "NIFTY PHARMA",
  "fast moving consumer goods": "NIFTY FMCG",
  "oil gas & consumable fuels": "NIFTY OIL & GAS",
  "metals & mining": "NIFTY METAL",
  "realty": "NIFTY REALTY",
  "media entertainment & publication": "NIFTY MEDIA",
  "consumer durables": "NIFTY CONSR DURBL",
  "consumer services": "NIFTY CONSUMPTION",
  "capital goods": "NIFTY INFRA",
  "construction": "NIFTY INFRA",
  "construction materials": "NIFTY INFRA",
  "power": "NIFTY ENERGY",
  "chemicals": "NIFTY CHEMICALS",
  "telecommunication": "NIFTY INFRA",
  "services": "NIFTY SERVICES SECTOR",
  "textiles": "NIFTY CONSUMPTION",
  "forest materials": "NIFTY COMMODITIES",
  "diversified": "NIFTY 500"
};

// Specific well-known NSE Banking symbols so Banking separates cleanly from broader Fin Services
const BANKING_SYMBOLS = new Set([
  "HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK",
  "BANKBARODA", "PNB", "CANBK", "AUBANK", "FEDERALBNK", "IDFCFIRSTB",
  "UNIONBANK", "INDIANB", "BANKINDIA", "YESBANK", "BANDHANBNK", "RBLBANK",
  "IOB", "UCOBANK", "MAHABANK", "CENTRALBK", "KARURVYSYA", "CUB", "J&KBANK"
]);

export function mapIndustryToSectorIndex(industry: string, symbol?: string): string {
  const cleanSym = (symbol || "").replace(/1!$/, "").trim().toUpperCase();
  if (BANKING_SYMBOLS.has(cleanSym)) return "NIFTY BANK";
  const key = (industry || "").trim().toLowerCase();
  return INDUSTRY_TO_SECTOR_INDEX[key] || "NIFTY 500";
}

function toAppTicker(nseSymbol: string): string {
  const clean = nseSymbol.trim().toUpperCase();
  return LEGACY_UNDERSCORE_MAP[clean] || clean;
}

function parseCsvRow(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

export interface LiveWatchlistState {
  fno: string[];
  nifty500: string[];
  descriptions: Record<string, string>;
  industries: Record<string, string>;
  sectors: Record<string, string>;
  updatedAt: string;
  source: "nse_official_live" | "disk_cache" | "compiled_baseline";
}

let cachedState: LiveWatchlistState = {
  fno: [...FNO_SYMBOLS_LIST],
  nifty500: [...NIFTY_500_SYMBOLS_LIST],
  descriptions: {},
  industries: {},
  sectors: {},
  updatedAt: "",
  source: "compiled_baseline"
};

let lastFetchMs = 0;
let refreshInFlight: Promise<LiveWatchlistState> | null = null;
let diskLoaded = false;

async function fetchTextWithTimeout(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/csv,text/plain,*/*"
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialNifty500(): Promise<{
  symbols: string[];
  descriptions: Record<string, string>;
  industries: Record<string, string>;
  sectors: Record<string, string>;
}> {
  let csvText = "";
  try {
    // niftyindices.com does not block cloud server IPs with Akamai 403 like nsearchives.nseindia.com
    csvText = await fetchTextWithTimeout(NIFTY_500_CSV_BACKUP, 8000);
  } catch {
    csvText = await fetchTextWithTimeout(NIFTY_500_CSV_PRIMARY, 8000);
  }

  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 400) {
    throw new Error(`Unexpected Nifty 500 CSV length: ${lines.length}`);
  }

  const descriptions: Record<string, string> = {};
  const industries: Record<string, string> = {};
  const sectors: Record<string, string> = {};
  const equities: string[] = [];
  const seen = new Set<string>(APP_INDEX_HEADERS);

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const companyName = cols[0] || "";
    const industry = cols[1] || "";
    const rawSymbol = (cols[2] || "").trim().toUpperCase();
    // Filter out demerger dummy placeholder entries like DUMMYHEG
    if (!rawSymbol || rawSymbol.startsWith("DUMMY")) continue;
    if (!/^[A-Z0-9&-]{1,32}$/.test(rawSymbol)) continue;

    const appSym = toAppTicker(rawSymbol);
    if (companyName) {
      descriptions[appSym] = companyName;
    }
    if (industry) {
      industries[appSym] = industry;
      sectors[appSym] = mapIndustryToSectorIndex(industry, appSym);
    }
    if (!seen.has(appSym)) {
      seen.add(appSym);
      equities.push(appSym);
    }
  }

  equities.sort((a, b) => a.localeCompare(b));

  if (equities.length < 450) {
    throw new Error(`Parsed too few Nifty 500 equities: ${equities.length}`);
  }

  return {
    symbols: [...APP_INDEX_HEADERS, ...equities],
    descriptions,
    industries,
    sectors
  };
}

async function fetchOfficialFno(): Promise<{ symbols: string[]; descriptions: Record<string, string> } | null> {
  let csvText = "";
  try {
    csvText = await fetchTextWithTimeout(FNO_MKTLOTS_CSV_URL, 6000);
  } catch {
    // nsearchives.nseindia.com frequently returns HTTP 403 to cloud/datacenter IPs;
    // retain the verified bundled/disk-cached official NSE F&O universe cleanly without throwing.
    return null;
  }
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 100) {
    return null;
  }

  const descriptions: Record<string, string> = {};
  const equities: string[] = [];
  const seen = new Set<string>(APP_INDEX_HEADERS);
  let inIndividualSecurities = false;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const underlying = (cols[0] || "").trim();
    const rawSymbol = (cols[1] || "").trim().toUpperCase();

    if (underlying.toLowerCase().includes("derivatives on individual securities")) {
      inIndividualSecurities = true;
      continue;
    }
    if (!inIndividualSecurities) continue;
    if (!rawSymbol || rawSymbol === "SYMBOL" || rawSymbol.startsWith("DUMMY")) continue;
    if (!/^[A-Z0-9&-]{1,32}$/.test(rawSymbol)) continue;

    // Require at least one active contract month with a positive numeric lot size
    const hasActiveContract = cols.slice(2).some(val => /^\d+$/.test(val) && Number(val) > 0);
    if (!hasActiveContract) continue;

    const appSym = toAppTicker(rawSymbol);
    if (underlying) {
      descriptions[appSym] = underlying;
    }
    if (!seen.has(appSym)) {
      seen.add(appSym);
      equities.push(appSym);
    }
  }

  equities.sort((a, b) => a.localeCompare(b));

  if (equities.length < 120) {
    throw new Error(`Parsed too few F&O equities: ${equities.length}`);
  }

  return {
    symbols: [...APP_INDEX_HEADERS, ...equities],
    descriptions
  };
}

async function loadDiskCacheOnce() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const raw = await fs.readFile(WATCHLIST_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed?.fno) &&
      parsed.fno.length >= 120 &&
      Array.isArray(parsed?.nifty500) &&
      parsed.nifty500.length >= 450
    ) {
      const loadedIndustries: Record<string, string> =
        parsed.industries && typeof parsed.industries === "object" ? parsed.industries : {};
      const loadedSectors: Record<string, string> =
        parsed.sectors && typeof parsed.sectors === "object" ? parsed.sectors : {};

      // Backfill sectors from industries if needed
      for (const [sym, ind] of Object.entries(loadedIndustries)) {
        if (!loadedSectors[sym]) {
          loadedSectors[sym] = mapIndustryToSectorIndex(ind, sym);
        }
      }

      cachedState = {
        fno: parsed.fno,
        nifty500: parsed.nifty500,
        descriptions: parsed.descriptions && typeof parsed.descriptions === "object" ? parsed.descriptions : {},
        industries: loadedIndustries,
        sectors: loadedSectors,
        updatedAt: String(parsed.updatedAt || ""),
        source: "disk_cache"
      };
      // Keep module-level arrays synchronized on the server
      FNO_SYMBOLS_LIST.splice(0, FNO_SYMBOLS_LIST.length, ...cachedState.fno);
      NIFTY_500_SYMBOLS_LIST.splice(0, NIFTY_500_SYMBOLS_LIST.length, ...cachedState.nifty500);
    }
  } catch {
    // No disk cache yet — compiled baseline is already loaded
  }
}

export async function refreshNseWatchlists(force = false): Promise<LiveWatchlistState> {
  await loadDiskCacheOnce();
  const now = Date.now();
  const missingIndustries = Object.keys(cachedState.industries || {}).length < 400;
  if (!force && !missingIndustries && lastFetchMs > 0 && now - lastFetchMs < REFRESH_TTL_MS) {
    return cachedState;
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const [n500Res, fnoRes] = await Promise.allSettled([
        fetchOfficialNifty500(),
        fetchOfficialFno()
      ]);

      let changed = false;
      const mergedDescriptions: Record<string, string> = { ...cachedState.descriptions };
      const mergedIndustries: Record<string, string> = { ...cachedState.industries };
      const mergedSectors: Record<string, string> = { ...cachedState.sectors };
      let nextNifty500 = cachedState.nifty500;
      let nextFno = cachedState.fno;

      if (fnoRes.status === "fulfilled" && fnoRes.value) {
        nextFno = fnoRes.value.symbols;
        Object.assign(mergedDescriptions, fnoRes.value.descriptions);
        changed = true;
      }

      if (n500Res.status === "fulfilled" && n500Res.value) {
        nextNifty500 = n500Res.value.symbols;
        // Prefer Nifty 500 properly cased Company Name over all-caps F&O underlying name
        Object.assign(mergedDescriptions, n500Res.value.descriptions);
        Object.assign(mergedIndustries, n500Res.value.industries);
        Object.assign(mergedSectors, n500Res.value.sectors);
        changed = true;
      }

      lastFetchMs = Date.now();

      if (changed) {
        const updated: LiveWatchlistState = {
          fno: nextFno,
          nifty500: nextNifty500,
          descriptions: mergedDescriptions,
          industries: mergedIndustries,
          sectors: mergedSectors,
          updatedAt: new Date().toISOString(),
          source: "nse_official_live"
        };
        cachedState = updated;

        // Update exported arrays in-place so server-side walk-forward audit & helpers stay synced
        FNO_SYMBOLS_LIST.splice(0, FNO_SYMBOLS_LIST.length, ...updated.fno);
        NIFTY_500_SYMBOLS_LIST.splice(0, NIFTY_500_SYMBOLS_LIST.length, ...updated.nifty500);

        await fs.writeFile(WATCHLIST_CACHE_FILE, JSON.stringify(updated, null, 2)).catch(() => {});
        console.log(
          `[NSE Universe Sync] Synced official NSE lists: F&O=${updated.fno.length} (${updated.fno.length - APP_INDEX_HEADERS.length} equities), Nifty500=${updated.nifty500.length} (${updated.nifty500.length - APP_INDEX_HEADERS.length} equities), Industries=${Object.keys(updated.industries).length}`
        );
      }
      return cachedState;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function getLiveWatchlists(): Promise<LiveWatchlistState> {
  await loadDiskCacheOnce();
  const missingIndustries = Object.keys(cachedState.industries || {}).length < 400;
  if (lastFetchMs === 0 || missingIndustries || Date.now() - lastFetchMs >= REFRESH_TTL_MS) {
    // Wait up to 2.5s for fresh NSE sync; otherwise serve current valid list while refresh completes
    await Promise.race([
      refreshNseWatchlists(missingIndustries),
      new Promise<void>(resolve => setTimeout(resolve, 2500))
    ]);
  }
  return cachedState;
}

export function getNseSymbolDescription(symbol: string): string | undefined {
  return cachedState.descriptions[symbol] || cachedState.descriptions[toAppTicker(symbol)];
}

export function getNseSymbolIndustry(symbol: string): string | undefined {
  return cachedState.industries[symbol] || cachedState.industries[toAppTicker(symbol)];
}

export function getNseSymbolSector(symbol: string): string {
  const explicit = cachedState.sectors[symbol] || cachedState.sectors[toAppTicker(symbol)];
  if (explicit) return explicit;
  const ind = getNseSymbolIndustry(symbol);
  return ind ? mapIndustryToSectorIndex(ind, symbol) : "NIFTY 500";
}

export function getAllNseSectorMappings(): {
  industries: Record<string, string>;
  sectors: Record<string, string>;
  descriptions: Record<string, string>;
} {
  return {
    industries: cachedState.industries,
    sectors: cachedState.sectors,
    descriptions: cachedState.descriptions
  };
}
