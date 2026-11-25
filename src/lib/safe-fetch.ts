/**
 * Safe JSON fetch utility that guarantees HTML error pages (e.g. proxy timeouts or
 * dev-server restarts returning `<!doctype html>`) never throw
 * `SyntaxError: Unexpected token '<'`.
 */
export async function safeParseJson<T = any>(res: Response): Promise<T | null> {
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("application/json")) {
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export async function safeFetchJson<T = any>(
  url: string,
  init?: RequestInit
): Promise<T | null> {
  const res = await fetch(url, init);
  return safeParseJson<T>(res);
}

export interface TwoPhaseDashboardOptions {
  symbols: string[];
  signal: AbortSignal;
  engine?: string;
  chunkSize?: number;
  fastTimeframes?: string;
  onRowsUpdate: (rows: any[], meta?: { isFirstChunk: boolean; phase: 1 | 2; rawJson: any }) => void;
  onPhase1Done?: () => void;
}

/**
 * Fast 2-Phase Parallel Loader for `/api/wt-dashboard`:
 * - Phase 1: Parallel waves (concurrency 4) fetching NSE MCP disk-cached 1D,3D,1W
 *   so symbols render in ~1-2 seconds instead of 3-5 minutes.
 * - Phase 2: Non-blocking background waves (concurrency 2) hydrating all 8 timeframes
 *   and merging seamlessly into the existing symbol rows.
 */
export async function fetchWtDashboardTwoPhase(opts: TwoPhaseDashboardOptions): Promise<void> {
  const {
    symbols,
    signal,
    engine,
    chunkSize = 50,
    fastTimeframes = "1D,3D,1W",
    onRowsUpdate,
    onPhase1Done,
  } = opts;

  if (symbols.length === 0) {
    onRowsUpdate([], { isFirstChunk: true, phase: 1, rawJson: null });
    onPhase1Done?.();
    return;
  }

  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }

  const mergedMap = new Map<string, any>();

  const emitOrdered = (isFirstChunk: boolean, phase: 1 | 2, rawJson: any) => {
    if (signal.aborted) return;
    const ordered: any[] = [];
    for (const sym of symbols) {
      const row = mergedMap.get(sym);
      if (row) ordered.push(row);
    }
    onRowsUpdate(ordered, { isFirstChunk, phase, rawJson });
  };

  const mergeRows = (rows: any[]) => {
    for (const row of rows) {
      if (!row?.Symbol) continue;
      const prev = mergedMap.get(row.Symbol);
      if (prev) {
        mergedMap.set(row.Symbol, {
          ...prev,
          ...row,
          timeframes: {
            ...(prev.timeframes || {}),
            ...(row.timeframes || {}),
          },
        });
      } else {
        mergedMap.set(row.Symbol, row);
      }
    }
  };

  const enginePrefix = engine ? `engine=${encodeURIComponent(engine)}&` : "";

  const runWave = async (
    tfParam: string | null,
    concurrency: number,
    phase: 1 | 2
  ) => {
    let cursor = 0;
    let firstEmitted = false;
    const worker = async () => {
      while (cursor < chunks.length && !signal.aborted) {
        const idx = cursor++;
        const slice = chunks[idx];
        const url = tfParam
          ? `/api/wt-dashboard?${enginePrefix}symbols=${encodeURIComponent(slice.join(","))}&timeframes=${encodeURIComponent(tfParam)}`
          : `/api/wt-dashboard?${enginePrefix}symbols=${encodeURIComponent(slice.join(","))}`;
        try {
          const response = await fetch(url, { signal });
          const json = await safeParseJson<any>(response);
          if (signal.aborted) return;
          if (json?.status === "ok" && Array.isArray(json.data)) {
            mergeRows(json.data);
            const isFirstChunk = phase === 1 && !firstEmitted;
            if (isFirstChunk) firstEmitted = true;
            emitOrdered(isFirstChunk, phase, json);
          }
        } catch (e: any) {
          if (e?.name === "AbortError") return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  };

  // Phase 1: Instant NSE MCP daily/weekly sweep
  await runWave(fastTimeframes, 4, 1);
  if (signal.aborted) return;
  onPhase1Done?.();

  // Phase 2: Non-blocking full 8-TF hydration in background
  runWave(null, 2, 2).catch(() => {});
}

