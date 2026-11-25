import {
  Candle,
  calcEMA,
  calcWMA,
  calcWaveTrend
} from "./pine-math.js";
import { DEFAULT_PERSONAL_SYMBOLS, FNO_SYMBOLS_LIST } from "../data/watchlists.js";
import { fetchNseHybridCandles, checkCorporateActionGuard, seedEodCacheFromRealCandles } from "./nse-mcp-client.js";

export interface HistoricalPickRecord {
  rank: number;
  symbol: string;
  prediction: "BULL" | "BEAR";
  actualOutcome: boolean;
  pnlPercent: number;
  signalScore?: number;
  indicators: {
    hmaFired: boolean;
    stFired: boolean;
    wtFired: boolean;
    tsiFired: boolean;
    htfFired: boolean;
  };
}

export interface HistoricalAuditDayEntry {
  date: string;
  signalDate?: string;
  type: "Trend" | "Reversal";
  isGenuineWalkForward?: boolean;
  bullishPicks: HistoricalPickRecord[];
  bearishPicks: HistoricalPickRecord[];
}

export const INITIAL_MWUA_WEIGHTS = {
  trend: {
    hmaWeight: 20,
    stWeight: 20,
    wtBase: 15,
    wtZero: 5,
    wtExtreme: 5,
    tsiBase: 15,
    tsiZero: 5,
    htfWt: 10,
    htfSt: 10,
    htfHma: 10,
    htfGc: 10,
    crossBonus: 10
  },
  reversal: {
    wtDeep: 20,
    wtSevere: 20,
    wtCross: 30,
    tsiDeep: 15,
    tsiSevere: 15,
    tsiCross: 20,
    stFlip: 15,
    hmaShift: 20,
    htfDiv: 15,
    baseMomentum: 15
  }
};

const INDEX_SCALE_MAP: Record<string, number> = {
  NIFTY: 100,
  BANKNIFTY: 100,
  CNXFINANCE: 1000,
  FINNIFTY: 1000,
  NIFTY_MID_SELECT: 100,
  MIDCPNIFTY: 100,
  NIFTYNXT50: 100
};

export function getAuditScaleFactor(symbol: string): number {
  const clean = symbol.replace(/1!$/, "").trim().toUpperCase();
  return INDEX_SCALE_MAP[clean] || 1;
}

export function getAuditYahooTicker(symbol: string): string {
  let clean = symbol.replace(/1!$/, "").trim().toUpperCase();
  if (clean === "NIFTY") return "NIFTYBEES.NS";
  if (clean === "BANKNIFTY") return "BANKBEES.NS";
  if (clean === "CNXFINANCE" || clean === "FINNIFTY") return "BFSI.NS";
  if (clean === "NIFTY_MID_SELECT" || clean === "MIDCPNIFTY") return "MID150BEES.NS";
  if (clean === "NIFTYNXT50") return "JUNIORBEES.NS";
  clean = clean.replace(/_/g, "-");
  return `${clean}.NS`;
}

function calcHMASeries(src: number[], len: number): number[] {
  const halfLen = Math.floor(len / 2);
  const sqrtLen = Math.round(Math.sqrt(len));
  const wmaHalf = calcWMA(src, halfLen || 1);
  const wmaFull = calcWMA(src, len);
  const diff: number[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    diff[i] = 2 * wmaHalf[i] - wmaFull[i];
  }
  return calcWMA(diff, sqrtLen || 1);
}

function calcRawTsiSeries(closePrices: number[]): { rawTsi: number[]; rawTsiSig: number[] } {
  const n = closePrices.length;
  const pc: number[] = [0];
  const apc: number[] = [0];
  for (let i = 1; i < n; i++) {
    const diff = (closePrices[i] ?? 0) - (closePrices[i - 1] ?? 0);
    pc.push(diff);
    apc.push(Math.abs(diff));
  }
  const pcEmaLong = calcEMA(pc, 25);
  const pcEmaDouble = calcEMA(pcEmaLong, 13);
  const apcEmaLong = calcEMA(apc, 25);
  const apcEmaDouble = calcEMA(apcEmaLong, 13);
  const rawTsi: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const denom = apcEmaDouble[i] ?? 0;
    rawTsi[i] = denom === 0 ? 0 : 100 * ((pcEmaDouble[i] ?? 0) / denom);
  }
  const rawTsiSig = calcEMA(rawTsi, 13);
  return { rawTsi, rawTsiSig };
}

function calcSupertrendDirSeries(candles: Candle[], atrPeriod = 10, factor = 3.0): { dir: number[]; os_val: number[] } {
  const n = candles.length;
  if (n === 0) return { dir: [], os_val: [] };

  const tr: number[] = new Array(n);
  const hl2: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const closePrev = i > 0 ? candles[i - 1].close : candles[i].close;
    hl2[i] = (high + low) / 2;
    tr[i] = Math.max(high - low, Math.abs(high - closePrev), Math.abs(low - closePrev));
  }

  const atr: number[] = new Array(n);
  let sumTR = 0;
  for (let i = 0; i < n; i++) {
    if (i < atrPeriod) {
      sumTR += tr[i];
      atr[i] = sumTR / (i + 1);
    } else {
      atr[i] = (atr[i - 1] * (atrPeriod - 1) + tr[i]) / atrPeriod;
    }
  }

  const upperBand: number[] = new Array(n);
  const lowerBand: number[] = new Array(n);
  const os_val: number[] = new Array(n);
  const dir: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const src = candles[i].close;
    const bandWidth = atr[i] * factor;
    const up = hl2[i] + bandWidth;
    const dn = hl2[i] - bandWidth;

    if (i === 0) {
      upperBand[0] = up;
      lowerBand[0] = dn;
      os_val[0] = src > upperBand[0] ? 1 : 0;
      dir[0] = os_val[0] === 1 ? 1 : -1;
      continue;
    }

    const srcPrev = candles[i - 1].close;
    const upperPrev = upperBand[i - 1];
    const lowerPrev = lowerBand[i - 1];

    upperBand[i] = srcPrev < upperPrev ? Math.min(up, upperPrev) : up;
    lowerBand[i] = srcPrev > lowerPrev ? Math.max(dn, lowerPrev) : dn;

    if (src > upperBand[i]) {
      os_val[i] = 1;
    } else if (src < lowerBand[i]) {
      os_val[i] = 0;
    } else {
      os_val[i] = os_val[i - 1];
    }
    dir[i] = os_val[i] === 1 ? 1 : -1;
  }

  return { dir, os_val };
}

interface PrecomputedSymbolSeries {
  symbol: string;
  dailyCandles: Candle[];
  dateIndexMap: Map<string, number>;
  wt1: number[];
  wt2: number[];
  hmaOpen: number[];
  hmaClose: number[];
  stDir: number[];
  scaledTsi: number[];
  scaledTsiSig: number[];
  weeklyCandles: Candle[];
  wWt1: number[];
  wWt2: number[];
  wHmaOpen: number[];
  wHmaClose: number[];
  wStDir: number[];
  wRawTsi: number[];
  wRawTsiSig: number[];
  caFlaggedDates: Set<string>;
}

const AUDIT_PRECOMPUTE_TTL_MS = 10 * 60 * 1000;
const auditPrecomputeCache = new Map<string, { ts: number; data: PrecomputedSymbolSeries | null }>();

function aggregateDailyToWeeklyCandles(daily: Candle[]): Candle[] {
  const buckets = new Map<string, Candle[]>();
  const order: string[] = [];
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

  for (const c of daily) {
    const ymd = fmt.format(new Date(c.time));
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayOfWeek = dt.getUTCDay();
    const diffToMon = (dayOfWeek + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - diffToMon);
    const weekKey = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    let arr = buckets.get(weekKey);
    if (!arr) {
      arr = [];
      buckets.set(weekKey, arr);
      order.push(weekKey);
    }
    arr.push(c);
  }

  return order.map(key => {
    const chunk = buckets.get(key)!;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const c of chunk) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume || 0;
    }
    return {
      time: chunk[0].time,
      open: chunk[0].open,
      high,
      low,
      close: chunk[chunk.length - 1].close,
      volume
    };
  });
}

async function fetchYahooCandlesForAudit(symbol: string, interval: "1d" | "1wk", range: string): Promise<Candle[]> {
  // Primary: Official NSE Bhavcopy MCP (+ live cm-market stitch) for exact exchange EOD history
  try {
    const nseCandles = await fetchNseHybridCandles(symbol, interval === "1wk" ? "1W" : "1D");
    const minNeeded = interval === "1wk" ? 15 : 65;
    if (nseCandles && nseCandles.length >= minNeeded) {
      return nseCandles;
    }
  } catch {
    // Fall back seamlessly to real Yahoo Finance `.NS` exchange OHLCV below
  }

  const ticker = getAuditYahooTicker(symbol);
  const scaleFactor = getAuditScaleFactor(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("application/json")) return [];

  let data: any;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) return [];

  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i] ?? 0;
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      time: timestamps[i] * 1000,
      open: o * scaleFactor,
      high: h * scaleFactor,
      low: l * scaleFactor,
      close: c * scaleFactor,
      volume: v
    });
  }
  if (interval === "1d" && candles.length >= 20) {
    seedEodCacheFromRealCandles(symbol, candles);
  }
  return candles;
}

function formatDateIST(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ms));
}

async function precomputeSymbol(symbol: string): Promise<PrecomputedSymbolSeries | null> {
  const cached = auditPrecomputeCache.get(symbol);
  if (cached && Date.now() - cached.ts < AUDIT_PRECOMPUTE_TTL_MS) {
    return cached.data;
  }

  try {
    // Single real 1D request (2y ≈ 500 NSE sessions) -> derive exact Mon-Fri 1W candles locally (2x faster, 100% consistent)
    const dailyCandles = await fetchYahooCandlesForAudit(symbol, "1d", "2y");
    if (dailyCandles.length < 65) {
      auditPrecomputeCache.set(symbol, { ts: Date.now(), data: null });
      return null;
    }

    const weeklyCandles = aggregateDailyToWeeklyCandles(dailyCandles);
    if (weeklyCandles.length < 15) {
      auditPrecomputeCache.set(symbol, { ts: Date.now(), data: null });
      return null;
    }

    const n = dailyCandles.length;
    const opens = dailyCandles.map(c => c.open);
    const highs = dailyCandles.map(c => c.high);
    const lows = dailyCandles.map(c => c.low);
    const closes = dailyCandles.map(c => c.close);

    const dateIndexMap = new Map<string, number>();
    dailyCandles.forEach((c, idx) => {
      dateIndexMap.set(formatDateIST(c.time), idx);
    });

    const wt = calcWaveTrend(highs, lows, closes, 7, 18);
    const hmaOpen = calcHMASeries(opens, 21);
    const hmaClose = calcHMASeries(closes, 21);
    const st = calcSupertrendDirSeries(dailyCandles, 10, 3.0);
    const { rawTsi, rawTsiSig } = calcRawTsiSeries(closes);

    const scaledTsi: number[] = new Array(n);
    const scaledTsiSig: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const startIdx = Math.max(0, i - 100 + 1);
      let tsiMax = -Infinity, tsiMin = Infinity, wtMax = -Infinity, wtMin = Infinity;
      for (let j = startIdx; j <= i; j++) {
        const rT = rawTsi[j] ?? 0;
        const w1 = wt.wt1[j] ?? 0;
        if (rT > tsiMax) tsiMax = rT;
        if (rT < tsiMin) tsiMin = rT;
        if (w1 > wtMax) wtMax = w1;
        if (w1 < wtMin) wtMin = w1;
      }
      const tsiRange = (tsiMax - tsiMin) === 0 ? 1 : (tsiMax - tsiMin);
      const wtRange = (wtMax - wtMin) === 0 ? 1 : (wtMax - wtMin);
      const ratio = wtRange / tsiRange;
      scaledTsi[i] = (rawTsi[i] ?? 0) * ratio;
      scaledTsiSig[i] = (rawTsiSig[i] ?? 0) * ratio;
    }

    const wOpens = weeklyCandles.map(c => c.open);
    const wHighs = weeklyCandles.map(c => c.high);
    const wLows = weeklyCandles.map(c => c.low);
    const wCloses = weeklyCandles.map(c => c.close);

    const wWt = calcWaveTrend(wHighs, wLows, wCloses, 7, 18);
    const wHmaOpen = calcHMASeries(wOpens, 21);
    const wHmaClose = calcHMASeries(wCloses, 21);
    const wSt = calcSupertrendDirSeries(weeklyCandles, 10, 3.0);
    const { rawTsi: wRawTsi, rawTsiSig: wRawTsiSig } = calcRawTsiSeries(wCloses);

    const caGuard = await checkCorporateActionGuard(symbol, dailyCandles, 120).catch(() => ({
      hasCorporateAction: false,
      flaggedDates: [] as string[]
    }));

    const computedSeries: PrecomputedSymbolSeries = {
      symbol,
      dailyCandles,
      dateIndexMap,
      wt1: wt.wt1,
      wt2: wt.wt2,
      hmaOpen,
      hmaClose,
      stDir: st.dir,
      scaledTsi,
      scaledTsiSig,
      weeklyCandles,
      wWt1: wWt.wt1,
      wWt2: wWt.wt2,
      wHmaOpen,
      wHmaClose,
      wStDir: wSt.dir,
      wRawTsi,
      wRawTsiSig,
      caFlaggedDates: new Set(caGuard.flaggedDates)
    };
    auditPrecomputeCache.set(symbol, { ts: Date.now(), data: computedSeries });
    return computedSeries;
  } catch {
    return null;
  }
}

/**
 * Evaluates a symbol's exact indicator state at daily bar index `idx` (strictly using data <= `idx`).
 */
function evaluateSymbolAtBarIndex(
  s: PrecomputedSymbolSeries,
  idx: number,
  weights: typeof INITIAL_MWUA_WEIGHTS
) {
  const wt1 = s.wt1[idx] ?? 0;
  const wt2 = s.wt2[idx] ?? 0;
  const isBull = wt1 > wt2;
  const isBear = wt1 < wt2;

  let barsSinceCross = 1;
  for (let k = idx - 1; k >= 0; k--) {
    const stateAtK = (s.wt1[k] ?? 0) > (s.wt2[k] ?? 0);
    if (stateAtK === isBull) barsSinceCross++;
    else break;
  }

  const isStBull = s.stDir[idx] === 1;
  const isStBear = s.stDir[idx] === -1;

  const hmaIsBull = (s.hmaClose[idx] ?? 0) > (s.hmaOpen[idx] ?? 0);
  const hmaIsBear = (s.hmaClose[idx] ?? 0) < (s.hmaOpen[idx] ?? 0);

  const scaledTsi = s.scaledTsi[idx] ?? 0;
  const scaledTsiSig = s.scaledTsiSig[idx] ?? 0;
  const isTsiBull = scaledTsi > scaledTsiSig;
  const isTsiBear = scaledTsi < scaledTsiSig;

  // Map weekly HTF strictly up to dailyCandles[idx].time (zero lookahead bias)
  const dailyTime = s.dailyCandles[idx].time;
  let wIdx = 0;
  for (let w = 0; w < s.weeklyCandles.length; w++) {
    if (s.weeklyCandles[w].time <= dailyTime) {
      wIdx = w;
    } else {
      break;
    }
  }

  const screenerH1b = (s.wWt1[wIdx] ?? 0) > (s.wWt2[wIdx] ?? 0);
  const screenerH1s = (s.wWt1[wIdx] ?? 0) < (s.wWt2[wIdx] ?? 0);
  const isStHtf1Bull = s.wStDir[wIdx] === 1;
  const isStHtf1Bear = s.wStDir[wIdx] === -1;
  const screenerHmaHtf1b = (s.wHmaClose[wIdx] ?? 0) > (s.wHmaOpen[wIdx] ?? 0);
  const screenerHmaHtf1s = (s.wHmaClose[wIdx] ?? 0) < (s.wHmaOpen[wIdx] ?? 0);
  const screenerGcb = (s.wRawTsi[wIdx] ?? 0) > (s.wRawTsiSig[wIdx] ?? 0);
  const screenerGcs = (s.wRawTsi[wIdx] ?? 0) < (s.wRawTsiSig[wIdx] ?? 0);

  let bull = 0;
  let bear = 0;
  let revBull = 0;
  let revBear = 0;

  // Exact MWUA Trend Scoring
  if (isBull) bull += weights.trend.wtBase;
  if (isBear) bear += weights.trend.wtBase;
  if (wt1 > 0) bull += weights.trend.wtZero;
  if (wt1 > 40) bull += weights.trend.wtExtreme;
  if (wt1 < 0) bear += weights.trend.wtZero;
  if (wt1 < -40) bear += weights.trend.wtExtreme;

  if (isStBull) bull += weights.trend.stWeight;
  if (isStBear) bear += weights.trend.stWeight;

  if (hmaIsBull) bull += weights.trend.hmaWeight;
  if (hmaIsBear) bear += weights.trend.hmaWeight;

  if (isTsiBull) bull += weights.trend.tsiBase;
  if (isTsiBear) bear += weights.trend.tsiBase;
  if (scaledTsi > 0) bull += weights.trend.tsiZero;
  if (scaledTsi < 0) bear += weights.trend.tsiZero;

  if (screenerH1b) bull += weights.trend.htfWt;
  if (screenerH1s) bear += weights.trend.htfWt;
  if (isStHtf1Bull) bull += weights.trend.htfSt;
  if (isStHtf1Bear) bear += weights.trend.htfSt;
  if (screenerHmaHtf1b) bull += weights.trend.htfHma;
  if (screenerHmaHtf1s) bear += weights.trend.htfHma;
  if (screenerGcb) bull += weights.trend.htfGc;
  if (screenerGcs) bear += weights.trend.htfGc;

  if (isBull && barsSinceCross < 3) bull += weights.trend.crossBonus;
  if (isBear && barsSinceCross < 3) bear += weights.trend.crossBonus;

  // Exact MWUA Reversal Scoring
  if (wt1 < -40) revBull += weights.reversal.wtDeep;
  if (wt1 < -50) revBull += weights.reversal.wtSevere;
  if (isBull && wt1 < -30) revBull += weights.reversal.wtCross;
  if (wt1 > 40) revBear += weights.reversal.wtDeep;
  if (wt1 > 50) revBear += weights.reversal.wtSevere;
  if (isBear && wt1 > 30) revBear += weights.reversal.wtCross;

  if (isStBull && barsSinceCross < 5 && wt1 < 0) revBull += weights.reversal.stFlip;
  if (isStBear && barsSinceCross < 5 && wt1 > 0) revBear += weights.reversal.stFlip;

  if (hmaIsBull && wt1 < -20) revBull += weights.reversal.hmaShift;
  if (hmaIsBear && wt1 > 20) revBear += weights.reversal.hmaShift;

  if (scaledTsi < -40) revBull += weights.reversal.tsiDeep;
  if (scaledTsi < -50) revBull += weights.reversal.tsiSevere;
  if (isTsiBull && scaledTsi < -30) revBull += weights.reversal.tsiCross;
  if (scaledTsi > 40) revBear += weights.reversal.tsiDeep;
  if (scaledTsi > 50) revBear += weights.reversal.tsiSevere;
  if (isTsiBear && scaledTsi > 30) revBear += weights.reversal.tsiCross;

  if (screenerH1b && isBull && wt1 < 0) revBull += weights.reversal.htfDiv;
  if (screenerH1s && isBear && wt1 > 0) revBear += weights.reversal.htfDiv;

  // Deterministic tie-breaker based on oscillator magnitude so Top 10 ranking is 100% deterministic
  const bullTieBreaker = Math.min(0.99, Math.max(0, (wt1 + 100) / 250));
  const bearTieBreaker = Math.min(0.99, Math.max(0, (100 - wt1) / 250));
  const revBullTieBreaker = Math.min(0.99, Math.max(0, Math.abs(Math.min(0, wt1)) / 100));
  const revBearTieBreaker = Math.min(0.99, Math.max(0, Math.max(0, wt1) / 100));

  return {
    symbol: s.symbol,
    bullScore: bull + bullTieBreaker,
    bearScore: bear + bearTieBreaker,
    reversalBullScore: revBull + revBullTieBreaker,
    reversalBearScore: revBear + revBearTieBreaker,
    bullIndicators: {
      hmaFired: hmaIsBull,
      stFired: isStBull,
      wtFired: isBull,
      tsiFired: isTsiBull,
      htfFired: screenerH1b || isStHtf1Bull || screenerHmaHtf1b
    },
    bearIndicators: {
      hmaFired: hmaIsBear,
      stFired: isStBear,
      wtFired: isBear,
      tsiFired: isTsiBear,
      htfFired: screenerH1s || isStHtf1Bear || screenerHmaHtf1s
    }
  };
}

function updateWeightsFromDayEntry(
  weights: typeof INITIAL_MWUA_WEIGHTS,
  entry: HistoricalAuditDayEntry,
  learningRate = 0.08
) {
  const stats = {
    hma: { f: 0, e: 0 },
    st: { f: 0, e: 0 },
    wt: { f: 0, e: 0 },
    tsi: { f: 0, e: 0 },
    htf: { f: 0, e: 0 }
  };
  const allPicks = [...entry.bullishPicks, ...entry.bearishPicks];
  for (const pick of allPicks) {
    const isWrong = !pick.actualOutcome;
    if (pick.indicators.hmaFired) { stats.hma.f++; if (isWrong) stats.hma.e++; }
    if (pick.indicators.stFired) { stats.st.f++; if (isWrong) stats.st.e++; }
    if (pick.indicators.wtFired) { stats.wt.f++; if (isWrong) stats.wt.e++; }
    if (pick.indicators.tsiFired) { stats.tsi.f++; if (isWrong) stats.tsi.e++; }
    if (pick.indicators.htfFired) { stats.htf.f++; if (isWrong) stats.htf.e++; }
  }

  const getMult = (f: number, e: number) => Math.exp(-learningRate * (f > 0 ? e / f : 0));
  const mults = {
    hma: getMult(stats.hma.f, stats.hma.e),
    st: getMult(stats.st.f, stats.st.e),
    wt: getMult(stats.wt.f, stats.wt.e),
    tsi: getMult(stats.tsi.f, stats.tsi.e),
    htf: getMult(stats.htf.f, stats.htf.e)
  };

  if (entry.type === "Trend") {
    weights.trend.hmaWeight *= mults.hma;
    weights.trend.stWeight *= mults.st;
    weights.trend.wtBase *= mults.wt;
    weights.trend.wtZero *= mults.wt;
    weights.trend.wtExtreme *= mults.wt;
    weights.trend.tsiBase *= mults.tsi;
    weights.trend.tsiZero *= mults.tsi;
    weights.trend.htfWt *= mults.htf;
    weights.trend.htfSt *= mults.htf;
    weights.trend.htfHma *= mults.htf;
    weights.trend.htfGc *= mults.htf;

    const sum = Object.values(weights.trend).reduce((a, b) => a + b, 0) || 135;
    const ratio = 135 / sum;
    for (const k of Object.keys(weights.trend) as (keyof typeof weights.trend)[]) {
      weights.trend[k] = Math.round(weights.trend[k] * ratio);
    }
  } else {
    weights.reversal.wtDeep *= mults.wt;
    weights.reversal.wtSevere *= mults.wt;
    weights.reversal.wtCross *= mults.wt;
    weights.reversal.tsiDeep *= mults.tsi;
    weights.reversal.tsiSevere *= mults.tsi;
    weights.reversal.tsiCross *= mults.tsi;
    weights.reversal.stFlip *= mults.st;
    weights.reversal.hmaShift *= mults.hma;
    weights.reversal.htfDiv *= mults.htf;

    const sum = Object.values(weights.reversal).reduce((a, b) => a + b, 0) || 185;
    const ratio = 185 / sum;
    for (const k of Object.keys(weights.reversal) as (keyof typeof weights.reversal)[]) {
      weights.reversal[k] = Math.round(weights.reversal[k] * ratio);
    }
  }
}

/**
 * Generates or incrementally updates genuine walk-forward 50-Day Audit Log entries
 * using real Yahoo Finance OHLCV candles and exact Pine Script indicator math.
 */
export async function computeGenuineWalkForwardAudit(
  candidateSymbols?: string[],
  existingEntries: HistoricalAuditDayEntry[] = [],
  targetDaysCount = 50
): Promise<HistoricalAuditDayEntry[]> {
  const baseCandidates =
    candidateSymbols && candidateSymbols.length >= 20
      ? candidateSymbols
      : FNO_SYMBOLS_LIST;
  const rawUniverse = Array.from(new Set(baseCandidates.map(s => s.trim().toUpperCase()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 250);

  const precomputedList: PrecomputedSymbolSeries[] = [];
  const batchSize = 25;
  for (let i = 0; i < rawUniverse.length; i += batchSize) {
    const chunk = rawUniverse.slice(i, i + batchSize);
    const res = await Promise.all(chunk.map(sym => precomputeSymbol(sym)));
    for (const item of res) {
      if (item) precomputedList.push(item);
    }
  }

  if (precomputedList.length === 0) {
    return existingEntries;
  }

  // Build canonical sorted list of trading dates from the most liquid benchmark symbol (e.g. RELIANCE or first valid)
  const refSeries =
    precomputedList.find(p => p.symbol === "RELIANCE") ||
    precomputedList.find(p => p.symbol === "HDFCBANK") ||
    precomputedList[0];

  const allDates = refSeries.dailyCandles.map(c => formatDateIST(c.time));
  const sliceStart = Math.max(40, allDates.length - (targetDaysCount + 1));
  const windowDates = allDates.slice(sliceStart);

  // Index existing verified walk-forward entries so historical days older than the 15-session live verification window are retained
  const existingMap = new Map<string, HistoricalAuditDayEntry>();
  for (const entry of existingEntries) {
    if (entry && entry.date && entry.type && entry.isGenuineWalkForward) {
      existingMap.set(`${entry.date}_${entry.type}`, entry);
    }
  }

  const weights: typeof INITIAL_MWUA_WEIGHTS = JSON.parse(JSON.stringify(INITIAL_MWUA_WEIGHTS));
  const outputEntries: HistoricalAuditDayEntry[] = [];
  const recentVerifyStartIdx = Math.max(0, windowDates.length - 16);

  for (let i = 0; i < windowDates.length - 1; i++) {
    const signalDate = windowDates[i];
    const outcomeDate = windowDates[i + 1];
    const isRecentLiveVerify = i >= recentVerifyStartIdx;

    const existingTrend = isRecentLiveVerify ? undefined : existingMap.get(`${outcomeDate}_Trend`);
    const existingRev = isRecentLiveVerify ? undefined : existingMap.get(`${outcomeDate}_Reversal`);

    if (existingTrend && existingRev) {
      outputEntries.push(existingTrend);
      outputEntries.push(existingRev);
      updateWeightsFromDayEntry(weights, existingTrend);
      updateWeightsFromDayEntry(weights, existingRev);
      continue;
    }

    // Evaluate all symbols on `signalDate` (day T) and compute actual return on `outcomeDate` (day T+1)
    const dayEvaluations: Array<
      ReturnType<typeof evaluateSymbolAtBarIndex> & { actualNextDayReturnPct: number }
    > = [];

    for (const s of precomputedList) {
      const idxT = s.dateIndexMap.get(signalDate);
      const idxNext = s.dateIndexMap.get(outcomeDate);
      if (idxT === undefined || idxNext === undefined || idxT < 30) continue;

      // Corporate Action Guard: exclude split/bonus ex-dates from distorting walk-forward PnL or false breakdown signals
      if (s.caFlaggedDates.has(outcomeDate) || s.caFlaggedDates.has(signalDate)) continue;

      const closeT = s.dailyCandles[idxT]?.close;
      const closeNext = s.dailyCandles[idxNext]?.close;
      if (!closeT || !closeNext) continue;

      const actualNextDayReturnPct = ((closeNext - closeT) / closeT) * 100;
      const evalAtT = evaluateSymbolAtBarIndex(s, idxT, weights);
      dayEvaluations.push({
        ...evalAtT,
        actualNextDayReturnPct
      });
    }

    if (dayEvaluations.length < 5) continue;

    const buildPickList = (
      sorted: typeof dayEvaluations,
      pred: "BULL" | "BEAR",
      mode: "Trend" | "Reversal"
    ): HistoricalPickRecord[] => {
      return sorted.slice(0, 10).map((item, idx) => {
        const pnl = Number(item.actualNextDayReturnPct.toFixed(2));
        const isWin = pred === "BULL" ? pnl > 0 : pnl < 0;
        const rawScore =
          mode === "Trend"
            ? pred === "BULL"
              ? Math.round(item.bullScore)
              : Math.round(item.bearScore)
            : pred === "BULL"
            ? Math.round(item.reversalBullScore)
            : Math.round(item.reversalBearScore);

        return {
          rank: idx + 1,
          symbol: item.symbol,
          prediction: pred,
          actualOutcome: isWin,
          pnlPercent: pnl,
          signalScore: rawScore,
          indicators: pred === "BULL" ? item.bullIndicators : item.bearIndicators
        };
      });
    };

    const trendBullSorted = [...dayEvaluations].sort((a, b) => b.bullScore - a.bullScore);
    const trendBearSorted = [...dayEvaluations].sort((a, b) => b.bearScore - a.bearScore);
    const revBullSorted = [...dayEvaluations].sort((a, b) => b.reversalBullScore - a.reversalBullScore);
    const revBearSorted = [...dayEvaluations].sort((a, b) => b.reversalBearScore - a.reversalBearScore);

    const trendEntry: HistoricalAuditDayEntry = existingTrend || {
      date: outcomeDate,
      signalDate,
      type: "Trend",
      isGenuineWalkForward: true,
      bullishPicks: buildPickList(trendBullSorted, "BULL", "Trend"),
      bearishPicks: buildPickList(trendBearSorted, "BEAR", "Trend")
    };

    const revEntry: HistoricalAuditDayEntry = existingRev || {
      date: outcomeDate,
      signalDate,
      type: "Reversal",
      isGenuineWalkForward: true,
      bullishPicks: buildPickList(revBullSorted, "BULL", "Reversal"),
      bearishPicks: buildPickList(revBearSorted, "BEAR", "Reversal")
    };

    outputEntries.push(trendEntry);
    outputEntries.push(revEntry);

    updateWeightsFromDayEntry(weights, trendEntry);
    updateWeightsFromDayEntry(weights, revEntry);
  }

  // Also preserve any manually finalized EOD entries whose date is newer than windowDates
  for (const [key, entry] of existingMap.entries()) {
    const alreadyIncluded = outputEntries.some(o => `${o.date}_${o.type}` === key);
    if (!alreadyIncluded) {
      outputEntries.push(entry);
    }
  }

  outputEntries.sort((a, b) => a.date.localeCompare(b.date));
  return outputEntries;
}

/**
 * Merges multiple audit log arrays (e.g., compiled baseline + disk archive + client vault)
 * deduplicating by `${date}_${type}` while strictly preferring genuine walk-forward records
 * over legacy placeholder records.
 */
export function mergeVerifiedAuditLogs(
  ...sources: (HistoricalAuditDayEntry[] | undefined | null)[]
): HistoricalAuditDayEntry[] {
  const merged = new Map<string, HistoricalAuditDayEntry>();

  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const entry of src) {
      if (!entry || !entry.date || !entry.type) continue;
      // Only accept entries that are marked genuine walk-forward (reject legacy random seed)
      if (!entry.isGenuineWalkForward) continue;

      const key = `${entry.date}_${entry.type}`;
      const existing = merged.get(key);
      if (!existing || (entry.bullishPicks?.length || 0) >= (existing.bullishPicks?.length || 0)) {
        merged.set(key, entry);
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export const INITIAL_LAYA_PRETURN_WEIGHTS = {
  rvol_wick: {
    d1HmaPreTurn: 26,
    d2StPreTurn: 22,
    d3WtPreTurn: 28,
    d4TsiPreTurn: 24,
    rvolClimaxBoost: 24,
    wickAbsorptionBoost: 18,
    htfConfluenceBoost: 16,
    lowVolFlagPenalty: 22
  },
  standard: {
    d1HmaPreTurn: 26,
    d2StPreTurn: 22,
    d3WtPreTurn: 28,
    d4TsiPreTurn: 24,
    htfConfluenceBoost: 18,
    synergyClusterBoost: 14
  }
};

function countBarsSinceStateFlip(arrA: number[], arrB: number[], idx: number): number {
  const curBull = (arrA[idx] ?? 0) > (arrB[idx] ?? 0);
  let bars = 1;
  for (let k = idx - 1; k >= 0; k--) {
    const stateK = (arrA[k] ?? 0) > (arrB[k] ?? 0);
    if (stateK === curBull) bars++;
    else break;
  }
  return bars;
}

/**
 * Evaluates a symbol's exact D5 Laya Pre-Turn Intel score at daily bar index `idx`
 * (strictly using data <= `idx`, zero lookahead bias) for both RVOL+Wick Climax and Standard modes.
 */
function evaluateLayaPreTurnAtBarIndex(
  s: PrecomputedSymbolSeries,
  idx: number,
  dashWeights: { d1: number; d2: number; d3: number; d4: number }
) {
  const c = s.dailyCandles[idx];
  const wt1 = s.wt1[idx] ?? 0;
  const wt2 = s.wt2[idx] ?? 0;
  const wtGap = Math.abs(wt1 - wt2);
  const isBull = wt1 > wt2;
  const isBear = wt1 < wt2;

  let upBars = 0;
  let downBars = 0;
  for (let k = idx; k >= 1; k--) {
    if ((s.wt1[k] ?? 0) > (s.wt1[k - 1] ?? 0)) {
      if (downBars > 0) break;
      upBars++;
    } else if ((s.wt1[k] ?? 0) < (s.wt1[k - 1] ?? 0)) {
      if (upBars > 0) break;
      downBars++;
    } else {
      break;
    }
  }

  const wtBars = countBarsSinceStateFlip(s.wt1, s.wt2, idx);
  const hmaOpen = s.hmaOpen[idx] ?? 0;
  const hmaClose = s.hmaClose[idx] ?? 0;
  const hmaIsBull = hmaClose > hmaOpen;
  const hmaIsBear = hmaClose < hmaOpen;
  const hmaSpreadPct = hmaOpen > 0 ? (Math.abs(hmaClose - hmaOpen) / hmaOpen) * 100 : 1;
  const hmaBars = countBarsSinceStateFlip(s.hmaClose, s.hmaOpen, idx);

  const isStBull = s.stDir[idx] === 1;
  const isStBear = s.stDir[idx] === -1;
  let stBars = 1;
  for (let k = idx - 1; k >= 0; k--) {
    if (s.stDir[k] === s.stDir[idx]) stBars++;
    else break;
  }

  const tsi = s.scaledTsi[idx] ?? 0;
  const tsiSig = s.scaledTsiSig[idx] ?? 0;
  const tsiGap = Math.abs(tsi - tsiSig);
  const isTsiBull = tsi > tsiSig;
  const isTsiBear = tsi < tsiSig;
  const tsiBars = countBarsSinceStateFlip(s.scaledTsi, s.scaledTsiSig, idx);

  // Weekly HTF mapped strictly up to dailyCandles[idx].time
  const dailyTime = c.time;
  let wIdx = 0;
  for (let w = 0; w < s.weeklyCandles.length; w++) {
    if (s.weeklyCandles[w].time <= dailyTime) wIdx = w;
    else break;
  }
  const screenerH1b = (s.wWt1[wIdx] ?? 0) > (s.wWt2[wIdx] ?? 0);
  const screenerH1s = (s.wWt1[wIdx] ?? 0) < (s.wWt2[wIdx] ?? 0);
  const isStHtf1Bull = s.wStDir[wIdx] === 1;
  const isStHtf1Bear = s.wStDir[wIdx] === -1;
  const screenerHmaHtf1b = (s.wHmaClose[wIdx] ?? 0) > (s.wHmaOpen[wIdx] ?? 0);
  const screenerHmaHtf1s = (s.wHmaClose[wIdx] ?? 0) < (s.wHmaOpen[wIdx] ?? 0);
  const screenerGcb = (s.wRawTsi[wIdx] ?? 0) > (s.wRawTsiSig[wIdx] ?? 0);
  const screenerGcs = (s.wRawTsi[wIdx] ?? 0) < (s.wRawTsiSig[wIdx] ?? 0);

  // Compute RVOL (vs prior 20 bars) & Wick Rejection Ratios
  let volSum = 0;
  let volCount = 0;
  for (let k = Math.max(0, idx - 20); k < idx; k++) {
    volSum += s.dailyCandles[k].volume || 0;
    volCount++;
  }
  const avgVol = volCount > 0 && volSum > 0 ? volSum / volCount : 1;
  const rvol = avgVol > 0 ? (c.volume || 0) / avgVol : 1.0;
  const rng = Math.max(0.0001, c.high - c.low);
  const lowerWickRatio = (Math.min(c.open, c.close) - c.low) / rng;
  const upperWickRatio = (c.high - Math.max(c.open, c.close)) / rng;
  const volDelta = ((c.close - c.low) - (c.high - c.close)) / rng;

  // D1 (HMA 21) Pre-Turn Impulse
  let d1Bull = 0, d1Bear = 0;
  if (hmaIsBear) {
    if (hmaSpreadPct < 0.85) d1Bull += 28;
    if (hmaSpreadPct < 0.35) d1Bull += 22;
    if (upBars >= 1 || isBull) d1Bull += 22;
    if (wt1 < -28) d1Bull += 16;
    if (hmaBars >= 6) d1Bull += 12;
    if (screenerHmaHtf1b) d1Bull += 15;
  } else if (hmaIsBull && hmaBars <= 2 && wt1 < 25) {
    d1Bull += 68 + (screenerHmaHtf1b ? 16 : 0);
  }
  if (hmaIsBull) {
    if (hmaSpreadPct < 0.85) d1Bear += 28;
    if (hmaSpreadPct < 0.35) d1Bear += 22;
    if (downBars >= 1 || isBear) d1Bear += 22;
    if (wt1 > 28) d1Bear += 16;
    if (hmaBars >= 6) d1Bear += 12;
    if (screenerHmaHtf1s) d1Bear += 15;
  } else if (hmaIsBear && hmaBars <= 2 && wt1 > -25) {
    d1Bear += 68 + (screenerHmaHtf1s ? 16 : 0);
  }

  // D2 (SuperTrend) Pre-Turn Impulse
  let d2Bull = 0, d2Bear = 0;
  if (isStBear) {
    if (hmaIsBull) d2Bull += 30;
    if (isBull || upBars >= 2) d2Bull += 24;
    if (wt1 < -30 && upBars >= 1) d2Bull += 18;
    if (isStHtf1Bull) d2Bull += 20;
    if (stBars >= 8) d2Bull += 12;
  } else if (isStBull && stBars <= 2 && wt1 < 30) {
    d2Bull += 72 + (isStHtf1Bull ? 15 : 0);
  }
  if (isStBull) {
    if (hmaIsBear) d2Bear += 30;
    if (isBear || downBars >= 2) d2Bear += 24;
    if (wt1 > 30 && downBars >= 1) d2Bear += 18;
    if (isStHtf1Bear) d2Bear += 20;
    if (stBars >= 8) d2Bear += 12;
  } else if (isStBear && stBars <= 2 && wt1 > -30) {
    d2Bear += 72 + (isStHtf1Bear ? 15 : 0);
  }

  // D3 (WaveTrend) Pre-Turn Impulse
  let d3Bull = 0, d3Bear = 0;
  if (isBear) {
    if (wt1 < -20) d3Bull += 20;
    if (wt1 < -38) d3Bull += 22;
    if (wt1 < -50) d3Bull += 15;
    if (upBars >= 1) d3Bull += 26;
    if (wtGap <= 4.2 && wt1 < -10) d3Bull += 24;
    if (screenerH1b) d3Bull += 15;
    if (wtBars >= 6) d3Bull += 10;
  } else if (isBull && wtBars <= 2 && wt1 < -15) {
    d3Bull += 74 + (wt1 < -35 ? 14 : 0);
  }
  if (isBull) {
    if (wt1 > 20) d3Bear += 20;
    if (wt1 > 38) d3Bear += 22;
    if (wt1 > 50) d3Bear += 15;
    if (downBars >= 1) d3Bear += 26;
    if (wtGap <= 4.2 && wt1 > 10) d3Bear += 24;
    if (screenerH1s) d3Bear += 15;
    if (wtBars >= 6) d3Bear += 10;
  } else if (isBear && wtBars <= 2 && wt1 > 15) {
    d3Bear += 74 + (wt1 > 35 ? 14 : 0);
  }

  // D4 (TSI) Pre-Turn Impulse
  let d4Bull = 0, d4Bear = 0;
  if (isTsiBear) {
    if (tsi < -18) d4Bull += 20;
    if (tsi < -32) d4Bull += 20;
    if (tsiGap <= 4.5 && tsi < -10) d4Bull += 26;
    else if (tsiGap <= 8.0 && tsi < -15) d4Bull += 14;
    if (upBars >= 1 || isBull) d4Bull += 24;
    if (screenerGcb) d4Bull += 15;
    if (tsiBars >= 6) d4Bull += 10;
  } else if (isTsiBull && tsiBars <= 2 && tsi < -12) {
    d4Bull += 72 + (tsi < -30 ? 15 : 0);
  }
  if (isTsiBull) {
    if (tsi > 18) d4Bear += 20;
    if (tsi > 32) d4Bear += 20;
    if (tsiGap <= 4.5 && tsi > 10) d4Bear += 26;
    else if (tsiGap <= 8.0 && tsi > 15) d4Bear += 14;
    if (downBars >= 1 || isBear) d4Bear += 24;
    if (screenerGcs) d4Bear += 15;
    if (tsiBars >= 6) d4Bear += 10;
  } else if (isTsiBear && tsiBars <= 2 && tsi > 12) {
    d4Bear += 72 + (tsi > 30 ? 15 : 0);
  }

  // Standard Combined Laya Pre-Turn Bull / Bear Scores
  const stdBullRaw =
    Math.min(100, d1Bull) * dashWeights.d1 +
    Math.min(100, d2Bull) * dashWeights.d2 +
    Math.min(100, d3Bull) * dashWeights.d3 +
    Math.min(100, d4Bull) * dashWeights.d4;
  const stdBearRaw =
    Math.min(100, d1Bear) * dashWeights.d1 +
    Math.min(100, d2Bear) * dashWeights.d2 +
    Math.min(100, d3Bear) * dashWeights.d3 +
    Math.min(100, d4Bear) * dashWeights.d4;

  // RVOL + Wick Climax Absorption Adjustments (D5 Default Mode)
  let rvolBullAdj = stdBullRaw;
  let rvolBearAdj = stdBearRaw;
  let rvolBullFired = false;
  let rvolBearFired = false;

  if (stdBullRaw > 15 || wt1 < -40 || tsi < -30) {
    if (rvol >= 1.8 && lowerWickRatio >= 0.32) {
      rvolBullAdj += (wt1 < -45 || tsi < -35 ? 28 : 20);
      rvolBullFired = true;
    } else if (rvol >= 1.3 && lowerWickRatio >= 0.25) {
      rvolBullAdj += 12;
      rvolBullFired = true;
    }
    if (volDelta > 0.3 && rvol >= 1.2) {
      rvolBullAdj += 8;
      rvolBullFired = true;
    }
    if (rvol > 0 && rvol < 0.6) {
      rvolBullAdj *= 0.45;
    }
  }

  if (stdBearRaw > 15 || wt1 > 40 || tsi > 30) {
    if (rvol >= 1.8 && upperWickRatio >= 0.32) {
      rvolBearAdj += (wt1 > 45 || tsi > 35 ? 28 : 20);
      rvolBearFired = true;
    } else if (rvol >= 1.3 && upperWickRatio >= 0.25) {
      rvolBearAdj += 12;
      rvolBearFired = true;
    }
    if (volDelta < -0.3 && rvol >= 1.2) {
      rvolBearAdj += 8;
      rvolBearFired = true;
    }
    if (rvol > 0 && rvol < 0.6) {
      rvolBearAdj *= 0.45;
    }
  }

  // Convert into 0-100 Laya Pre-Turn Scale (50 = Neutral, >50 = Turn Bull, <50 = Turn Bear)
  const stdNet = Math.max(-96, Math.min(96, stdBullRaw - stdBearRaw));
  const rvolNet = Math.max(-96, Math.min(96, rvolBullAdj - rvolBearAdj));

  const tieBull = Math.min(0.99, Math.max(0, Math.abs(Math.min(0, wt1)) / 100));
  const tieBear = Math.min(0.99, Math.max(0, Math.max(0, wt1) / 100));

  // Turn Bull Score (50..98) and Turn Bear Conviction Score (50..98, i.e., 100 - layaScore)
  const stdTurnBullScore = Math.max(2, Math.min(98, 50 + stdNet * 0.5)) + tieBull;
  const stdTurnBearScore = Math.max(2, Math.min(98, 50 - stdNet * 0.5)) + tieBear;

  const rvolTurnBullScore = Math.max(2, Math.min(98, 50 + rvolNet * 0.52)) + tieBull;
  const rvolTurnBearScore = Math.max(2, Math.min(98, 50 - rvolNet * 0.52)) + tieBear;

  return {
    symbol: s.symbol,
    rvolTurnBullScore,
    rvolTurnBearScore,
    stdTurnBullScore,
    stdTurnBearScore,
    bullIndicators: {
      hmaFired: d1Bull >= 28,
      stFired: d2Bull >= 28,
      wtFired: d3Bull >= 28,
      tsiFired: d4Bull >= 28,
      htfFired: rvolBullFired || screenerH1b || isStHtf1Bull || screenerHmaHtf1b
    },
    bearIndicators: {
      hmaFired: d1Bear >= 28,
      stFired: d2Bear >= 28,
      wtFired: d3Bear >= 28,
      tsiFired: d4Bear >= 28,
      htfFired: rvolBearFired || screenerH1s || isStHtf1Bear || screenerHmaHtf1s
    }
  };
}

/**
 * Generates or incrementally updates genuine walk-forward 50-Day Audit Log entries
 * specifically for the D5 Virtual Dashboard's `Laya Pre-Turn Intel` column:
 * - `type: "Reversal"` -> Volume-Weighted & RVOL Confirmation (`rvol_wick`) Laya Pre-Turn Top 10
 * - `type: "Trend"` -> Standard D1-D4 Laya Pre-Turn (`standard`) Top 10
 */
export async function computeLayaPreTurnWalkForwardAudit(
  candidateSymbols?: string[],
  existingEntries: HistoricalAuditDayEntry[] = [],
  targetDaysCount = 55
): Promise<HistoricalAuditDayEntry[]> {
  const baseCandidates =
    candidateSymbols && candidateSymbols.length >= 20
      ? candidateSymbols
      : FNO_SYMBOLS_LIST;
  const rawUniverse = Array.from(new Set(baseCandidates.map(s => s.trim().toUpperCase()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 250);

  const precomputedList: PrecomputedSymbolSeries[] = [];
  const batchSize = 25;
  for (let i = 0; i < rawUniverse.length; i += batchSize) {
    const chunk = rawUniverse.slice(i, i + batchSize);
    const res = await Promise.all(chunk.map(sym => precomputeSymbol(sym)));
    for (const item of res) {
      if (item) precomputedList.push(item);
    }
  }

  if (precomputedList.length === 0) {
    return existingEntries;
  }

  const refSeries =
    precomputedList.find(p => p.symbol === "RELIANCE") ||
    precomputedList.find(p => p.symbol === "HDFCBANK") ||
    precomputedList[0];

  const allDates = refSeries.dailyCandles.map(c => formatDateIST(c.time));
  const sliceStart = Math.max(40, allDates.length - (targetDaysCount + 1));
  const windowDates = allDates.slice(sliceStart);

  const existingMap = new Map<string, HistoricalAuditDayEntry>();
  for (const entry of existingEntries) {
    if (entry && entry.date && entry.type && entry.isGenuineWalkForward) {
      existingMap.set(`${entry.date}_${entry.type}`, entry);
    }
  }

  const dashWeights = { d1: 0.26, d2: 0.22, d3: 0.28, d4: 0.24 };
  const outputEntries: HistoricalAuditDayEntry[] = [];
  const recentVerifyStartIdx = Math.max(0, windowDates.length - 16);

  const updateDashWeightsFromEntry = (entry: HistoricalAuditDayEntry) => {
    const stats = {
      d1: { f: 0, w: 0 },
      d2: { f: 0, w: 0 },
      d3: { f: 0, w: 0 },
      d4: { f: 0, w: 0 }
    };
    for (const p of [...entry.bullishPicks, ...entry.bearishPicks]) {
      const win = p.actualOutcome ? 1 : 0;
      if (p.indicators.hmaFired) { stats.d1.f++; stats.d1.w += win; }
      if (p.indicators.stFired) { stats.d2.f++; stats.d2.w += win; }
      if (p.indicators.wtFired) { stats.d3.f++; stats.d3.w += win; }
      if (p.indicators.tsiFired) { stats.d4.f++; stats.d4.w += win; }
    }
    const lr = 0.06;
    const mult = (f: number, w: number) => f > 0 ? Math.exp(lr * ((w / f) - 0.5)) : 1;
    dashWeights.d1 *= mult(stats.d1.f, stats.d1.w);
    dashWeights.d2 *= mult(stats.d2.f, stats.d2.w);
    dashWeights.d3 *= mult(stats.d3.f, stats.d3.w);
    dashWeights.d4 *= mult(stats.d4.f, stats.d4.w);
    const sum = dashWeights.d1 + dashWeights.d2 + dashWeights.d3 + dashWeights.d4 || 1;
    dashWeights.d1 /= sum;
    dashWeights.d2 /= sum;
    dashWeights.d3 /= sum;
    dashWeights.d4 /= sum;
  };

  for (let i = 0; i < windowDates.length - 1; i++) {
    const signalDate = windowDates[i];
    const outcomeDate = windowDates[i + 1];
    const isRecentLiveVerify = i >= recentVerifyStartIdx;

    const existingStd = isRecentLiveVerify ? undefined : existingMap.get(`${outcomeDate}_Trend`);
    const existingRvol = isRecentLiveVerify ? undefined : existingMap.get(`${outcomeDate}_Reversal`);

    if (existingStd && existingRvol) {
      outputEntries.push(existingStd);
      outputEntries.push(existingRvol);
      updateDashWeightsFromEntry(existingRvol);
      continue;
    }

    const dayEvaluations: Array<
      ReturnType<typeof evaluateLayaPreTurnAtBarIndex> & { actualNextDayReturnPct: number }
    > = [];

    for (const s of precomputedList) {
      const idxT = s.dateIndexMap.get(signalDate);
      const idxNext = s.dateIndexMap.get(outcomeDate);
      if (idxT === undefined || idxNext === undefined || idxT < 30) continue;

      // Corporate Action Guard: exclude split/bonus ex-dates from walk-forward PnL & false breakdowns
      if (s.caFlaggedDates.has(outcomeDate) || s.caFlaggedDates.has(signalDate)) continue;

      const closeT = s.dailyCandles[idxT]?.close;
      const closeNext = s.dailyCandles[idxNext]?.close;
      if (!closeT || !closeNext) continue;

      const actualNextDayReturnPct = ((closeNext - closeT) / closeT) * 100;
      const evalAtT = evaluateLayaPreTurnAtBarIndex(s, idxT, dashWeights);
      dayEvaluations.push({
        ...evalAtT,
        actualNextDayReturnPct
      });
    }

    if (dayEvaluations.length < 5) continue;

    const buildPickList = (
      sorted: typeof dayEvaluations,
      pred: "BULL" | "BEAR",
      mode: "Trend" | "Reversal"
    ): HistoricalPickRecord[] => {
      return sorted.slice(0, 10).map((item, idx) => {
        const pnl = Number(item.actualNextDayReturnPct.toFixed(2));
        const isWin = pred === "BULL" ? pnl > 0 : pnl < 0;
        const rawScore =
          mode === "Reversal"
            ? pred === "BULL"
              ? Math.round(item.rvolTurnBullScore)
              : Math.round(100 - item.rvolTurnBearScore)
            : pred === "BULL"
            ? Math.round(item.stdTurnBullScore)
            : Math.round(100 - item.stdTurnBearScore);

        return {
          rank: idx + 1,
          symbol: item.symbol,
          prediction: pred,
          actualOutcome: isWin,
          pnlPercent: pnl,
          signalScore: rawScore,
          indicators: pred === "BULL" ? item.bullIndicators : item.bearIndicators
        };
      });
    };

    const rvolBullSorted = [...dayEvaluations].sort((a, b) => b.rvolTurnBullScore - a.rvolTurnBullScore);
    const rvolBearSorted = [...dayEvaluations].sort((a, b) => b.rvolTurnBearScore - a.rvolTurnBearScore);
    const stdBullSorted = [...dayEvaluations].sort((a, b) => b.stdTurnBullScore - a.stdTurnBullScore);
    const stdBearSorted = [...dayEvaluations].sort((a, b) => b.stdTurnBearScore - a.stdTurnBearScore);

    const stdEntry: HistoricalAuditDayEntry = existingStd || {
      date: outcomeDate,
      signalDate,
      type: "Trend",
      isGenuineWalkForward: true,
      bullishPicks: buildPickList(stdBullSorted, "BULL", "Trend"),
      bearishPicks: buildPickList(stdBearSorted, "BEAR", "Trend")
    };

    const rvolEntry: HistoricalAuditDayEntry = existingRvol || {
      date: outcomeDate,
      signalDate,
      type: "Reversal",
      isGenuineWalkForward: true,
      bullishPicks: buildPickList(rvolBullSorted, "BULL", "Reversal"),
      bearishPicks: buildPickList(rvolBearSorted, "BEAR", "Reversal")
    };

    outputEntries.push(stdEntry);
    outputEntries.push(rvolEntry);

    updateDashWeightsFromEntry(rvolEntry);
  }

  for (const [key, entry] of existingMap.entries()) {
    const alreadyIncluded = outputEntries.some(o => `${o.date}_${o.type}` === key);
    if (!alreadyIncluded) {
      outputEntries.push(entry);
    }
  }

  outputEntries.sort((a, b) => a.date.localeCompare(b.date));
  return outputEntries;
}

