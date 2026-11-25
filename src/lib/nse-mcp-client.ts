import { Candle } from "./pine-math.js";
import { Timeframe } from "../types.js";

const DEFAULT_BHAVCOPY_MCP_URL = "https://mcp.nseindia.in/bhavcopy/cm/mcp";
const DEFAULT_CM_MARKET_MCP_URL = "https://mcp.nseindia.in/cmmkt/mcp";

const ALLOWED_MCP_HOSTS = new Set(["mcp.nseindia.in"]);

const isNodeRuntime =
  typeof window === "undefined" &&
  typeof process !== "undefined" &&
  Boolean(process.versions?.node);

async function getNodeDiskCacheIo(): Promise<{
  readFile: (p: string, enc: BufferEncoding) => Promise<string>;
  writeFile: (p: string, data: string, enc: BufferEncoding) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  cacheFilePath: string;
} | null> {
  if (!isNodeRuntime) return null;
  try {
    const fsModName = "fs/promises";
    const pathModName = "path";
    const [fsMod, pathMod] = await Promise.all([
      import(/* @vite-ignore */ fsModName),
      import(/* @vite-ignore */ pathModName)
    ]);
    const fsApi = fsMod.default || fsMod;
    const pathApi = pathMod.default || pathMod;
    return {
      readFile: fsApi.readFile.bind(fsApi),
      writeFile: fsApi.writeFile.bind(fsApi),
      rename: fsApi.rename.bind(fsApi),
      cacheFilePath: pathApi.resolve(process.cwd(), "nse_eod_cache.json")
    };
  } catch {
    return null;
  }
}

function resolveSafeMcpUrl(envValue: string | undefined, fallback: string): string {
  if (!envValue) return fallback;
  try {
    const parsed = new URL(envValue.trim());
    if (parsed.protocol === "https:" && ALLOWED_MCP_HOSTS.has(parsed.hostname)) {
      return parsed.toString();
    }
  } catch {
    // Ignore invalid URL and use default
  }
  return fallback;
}

const envBhavcopyUrl = typeof process !== "undefined" ? process.env?.NSE_BHAVCOPY_MCP_URL : undefined;
const envCmMarketUrl = typeof process !== "undefined" ? process.env?.NSE_CM_MARKET_MCP_URL : undefined;
const BHAVCOPY_MCP_URL = resolveSafeMcpUrl(envBhavcopyUrl, DEFAULT_BHAVCOPY_MCP_URL);
const CM_MARKET_MCP_URL = resolveSafeMcpUrl(envCmMarketUrl, DEFAULT_CM_MARKET_MCP_URL);

const VALID_NSE_SYMBOL_RE = /^[A-Z0-9&-]{1,32}$/;

interface NseIndexMapping {
  bhavcopyName: string;
  cmLiveName: string;
}

const INDEX_MAPPINGS: Record<string, NseIndexMapping> = {
  NIFTY: { bhavcopyName: "Nifty 50", cmLiveName: "NIFTY 50" },
  BANKNIFTY: { bhavcopyName: "Nifty Bank", cmLiveName: "NIFTY BANK" },
  CNXFINANCE: { bhavcopyName: "Nifty Financial Services", cmLiveName: "NIFTY FIN SERVICE" },
  FINNIFTY: { bhavcopyName: "Nifty Financial Services", cmLiveName: "NIFTY FIN SERVICE" },
  NIFTY_MID_SELECT: { bhavcopyName: "Nifty Midcap Select", cmLiveName: "NIFTY MID SELECT" },
  MIDCPNIFTY: { bhavcopyName: "Nifty Midcap Select", cmLiveName: "NIFTY MID SELECT" },
  NIFTYNXT50: { bhavcopyName: "Nifty Next 50", cmLiveName: "NIFTY NEXT 50" },
  NIFTY500: { bhavcopyName: "Nifty 500", cmLiveName: "NIFTY 500" }
};

export function getNseIndexMapping(symbol: string): NseIndexMapping | null {
  const clean = symbol.replace(/1!$/, "").trim().toUpperCase();
  return INDEX_MAPPINGS[clean] || null;
}

export function toOfficialNseSymbol(symbol: string): string | null {
  const clean = symbol.replace(/1!$/, "").trim().toUpperCase().replace(/_/g, "-");
  if (!VALID_NSE_SYMBOL_RE.test(clean)) return null;
  return clean;
}

export function isNseMcpTimeframe(tf: Timeframe): boolean {
  return tf === "1D" || tf === "3D" || tf === "1W" || tf === "1M";
}

/**
 * Concurrency + minimum inter-request spacing gate so NSE Akamai WAF is never burst-throttled.
 */
class PacedSemaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private lastStartMs = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly minSpacingMs: number
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      const waitMs = Math.max(0, this.lastStartMs + this.minSpacingMs - Date.now());
      this.lastStartMs = Date.now() + waitMs;
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

class StreamableHttpMcpClient {
  private sessionId: string | null = null;
  private initPromise: Promise<string | null> | null = null;
  private reqId = 1;
  private cooldownUntilMs = 0;
  private readonly semaphore: PacedSemaphore;
  private readonly timeoutMs: number;

  constructor(
    private readonly name: string,
    private readonly endpointUrl: string,
    maxConcurrent = 3,
    minSpacingMs = 120,
    timeoutMs = 10000
  ) {
    this.semaphore = new PacedSemaphore(maxConcurrent, minSpacingMs);
    this.timeoutMs = timeoutMs;
  }

  isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntilMs;
  }

  private tripCooldown(reason: string, durationMs = 90_000) {
    const alreadyCooling = this.isCoolingDown();
    this.cooldownUntilMs = Date.now() + durationMs;
    this.sessionId = null;
    if (!alreadyCooling) {
      console.warn(`[NSE MCP] ${this.name} entering ${Math.round(durationMs / 1000)}s cooldown (${reason}); using fallback meanwhile.`);
    }
  }

  private async fetchWithTimeout(body: object, sessionId?: string | null): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      };
      if (sessionId) {
        headers["mcp-session-id"] = sessionId;
      }
      return await fetch(this.endpointUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private parseMcpPayload(rawText: string): any {
    const trimmed = rawText.trim();
    if (!trimmed) throw new Error("Empty MCP response");
    if (trimmed.startsWith("<")) {
      throw new Error("Received HTML WAF/gateway response");
    }
    let jsonStr = trimmed;
    if (trimmed.includes("data:")) {
      const dataLines = trimmed
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length > 0) {
        jsonStr = dataLines[dataLines.length - 1];
      }
    }
    return JSON.parse(jsonStr);
  }

  private async ensureSession(forceNew = false): Promise<string | null> {
    if (this.isCoolingDown()) {
      throw new Error(`MCP ${this.name} in cooldown`);
    }
    if (!forceNew && this.sessionId) return this.sessionId;
    if (!forceNew && this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const res = await this.fetchWithTimeout({
          jsonrpc: "2.0",
          id: this.reqId++,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "quant-swt-screener", version: "2.1.0" }
          }
        });
        if (res.status === 403 || res.status === 429) {
          this.tripCooldown(`HTTP ${res.status} on initialize`);
          throw new Error(`MCP ${this.name} rate-limited (HTTP ${res.status})`);
        }
        if (!res.ok) {
          throw new Error(`MCP initialize failed (${this.name}): HTTP ${res.status}`);
        }
        const sid = res.headers.get("mcp-session-id");
        this.sessionId = sid;
        await res.text().catch(() => "");

        await this.fetchWithTimeout(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          sid
        ).then(r => r.text().catch(() => "")).catch(() => {});

        return sid;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async callTool<T = any>(toolName: string, args: Record<string, any>): Promise<T> {
    if (this.isCoolingDown()) {
      throw new Error(`MCP ${this.name} in cooldown`);
    }

    return this.semaphore.run(async () => {
      if (this.isCoolingDown()) {
        throw new Error(`MCP ${this.name} in cooldown`);
      }

      let lastErr: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const sid = await this.ensureSession(attempt > 0);
          const res = await this.fetchWithTimeout(
            {
              jsonrpc: "2.0",
              id: this.reqId++,
              method: "tools/call",
              params: { name: toolName, arguments: args }
            },
            sid
          );

          if (res.status === 403 || res.status === 429) {
            this.tripCooldown(`HTTP ${res.status} on ${toolName}`);
            throw new Error(`MCP ${this.name}:${toolName} HTTP ${res.status}`);
          }

          if (!res.ok) {
            if (res.status === 400 || res.status === 404 || res.status === 410) {
              this.sessionId = null;
            }
            const errTxt = await res.text().catch(() => "");
            throw new Error(`MCP ${this.name}:${toolName} HTTP ${res.status}: ${errTxt.slice(0, 120)}`);
          }

          const rawText = await res.text();
          const rpc = this.parseMcpPayload(rawText);

          if (rpc.error) {
            throw new Error(`MCP RPC error (${this.name}:${toolName}): ${rpc.error.message || JSON.stringify(rpc.error)}`);
          }

          const contentText = rpc?.result?.content?.[0]?.text;
          if (typeof contentText !== "string") {
            throw new Error(`Unexpected MCP tool response (${this.name}:${toolName})`);
          }
          if (rpc?.result?.isError) {
            throw new Error(`MCP tool error (${this.name}:${toolName}): ${contentText.slice(0, 160)}`);
          }

          return JSON.parse(contentText) as T;
        } catch (err: any) {
          lastErr = err;
          if (this.isCoolingDown()) throw err;
          if (attempt === 0) {
            this.sessionId = null;
            await new Promise(r => setTimeout(r, 180 + Math.floor(Math.random() * 120)));
          }
        }
      }
      throw lastErr;
    });
  }
}

// Balanced pacing keeps request rate below NSE WAF thresholds while delivering sub-second throughput
const bhavcopyClient = new StreamableHttpMcpClient("nse-bhavcopy", BHAVCOPY_MCP_URL, 6, 55, 8000);
const cmMarketClient = new StreamableHttpMcpClient("cm-market", CM_MARKET_MCP_URL, 5, 60, 8000);

export interface NseLiveQuote {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  change: number;
  perChange: number;
  volume: number;
  turnover?: number; // INR
  tradingDate: string; // yyyy-MM-dd (IST)
  isIndex: boolean;
}

const LIVE_QUOTE_TTL_MS = 90_000;

let liveIndicesCache: { fetchedAt: number; map: Map<string, NseLiveQuote> } | null = null;
let liveIndicesInFlight: Promise<Map<string, NseLiveQuote>> | null = null;

// Per-prefix lazy cache for cm_get_equity_stocks so we NEVER burst 36 prefixes at once
const prefixEquitiesCache = new Map<string, { fetchedAt: number; map: Map<string, NseLiveQuote> }>();
const prefixEquitiesInFlight = new Map<string, Promise<Map<string, NseLiveQuote>>>();
const singleQuoteCache = new Map<string, { fetchedAt: number; quote: NseLiveQuote | null }>();

function parseNseTimestampToDateYmd(ts?: string): string {
  if (!ts) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  }
  const isoMatch = ts.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  const dmyMatch = ts.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (dmyMatch) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
    };
    const m = months[dmyMatch[2].toLowerCase()];
    if (m) {
      return `${dmyMatch[3]}-${m}-${dmyMatch[1].padStart(2, "0")}`;
    }
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function ymdToIstMarketMs(ymd: string): number {
  const parsed = Date.parse(`${ymd}T09:15:00+05:30`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function getLiveIndicesMap(): Promise<Map<string, NseLiveQuote>> {
  const now = Date.now();
  if (liveIndicesCache && now - liveIndicesCache.fetchedAt < LIVE_QUOTE_TTL_MS) {
    return liveIndicesCache.map;
  }
  if (cmMarketClient.isCoolingDown()) {
    return liveIndicesCache?.map || new Map();
  }
  if (liveIndicesInFlight) return liveIndicesInFlight;

  liveIndicesInFlight = (async () => {
    try {
      const indicesResult = await cmMarketClient.callTool<any>("cm_get_live_indices", { group: "all", nameFilter: "" });
      const map = new Map<string, NseLiveQuote>();
      if (indicesResult?.indices && typeof indicesResult.indices === "object") {
        const defaultDate = parseNseTimestampToDateYmd(indicesResult.nseTimestamp);
        for (const groupArr of Object.values(indicesResult.indices)) {
          if (!Array.isArray(groupArr)) continue;
          for (const row of groupArr as any[]) {
            const idxName = String(row.indexName || "").trim().toUpperCase();
            if (!idxName) continue;
            const last = Number(row.last);
            if (!Number.isFinite(last) || last <= 0) continue;
            const prevClose = Number(row.previousClose) || last;
            const open = Number(row.open) || last;
            const high = Number(row.high) || Math.max(open, last);
            const low = Number(row.low) || Math.min(open, last);
            const change = Number.isFinite(Number(row.change)) ? Number(row.change) : last - prevClose;
            const perChange = Number.isFinite(Number(row.percChange))
              ? Number(row.percChange)
              : prevClose > 0
              ? ((last - prevClose) / prevClose) * 100
              : 0;
            map.set(idxName, {
              symbol: idxName,
              open,
              high,
              low,
              close: last,
              prevClose,
              change,
              perChange,
              volume: 0,
              tradingDate: parseNseTimestampToDateYmd(row.timeVal || defaultDate),
              isIndex: true
            });
          }
        }
      }
      if (map.size > 0) {
        liveIndicesCache = { fetchedAt: Date.now(), map };
      }
      return liveIndicesCache?.map || map;
    } catch {
      return liveIndicesCache?.map || new Map();
    } finally {
      liveIndicesInFlight = null;
    }
  })();

  return liveIndicesInFlight;
}

async function getLiveEquitiesByPrefix(prefix: string): Promise<Map<string, NseLiveQuote>> {
  const key = prefix.toUpperCase().slice(0, 1);
  if (!key) return new Map();

  const now = Date.now();
  const cached = prefixEquitiesCache.get(key);
  if (cached && now - cached.fetchedAt < LIVE_QUOTE_TTL_MS) {
    return cached.map;
  }
  if (cmMarketClient.isCoolingDown()) {
    return cached?.map || new Map();
  }
  const active = prefixEquitiesInFlight.get(key);
  if (active) return active;

  const promise = (async () => {
    try {
      const batch = await cmMarketClient.callTool<any>("cm_get_equity_stocks", {
        limit: 500,
        symbolFilter: key
      });
      const map = new Map<string, NseLiveQuote>();
      const stocks = batch?.stocks;
      if (Array.isArray(stocks)) {
        for (const s of stocks) {
          const sym = String(s.symbol || "").trim().toUpperCase();
          if (!sym) continue;
          const existing = map.get(sym);
          if (existing && s.series !== "EQ") continue;

          const ltp = Number(s.lastTradedPrice);
          if (!Number.isFinite(ltp) || ltp <= 0) continue;
          const prevClose = Number(s.preClosePrice) || ltp;
          const open = Number(s.openPrice) || ltp;
          const high = Number(s.highPrice) || Math.max(open, ltp);
          const low = Number(s.lowPrice) || Math.min(open, ltp);
          const change = Number.isFinite(Number(s.change)) ? Number(s.change) : ltp - prevClose;
          const perChange = Number.isFinite(Number(s.perChange))
            ? Number(s.perChange)
            : prevClose > 0
            ? ((ltp - prevClose) / prevClose) * 100
            : 0;
          const volume = Number(s.volume) || 0;
          const turnover = Number(s.totalTradedValue) || Number(s.turnover) || (volume > 0 ? volume * ltp : 0);
          map.set(sym, {
            symbol: sym,
            open,
            high,
            low,
            close: ltp,
            prevClose,
            change,
            perChange,
            volume,
            turnover,
            tradingDate: parseNseTimestampToDateYmd(s.latestTimestamp),
            isIndex: false
          });
        }
      }
      if (map.size > 0) {
        prefixEquitiesCache.set(key, { fetchedAt: Date.now(), map });
      }
      return prefixEquitiesCache.get(key)?.map || map;
    } catch {
      return cached?.map || new Map();
    } finally {
      prefixEquitiesInFlight.delete(key);
    }
  })();

  prefixEquitiesInFlight.set(key, promise);
  return promise;
}

export async function getNseLiveQuoteForSymbol(symbol: string): Promise<NseLiveQuote | null> {
  if (cmMarketClient.isCoolingDown()) return null;

  const idxMap = getNseIndexMapping(symbol);
  if (idxMap) {
    const indices = await getLiveIndicesMap();
    return indices.get(idxMap.cmLiveName.toUpperCase()) || null;
  }

  const nseSym = toOfficialNseSymbol(symbol);
  if (!nseSym) return null;

  const prefixMap = await getLiveEquitiesByPrefix(nseSym[0]);
  const fromPrefix = prefixMap.get(nseSym);
  if (fromPrefix) return fromPrefix;

  const cachedSingle = singleQuoteCache.get(nseSym);
  if (cachedSingle && Date.now() - cachedSingle.fetchedAt < LIVE_QUOTE_TTL_MS) {
    return cachedSingle.quote;
  }
  if (cmMarketClient.isCoolingDown()) return null;

  try {
    const q = await cmMarketClient.callTool<any>("cm_get_stock_quote", { symbol: nseSym });
    const s = q?.stock;
    const ltp = Number(s?.lastTradedPrice);
    if (!Number.isFinite(ltp) || ltp <= 0) {
      singleQuoteCache.set(nseSym, { fetchedAt: Date.now(), quote: null });
      return null;
    }
    const prevClose = Number(s?.preClosePrice) || ltp;
    const open = Number(s?.openPrice) || ltp;
    const high = Number(s?.highPrice) || Math.max(open, ltp);
    const low = Number(s?.lowPrice) || Math.min(open, ltp);
    const volume = Number(s?.volume) || 0;
    const turnover = Number(s?.totalTradedValue) || Number(s?.turnover) || (volume > 0 ? volume * ltp : 0);
    const quote: NseLiveQuote = {
      symbol: nseSym,
      open,
      high,
      low,
      close: ltp,
      prevClose,
      change: Number.isFinite(Number(s?.change)) ? Number(s.change) : ltp - prevClose,
      perChange: Number.isFinite(Number(s?.perChange))
        ? Number(s.perChange)
        : prevClose > 0
        ? ((ltp - prevClose) / prevClose) * 100
        : 0,
      volume,
      turnover,
      tradingDate: parseNseTimestampToDateYmd(s?.latestTimestamp),
      isIndex: false
    };
    singleQuoteCache.set(nseSym, { fetchedAt: Date.now(), quote });
    return quote;
  } catch {
    singleQuoteCache.set(nseSym, { fetchedAt: Date.now(), quote: null });
    return null;
  }
}

export async function getNseLiveQuotesForSymbols(symbols: string[]): Promise<Record<string, NseLiveQuote>> {
  const out: Record<string, NseLiveQuote> = {};
  if (!symbols.length || cmMarketClient.isCoolingDown()) return out;

  let needsIndices = false;
  const neededPrefixes = new Set<string>();

  for (const sym of symbols) {
    if (getNseIndexMapping(sym)) {
      needsIndices = true;
    } else {
      const nseSym = toOfficialNseSymbol(sym);
      if (nseSym) neededPrefixes.add(nseSym[0]);
    }
  }

  const [indicesMap] = await Promise.all([
    needsIndices ? getLiveIndicesMap() : Promise.resolve(new Map<string, NseLiveQuote>()),
    ...Array.from(neededPrefixes).map(p => getLiveEquitiesByPrefix(p))
  ]);

  const missing: string[] = [];
  for (const sym of symbols) {
    const idxMap = getNseIndexMapping(sym);
    if (idxMap) {
      const q = indicesMap.get(idxMap.cmLiveName.toUpperCase());
      if (q) out[sym] = q;
      continue;
    }
    const nseSym = toOfficialNseSymbol(sym);
    if (!nseSym) continue;
    const pMap = prefixEquitiesCache.get(nseSym[0])?.map;
    const q = pMap?.get(nseSym);
    if (q) out[sym] = q;
    else missing.push(sym);
  }

  if (missing.length > 0 && missing.length <= 10 && !cmMarketClient.isCoolingDown()) {
    for (const sym of missing) {
      const q = await getNseLiveQuoteForSymbol(sym).catch(() => null);
      if (q) out[sym] = q;
    }
  }

  return out;
}

// ============================================================================
// Disk-Persisted Bhavcopy EOD Cache (nse_eod_cache.json) + Incremental Extend
// ============================================================================

interface CachedEodSeries {
  fetchedAt: number;
  istDayKey: string;
  monthsCovered: number;
  byDate: Map<string, Candle>;
  candles: Candle[];
  lastDateYmd: string;
}

interface SerializedEodEntry {
  fetchedAt: number;
  istDayKey: string;
  monthsCovered: number;
  lastDateYmd: string;
  // Compact tuple: [ymd, open, high, low, close, volume, turnover]
  rows: Array<[string, number, number, number, number, number, number]>;
}

const eodCache = new Map<string, CachedEodSeries>();
const eodInFlight = new Map<string, Promise<CachedEodSeries | null>>();
let eodDiskLoaded = false;
let eodDiskLoadPromise: Promise<void> | null = null;
let eodSaveTimer: ReturnType<typeof setTimeout> | null = null;
let eodDirty = false;

export async function ensureNseEodDiskCacheLoaded(): Promise<void> {
  if (eodDiskLoaded) return;
  if (eodDiskLoadPromise) return eodDiskLoadPromise;

  eodDiskLoadPromise = (async () => {
    try {
      const io = await getNodeDiskCacheIo();
      if (!io) return;
      const raw = await io.readFile(io.cacheFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        let count = 0;
        for (const [key, item] of Object.entries(parsed.entries as Record<string, SerializedEodEntry>)) {
          if (!item || !Array.isArray(item.rows) || item.rows.length < 5) continue;
          const byDate = new Map<string, Candle>();
          const candles: Candle[] = [];
          for (const tuple of item.rows) {
            const [ymd, open, high, low, close, volume, turnover] = tuple;
            if (!ymd || !Number.isFinite(close) || close <= 0) continue;
            const c: Candle = {
              time: ymdToIstMarketMs(ymd),
              open,
              high,
              low,
              close,
              volume: volume || 0,
              turnover: turnover || 0
            };
            byDate.set(ymd, c);
            candles.push(c);
          }
          if (candles.length >= 5) {
            eodCache.set(key, {
              fetchedAt: item.fetchedAt || Date.now(),
              istDayKey: item.istDayKey || "",
              monthsCovered: item.monthsCovered || 12,
              byDate,
              candles,
              lastDateYmd: item.lastDateYmd || item.rows[item.rows.length - 1][0]
            });
            count++;
          }
        }
        if (count > 0) {
          console.log(`[NSE EOD Cache] Hydrated ${count} official Bhavcopy series from disk (nse_eod_cache.json)`);
        }
      }
    } catch {
      // No disk cache yet — will build automatically on first fetches
    } finally {
      eodDiskLoaded = true;
      eodDiskLoadPromise = null;
    }
  })();

  return eodDiskLoadPromise;
}

function scheduleEodDiskPersist() {
  eodDirty = true;
  if (eodSaveTimer) return;
  eodSaveTimer = setTimeout(async () => {
    eodSaveTimer = null;
    if (!eodDirty) return;
    eodDirty = false;
    try {
      // Keep up to 650 most recently used series on disk so file stays compact & fast
      const entriesArr = Array.from(eodCache.entries())
        .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
        .slice(0, 650);

      const serialized: Record<string, SerializedEodEntry> = {};
      for (const [key, val] of entriesArr) {
        const sortedDates = Array.from(val.byDate.keys()).sort();
        const rows: Array<[string, number, number, number, number, number, number]> = sortedDates.map(ymd => {
          const c = val.byDate.get(ymd)!;
          return [
            ymd,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
            c.turnover || 0
          ];
        });
        serialized[key] = {
          fetchedAt: val.fetchedAt,
          istDayKey: val.istDayKey,
          monthsCovered: val.monthsCovered,
          lastDateYmd: val.lastDateYmd,
          rows
        };
      }
      const payload = JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        symbolCount: entriesArr.length,
        entries: serialized
      });
      const io = await getNodeDiskCacheIo();
      if (!io) return;
      const tmpPath = `${io.cacheFilePath}.tmp.${process.pid}.${Date.now()}`;
      await io.writeFile(tmpPath, payload, "utf-8");
      await io.rename(tmpPath, io.cacheFilePath);
    } catch (err: any) {
      console.warn("[NSE EOD Cache] Disk persist warning:", err?.message || err);
    }
  }, 4000);
}

/**
 * Seeds the real-data EOD disk cache with verified live exchange daily OHLCV candles
 * (e.g., official NSE `.NS` daily series from Yahoo Finance when NSE MCP WAF is cooling down).
 * Only accepts genuine exchange candles (>= 20 bars with valid timestamps and positive closes).
 */
export function seedEodCacheFromRealCandles(symbol: string, candles: Candle[]): void {
  if (!candles || candles.length < 20) return;
  const idxMap = getNseIndexMapping(symbol);
  const canonicalKey = idxMap ? `IDX:${idxMap.bhavcopyName}` : `EQ:${toOfficialNseSymbol(symbol) || ""}`;
  if (canonicalKey === "EQ:") return;

  const existing = eodCache.get(canonicalKey);
  const byDate = new Map<string, Candle>(existing ? existing.byDate : undefined);
  const istFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

  let addedOrUpdated = false;
  for (const c of candles) {
    if (!c || !Number.isFinite(c.close) || c.close <= 0 || !Number.isFinite(c.time)) continue;
    const ymd = istFmt.format(new Date(c.time));
    const prev = byDate.get(ymd);
    if (!prev || prev.close !== c.close || prev.high !== c.high || prev.low !== c.low) {
      byDate.set(ymd, {
        time: ymdToIstMarketMs(ymd),
        open: c.open || c.close,
        high: c.high || Math.max(c.open || c.close, c.close),
        low: c.low || Math.min(c.open || c.close, c.close),
        close: c.close,
        volume: c.volume || 0,
        turnover: c.turnover || (c.close * (c.volume || 0))
      });
      addedOrUpdated = true;
    }
  }

  if (!addedOrUpdated && existing) return;

  const sortedDates = Array.from(byDate.keys()).sort();
  if (sortedDates.length < 20) return;
  const mergedCandles = sortedDates.map(d => byDate.get(d)!);
  const lastDateYmd = sortedDates[sortedDates.length - 1];
  const monthsCovered = Math.max(existing?.monthsCovered || 0, Math.round(sortedDates.length / 21));

  eodCache.set(canonicalKey, {
    fetchedAt: Date.now(),
    istDayKey: getCurrentIstDayKey(),
    monthsCovered,
    byDate,
    candles: mergedCandles,
    lastDateYmd
  });
  scheduleEodDiskPersist();
}

function getCurrentIstDayKey(): string {
  const now = new Date();
  const istStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const d = new Date(istStr);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slot = d.getHours() >= 16 ? "post" : "pre";
  return `${ymd}_${slot}`;
}

/**
 * Latest NSE trading date (YYYY-MM-DD, IST) whose official EOD Bhavcopy is expected to be published.
 * Weekdays before 16:30 IST -> previous weekday; weekends -> Friday; weekdays >= 16:30 IST -> today.
 */
function getLatestExpectedClosedTradingYmd(): string {
  const now = new Date();
  const istStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const d = new Date(istStr);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const mins = d.getHours() * 60 + d.getMinutes();

  if (dow === 6) {
    d.setDate(d.getDate() - 1); // Sat -> Fri
  } else if (dow === 0) {
    d.setDate(d.getDate() - 2); // Sun -> Fri
  } else if (mins < 16 * 60 + 30) {
    d.setDate(d.getDate() - (dow === 1 ? 3 : 1));
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stepBackMonthsYmd(baseDate: Date, monthsBack: number): string {
  const d = new Date(baseDate.getTime());
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  if (monthsBack > 0) {
    d.setUTCDate(d.getUTCDate() + 2);
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

async function fetchClosedEodHistoryFromBhavcopy(symbol: string, monthsNeeded: number): Promise<CachedEodSeries | null> {
  await ensureNseEodDiskCacheLoaded();

  const idxMap = getNseIndexMapping(symbol);
  const canonicalKey = idxMap ? `IDX:${idxMap.bhavcopyName}` : `EQ:${toOfficialNseSymbol(symbol) || ""}`;
  if (canonicalKey === "EQ:") return null;

  const istDayKey = getCurrentIstDayKey();
  const expectedClosedYmd = getLatestExpectedClosedTradingYmd();
  const now = Date.now();
  const existing = eodCache.get(canonicalKey);

  // Instant 0ms hit if disk/memory cache already covers the latest closed NSE session & required history depth
  if (
    existing &&
    existing.monthsCovered >= monthsNeeded &&
    (existing.lastDateYmd >= expectedClosedYmd ||
      (existing.istDayKey === istDayKey && now - existing.fetchedAt < 12 * 60 * 60 * 1000))
  ) {
    return existing;
  }

  // If bhavcopy is in cooldown, ONLY serve disk cache if it is genuinely current (checked this IST slot or already covers latest closed day);
  // otherwise return null so caller fetches fresh live exchange OHLCV from Yahoo Finance `.NS` (never serve stale days!).
  if (bhavcopyClient.isCoolingDown()) {
    if (
      existing &&
      existing.candles.length >= 20 &&
      (existing.lastDateYmd >= expectedClosedYmd ||
        (existing.istDayKey === istDayKey && now - existing.fetchedAt < 60 * 60 * 1000))
    ) {
      return existing;
    }
    return null;
  }

  // Stale-while-revalidate: only serve immediately if cache is fresh (at most 1 trading day behind)
  const hasDeepDiskForSwr = Boolean(
    existing &&
      existing.monthsCovered >= monthsNeeded &&
      existing.candles.length >= 60 &&
      (existing.lastDateYmd >= expectedClosedYmd || existing.istDayKey === istDayKey)
  );

  const inFlightKey = `${canonicalKey}:${monthsNeeded}`;
  const active = eodInFlight.get(inFlightKey);
  if (active) return hasDeepDiskForSwr ? existing! : active;

  for (const [k, p] of eodInFlight.entries()) {
    if (k.startsWith(`${canonicalKey}:`)) {
      const m = Number(k.split(":").pop());
      if (Number.isFinite(m) && m >= monthsNeeded) {
        return hasDeepDiskForSwr ? existing! : p;
      }
    }
  }

  const promise = (async (): Promise<CachedEodSeries | null> => {
    try {
      const today = new Date();
      // Incremental catch-up! If we already have historical chunks cached from an earlier day on disk,
      // we only need to fetch the most recent 1-3 month chunk to top up new trading days instead of re-fetching all 24 months!
      const hasDeepDiskHistory = existing && existing.monthsCovered >= monthsNeeded && existing.candles.length >= 60;
      const canExtendSameDay = existing && existing.istDayKey === istDayKey;
      const byDate = new Map<string, Candle>(existing ? existing.byDate : undefined);

      if (idxMap) {
        const chunkMonths = 12;
        const endDates: string[] = [];
        if (hasDeepDiskHistory) {
          // Only top up latest 1 month of new EOD bars
          endDates.push("today");
        } else {
          const alreadyCoveredMonths = canExtendSameDay ? existing.monthsCovered : 0;
          const startChunk = Math.floor(alreadyCoveredMonths / chunkMonths);
          const totalChunks = Math.max(1, Math.ceil(monthsNeeded / chunkMonths));
          for (let i = startChunk; i < totalChunks; i++) {
            endDates.push(i === 0 ? "today" : stepBackMonthsYmd(today, i * chunkMonths));
          }
        }

        const chunks = await Promise.all(
          endDates.map(endDate =>
            bhavcopyClient
              .callTool<any>("get_index_history", {
                indexName: idxMap.bhavcopyName,
                months: hasDeepDiskHistory ? 1 : chunkMonths,
                endDate
              })
              .catch(() => null)
          )
        );

        for (const chunk of chunks) {
          const rows = chunk?.data;
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            const ymd = String(row.date || "").slice(0, 10);
            if (!ymd) continue;
            const close = Number(row.close);
            if (!Number.isFinite(close) || close <= 0) continue;
            const open = Number(row.open) || close;
            const high = Number(row.high) || Math.max(open, close);
            const low = Number(row.low) || Math.min(open, close);
            const volume = Number(row.volume) || 0;
            const turnover = Number(row.turnoverCr) ? Number(row.turnoverCr) * 1e7 : (Number(row.totalTradedValue) || 0);
            byDate.set(ymd, {
              time: ymdToIstMarketMs(ymd),
              open,
              high,
              low,
              close,
              volume,
              turnover
            });
          }
        }
      } else {
        const nseSym = toOfficialNseSymbol(symbol)!;
        const chunkMonths = 3;
        const endDates: string[] = [];
        if (hasDeepDiskHistory) {
          // Only fetch the newest 1 month chunk to top up recent trading sessions!
          endDates.push("today");
        } else {
          const alreadyCoveredMonths = canExtendSameDay ? existing.monthsCovered : 0;
          const startChunk = Math.floor(alreadyCoveredMonths / chunkMonths);
          const totalChunks = Math.max(1, Math.ceil(monthsNeeded / chunkMonths));
          for (let i = startChunk; i < totalChunks; i++) {
            endDates.push(i === 0 ? "today" : stepBackMonthsYmd(today, i * chunkMonths));
          }
        }

        const chunks = await Promise.all(
          endDates.map(endDate =>
            bhavcopyClient
              .callTool<any>("get_stock_history", {
                symbol: nseSym,
                months: hasDeepDiskHistory ? 1 : chunkMonths,
                endDate
              })
              .catch(() => null)
          )
        );

        for (const chunk of chunks) {
          const rows = chunk?.data;
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            const ymd = String(row.date || "").slice(0, 10);
            if (!ymd) continue;
            const close = Number(row.close);
            if (!Number.isFinite(close) || close <= 0) continue;
            const open = Number(row.open) || close;
            const high = Number(row.high) || Math.max(open, close);
            const low = Number(row.low) || Math.min(open, close);
            const volume = Number(row.volume) || 0;
            const turnover = Number(row.totalTradedValue) || (volume > 0 ? volume * close : 0);
            byDate.set(ymd, {
              time: ymdToIstMarketMs(ymd),
              open,
              high,
              low,
              close,
              volume,
              turnover
            });
          }
        }
      }

      const sortedDates = Array.from(byDate.keys()).sort();
      if (sortedDates.length < 5) {
        return existing && existing.candles.length >= 5 ? existing : null;
      }

      const candles = sortedDates.map(d => byDate.get(d)!);
      const entry: CachedEodSeries = {
        fetchedAt: Date.now(),
        istDayKey,
        monthsCovered: Math.max(existing?.monthsCovered || 0, monthsNeeded),
        byDate,
        candles,
        lastDateYmd: sortedDates[sortedDates.length - 1]
      };

      const prev = eodCache.get(canonicalKey);
      if (!prev || prev.istDayKey !== istDayKey || entry.monthsCovered >= prev.monthsCovered) {
        eodCache.set(canonicalKey, entry);
        scheduleEodDiskPersist();
      }
      return entry;
    } finally {
      eodInFlight.delete(inFlightKey);
    }
  })();

  eodInFlight.set(inFlightKey, promise);
  // If we already have deep cached history on disk, return immediately while background top-up finishes
  if (hasDeepDiskForSwr && existing) {
    promise.catch(() => {});
    return existing;
  }
  return promise;
}

function isNseMarketSessionActiveIST(now: Date = new Date()): boolean {
  const istStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const d = new Date(istStr);
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  // Active NSE equity session window: 09:05 IST to 15:45 IST
  return mins >= 9 * 60 + 5 && mins <= 15 * 60 + 45;
}

function getTodayYmdIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

function getCachedLiveQuoteSync(symbol: string): NseLiveQuote | null {
  const idxMap = getNseIndexMapping(symbol);
  if (idxMap) {
    return liveIndicesCache?.map.get(idxMap.cmLiveName.toUpperCase()) || null;
  }
  const nseSym = toOfficialNseSymbol(symbol);
  if (!nseSym) return null;
  const fromPrefix = prefixEquitiesCache.get(nseSym[0])?.map.get(nseSym);
  if (fromPrefix) return fromPrefix;
  const cachedSingle = singleQuoteCache.get(nseSym);
  if (cachedSingle && Date.now() - cachedSingle.fetchedAt < LIVE_QUOTE_TTL_MS * 3) {
    return cachedSingle.quote;
  }
  return null;
}

export async function fetchNseDailyCandles(symbol: string, monthsNeeded = 12): Promise<Candle[] | null> {
  const eod = await fetchClosedEodHistoryFromBhavcopy(symbol, monthsNeeded);

  if (!eod || eod.candles.length < 5) {
    return null;
  }

  // Only fetch per-symbol CM live quote when NSE market is actively trading OR EOD cache is behind the latest closed session.
  // Use instant 0ms memory-cached prefix/index quotes when available, and non-blocking SWR when deep EOD history is already on disk!
  const todayYmd = getTodayYmdIST();
  const expectedClosedYmd = getLatestExpectedClosedTradingYmd();
  const marketActive = isNseMarketSessionActiveIST();
  const needsLiveStitch = marketActive
    ? eod.lastDateYmd < todayYmd
    : eod.lastDateYmd < expectedClosedYmd;

  let liveQuote: NseLiveQuote | null = null;
  if (needsLiveStitch) {
    liveQuote = getCachedLiveQuoteSync(symbol);
    if (!liveQuote) {
      const livePromise = getNseLiveQuoteForSymbol(symbol).catch(() => null);
      if (marketActive) {
        // Active session: allow brief 400ms window for batched prefix quote; otherwise return immediately while warming cache
        liveQuote = await Promise.race([
          livePromise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 400))
        ]);
      } else if (eod.candles.length >= 60) {
        // Market closed & deep EOD history already on disk: warm live prefix cache non-blockingly for 0ms latency!
        livePromise.catch(() => {});
      } else {
        liveQuote = await Promise.race([
          livePromise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 600))
        ]);
      }
    }
  }

  const candles = eod.candles.slice();
  if (liveQuote && liveQuote.close > 0 && liveQuote.tradingDate) {
    const liveCandle: Candle = {
      time: ymdToIstMarketMs(liveQuote.tradingDate),
      open: liveQuote.open > 0 ? liveQuote.open : liveQuote.close,
      high: liveQuote.high > 0 ? liveQuote.high : Math.max(liveQuote.open || liveQuote.close, liveQuote.close),
      low: liveQuote.low > 0 ? liveQuote.low : Math.min(liveQuote.open || liveQuote.close, liveQuote.close),
      close: liveQuote.close,
      volume: liveQuote.volume > 0 ? liveQuote.volume : (candles[candles.length - 1]?.volume || 0),
      turnover: liveQuote.turnover && liveQuote.turnover > 0
        ? liveQuote.turnover
        : (liveQuote.volume > 0 ? liveQuote.volume * liveQuote.close : (candles[candles.length - 1]?.turnover || 0))
    };

    if (liveQuote.tradingDate > eod.lastDateYmd) {
      candles.push(liveCandle);
    } else if (liveQuote.tradingDate === eod.lastDateYmd) {
      const last = candles[candles.length - 1];
      if (last && last.volume === 0 && liveCandle.volume > 0) {
        candles[candles.length - 1] = { ...last, volume: liveCandle.volume, turnover: liveCandle.turnover || last.turnover };
      }
    }
  }

  return candles;
}

function getIsoMondayKeyIST(ms: number): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ms));
  const [y, m, d] = ymd.split("-").map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = utcDate.getUTCDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  utcDate.setUTCDate(utcDate.getUTCDate() + diffToMonday);
  return utcDate.toISOString().slice(0, 10);
}

export function aggregateNseWeeklyCandles(dailyCandles: Candle[]): Candle[] {
  if (dailyCandles.length === 0) return [];
  const weekOrder: string[] = [];
  const weekBuckets = new Map<string, Candle[]>();

  for (const c of dailyCandles) {
    const key = getIsoMondayKeyIST(c.time);
    let bucket = weekBuckets.get(key);
    if (!bucket) {
      bucket = [];
      weekBuckets.set(key, bucket);
      weekOrder.push(key);
    }
    bucket.push(c);
  }

  return weekOrder.map(key => {
    const chunk = weekBuckets.get(key)!;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let turnover = 0;
    for (const c of chunk) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
      turnover += c.turnover || 0;
    }
    return {
      time: chunk[0].time,
      open: chunk[0].open,
      high,
      low,
      close: chunk[chunk.length - 1].close,
      volume,
      turnover
    };
  });
}

export function aggregateNse3DayCandles(dailyCandles: Candle[]): Candle[] {
  const aggregated: Candle[] = [];
  for (let i = 0; i < dailyCandles.length; i += 3) {
    const chunk = dailyCandles.slice(i, i + 3);
    if (chunk.length === 0) continue;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let turnover = 0;
    for (const c of chunk) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
      turnover += c.turnover || 0;
    }
    aggregated.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high,
      low,
      close: chunk[chunk.length - 1].close,
      volume,
      turnover
    });
  }
  return aggregated;
}

export function aggregateNseMonthlyCandles(dailyCandles: Candle[]): Candle[] {
  if (dailyCandles.length === 0) return [];
  const monthOrder: string[] = [];
  const buckets = new Map<string, Candle[]>();

  for (const c of dailyCandles) {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.time));
    const key = ymd.slice(0, 7);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      monthOrder.push(key);
    }
    bucket.push(c);
  }

  return monthOrder.map(key => {
    const chunk = buckets.get(key)!;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let turnover = 0;
    for (const c of chunk) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
      turnover += c.turnover || 0;
    }
    return {
      time: chunk[0].time,
      open: chunk[0].open,
      high,
      low,
      close: chunk[chunk.length - 1].close,
      volume,
      turnover
    };
  });
}

export async function fetchNseHybridCandles(symbol: string, timeframe: Timeframe): Promise<Candle[] | null> {
  if (!isNseMcpTimeframe(timeframe)) return null;

  try {
    // Request 12+ months minimum so 1D/3D/1W/1M all reuse the exact same disk-cached daily series
    // (nse_eod_cache.json stores 24-48 months per symbol -> 0ms instant hit for all four higher timeframes!)
    const daily = await fetchNseDailyCandles(symbol, 12);
    if (!daily || daily.length < 5) return null;

    if (timeframe === "1D") return daily;
    if (timeframe === "3D") {
      const d3 = aggregateNse3DayCandles(daily);
      return d3.length >= 5 ? d3 : null;
    }
    if (timeframe === "1W") {
      const weekly = aggregateNseWeeklyCandles(daily);
      return weekly.length >= 5 ? weekly : null;
    }
    if (timeframe === "1M") {
      const monthly = aggregateNseMonthlyCandles(daily);
      return monthly.length >= 5 ? monthly : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// 1. Market Mood & India VIX Regime Overlay (get_market_mood + cm_get_index_quote)
// ============================================================================

export type MacroMoodRegime =
  | "WASHOUT_FEAR"
  | "ELEVATED_VOL"
  | "RISK_ON"
  | "OVERBOUGHT_GREED"
  | "NEUTRAL";

export interface NseMarketMoodSnapshot {
  date: string;
  updatedAt: string;
  indiaVix: {
    level: number;
    prevClose: number;
    change1dPct: number;
    change1wPct: number;
    change1mPct: number;
    yearHigh: number;
    yearLow: number;
    zone: "LOW_COMPLACENCY" | "NORMAL" | "ELEVATED" | "PANIC_SPIKE";
  };
  breadth: {
    stocksUp: number;
    stocksDown: number;
    stocksUnchanged: number;
    totalStocks: number;
    advPct: number;
    reading: string;
    indicesUp: number;
    indicesDown: number;
  };
  benchmarks: {
    nifty50: { close: number; changePct: number };
    nifty500: { close: number; changePct: number };
    bankNifty: { close: number; changePct: number };
    midcap100: { close: number; changePct: number };
    smallcap100: { close: number; changePct: number };
  };
  moodRegime: MacroMoodRegime;
  regimeNote: string;
}

let marketMoodCache: { fetchedAt: number; data: NseMarketMoodSnapshot } | null = null;
let marketMoodInFlight: Promise<NseMarketMoodSnapshot | null> | null = null;

export async function getNseMarketMood(force = false): Promise<NseMarketMoodSnapshot | null> {
  const now = Date.now();
  if (!force && marketMoodCache && now - marketMoodCache.fetchedAt < LIVE_QUOTE_TTL_MS) {
    return marketMoodCache.data;
  }
  if (marketMoodInFlight) return marketMoodInFlight;

  marketMoodInFlight = (async () => {
    try {
      const [moodRes, vixRes, liveIndices] = await Promise.all([
        bhavcopyClient.callTool<any>("get_market_mood", {}).catch(() => null),
        cmMarketClient.callTool<any>("cm_get_index_quote", { indexName: "INDIA VIX" }).catch(() => null),
        getLiveIndicesMap().catch(() => new Map<string, NseLiveQuote>())
      ]);

      if (!moodRes && !vixRes) {
        return marketMoodCache?.data || null;
      }

      const vixLive = vixRes?.index;
      const vixBhav = moodRes?.india_vix;
      const vixLevel = Number(vixLive?.last) || Number(vixBhav?.level) || 14.0;
      const vixPrev = Number(vixLive?.previousClose) || vixLevel;
      const vix1d = Number.isFinite(Number(vixLive?.percChange))
        ? Number(vixLive.percChange)
        : Number(vixBhav?.change_1d_pct) || 0;
      const vix1w = Number.isFinite(Number(vixLive?.comparisons?.oneWeekAgo?.changePct))
        ? Number(vixLive.comparisons.oneWeekAgo.changePct)
        : Number(vixBhav?.vs_1w_ago?.change_pct) || 0;
      const vix1m = Number.isFinite(Number(vixLive?.comparisons?.oneMonthAgo?.changePct))
        ? Number(vixLive.comparisons.oneMonthAgo.changePct)
        : Number(vixBhav?.vs_1m_ago?.change_pct) || 0;

      const vixZone: NseMarketMoodSnapshot["indiaVix"]["zone"] =
        vixLevel >= 22 || vix1w >= 18
          ? "PANIC_SPIKE"
          : vixLevel >= 16.5 || vix1w >= 10
          ? "ELEVATED"
          : vixLevel <= 11.5
          ? "LOW_COMPLACENCY"
          : "NORMAL";

      const sb = moodRes?.stock_breadth || {};
      const ib = moodRes?.index_breadth || {};
      const stocksUp = Number(sb.up) || 0;
      const stocksDown = Number(sb.down) || 0;
      const stocksUnchanged = Number(sb.unchanged) || 0;
      const totalStocks = Number(sb.stocks) || stocksUp + stocksDown + stocksUnchanged;
      const advPct = Number.isFinite(Number(sb.up_pct))
        ? Number(sb.up_pct)
        : totalStocks > 0
        ? Number(((stocksUp / totalStocks) * 100).toFixed(1))
        : 50;

      const liveN50 = liveIndices.get("NIFTY 50");
      const liveN500 = liveIndices.get("NIFTY 500");
      const liveBank = liveIndices.get("NIFTY BANK");
      const liveMid = liveIndices.get("NIFTY MIDCAP 100");
      const liveSmall = liveIndices.get("NIFTY SMLCAP 100") || liveIndices.get("NIFTY SMALLCAP 100");

      const bm = moodRes?.benchmarks || {};
      const nifty50 = {
        close: liveN50?.close || Number(bm["Nifty 50"]?.close) || 0,
        changePct: Number.isFinite(liveN50?.perChange) ? Number(liveN50!.perChange.toFixed(2)) : Number(bm["Nifty 50"]?.change_pct) || 0
      };
      const nifty500 = {
        close: liveN500?.close || Number(bm["Nifty 500"]?.close) || 0,
        changePct: Number.isFinite(liveN500?.perChange) ? Number(liveN500!.perChange.toFixed(2)) : Number(bm["Nifty 500"]?.change_pct) || 0
      };
      const bankNifty = {
        close: liveBank?.close || 0,
        changePct: Number.isFinite(liveBank?.perChange) ? Number(liveBank!.perChange.toFixed(2)) : 0
      };
      const midcap100 = {
        close: liveMid?.close || Number(bm["NIFTY Midcap 100"]?.close) || 0,
        changePct: Number.isFinite(liveMid?.perChange) ? Number(liveMid!.perChange.toFixed(2)) : Number(bm["NIFTY Midcap 100"]?.change_pct) || 0
      };
      const smallcap100 = {
        close: liveSmall?.close || Number(bm["NIFTY Smallcap 100"]?.close) || 0,
        changePct: Number.isFinite(liveSmall?.perChange) ? Number(liveSmall!.perChange.toFixed(2)) : Number(bm["NIFTY Smallcap 100"]?.change_pct) || 0
      };

      let moodRegime: MacroMoodRegime = "NEUTRAL";
      let regimeNote = "Balanced NSE breadth & volatility; standard Laya System-1 weights active.";

      if ((vixLevel >= 17 || vix1w >= 10) && advPct <= 35) {
        moodRegime = "WASHOUT_FEAR";
        regimeNote = "Broad washout + rising India VIX: Laya boosts oversold climax reversal conviction & tightens trend-chase guard.";
      } else if (vixLevel >= 18 || vix1d >= 6) {
        moodRegime = "ELEVATED_VOL";
        regimeNote = "Elevated India VIX: Laya increases whipsaw-trap vigilance on low-confluence breakouts.";
      } else if (advPct >= 72 && vixLevel <= 13) {
        moodRegime = "OVERBOUGHT_GREED";
        regimeNote = "Extreme positive breadth + compressed VIX: Laya elevates bearish climax exhaustion watch.";
      } else if (advPct >= 58 && vixLevel < 16) {
        moodRegime = "RISK_ON";
        regimeNote = "Healthy advancing breadth + calm VIX: Laya favors trend & pullback continuation setups.";
      }

      const snapshot: NseMarketMoodSnapshot = {
        date: String(moodRes?.date || parseNseTimestampToDateYmd(vixRes?.nseTimestamp)),
        updatedAt: new Date().toISOString(),
        indiaVix: {
          level: Number(vixLevel.toFixed(2)),
          prevClose: Number(vixPrev.toFixed(2)),
          change1dPct: Number(vix1d.toFixed(2)),
          change1wPct: Number(vix1w.toFixed(2)),
          change1mPct: Number(vix1m.toFixed(2)),
          yearHigh: Number(vixLive?.yearHigh) || 0,
          yearLow: Number(vixLive?.yearLow) || 0,
          zone: vixZone
        },
        breadth: {
          stocksUp,
          stocksDown,
          stocksUnchanged,
          totalStocks,
          advPct: Number(advPct.toFixed(1)),
          reading: String(sb.reading || (advPct >= 55 ? "broad advance" : advPct <= 40 ? "broad decline" : "mixed")),
          indicesUp: Number(ib.up) || 0,
          indicesDown: Number(ib.down) || 0
        },
        benchmarks: {
          nifty50,
          nifty500,
          bankNifty,
          midcap100,
          smallcap100
        },
        moodRegime,
        regimeNote
      };

      marketMoodCache = { fetchedAt: Date.now(), data: snapshot };
      return snapshot;
    } catch {
      return marketMoodCache?.data || null;
    } finally {
      marketMoodInFlight = null;
    }
  })();

  return marketMoodInFlight;
}

// ============================================================================
// 2. Corporate Action Guard (get_corporate_actions)
// ============================================================================

export interface CorporateActionEvent {
  exDate: string;
  actionType: string;
  purpose: string;
  adjustmentFactor: number;
}

export interface CorporateActionGuardResult {
  hasCorporateAction: boolean;
  recentAnomalyDropPct?: number;
  anomalyDate?: string;
  matchedAction?: CorporateActionEvent;
  flaggedDates: string[];
}

const corpActionsCache = new Map<string, { fetchedAt: number; actions: CorporateActionEvent[] }>();
const CORP_ACTIONS_TTL_MS = 12 * 60 * 60 * 1000;

export async function getNseCorporateActions(symbol: string): Promise<CorporateActionEvent[]> {
  const nseSym = toOfficialNseSymbol(symbol);
  if (!nseSym || getNseIndexMapping(symbol)) return [];

  const cached = corpActionsCache.get(nseSym);
  if (cached && Date.now() - cached.fetchedAt < CORP_ACTIONS_TTL_MS) {
    return cached.actions;
  }
  if (bhavcopyClient.isCoolingDown()) {
    return cached?.actions || [];
  }

  try {
    const res = await bhavcopyClient.callTool<any>("get_corporate_actions", { symbol: nseSym });
    const rawActions = Array.isArray(res?.actions) ? res.actions : [];
    const actions: CorporateActionEvent[] = rawActions
      .map((a: any) => ({
        exDate: String(a.exDate || "").slice(0, 10),
        actionType: String(a.actionType || "").toUpperCase(),
        purpose: String(a.purpose || ""),
        adjustmentFactor: Number(a.adjustmentFactor) || 1
      }))
      .filter((a: CorporateActionEvent) => Boolean(a.exDate));
    corpActionsCache.set(nseSym, { fetchedAt: Date.now(), actions });
    return actions;
  } catch {
    corpActionsCache.set(nseSym, { fetchedAt: Date.now(), actions: cached?.actions || [] });
    return cached?.actions || [];
  }
}

function candleTimeToYmd(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ms));
}

function dateDiffDays(ymdA: string, ymdB: string): number {
  const a = Date.parse(`${ymdA}T00:00:00Z`);
  const b = Date.parse(`${ymdB}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999;
  return Math.abs(Math.round((a - b) / (1000 * 60 * 60 * 24)));
}

/**
 * Inspects daily candles for any single-day close-to-close drop > 15% in the lookback window.
 * Only triggers a `get_corporate_actions` lookup when such an anomaly exists, keeping WAF traffic minimal.
 */
export async function checkCorporateActionGuard(
  symbol: string,
  dailyCandles: Candle[],
  lookbackDays = 60
): Promise<CorporateActionGuardResult> {
  if (!dailyCandles || dailyCandles.length < 3 || getNseIndexMapping(symbol)) {
    return { hasCorporateAction: false, flaggedDates: [] };
  }

  const startIdx = Math.max(1, dailyCandles.length - lookbackDays);
  const anomalies: Array<{ ymd: string; dropPct: number }> = [];

  for (let i = startIdx; i < dailyCandles.length; i++) {
    const prev = dailyCandles[i - 1]?.close || 0;
    const cur = dailyCandles[i]?.close || 0;
    if (prev > 0 && cur > 0) {
      const pct = ((cur - prev) / prev) * 100;
      if (pct <= -15) {
        anomalies.push({ ymd: candleTimeToYmd(dailyCandles[i].time), dropPct: Number(pct.toFixed(2)) });
      }
    }
  }

  if (anomalies.length === 0) {
    return { hasCorporateAction: false, flaggedDates: [] };
  }

  const actions = await getNseCorporateActions(symbol);
  const priceAdjustingActions = actions.filter(
    a =>
      a.actionType === "SPLIT" ||
      a.actionType === "BONUS" ||
      a.actionType === "DEMERGER" ||
      a.actionType === "RIGHTS" ||
      (Number.isFinite(a.adjustmentFactor) && a.adjustmentFactor > 0 && Math.abs(a.adjustmentFactor - 1) > 0.05) ||
      /split|bonus|sub-division|face value|demerger/i.test(a.purpose)
  );

  const flaggedDates: string[] = [];
  let matchedAction: CorporateActionEvent | undefined;
  let recentAnomaly: { ymd: string; dropPct: number } | undefined;

  for (const anom of anomalies) {
    const match = priceAdjustingActions.find(a => dateDiffDays(a.exDate, anom.ymd) <= 4);
    if (match) {
      flaggedDates.push(anom.ymd);
      matchedAction = match;
      recentAnomaly = anom;
    }
  }

  return {
    hasCorporateAction: flaggedDates.length > 0,
    recentAnomalyDropPct: recentAnomaly?.dropPct,
    anomalyDate: recentAnomaly?.ymd,
    matchedAction,
    flaggedDates
  };
}

// ============================================================================
// 3. Sectoral Rotation & Heatmap (cm_get_live_indices + get_index_snapshot + get_index_movers)
// ============================================================================

export type RotationQuadrant = "Leading" | "Improving" | "Weakening" | "Lagging";

export interface SectoralHeatmapItem {
  indexName: string;
  shortName: string;
  last: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change1dPct: number;
  change1wPct: number;
  change1mPct: number;
  rsVsNifty1d: number;
  rsVsNifty1w: number;
  rsVsNifty1m: number;
  turnoverCr: number;
  pe: number;
  pb: number;
  divYield: number;
  quadrant: RotationQuadrant;
  rotationScore: number;
}

export interface SectoralRotationSnapshot {
  updatedAt: string;
  date: string;
  nifty50: { last: number; change1dPct: number; change1wPct: number; change1mPct: number };
  sectors: SectoralHeatmapItem[];
}

let sectoralCache: { fetchedAt: number; data: SectoralRotationSnapshot } | null = null;
let sectoralInFlight: Promise<SectoralRotationSnapshot | null> | null = null;
let indexMoversMultiCache: { fetchedAt: number; map1w: Map<string, number>; map1m: Map<string, number> } | null = null;

interface CanonicalSectorIndexSpec {
  indexName: string;
  yahooTicker: string;
  constituentProxies?: string[];
}

const CANONICAL_NSE_SECTORAL_INDICES: CanonicalSectorIndexSpec[] = [
  { indexName: "NIFTY BANK", yahooTicker: "^NSEBANK" },
  { indexName: "NIFTY FIN SERVICE", yahooTicker: "NIFTY_FIN_SERVICE.NS" },
  { indexName: "NIFTY IT", yahooTicker: "^CNXIT" },
  { indexName: "NIFTY PHARMA", yahooTicker: "^CNXPHARMA" },
  { indexName: "NIFTY FMCG", yahooTicker: "^CNXFMCG" },
  { indexName: "NIFTY AUTO", yahooTicker: "^CNXAUTO" },
  { indexName: "NIFTY METAL", yahooTicker: "^CNXMETAL" },
  { indexName: "NIFTY REALTY", yahooTicker: "^CNXREALTY" },
  { indexName: "NIFTY PSU BANK", yahooTicker: "^CNXPSUBANK" },
  {
    indexName: "NIFTY PVT BANK",
    yahooTicker: "NIFTY_PVT_BANK.NS",
    constituentProxies: ["HDFCBANK", "ICICIBANK", "KOTAKBANK", "AXISBANK", "INDUSINDBK", "FEDERALBNK", "IDFCFIRSTB", "BANDHANBNK", "RBLBANK"]
  },
  { indexName: "NIFTY ENERGY", yahooTicker: "^CNXENERGY" },
  { indexName: "NIFTY INFRA", yahooTicker: "^CNXINFRA" },
  { indexName: "NIFTY CONSUMPTION", yahooTicker: "^CNXCONSUM" },
  {
    indexName: "NIFTY OIL & GAS",
    yahooTicker: "NIFTY_OIL_AND_GAS.NS",
    constituentProxies: ["RELIANCE", "ONGC", "BPCL", "IOC", "GAIL", "HINDPETRO", "OIL", "PETRONET", "IGL", "MGL"]
  },
  {
    indexName: "NIFTY HEALTHCARE",
    yahooTicker: "NIFTY_HEALTHCARE.NS",
    constituentProxies: ["SUNPHARMA", "DIVISLAB", "CIPLA", "DRREDDY", "APOLLOHOSP", "MAXHEALTH", "LUPIN", "AUROPHARMA", "TORNTPHARM", "FORTIS"]
  },
  {
    indexName: "NIFTY CONSR DURBL",
    yahooTicker: "NIFTY_CONSR_DURBL.NS",
    constituentProxies: ["TITAN", "HAVELLS", "VOLTAS", "DIXON", "BLUESTARCO", "AMBER", "CROMPTON", "KALYANKJIL", "PGEL"]
  },
  {
    indexName: "NIFTY CHEMICALS",
    yahooTicker: "NIFTY_CHEMICALS.NS",
    constituentProxies: ["SRF", "PIDILITIND", "PIIND", "UPL", "SOLARINDS", "TATACHEM", "NAVINFLUOR"]
  },
  {
    indexName: "NIFTY COMMODITIES",
    yahooTicker: "^CNXCMDT",
    constituentProxies: ["HINDALCO", "TATASTEEL", "JSWSTEEL", "VEDL", "RELIANCE", "ONGC", "COALINDIA", "ULTRACEMCO", "GRASIM", "SRF"]
  },
  {
    indexName: "NIFTY SERVICES SECTOR",
    yahooTicker: "^CNXSERVICE",
    constituentProxies: ["TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "BHARTIARTL", "ADANIPORTS", "INDIGO", "INDHOTEL", "IRCTC"]
  },
  {
    indexName: "NIFTY MEDIA",
    yahooTicker: "^CNXMEDIA",
    constituentProxies: ["ZEEL", "SUNTV", "PVRINOX", "NAZARA"]
  }
];

interface YahooIndexSeriesSnapshot {
  last: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change1dPct: number;
  change1wPct: number | null;
  change1mPct: number | null;
  dateYmd: string;
}

const yahooSectorSeriesCache = new Map<string, { fetchedAt: number; data: YahooIndexSeriesSnapshot }>();
const YAHOO_SECTOR_TTL_MS = 2 * 60 * 1000; // 2 min live refresh
const mediaProxyReturnsCache: { fetchedAt: number; ret1w: number | null; ret1m: number | null } = {
  fetchedAt: 0,
  ret1w: null,
  ret1m: null
};

function normalizeIndexKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function canonicalizeSectorIndexName(rawName: string): string {
  const upper = rawName.trim().toUpperCase().replace(/\s+/g, " ");
  const nk = normalizeIndexKey(upper);
  if (nk === "NIFTYFINANCIALSERVICES" || nk === "NIFTYFINSERVICE") return "NIFTY FIN SERVICE";
  if (nk === "NIFTYCONSUMERDURABLES" || nk === "NIFTYCONSRDURBL") return "NIFTY CONSR DURBL";
  if (nk === "NIFTYOILANDGAS" || nk === "NIFTYOILGAS") return "NIFTY OIL & GAS";
  if (nk === "NIFTYPRIVATEBANK" || nk === "NIFTYPVTBANK") return "NIFTY PVT BANK";
  if (nk === "NIFTYHEALTHCAREINDEX" || nk === "NIFTYHEALTHCARE") return "NIFTY HEALTHCARE";
  if (nk === "NIFTYINFRASTRUCTURE" || nk === "NIFTYINFRA") return "NIFTY INFRA";
  if (nk === "NIFTYINDIACONSUMPTION" || nk === "NIFTYCONSUMPTION") return "NIFTY CONSUMPTION";
  return upper;
}

function buildSectorShortName(name: string): string {
  return name
    .replace(/^NIFTY\s+/i, "")
    .replace(/FIN\s*SERVICE/i, "FIN SERVICES")
    .replace(/CONSR\s*DURBL/i, "CONSUMER DURABLES")
    .replace(/IND\s*DIGITAL/i, "INDIA DIGITAL")
    .replace(/PVT\s*BANK/i, "PRIVATE BANK")
    .trim();
}

const SECTOR_ALIAS_LOOKUP: Record<string, string[]> = {
  "NIFTYFINSERVICE": ["NIFTYFINANCIALSERVICES", "NIFTYFINSERVICE", "NIFTYFINSRV2550"],
  "NIFTYCONSRDURBL": ["NIFTYCONSUMERDURABLES", "NIFTYCONSRDURBL"],
  "NIFTYOILGAS": ["NIFTYOILGAS", "NIFTYOILANDGAS"],
  "NIFTYPSUBANK": ["NIFTYPSUBANK"],
  "NIFTYPVTBANK": ["NIFTYPRIVATEBANK", "NIFTYPVTBANK"],
  "NIFTYHEALTHCARE": ["NIFTYHEALTHCAREINDEX", "NIFTYHEALTHCARE"],
  "NIFTYINFRA": ["NIFTYINFRASTRUCTURE", "NIFTYINFRA"],
  "NIFTYCONSUMPTION": ["NIFTYINDIACONSUMPTION", "NIFTYCONSUMPTION"]
};

function lookupPeriodReturn(map: Map<string, number>, rawName: string): number | null {
  const norm = normalizeIndexKey(rawName);
  if (map.has(norm)) return map.get(norm)!;
  for (const [k, aliases] of Object.entries(SECTOR_ALIAS_LOOKUP)) {
    if (norm === k || aliases.includes(norm)) {
      for (const a of [k, ...aliases]) {
        if (map.has(a)) return map.get(a)!;
      }
    }
  }
  return null;
}

async function withFastTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchYahooNseIndexSeries(yahooTicker: string, force = false): Promise<YahooIndexSeriesSnapshot | null> {
  const now = Date.now();
  const cached = yahooSectorSeriesCache.get(yahooTicker);
  if (!force && cached && now - cached.fetchedAt < YAHOO_SECTOR_TTL_MS) {
    return cached.data;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=3mo`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    if (!res.ok) return cached?.data || null;
    const json: any = await res.json();
    const chart = json?.chart?.result?.[0];
    if (!chart) return cached?.data || null;

    const meta = chart.meta || {};
    const timestamps: number[] = Array.isArray(chart.timestamp) ? chart.timestamp : [];
    const quote = chart.indicators?.quote?.[0] || {};
    const opens: Array<number | null> = quote.open || [];
    const highs: Array<number | null> = quote.high || [];
    const lows: Array<number | null> = quote.low || [];
    const closes: Array<number | null> = quote.close || [];

    // Deduplicate by IST YYYY-MM-DD keeping latest bar per date
    const byDate = new Map<string, { open: number; high: number; low: number; close: number }>();
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c) || c <= 0) continue;
      const ymd = candleTimeToYmd(timestamps[i] * 1000);
      byDate.set(ymd, {
        open: opens[i] != null && Number.isFinite(opens[i]!) ? opens[i]! : c,
        high: highs[i] != null && Number.isFinite(highs[i]!) ? highs[i]! : c,
        low: lows[i] != null && Number.isFinite(lows[i]!) ? lows[i]! : c,
        close: c
      });
    }

    const sortedDates = Array.from(byDate.keys()).sort();
    const bars = sortedDates.map(d => ({ date: d, ...byDate.get(d)! }));

    const metaPrice = Number(meta.regularMarketPrice);
    const metaPrevClose = Number(meta.previousClose || meta.chartPreviousClose);
    const latestBar = bars.length > 0 ? bars[bars.length - 1] : null;
    const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;

    const last = Number.isFinite(metaPrice) && metaPrice > 0 ? metaPrice : (latestBar?.close || 0);
    if (!Number.isFinite(last) || last <= 0) return cached?.data || null;

    const prevClose = prevBar && prevBar.close > 0
      ? prevBar.close
      : Number.isFinite(metaPrevClose) && metaPrevClose > 0
      ? metaPrevClose
      : last;

    const open = latestBar?.open || last;
    const high = latestBar?.high || Math.max(open, last);
    const low = latestBar?.low || Math.min(open, last);
    const change1dPct = prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : 0;

    let change1wPct: number | null = null;
    let change1mPct: number | null = null;

    if (bars.length >= 6) {
      const ref1w = bars[bars.length - 6].close;
      if (ref1w > 0) change1wPct = ((last - ref1w) / ref1w) * 100;
    }
    if (bars.length >= 22) {
      const ref1m = bars[bars.length - 22].close;
      if (ref1m > 0) change1mPct = ((last - ref1m) / ref1m) * 100;
    } else if (bars.length >= 15) {
      const ref1m = bars[0].close;
      if (ref1m > 0) change1mPct = ((last - ref1m) / ref1m) * 100;
    }

    const dateYmd = latestBar?.date || candleTimeToYmd(Date.now());
    const snapshot: YahooIndexSeriesSnapshot = {
      last,
      open,
      high,
      low,
      prevClose,
      change1dPct,
      change1wPct,
      change1mPct,
      dateYmd
    };
    yahooSectorSeriesCache.set(yahooTicker, { fetchedAt: Date.now(), data: snapshot });
    return snapshot;
  } catch {
    return cached?.data || null;
  } finally {
    clearTimeout(timer);
  }
}

async function computeConstituentBasketPeriodReturns(
  symbols: string[],
  allowYahooFetch = false
): Promise<{ ret1w: number | null; ret1m: number | null }> {
  const rets1w: number[] = [];
  const rets1m: number[] = [];

  for (const sym of symbols) {
    const clean = toOfficialNseSymbol(sym);
    const entry = eodCache.get(`EQ:${clean}`) || eodCache.get(clean);
    if (entry && entry.candles.length >= 6) {
      const c = entry.candles;
      const last = c[c.length - 1].close;
      const wRef = c[c.length - 6].close;
      if (last > 0 && wRef > 0) rets1w.push(((last - wRef) / wRef) * 100);
      if (c.length >= 22) {
        const mRef = c[c.length - 22].close;
        if (last > 0 && mRef > 0) rets1m.push(((last - mRef) / mRef) * 100);
      }
    }
  }

  // For sectors with no F&O constituents in eodCache (e.g. NIFTY MEDIA), fetch their real NSE stocks once per 15m
  if (rets1w.length === 0 && allowYahooFetch) {
    const now = Date.now();
    if (now - mediaProxyReturnsCache.fetchedAt < 15 * 60 * 1000 && (mediaProxyReturnsCache.ret1w !== null || mediaProxyReturnsCache.ret1m !== null)) {
      return { ret1w: mediaProxyReturnsCache.ret1w, ret1m: mediaProxyReturnsCache.ret1m };
    }
    const snaps = await Promise.all(symbols.map(s => fetchYahooNseIndexSeries(`${s}.NS`, false)));
    for (const snap of snaps) {
      if (!snap) continue;
      if (snap.change1wPct !== null) rets1w.push(snap.change1wPct);
      if (snap.change1mPct !== null) rets1m.push(snap.change1mPct);
    }
    const r1w = rets1w.length > 0 ? rets1w.reduce((a, b) => a + b, 0) / rets1w.length : null;
    const r1m = rets1m.length > 0 ? rets1m.reduce((a, b) => a + b, 0) / rets1m.length : null;
    mediaProxyReturnsCache.fetchedAt = Date.now();
    mediaProxyReturnsCache.ret1w = r1w;
    mediaProxyReturnsCache.ret1m = r1m;
    return { ret1w: r1w, ret1m: r1m };
  }

  return {
    ret1w: rets1w.length > 0 ? rets1w.reduce((a, b) => a + b, 0) / rets1w.length : null,
    ret1m: rets1m.length > 0 ? rets1m.reduce((a, b) => a + b, 0) / rets1m.length : null
  };
}

/**
 * Exposes the latest real EOD close, prevClose, 1D % change, volume, and turnover
 * from the hydrated `nse_eod_cache.json` for fast constituent drill-down when live CM MCP is rate-limited.
 */
export async function getCachedEodQuoteSummary(symbol: string): Promise<{
  close: number;
  prevClose: number;
  perChange: number;
  volume: number;
  turnover: number;
} | null> {
  await ensureNseEodDiskCacheLoaded();
  const clean = toOfficialNseSymbol(symbol);
  const entry = eodCache.get(`EQ:${clean}`) || eodCache.get(clean);
  if (!entry || entry.candles.length < 2) return null;
  const last = entry.candles[entry.candles.length - 1];
  const prev = entry.candles[entry.candles.length - 2];
  if (!last?.close || last.close <= 0) return null;
  const prevClose = prev?.close > 0 ? prev.close : last.close;
  const perChange = prevClose > 0 ? ((last.close - prevClose) / prevClose) * 100 : 0;
  return {
    close: last.close,
    prevClose,
    perChange,
    volume: last.volume || 0,
    turnover: last.turnover || (last.volume && last.close ? last.volume * last.close : 0)
  };
}

async function getIndexPeriodReturnMaps(): Promise<{ map1w: Map<string, number>; map1m: Map<string, number> }> {
  const now = Date.now();
  if (indexMoversMultiCache && now - indexMoversMultiCache.fetchedAt < 15 * 60 * 1000) {
    return { map1w: indexMoversMultiCache.map1w, map1m: indexMoversMultiCache.map1m };
  }

  const map1w = new Map<string, number>();
  const map1m = new Map<string, number>();
  if (bhavcopyClient.isCoolingDown()) {
    return { map1w, map1m };
  }

  const [res1w, res1m] = await Promise.all([
    withFastTimeout(bhavcopyClient.callTool<any>("get_index_movers", { period: "1w", n: 80, scope: "equity" }).catch(() => null), 4000, null),
    withFastTimeout(bhavcopyClient.callTool<any>("get_index_movers", { period: "1m", n: 80, scope: "equity" }).catch(() => null), 4000, null)
  ]);

  const ingest = (res: any, target: Map<string, number>) => {
    for (const list of [res?.gainers, res?.losers]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const idx = String(item.index || item.indexName || "").trim();
        const ret = Number(item.return_pct);
        if (idx && Number.isFinite(ret)) {
          target.set(normalizeIndexKey(idx), ret);
        }
      }
    }
  };

  ingest(res1w, map1w);
  ingest(res1m, map1m);

  if (map1w.size > 0 || map1m.size > 0) {
    indexMoversMultiCache = { fetchedAt: Date.now(), map1w, map1m };
  }
  return { map1w, map1m };
}

export async function getNseSectoralRotation(force = false): Promise<SectoralRotationSnapshot | null> {
  const now = Date.now();
  if (!force && sectoralCache && sectoralCache.data.sectors.length >= 10 && now - sectoralCache.fetchedAt < LIVE_QUOTE_TTL_MS) {
    return sectoralCache.data;
  }
  if (sectoralInFlight) return sectoralInFlight;

  sectoralInFlight = (async () => {
    try {
      await ensureNseEodDiskCacheLoaded();

      // Fetch live Yahoo Finance official NSE sectoral index series + optional NSE MCP data concurrently
      const yahooTickersPromise = Promise.all([
        fetchYahooNseIndexSeries("^NSEI", force),
        ...CANONICAL_NSE_SECTORAL_INDICES.map(spec => fetchYahooNseIndexSeries(spec.yahooTicker, force))
      ]);

      const mcpPromise = Promise.all([
        cmMarketClient.isCoolingDown()
          ? Promise.resolve(null)
          : withFastTimeout(cmMarketClient.callTool<any>("cm_get_live_indices", { group: "sectoral", nameFilter: "" }).catch(() => null), 4000, null),
        bhavcopyClient.isCoolingDown()
          ? Promise.resolve(null)
          : withFastTimeout(bhavcopyClient.callTool<any>("get_index_snapshot", {}).catch(() => null), 4000, null),
        getIndexPeriodReturnMaps().catch(() => ({ map1w: new Map<string, number>(), map1m: new Map<string, number>() })),
        cmMarketClient.isCoolingDown()
          ? Promise.resolve(new Map<string, NseLiveQuote>())
          : withFastTimeout(getLiveIndicesMap().catch(() => new Map<string, NseLiveQuote>()), 4000, new Map<string, NseLiveQuote>())
      ]);

      const [[yfNifty50, ...yfSectorSnaps], [liveSecRes, snapshotRes, periodMaps, allLiveMap]] = await Promise.all([
        yahooTickersPromise,
        mcpPromise
      ]);

      const yahooByNorm = new Map<string, YahooIndexSeriesSnapshot>();
      const specByNorm = new Map<string, CanonicalSectorIndexSpec>();
      CANONICAL_NSE_SECTORAL_INDICES.forEach((spec, idx) => {
        const nk = normalizeIndexKey(spec.indexName);
        specByNorm.set(nk, spec);
        const snap = yfSectorSnaps[idx];
        if (snap) yahooByNorm.set(nk, snap);
      });

      const snapByNorm = new Map<string, any>();
      if (Array.isArray(snapshotRes?.indices)) {
        for (const row of snapshotRes.indices) {
          const nm = String(row.indexName || "").trim();
          if (nm) snapByNorm.set(normalizeIndexKey(nm), row);
        }
      }

      // Benchmark Nifty 50: prefer live NSE MCP if valid, always fill with official ^NSEI series
      const n50Live = allLiveMap.get("NIFTY 50");
      const n50Snap = snapByNorm.get("NIFTY50");
      const n50Last = n50Live?.close || Number(n50Snap?.close) || yfNifty50?.last || 0;
      const n50_1d =
        Number.isFinite(n50Live?.perChange) && (n50Live?.close || 0) > 0
          ? Number(n50Live!.perChange)
          : Number.isFinite(yfNifty50?.change1dPct)
          ? Number(yfNifty50!.change1dPct)
          : Number(n50Snap?.pctChange) || 0;
      const n50_1w =
        lookupPeriodReturn(periodMaps.map1w, "Nifty 50") ??
        (yfNifty50?.change1wPct !== null && yfNifty50?.change1wPct !== undefined ? yfNifty50.change1wPct : n50_1d);
      const n50_1m =
        lookupPeriodReturn(periodMaps.map1m, "Nifty 50") ??
        (yfNifty50?.change1mPct !== null && yfNifty50?.change1mPct !== undefined ? yfNifty50.change1mPct : n50_1w);

      // Build unified, deduplicated sector rows starting from MCP live sectoral rows + all 20 canonical NSE sectoral indices
      const rawRows: any[] = [];
      const existingKeys = new Set<string>();

      const pushRowIfNew = (row: any) => {
        const canonicalName = canonicalizeSectorIndexName(String(row.indexName || ""));
        const nk = normalizeIndexKey(canonicalName);
        if (!canonicalName || !specByNorm.has(nk) || existingKeys.has(nk)) {
          return;
        }
        const last = Number(row.last);
        if (!Number.isFinite(last) || last <= 0) return;
        existingKeys.add(nk);
        rawRows.push({ ...row, indexName: canonicalName });
      };

      if (Array.isArray(liveSecRes?.indices?.sectoral)) {
        for (const r of liveSecRes.indices.sectoral) pushRowIfNew(r);
      }

      // Guarantee every canonical NSE sectoral index is included from allLiveMap -> snapByNorm -> live Yahoo NSE series
      for (const spec of CANONICAL_NSE_SECTORAL_INDICES) {
        const nk = normalizeIndexKey(spec.indexName);
        if (existingKeys.has(nk)) continue;

        const fromAll = allLiveMap.get(spec.indexName);
        const fromSnap = snapByNorm.get(nk);
        const fromYf = yahooByNorm.get(nk);

        if (fromAll && fromAll.close > 0) {
          pushRowIfNew({
            indexName: spec.indexName,
            last: fromAll.close,
            open: fromAll.open,
            high: fromAll.high,
            low: fromAll.low,
            previousClose: fromAll.prevClose,
            percChange: fromAll.perChange
          });
        } else if (fromYf && fromYf.last > 0) {
          pushRowIfNew({
            indexName: spec.indexName,
            last: fromYf.last,
            open: fromYf.open,
            high: fromYf.high,
            low: fromYf.low,
            previousClose: fromYf.prevClose,
            percChange: fromYf.change1dPct
          });
        } else if (fromSnap && Number(fromSnap.close) > 0) {
          pushRowIfNew({
            indexName: spec.indexName,
            last: fromSnap.close,
            open: fromSnap.open,
            high: fromSnap.high,
            low: fromSnap.low,
            previousClose: Number(fromSnap.close) - (Number(fromSnap.pointsChange) || 0),
            percChange: fromSnap.pctChange
          });
        }
      }

      const sectors: SectoralHeatmapItem[] = [];
      for (const row of rawRows) {
        const idxName = String(row.indexName || "").trim().toUpperCase();
        const last = Number(row.last);
        if (!idxName || !Number.isFinite(last) || last <= 0) continue;

        const prevClose = Number(row.previousClose) || last;
        const open = Number(row.open) || last;
        const high = Number(row.high) || Math.max(open, last);
        const low = Number(row.low) || Math.min(open, last);
        const change1dPct = Number.isFinite(Number(row.percChange))
          ? Number(row.percChange)
          : prevClose > 0
          ? ((last - prevClose) / prevClose) * 100
          : 0;

        // Match Bhavcopy snapshot metadata (PE, PB, TurnoverCr, DivYield)
        const nk = normalizeIndexKey(idxName);
        let snap = snapByNorm.get(nk);
        if (!snap) {
          for (const [k, aliases] of Object.entries(SECTOR_ALIAS_LOOKUP)) {
            if (nk === k || aliases.includes(nk)) {
              for (const a of [k, ...aliases]) {
                if (snapByNorm.has(a)) {
                  snap = snapByNorm.get(a);
                  break;
                }
              }
            }
          }
        }

        const yfSnap = yahooByNorm.get(nk);
        const spec = specByNorm.get(nk);

        let change1wPct =
          lookupPeriodReturn(periodMaps.map1w, idxName) ??
          (yfSnap?.change1wPct !== null && yfSnap?.change1wPct !== undefined ? yfSnap.change1wPct : null);
        let change1mPct =
          lookupPeriodReturn(periodMaps.map1m, idxName) ??
          (yfSnap?.change1mPct !== null && yfSnap?.change1mPct !== undefined ? yfSnap.change1mPct : null);

        // If neither Bhavcopy MCP nor Yahoo multi-bar index history has 1W/1M (for secondary NSE indices),
        // compute true 5D/21D average return from their official NSE constituent stocks' real EOD series
        if ((change1wPct === null || change1mPct === null) && spec?.constituentProxies?.length) {
          const basket = await computeConstituentBasketPeriodReturns(
            spec.constituentProxies,
            idxName === "NIFTY MEDIA"
          );
          if (change1wPct === null && basket.ret1w !== null) change1wPct = basket.ret1w;
          if (change1mPct === null && basket.ret1m !== null) change1mPct = basket.ret1m;
        }

        const final1w = change1wPct !== null ? change1wPct : change1dPct;
        const final1m = change1mPct !== null ? change1mPct : final1w;

        const rsVsNifty1d = Number((change1dPct - n50_1d).toFixed(2));
        const rsVsNifty1w = Number((final1w - n50_1w).toFixed(2));
        const rsVsNifty1m = Number((final1m - n50_1m).toFixed(2));

        // RRG Quadrant: RS Ratio (1M relative strength) vs RS Momentum (1W relative momentum)
        let quadrant: RotationQuadrant = "Lagging";
        if (rsVsNifty1m >= 0 && rsVsNifty1w >= 0) quadrant = "Leading";
        else if (rsVsNifty1m < 0 && rsVsNifty1w >= 0) quadrant = "Improving";
        else if (rsVsNifty1m >= 0 && rsVsNifty1w < 0) quadrant = "Weakening";
        else quadrant = "Lagging";

        const rotationScore = Number((rsVsNifty1d * 0.25 + rsVsNifty1w * 0.35 + rsVsNifty1m * 0.4).toFixed(2));

        sectors.push({
          indexName: idxName,
          shortName: buildSectorShortName(idxName),
          last: Number(last.toFixed(2)),
          open: Number(open.toFixed(2)),
          high: Number(high.toFixed(2)),
          low: Number(low.toFixed(2)),
          prevClose: Number(prevClose.toFixed(2)),
          change1dPct: Number(change1dPct.toFixed(2)),
          change1wPct: Number(final1w.toFixed(2)),
          change1mPct: Number(final1m.toFixed(2)),
          rsVsNifty1d,
          rsVsNifty1w,
          rsVsNifty1m,
          turnoverCr: Number(snap?.turnoverCr) || 0,
          pe: Number(snap?.pe) || 0,
          pb: Number(snap?.pb) || 0,
          divYield: Number(snap?.divYield) || 0,
          quadrant,
          rotationScore
        });
      }

      sectors.sort((a, b) => b.rotationScore - a.rotationScore);

      const result: SectoralRotationSnapshot = {
        updatedAt: new Date().toISOString(),
        date: String(
          snapshotRes?.date ||
            (liveSecRes?.nseTimestamp ? parseNseTimestampToDateYmd(liveSecRes.nseTimestamp) : "") ||
            yfNifty50?.dateYmd ||
            candleTimeToYmd(Date.now())
        ),
        nifty50: {
          last: Number(n50Last.toFixed(2)),
          change1dPct: Number(n50_1d.toFixed(2)),
          change1wPct: Number(n50_1w.toFixed(2)),
          change1mPct: Number(n50_1m.toFixed(2))
        },
        sectors
      };

      if (sectors.length >= 10) {
        sectoralCache = { fetchedAt: Date.now(), data: result };
      } else if (sectoralCache && sectoralCache.data.sectors.length > sectors.length) {
        return sectoralCache.data;
      }
      return result;
    } catch {
      return sectoralCache?.data || null;
    } finally {
      sectoralInFlight = null;
    }
  })();

  return sectoralInFlight;
}

// ============================================================================
// 4. Live NSE Market Movers (nse_get_market_movers)
// ============================================================================

export interface MarketMoverRow {
  symbol: string;
  ltp: number;
  prevPrice: number;
  perChange: number;
  turnover: string;
  tradeQuantity: string;
}

export interface NseMarketMoversSnapshot {
  updatedAt: string;
  gainers: MarketMoverRow[];
  losers: MarketMoverRow[];
}

let marketMoversCache: { fetchedAt: number; data: NseMarketMoversSnapshot } | null = null;

export async function getNseLiveMarketMovers(limit = 12): Promise<NseMarketMoversSnapshot | null> {
  if (marketMoversCache && Date.now() - marketMoversCache.fetchedAt < 60_000) {
    return marketMoversCache.data;
  }
  if (cmMarketClient.isCoolingDown()) {
    return marketMoversCache?.data || null;
  }

  try {
    const res = await cmMarketClient.callTool<any>("nse_get_market_movers", {
      indexName: "NIFTY 500",
      limit: Math.min(25, Math.max(5, limit))
    });
    const mapList = (arr: any): MarketMoverRow[] =>
      Array.isArray(arr)
        ? arr
            .map((item: any) => ({
              symbol: String(item.symbol || "").trim().toUpperCase(),
              ltp: Number(item.ltp) || 0,
              prevPrice: Number(item.prev_price) || 0,
              perChange: Number(item.perChange ?? item.net_price) || 0,
              turnover: String(item.turnover || "—"),
              tradeQuantity: String(item.trade_quantity || "—")
            }))
            .filter(r => r.symbol && r.ltp > 0)
        : [];

    const data: NseMarketMoversSnapshot = {
      updatedAt: new Date().toISOString(),
      gainers: mapList(res?.gainers),
      losers: mapList(res?.losers)
    };
    marketMoversCache = { fetchedAt: Date.now(), data };
    return data;
  } catch {
    return marketMoversCache?.data || null;
  }
}

// ============================================================================
// 5. Fast Per-Symbol NSE Institutional Analytics (0ms from cached Bhavcopy daily)
//    + On-demand deep MCP tools (get_stock_vs_index, get_52_week_high_low, get_volume_analysis)
// ============================================================================

export interface StockNseIntel {
  turnoverCr: number;
  avgTurnover20dCr: number;
  turnoverRvol: number;
  high52w: number;
  low52w: number;
  pctFrom52wHigh: number;
  pctFrom52wLow: number;
  positionIn52wRangePct: number;
  rsVsNifty20dPct: number;
  rsVsNifty60dPct: number;
  beta: number;
  correlation: number;
  corporateActionAlert?: {
    exDate: string;
    actionType: string;
    purpose: string;
    anomalyDropPct: number;
  } | null;
}

export function computeStockNseAnalytics(
  dailyCandles: Candle[],
  niftyDailyCandles: Candle[] | null,
  caGuard?: CorporateActionGuardResult | null
): StockNseIntel {
  const n = dailyCandles.length;
  if (n < 2) {
    return {
      turnoverCr: 0,
      avgTurnover20dCr: 0,
      turnoverRvol: 1,
      high52w: 0,
      low52w: 0,
      pctFrom52wHigh: 0,
      pctFrom52wLow: 0,
      positionIn52wRangePct: 50,
      rsVsNifty20dPct: 0,
      rsVsNifty60dPct: 0,
      beta: 1,
      correlation: 0,
      corporateActionAlert: null
    };
  }

  const flaggedSet = new Set(caGuard?.flaggedDates || []);
  const latest = dailyCandles[n - 1];
  const latestTurnoverInr = latest.turnover && latest.turnover > 0 ? latest.turnover : latest.close * latest.volume;
  const turnoverCr = Number((latestTurnoverInr / 1e7).toFixed(2));

  // 20-day average daily turnover (excluding latest bar)
  const turnStart = Math.max(0, n - 21);
  let turnSum = 0;
  let turnCount = 0;
  for (let i = turnStart; i < n - 1; i++) {
    const c = dailyCandles[i];
    const tv = c.turnover && c.turnover > 0 ? c.turnover : c.close * c.volume;
    if (tv > 0) {
      turnSum += tv;
      turnCount++;
    }
  }
  const avgTurnover20dInr = turnCount > 0 ? turnSum / turnCount : latestTurnoverInr;
  const avgTurnover20dCr = Number((avgTurnover20dInr / 1e7).toFixed(2));
  const turnoverRvol = avgTurnover20dInr > 0 ? Number((latestTurnoverInr / avgTurnover20dInr).toFixed(2)) : 1;

  // 52-week (~252 trading days) High / Low proximity
  const w52Start = Math.max(0, n - 252);
  let high52w = -Infinity;
  let low52w = Infinity;
  for (let i = w52Start; i < n; i++) {
    const c = dailyCandles[i];
    if (c.high > high52w) high52w = c.high;
    if (c.low < low52w) low52w = c.low;
  }
  if (!Number.isFinite(high52w) || high52w <= 0) high52w = latest.high;
  if (!Number.isFinite(low52w) || low52w <= 0) low52w = latest.low;

  const pctFrom52wHigh = high52w > 0 ? Number((((latest.close - high52w) / high52w) * 100).toFixed(2)) : 0;
  const pctFrom52wLow = low52w > 0 ? Number((((latest.close - low52w) / low52w) * 100).toFixed(2)) : 0;
  const range52 = high52w - low52w;
  const positionIn52wRangePct = range52 > 0 ? Number((((latest.close - low52w) / range52) * 100).toFixed(1)) : 50;

  // Relative Strength (20D & 60D) + Beta & Pearson Correlation vs Nifty 50
  let rsVsNifty20dPct = 0;
  let rsVsNifty60dPct = 0;
  let beta = 1;
  let correlation = 0;

  if (niftyDailyCandles && niftyDailyCandles.length >= 25) {
    const niftyByYmd = new Map<string, number>();
    for (const nc of niftyDailyCandles) {
      niftyByYmd.set(candleTimeToYmd(nc.time), nc.close);
    }

    const aligned: Array<{ ymd: string; sClose: number; nClose: number }> = [];
    const lookbackStart = Math.max(0, n - 75);
    for (let i = lookbackStart; i < n; i++) {
      const ymd = candleTimeToYmd(dailyCandles[i].time);
      const nClose = niftyByYmd.get(ymd);
      if (nClose && nClose > 0 && dailyCandles[i].close > 0) {
        aligned.push({ ymd, sClose: dailyCandles[i].close, nClose });
      }
    }

    if (aligned.length >= 10) {
      const endItem = aligned[aligned.length - 1];
      const idx20 = Math.max(0, aligned.length - 21);
      const idx60 = Math.max(0, aligned.length - 61);

      const sRet20 = ((endItem.sClose - aligned[idx20].sClose) / aligned[idx20].sClose) * 100;
      const nRet20 = ((endItem.nClose - aligned[idx20].nClose) / aligned[idx20].nClose) * 100;
      rsVsNifty20dPct = Number((sRet20 - nRet20).toFixed(2));

      const sRet60 = ((endItem.sClose - aligned[idx60].sClose) / aligned[idx60].sClose) * 100;
      const nRet60 = ((endItem.nClose - aligned[idx60].nClose) / aligned[idx60].nClose) * 100;
      rsVsNifty60dPct = Number((sRet60 - nRet60).toFixed(2));

      // Daily return pairs for Beta & Correlation (skipping corporate action ex-dates!)
      const sRets: number[] = [];
      const nRets: number[] = [];
      for (let i = 1; i < aligned.length; i++) {
        if (flaggedSet.has(aligned[i].ymd)) continue;
        const sr = (aligned[i].sClose - aligned[i - 1].sClose) / aligned[i - 1].sClose;
        const nr = (aligned[i].nClose - aligned[i - 1].nClose) / aligned[i - 1].nClose;
        if (Math.abs(sr) < 0.25 && Number.isFinite(sr) && Number.isFinite(nr)) {
          sRets.push(sr);
          nRets.push(nr);
        }
      }

      const m = sRets.length;
      if (m >= 10) {
        const meanS = sRets.reduce((a, b) => a + b, 0) / m;
        const meanN = nRets.reduce((a, b) => a + b, 0) / m;
        let cov = 0;
        let varS = 0;
        let varN = 0;
        for (let i = 0; i < m; i++) {
          const ds = sRets[i] - meanS;
          const dn = nRets[i] - meanN;
          cov += ds * dn;
          varS += ds * ds;
          varN += dn * dn;
        }
        if (varN > 1e-10) {
          beta = Number((cov / varN).toFixed(2));
        }
        if (varS > 1e-10 && varN > 1e-10) {
          correlation = Number((cov / Math.sqrt(varS * varN)).toFixed(2));
        }
      }
    }
  }

  return {
    turnoverCr,
    avgTurnover20dCr,
    turnoverRvol,
    high52w: Number(high52w.toFixed(2)),
    low52w: Number(low52w.toFixed(2)),
    pctFrom52wHigh,
    pctFrom52wLow,
    positionIn52wRangePct,
    rsVsNifty20dPct,
    rsVsNifty60dPct,
    beta,
    correlation,
    corporateActionAlert: caGuard?.hasCorporateAction && caGuard.matchedAction
      ? {
          exDate: caGuard.matchedAction.exDate,
          actionType: caGuard.matchedAction.actionType,
          purpose: caGuard.matchedAction.purpose,
          anomalyDropPct: caGuard.recentAnomalyDropPct || 0
        }
      : null
  };
}

export async function getNseStockDeepIntel(symbol: string) {
  const nseSym = toOfficialNseSymbol(symbol);
  if (!nseSym) return null;

  const [vsIndex, highLow52w, volumeAnalysis, corpActions] = await Promise.all([
    bhavcopyClient.callTool<any>("get_stock_vs_index", { symbol: nseSym, indexName: "Nifty 50", months: 3 }).catch(() => null),
    bhavcopyClient.callTool<any>("get_52_week_high_low", { symbol: nseSym }).catch(() => null),
    bhavcopyClient.callTool<any>("get_volume_analysis", { symbol: nseSym, days: 20 }).catch(() => null),
    getNseCorporateActions(nseSym).catch(() => [])
  ]);

  return {
    symbol: nseSym,
    vsIndex,
    highLow52w,
    volumeAnalysis,
    corporateActions: corpActions.slice(-8)
  };
}

export function getNseEodCacheStats() {
  return {
    cachedSymbols: eodCache.size,
    diskLoaded: eodDiskLoaded
  };
}
