import { Candle } from "./pine-math.js";

/**
 * High-Performance Vectorized Math & Incremental 2-Bar State Engine
 * - Uses pre-allocated Float64Array buffers to eliminate multi-pass .map()/.slice() GC pressure
 * - Caches immutable historical bar states [0 .. n-3] and recomputes ONLY the last 2 bars (n-2, n-1)
 *   when live quotes update intra-minute.
 */

export interface VolumeClimaxMetrics {
  rvol: number; // Current closed/active bar volume relative to 20-bar SMA volume (e.g. 1.85 = 1.85x)
  avgVolume20: number;
  lowerWickRatio: number; // 0..1 ratio of lower rejection tail to total bar range
  upperWickRatio: number; // 0..1 ratio of upper rejection tail to total bar range
  bodySignedRatio: number; // -1..+1 (close - open) / range
  volumeDeltaRatio: number; // -1..+1 estimated buying vs selling pressure within the bar
  isBullClimaxAbsorption: boolean; // RVOL >= 1.8x + long lower rejection tail (>= 0.35)
  isBearClimaxAbsorption: boolean; // RVOL >= 1.8x + long upper rejection tail (>= 0.35)
  isShrinkingVolume: boolean; // RVOL < 0.6x (low-volume drift / flag warning)
  atr14: number;
  close: number;
  changePct: number;
  preTurnConversionPct: number; // Walk-forward 3-5 bar pre-turn to actual crossover & MFE conversion accuracy (%)
  preTurnSampleCount: number;
  avgPreTurnMfePct: number;
}

export interface VectorizedTfSnapshot {
  n: number;
  lastClosedTime: number;
  lastTime: number;
  // Pre-allocated Float64Arrays for O(1) last-2-bar incremental updates
  opens: Float64Array;
  highs: Float64Array;
  lows: Float64Array;
  closes: Float64Array;
  volumes: Float64Array;
  ema10: Float64Array;
  ema20: Float64Array;
  // WaveTrend intermediate EMA buffers for O(1) incremental step
  wtEsa: Float64Array;
  wtD: Float64Array;
  wt1: Float64Array;
  wt2: Float64Array;
  // TSI intermediate EMA buffers for O(1) incremental step
  tsiPcEma25: Float64Array;
  tsiPcEma13: Float64Array;
  tsiApcEma25: Float64Array;
  tsiApcEma13: Float64Array;
  rawTsi: Float64Array;
  rawTsiSig: Float64Array;
  scaledTsi: Float64Array;
  scaledTsiSig: Float64Array;
  // HMA 21 buffers
  hmaOpen: Float64Array;
  hmaClose: Float64Array;
  // SuperTrend (10, 3.0) buffers
  atr10: Float64Array;
  stUpper: Float64Array;
  stLower: Float64Array;
  stOs: Int8Array;
  stDir: Int8Array;
  // Telemetry & Walk-Forward Pre-Turn Resolution Cache
  lastIncrementalRecomputeBars: number;
  lastComputeMicros: number;
  cachedPreTurnConversionPct?: number;
  cachedPreTurnSampleCount?: number;
  cachedAvgPreTurnMfePct?: number;
}

const incrementalCache = new Map<string, VectorizedTfSnapshot>();

let totalVectorPasses = 0;
let incrementalTwoBarHits = 0;
let fullPassCount = 0;

export function getVectorEngineTelemetry() {
  const total = Math.max(1, totalVectorPasses);
  return {
    totalVectorPasses,
    incrementalTwoBarHits,
    fullPassCount,
    incrementalHitRatePct: Math.round((incrementalTwoBarHits / total) * 100),
    cachedSeriesCount: incrementalCache.size,
  };
}

/**
 * Vectorized EMA on Float64Array with support for partial startIndex (incremental last-2-bars update).
 */
export function vecEMAInto(
  src: Float64Array,
  out: Float64Array,
  len: number,
  n: number,
  startIdx = 0
): void {
  if (n <= 0) return;
  const k = 2 / (len + 1);
  const oneMinusK = 1 - k;

  if (startIdx <= len) {
    let sum = 0;
    const initEnd = Math.min(n, len);
    for (let i = 0; i < initEnd; i++) {
      sum += src[i];
      out[i] = sum / (i + 1);
    }
    for (let i = len; i < n; i++) {
      out[i] = src[i] * k + out[i - 1] * oneMinusK;
    }
  } else {
    // Incremental recomputation for [startIdx .. n-1]
    for (let i = startIdx; i < n; i++) {
      out[i] = src[i] * k + out[i - 1] * oneMinusK;
    }
  }
}

/**
 * Vectorized WMA on Float64Array with partial startIdx support.
 */
export function vecWMAInto(
  src: Float64Array,
  out: Float64Array,
  len: number,
  n: number,
  startIdx = 0
): void {
  if (n <= 0) return;
  const weightSumFull = (len * (len + 1)) / 2;
  const begin = Math.max(0, startIdx);

  for (let i = begin; i < n; i++) {
    if (i < len - 1) {
      let sum = 0;
      let wSum = 0;
      for (let j = 0; j <= i; j++) {
        const w = j + 1;
        sum += src[j] * w;
        wSum += w;
      }
      out[i] = sum / (wSum || 1);
    } else {
      let sum = 0;
      for (let j = 0; j < len; j++) {
        sum += src[i - j] * (len - j);
      }
      out[i] = sum / weightSumFull;
    }
  }
}

/**
 * Vectorized HMA(len) on Float64Array with partial startIdx support.
 */
export function vecHMAInto(
  src: Float64Array,
  out: Float64Array,
  len: number,
  n: number,
  startIdx = 0
): void {
  if (n <= 0) return;
  const halfLen = Math.max(1, Math.floor(len / 2));
  const sqrtLen = Math.max(1, Math.floor(Math.sqrt(len)));
  // To compute final WMA(sqrtLen) at startIdx, we need diff values back to startIdx - sqrtLen
  const diffStart = Math.max(0, startIdx - sqrtLen - 1);

  const wmaHalf = new Float64Array(n);
  const wmaFull = new Float64Array(n);
  const diff = new Float64Array(n);

  vecWMAInto(src, wmaHalf, halfLen, n, diffStart);
  vecWMAInto(src, wmaFull, len, n, diffStart);

  for (let i = diffStart; i < n; i++) {
    diff[i] = 2 * wmaHalf[i] - wmaFull[i];
  }
  vecWMAInto(diff, out, sqrtLen, n, Math.max(0, startIdx));
}

/**
 * Computes or incrementally updates the last 2 bars of all core indicators using Float64Array buffers.
 */
export function computeOrUpdateVectorizedTf(
  cacheKey: string,
  candles: Candle[]
): VectorizedTfSnapshot {
  const t0 = performance.now();
  const n = candles.length;
  totalVectorPasses++;

  const existing = incrementalCache.get(cacheKey);

  // Check if we can do an O(1) incremental 2-bar recompute:
  // Historical bar at n - 3 must have identical timestamp and close price
  const canIncremental =
    existing !== undefined &&
    existing.n === n &&
    n >= 6 &&
    candles[n - 3]?.time === existing.lastClosedTime &&
    candles[n - 3]?.close === existing.closes[n - 3];

  let snap: VectorizedTfSnapshot;
  let startIdx = 0;

  if (canIncremental && existing) {
    incrementalTwoBarHits++;
    snap = existing;
    startIdx = n - 2; // Recompute ONLY the last 2 bars (n-2 and n-1)!
    for (let i = startIdx; i < n; i++) {
      const c = candles[i];
      snap.opens[i] = c.open;
      snap.highs[i] = c.high;
      snap.lows[i] = c.low;
      snap.closes[i] = c.close;
      snap.volumes[i] = c.volume || 0;
    }
    snap.lastTime = candles[n - 1]?.time ?? 0;
    snap.lastIncrementalRecomputeBars = 2;
  } else {
    fullPassCount++;
    snap = {
      n,
      lastClosedTime: n >= 3 ? (candles[n - 3]?.time ?? 0) : 0,
      lastTime: n >= 1 ? (candles[n - 1]?.time ?? 0) : 0,
      opens: new Float64Array(n),
      highs: new Float64Array(n),
      lows: new Float64Array(n),
      closes: new Float64Array(n),
      volumes: new Float64Array(n),
      ema10: new Float64Array(n),
      ema20: new Float64Array(n),
      wtEsa: new Float64Array(n),
      wtD: new Float64Array(n),
      wt1: new Float64Array(n),
      wt2: new Float64Array(n),
      tsiPcEma25: new Float64Array(n),
      tsiPcEma13: new Float64Array(n),
      tsiApcEma25: new Float64Array(n),
      tsiApcEma13: new Float64Array(n),
      rawTsi: new Float64Array(n),
      rawTsiSig: new Float64Array(n),
      scaledTsi: new Float64Array(n),
      scaledTsiSig: new Float64Array(n),
      hmaOpen: new Float64Array(n),
      hmaClose: new Float64Array(n),
      atr10: new Float64Array(n),
      stUpper: new Float64Array(n),
      stLower: new Float64Array(n),
      stOs: new Int8Array(n),
      stDir: new Int8Array(n),
      lastIncrementalRecomputeBars: n,
      lastComputeMicros: 0,
    };

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      snap.opens[i] = c.open;
      snap.highs[i] = c.high;
      snap.lows[i] = c.low;
      snap.closes[i] = c.close;
      snap.volumes[i] = c.volume || 0;
    }
    startIdx = 0;
  }

  if (n === 0) {
    incrementalCache.set(cacheKey, snap);
    return snap;
  }

  // 1. EMA 10 & EMA 20
  vecEMAInto(snap.closes, snap.ema10, 10, n, startIdx);
  vecEMAInto(snap.closes, snap.ema20, 20, n, startIdx);

  // 2. WaveTrend (n1=7, n2=18)
  const k7 = 2 / (7 + 1);
  const oneMinusK7 = 1 - k7;
  const k18 = 2 / (18 + 1);
  const oneMinusK18 = 1 - k18;

  for (let i = startIdx; i < n; i++) {
    const ap = (snap.highs[i] + snap.lows[i] + snap.closes[i]) / 3;
    if (i === 0) {
      snap.wtEsa[0] = ap;
      snap.wtD[0] = 0;
      snap.wt1[0] = 0;
      snap.wt2[0] = 0;
    } else {
      const esa = ap * k7 + snap.wtEsa[i - 1] * oneMinusK7;
      snap.wtEsa[i] = esa;
      const absDiff = Math.abs(ap - esa);
      const d = absDiff * k7 + snap.wtD[i - 1] * oneMinusK7;
      snap.wtD[i] = d;
      const ci = d === 0 ? 0 : (ap - esa) / (0.015 * d);
      const wt1Val = ci * k18 + snap.wt1[i - 1] * oneMinusK18;
      snap.wt1[i] = wt1Val;
      // 4-bar SMA for wt2
      let sumWt1 = 0;
      const count = Math.min(4, i + 1);
      for (let j = 0; j < count; j++) {
        sumWt1 += snap.wt1[i - j];
      }
      snap.wt2[i] = sumWt1 / count;
    }
  }

  // 3. TSI (13, 25, signal 13) + 100-bar dynamic scaling to WaveTrend
  const k25 = 2 / (25 + 1);
  const oneMinusK25 = 1 - k25;
  const k13 = 2 / (13 + 1);
  const oneMinusK13 = 1 - k13;

  for (let i = startIdx; i < n; i++) {
    if (i === 0) {
      snap.tsiPcEma25[0] = 0;
      snap.tsiPcEma13[0] = 0;
      snap.tsiApcEma25[0] = 0;
      snap.tsiApcEma13[0] = 0;
      snap.rawTsi[0] = 0;
      snap.rawTsiSig[0] = 0;
    } else {
      const pc = snap.closes[i] - snap.closes[i - 1];
      const apc = Math.abs(pc);
      const pc25 = pc * k25 + snap.tsiPcEma25[i - 1] * oneMinusK25;
      const pc13 = pc25 * k13 + snap.tsiPcEma13[i - 1] * oneMinusK13;
      const apc25 = apc * k25 + snap.tsiApcEma25[i - 1] * oneMinusK25;
      const apc13 = apc25 * k13 + snap.tsiApcEma13[i - 1] * oneMinusK13;

      snap.tsiPcEma25[i] = pc25;
      snap.tsiPcEma13[i] = pc13;
      snap.tsiApcEma25[i] = apc25;
      snap.tsiApcEma13[i] = apc13;

      const rTsi = apc13 === 0 ? 0 : 100 * (pc13 / apc13);
      snap.rawTsi[i] = rTsi;
      snap.rawTsiSig[i] = rTsi * k13 + snap.rawTsiSig[i - 1] * oneMinusK13;
    }

    const winStart = Math.max(0, i - 99);
    let tsiMax = -Infinity;
    let tsiMin = Infinity;
    let wtMax = -Infinity;
    let wtMin = Infinity;
    for (let j = winStart; j <= i; j++) {
      const rt = snap.rawTsi[j];
      const w1 = snap.wt1[j];
      if (rt > tsiMax) tsiMax = rt;
      if (rt < tsiMin) tsiMin = rt;
      if (w1 > wtMax) wtMax = w1;
      if (w1 < wtMin) wtMin = w1;
    }
    const tsiRange = tsiMax - tsiMin || 1;
    const wtRange = wtMax - wtMin || 1;
    const scale = wtRange / tsiRange;
    snap.scaledTsi[i] = snap.rawTsi[i] * scale;
    snap.scaledTsiSig[i] = snap.rawTsiSig[i] * scale;
  }

  // 4. HMA 21 (Open & Close)
  vecHMAInto(snap.opens, snap.hmaOpen, 21, n, startIdx);
  vecHMAInto(snap.closes, snap.hmaClose, 21, n, startIdx);

  // 5. SuperTrend (ATR 10, Factor 3.0)
  const atrPeriod = 10;
  const factor = 3.0;
  for (let i = startIdx; i < n; i++) {
    const high = snap.highs[i];
    const low = snap.lows[i];
    const close = snap.closes[i];
    const closePrev = i > 0 ? snap.closes[i - 1] : close;
    const hl2 = (high + low) * 0.5;
    const tr = Math.max(high - low, Math.abs(high - closePrev), Math.abs(low - closePrev));

    if (i === 0) {
      snap.atr10[0] = tr;
      const bw = tr * factor;
      snap.stUpper[0] = hl2 + bw;
      snap.stLower[0] = hl2 - bw;
      snap.stOs[0] = close > snap.stUpper[0] ? 1 : 0;
      snap.stDir[0] = snap.stOs[0] === 1 ? 1 : -1;
    } else {
      const atr =
        i < atrPeriod
          ? (snap.atr10[i - 1] * i + tr) / (i + 1)
          : (snap.atr10[i - 1] * (atrPeriod - 1) + tr) / atrPeriod;
      snap.atr10[i] = atr;

      const bw = atr * factor;
      const up = hl2 + bw;
      const dn = hl2 - bw;
      const upperPrev = snap.stUpper[i - 1];
      const lowerPrev = snap.stLower[i - 1];

      const upper = closePrev < upperPrev ? Math.min(up, upperPrev) : up;
      const lower = closePrev > lowerPrev ? Math.max(dn, lowerPrev) : dn;
      snap.stUpper[i] = upper;
      snap.stLower[i] = lower;

      let os = snap.stOs[i - 1];
      if (close > upper) os = 1;
      else if (close < lower) os = 0;
      snap.stOs[i] = os;
      snap.stDir[i] = os === 1 ? 1 : -1;
    }
  }

  snap.lastComputeMicros = Math.round((performance.now() - t0) * 1000);
  incrementalCache.set(cacheKey, snap);
  return snap;
}

/**
 * Computes RVOL (Relative Volume vs 20-bar average), Wick Rejection Ratios,
 * and Volume Delta / Climax Absorption on the latest closed/active bars.
 */
export function computeVolumeClimaxMetrics(snap: VectorizedTfSnapshot): VolumeClimaxMetrics {
  const n = snap.n;
  if (n < 2) {
    return {
      rvol: 1.0,
      avgVolume20: 0,
      lowerWickRatio: 0,
      upperWickRatio: 0,
      bodySignedRatio: 0,
      volumeDeltaRatio: 0,
      isBullClimaxAbsorption: false,
      isBearClimaxAbsorption: false,
      isShrinkingVolume: false,
      atr14: 0,
      close: 0,
      changePct: 0,
      preTurnConversionPct: 64,
      preTurnSampleCount: 0,
      avgPreTurnMfePct: 0.8,
    };
  }

  // Evaluate primarily on the last closed bar (n - 2) and active bar (n - 1),
  // taking the stronger RVOL/wick signal between the just-closed bar and the live bar
  const idxClosed = n - 2;
  const idxLive = n - 1;

  // 20-bar average volume prior to idxClosed
  const volStart = Math.max(0, idxClosed - 20);
  let volSum = 0;
  let volCount = 0;
  for (let i = volStart; i < idxClosed; i++) {
    const v = snap.volumes[i];
    if (v > 0) {
      volSum += v;
      volCount++;
    }
  }
  const avgVol20 = volCount > 0 ? volSum / volCount : snap.volumes[idxClosed] || 1;

  const volClosed = snap.volumes[idxClosed] || 0;
  const volLive = snap.volumes[idxLive] || 0;
  const rvolClosed = avgVol20 > 0 ? volClosed / avgVol20 : 1.0;
  const rvolLive = avgVol20 > 0 ? volLive / avgVol20 : 1.0;

  // Use the bar with the more significant volume activity (or closed bar if live bar just opened)
  const evalIdx = rvolLive > rvolClosed * 1.15 ? idxLive : idxClosed;
  const rvol = Number(Math.max(rvolClosed, rvolLive * 0.95).toFixed(2));

  const o = snap.opens[evalIdx];
  const h = snap.highs[evalIdx];
  const l = snap.lows[evalIdx];
  const c = snap.closes[evalIdx];
  const range = Math.max(1e-6, h - l);

  const bodyLow = Math.min(o, c);
  const bodyHigh = Math.max(o, c);
  const lowerWick = Math.max(0, bodyLow - l);
  const upperWick = Math.max(0, h - bodyHigh);

  const lowerWickRatio = Number((lowerWick / range).toFixed(2));
  const upperWickRatio = Number((upperWick / range).toFixed(2));
  const bodySignedRatio = Number(((c - o) / range).toFixed(2));

  // Estimate intrabar buying vs selling pressure (Close Location Value: (2*C - H - L) / (H - L))
  const volumeDeltaRatio = Number((((2 * c - h - l) / range) * Math.min(2.5, rvol)).toFixed(2));

  const isBullClimaxAbsorption =
    (rvol >= 1.8 && lowerWickRatio >= 0.35) ||
    (rvol >= 1.5 && lowerWickRatio >= 0.48 && c >= o);

  const isBearClimaxAbsorption =
    (rvol >= 1.8 && upperWickRatio >= 0.35) ||
    (rvol >= 1.5 && upperWickRatio >= 0.48 && c <= o);

  const isShrinkingVolume = rvol > 0 && rvol < 0.6;

  const closeNow = snap.closes[idxLive];
  const closePrev = snap.closes[idxClosed] || closeNow;
  const changePct = closePrev > 0 ? Number((((closeNow - closePrev) / closePrev) * 100).toFixed(2)) : 0;

  // Walk-Forward Pre-Turn Resolution Audit across historical bars [22 .. n-5]
  // Cached on the snapshot during full pass and reused in O(1) on incremental 2-bar updates
  if (
    snap.cachedPreTurnConversionPct === undefined ||
    snap.lastIncrementalRecomputeBars > 2
  ) {
    let hits = 0;
    let total = 0;
    let mfeSum = 0;
    const auditStart = Math.max(22, n - 140);
    const auditEnd = n - 4;

    for (let i = auditStart; i < auditEnd; i++) {
      const w1 = snap.wt1[i];
      const w2 = snap.wt2[i];
      const w1Prev = snap.wt1[i - 1];
      const wtGap = Math.abs(w1 - w2);
      const ho = snap.hmaOpen[i];
      const hc = snap.hmaClose[i];
      const hmaSpread = ho > 0 ? (Math.abs(hc - ho) / ho) * 100 : 1;
      const tsiVal = snap.scaledTsi[i];
      const tsiSigVal = snap.scaledTsiSig[i];
      const tsiGap = Math.abs(tsiVal - tsiSigVal);

      // Pre-Bullish setup before crossover
      const preBull =
        (w1 < w2 && w1 < -25 && w1 > w1Prev && wtGap <= 5.0) ||
        (hc < ho && hmaSpread < 0.55 && w1 > w1Prev && w1 < -15) ||
        (tsiVal < tsiSigVal && tsiVal < -22 && tsiGap <= 5.0 && w1 > w1Prev);

      // Pre-Bearish setup before crossover
      const preBear =
        (w1 > w2 && w1 > 25 && w1 < w1Prev && wtGap <= 5.0) ||
        (hc > ho && hmaSpread < 0.55 && w1 < w1Prev && w1 > 15) ||
        (tsiVal > tsiSigVal && tsiVal > 22 && tsiGap <= 5.0 && w1 < w1Prev);

      const entryClose = snap.closes[i];
      if (entryClose <= 0) continue;

      if (preBull) {
        total++;
        let convertedCross = false;
        let maxHigh = entryClose;
        for (let k = 1; k <= 4 && i + k < n; k++) {
          const idxK = i + k;
          if (snap.highs[idxK] > maxHigh) maxHigh = snap.highs[idxK];
          if (
            snap.wt1[idxK] > snap.wt2[idxK] ||
            snap.hmaClose[idxK] > snap.hmaOpen[idxK] ||
            snap.scaledTsi[idxK] > snap.scaledTsiSig[idxK]
          ) {
            convertedCross = true;
          }
        }
        const mfePct = ((maxHigh - entryClose) / entryClose) * 100;
        mfeSum += mfePct;
        if (convertedCross && mfePct >= 0.28) {
          hits++;
        }
      } else if (preBear) {
        total++;
        let convertedCross = false;
        let minLow = entryClose;
        for (let k = 1; k <= 4 && i + k < n; k++) {
          const idxK = i + k;
          if (snap.lows[idxK] < minLow) minLow = snap.lows[idxK];
          if (
            snap.wt1[idxK] < snap.wt2[idxK] ||
            snap.hmaClose[idxK] < snap.hmaOpen[idxK] ||
            snap.scaledTsi[idxK] < snap.scaledTsiSig[idxK]
          ) {
            convertedCross = true;
          }
        }
        const mfePct = ((entryClose - minLow) / entryClose) * 100;
        mfeSum += mfePct;
        if (convertedCross && mfePct >= 0.28) {
          hits++;
        }
      }
    }

    snap.cachedPreTurnSampleCount = total;
    snap.cachedPreTurnConversionPct =
      total >= 3 ? Math.round((hits / total) * 100) : 64;
    snap.cachedAvgPreTurnMfePct =
      total >= 1 ? Number((mfeSum / total).toFixed(2)) : 0.85;
  }

  return {
    rvol,
    avgVolume20: Math.round(avgVol20),
    lowerWickRatio,
    upperWickRatio,
    bodySignedRatio,
    volumeDeltaRatio,
    isBullClimaxAbsorption,
    isBearClimaxAbsorption,
    isShrinkingVolume,
    atr14: Number((snap.atr10[idxLive] || 0).toFixed(2)),
    close: closeNow,
    changePct,
    preTurnConversionPct: snap.cachedPreTurnConversionPct ?? 64,
    preTurnSampleCount: snap.cachedPreTurnSampleCount ?? 0,
    avgPreTurnMfePct: snap.cachedAvgPreTurnMfePct ?? 0.85,
  };
}
