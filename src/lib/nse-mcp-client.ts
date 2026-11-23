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

// Conservative pacing keeps request rate well below NSE Akamai WAF burst thresholds
const bhavcopyClient = new StreamableHttpMcpClient("nse-bhavcopy", BHAVCOPY_MCP_URL, 3, 120, 10000);
const cmMarketClient = new StreamableHttpMcpClient("cm-market", CM_MARKET_MCP_URL, 2, 150, 10000);

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
      await io.writeFile(io.cacheFilePath, payload, "utf-8");
    } catch (err: any) {
      console.warn("[NSE EOD Cache] Disk persist warning:", err?.message || err);
    }
  }, 4000);
}

function getCurrentIstDayKey(): string {
  const now = new Date();
  const istStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const d = new Date(istStr);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slot = d.getHours() >= 16 ? "post" : "pre";
  return `${ymd}_${slot}`;
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
  const now = Date.now();
  const existing = eodCache.get(canonicalKey);

  // Instant hit if disk/memory cache covers this IST day and required history depth
  if (
    existing &&
    existing.istDayKey === istDayKey &&
    existing.monthsCovered >= monthsNeeded &&
    now - existing.fetchedAt < 12 * 60 * 60 * 1000
  ) {
    return existing;
  }

  // If bhavcopy is in cooldown, gracefully serve slightly older disk cache rather than failing!
  if (bhavcopyClient.isCoolingDown()) {
    return existing && existing.candles.length >= 5 ? existing : null;
  }

  const inFlightKey = `${canonicalKey}:${monthsNeeded}`;
  const active = eodInFlight.get(inFlightKey);
  if (active) return active;

  for (const [k, p] of eodInFlight.entries()) {
    if (k.startsWith(`${canonicalKey}:`)) {
      const m = Number(k.split(":").pop());
      if (Number.isFinite(m) && m >= monthsNeeded) {
        return p;
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
  return promise;
}

export async function fetchNseDailyCandles(symbol: string, monthsNeeded = 12): Promise<Candle[] | null> {
  const [eod, liveQuote] = await Promise.all([
    fetchClosedEodHistoryFromBhavcopy(symbol, monthsNeeded),
    getNseLiveQuoteForSymbol(symbol).catch(() => null)
  ]);

  if (!eod || eod.candles.length < 5) {
    return null;
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
    if (timeframe === "1M") {
      const daily = await fetchNseDailyCandles(symbol, 48);
      if (!daily || daily.length < 5) return null;
      const monthly = aggregateNseMonthlyCandles(daily);
      return monthly.length >= 5 ? monthly : null;
    }

    const daily = await fetchNseDailyCandles(symbol, 24);
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

function normalizeIndexKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function buildSectorShortName(name: string): string {
  return name
    .replace(/^NIFTY\s+/i, "")
    .replace(/FIN\s*SERVICE/i, "FIN SERVICES")
    .replace(/CONSR\s*DURBL/i, "CONSUMER DURABLES")
    .replace(/IND\s*DIGITAL/i, "INDIA DIGITAL")
    .trim();
}

const SECTOR_ALIAS_LOOKUP: Record<string, string[]> = {
  "NIFTYFINSERVICE": ["NIFTYFINANCIALSERVICES", "NIFTYFINSERVICE", "NIFTYFINSRV2550"],
  "NIFTYCONSRDURBL": ["NIFTYCONSUMERDURABLES", "NIFTYCONSRDURBL"],
  "NIFTYOILGAS": ["NIFTYOILGAS", "NIFTYOILANDGAS"],
  "NIFTYPSUBANK": ["NIFTYPSUBANK"],
  "NIFTYPVTBANK": ["NIFTYPRIVATEBANK", "NIFTYPVTBANK"],
  "NIFTYHEALTHCARE": ["NIFTYHEALTHCAREINDEX", "NIFTYHEALTHCARE"],
  "NIFTYINFRA": ["NIFTYINFRASTRUCTURE", "NIFTYINFRA"]
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

async function getIndexPeriodReturnMaps(): Promise<{ map1w: Map<string, number>; map1m: Map<string, number> }> {
  const now = Date.now();
  if (indexMoversMultiCache && now - indexMoversMultiCache.fetchedAt < 15 * 60 * 1000) {
    return { map1w: indexMoversMultiCache.map1w, map1m: indexMoversMultiCache.map1m };
  }

  const map1w = new Map<string, number>();
  const map1m = new Map<string, number>();

  const [res1w, res1m] = await Promise.all([
    bhavcopyClient.callTool<any>("get_index_movers", { period: "1w", n: 80, scope: "equity" }).catch(() => null),
    bhavcopyClient.callTool<any>("get_index_movers", { period: "1m", n: 80, scope: "equity" }).catch(() => null)
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
  if (!force && sectoralCache && now - sectoralCache.fetchedAt < LIVE_QUOTE_TTL_MS) {
    return sectoralCache.data;
  }
  if (sectoralInFlight) return sectoralInFlight;

  sectoralInFlight = (async () => {
    try {
      const [liveSecRes, snapshotRes, periodMaps, allLiveMap] = await Promise.all([
        cmMarketClient.callTool<any>("cm_get_live_indices", { group: "sectoral", nameFilter: "" }).catch(() => null),
        bhavcopyClient.callTool<any>("get_index_snapshot", {}).catch(() => null),
        getIndexPeriodReturnMaps().catch(() => ({ map1w: new Map<string, number>(), map1m: new Map<string, number>() })),
        getLiveIndicesMap().catch(() => new Map<string, NseLiveQuote>())
      ]);

      const snapByNorm = new Map<string, any>();
      if (Array.isArray(snapshotRes?.indices)) {
        for (const row of snapshotRes.indices) {
          const nm = String(row.indexName || "").trim();
          if (nm) snapByNorm.set(normalizeIndexKey(nm), row);
        }
      }

      const n50Live = allLiveMap.get("NIFTY 50");
      const n50Snap = snapByNorm.get("NIFTY50");
      const n50Last = n50Live?.close || Number(n50Snap?.close) || 0;
      const n50_1d = Number.isFinite(n50Live?.perChange) ? Number(n50Live!.perChange) : Number(n50Snap?.pctChange) || 0;
      const n50_1w = lookupPeriodReturn(periodMaps.map1w, "Nifty 50") ?? n50_1d;
      const n50_1m = lookupPeriodReturn(periodMaps.map1m, "Nifty 50") ?? n50_1w;

      // Primary source: live sectoral indices from cm_get_live_indices(group: "sectoral") + key thematic/sectoral additions
      const rawRows: any[] = Array.isArray(liveSecRes?.indices?.sectoral) ? [...liveSecRes.indices.sectoral] : [];
      const extraCanonical = ["NIFTY ENERGY", "NIFTY INFRA", "NIFTY CONSUMPTION", "NIFTY COMMODITIES", "NIFTY CHEMICALS", "NIFTY SERVICES SECTOR"];
      const existingKeys = new Set(rawRows.map(r => normalizeIndexKey(String(r.indexName || ""))));

      for (const extraName of extraCanonical) {
        const nk = normalizeIndexKey(extraName);
        if (existingKeys.has(nk)) continue;
        const fromAll = allLiveMap.get(extraName);
        const fromSnap = snapByNorm.get(nk);
        if (fromAll) {
          rawRows.push({
            indexName: extraName,
            last: fromAll.close,
            open: fromAll.open,
            high: fromAll.high,
            low: fromAll.low,
            previousClose: fromAll.prevClose,
            percChange: fromAll.perChange
          });
          existingKeys.add(nk);
        } else if (fromSnap) {
          rawRows.push({
            indexName: extraName,
            last: fromSnap.close,
            open: fromSnap.open,
            high: fromSnap.high,
            low: fromSnap.low,
            previousClose: fromSnap.close - (fromSnap.pointsChange || 0),
            percChange: fromSnap.pctChange
          });
          existingKeys.add(nk);
        }
      }

      const sectors: SectoralHeatmapItem[] = [];
      for (const row of rawRows) {
        const idxName = String(row.indexName || "").trim().toUpperCase();
        if (!idxName || idxName.includes("EX-BANK") || idxName.includes("25 50")) continue;
        const last = Number(row.last);
        if (!Number.isFinite(last) || last <= 0) continue;

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

        const change1wPct = lookupPeriodReturn(periodMaps.map1w, idxName) ?? change1dPct;
        const change1mPct = lookupPeriodReturn(periodMaps.map1m, idxName) ?? change1wPct;

        const rsVsNifty1d = Number((change1dPct - n50_1d).toFixed(2));
        const rsVsNifty1w = Number((change1wPct - n50_1w).toFixed(2));
        const rsVsNifty1m = Number((change1mPct - n50_1m).toFixed(2));

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
          change1wPct: Number(change1wPct.toFixed(2)),
          change1mPct: Number(change1mPct.toFixed(2)),
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
        date: String(snapshotRes?.date || parseNseTimestampToDateYmd(liveSecRes?.nseTimestamp)),
        nifty50: {
          last: Number(n50Last.toFixed(2)),
          change1dPct: Number(n50_1d.toFixed(2)),
          change1wPct: Number(n50_1w.toFixed(2)),
          change1mPct: Number(n50_1m.toFixed(2))
        },
        sectors
      };

      if (sectors.length > 0) {
        sectoralCache = { fetchedAt: Date.now(), data: result };
      }
      return sectoralCache?.data || result;
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
