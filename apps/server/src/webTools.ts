import { AppError, ErrorCodes, sanitizeDiagnosticText, type WebSearchSourceDTO } from '@mj/shared';
import type { ServerConfig } from './config.js';

export interface AppClipboardSnapshot {
  text: string;
  label?: string;
  updatedAt: string;
}

/**
 * Process-scoped in-app clipboard buffer so MJ tools (`clipboard_copy` and `clipboard_paste_summary`)
 * operate explicitly on text copied/pasted within the MJ app rather than snooping arbitrary OS clipboard contents.
 */
export class AppClipboardStore {
  private latest: AppClipboardSnapshot | null = null;

  public get(): AppClipboardSnapshot | null {
    return this.latest ? { ...this.latest } : null;
  }

  public set(entry: { text: string; label?: string }): AppClipboardSnapshot {
    const snapshot: AppClipboardSnapshot = {
      text: entry.text,
      ...(entry.label?.trim() ? { label: entry.label.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.latest = snapshot;
    return { ...snapshot };
  }

  public clear(): void {
    this.latest = null;
  }
}

function sanitizeSafeHttpsUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function stripKeyDiagnostics(rawText: string): string {
  return sanitizeDiagnosticText(rawText)
    .replace(/([?&]appid=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(x-goog-api-key\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

/**
 * Executes web search using a configured search API (`WEB_SEARCH_API_KEY`) or
 * Google Gemini REST Grounding with Google Search (`tools: [{ google_search: {} }]`).
 * API keys stay strictly on the server.
 */
export async function executeServerWebSearch(
  config: ServerConfig,
  params: { query: string; maxResults: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  summary: string;
  sources: WebSearchSourceDTO[];
  queriesUsed: string[];
  provider: string;
}> {
  const query = params.query.trim();
  const maxResults = Math.max(1, Math.min(params.maxResults || 5, 8));

  // Option 1: Configured external search API (Tavily-compatible REST schema)
  const searchApiKey = config.toolsConfig.webSearchApiKey;
  if (searchApiKey) {
    let response: Response;
    try {
      response = await fetchImpl(config.toolsConfig.webSearchBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${searchApiKey}`,
        },
        body: JSON.stringify({
          api_key: searchApiKey,
          query,
          max_results: maxResults,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AppError({
        code: ErrorCodes.UPSTREAM_ERROR,
        category: 'api',
        statusCode: 502,
        message: `Web search request failed: ${stripKeyDiagnostics(err instanceof Error ? err.message : String(err))}`,
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new AppError({
        code: ErrorCodes.UPSTREAM_ERROR,
        category: 'api',
        statusCode: 502,
        message: `Search API returned status ${response.status}: ${stripKeyDiagnostics(bodyText.slice(0, 240))}`,
      });
    }

    const json = (await response.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const rawResults = Array.isArray(json.results) ? json.results : [];
    const sources: WebSearchSourceDTO[] = [];
    const seenUrls = new Set<string>();
    for (const r of rawResults) {
      const safeUrl = r.url ? sanitizeSafeHttpsUrl(r.url) : null;
      if (!safeUrl || seenUrls.has(safeUrl)) continue;
      seenUrls.add(safeUrl);
      sources.push({
        title: (r.title?.trim() || new URL(safeUrl).hostname).slice(0, 120),
        url: safeUrl,
      });
      if (sources.length >= maxResults) break;
    }

    const summary =
      json.answer?.trim() ||
      rawResults
        .slice(0, 3)
        .map((r) => `${r.title ?? 'Result'}: ${r.content ?? ''}`.trim())
        .filter(Boolean)
        .join(' ') ||
      `Found ${sources.length} search results for "${query}".`;

    return {
      summary: summary.slice(0, 1200),
      sources,
      queriesUsed: [query],
      provider: 'configured-search-api',
    };
  }

  // Option 2: Google Gemini REST Grounding with Google Search (`google_search` tool)
  const geminiKey = config.aiProviders.gemini.apiKey;
  if (!geminiKey) {
    throw new Error(
      'Web search requires GEMINI_API_KEY (for Gemini Google Search grounding) or WEB_SEARCH_API_KEY configured on the server.',
    );
  }

  const base = config.aiProviders.gemini.baseUrl
    .replace(/\/openai\/?$/, '')
    .replace(/\/+$/, '');
  const model = encodeURIComponent(config.aiProviders.gemini.model || 'gemini-2.5-flash');
  const endpoint = `${base}/models/${model}:generateContent`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Search the web and give a concise, factual 2-4 sentence summary answering: ${query}`,
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(18_000),
    });
  } catch (err) {
    throw new AppError({
      code: ErrorCodes.UPSTREAM_ERROR,
      category: 'api',
      statusCode: 502,
      message: `Gemini web grounding request failed: ${stripKeyDiagnostics(err instanceof Error ? err.message : String(err))}`,
    });
  }

  if (!response.ok) {
    const rawErr = await response.text().catch(() => '');
    throw new AppError({
      code: ErrorCodes.UPSTREAM_ERROR,
      category: 'api',
      statusCode: 502,
      message: `Gemini grounding failed with status ${response.status}: ${stripKeyDiagnostics(rawErr.slice(0, 260))}`,
    });
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
  };

  const first = payload.candidates?.[0];
  const answerText = (first?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  const chunks = first?.groundingMetadata?.groundingChunks ?? [];
  const sources: WebSearchSourceDTO[] = [];
  const seenUrls = new Set<string>();

  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    const safeUrl = uri ? sanitizeSafeHttpsUrl(uri) : null;
    if (!safeUrl || seenUrls.has(safeUrl)) continue;
    seenUrls.add(safeUrl);
    sources.push({
      title: (chunk.web?.title?.trim() || new URL(safeUrl).hostname).slice(0, 120),
      url: safeUrl,
    });
    if (sources.length >= maxResults) break;
  }

  const queriesUsed = (first?.groundingMetadata?.webSearchQueries ?? [])
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    .slice(0, 5);

  return {
    summary:
      answerText ||
      (sources.length > 0
        ? `Found ${sources.length} grounded web source(s) for "${query}".`
        : `No live web results returned for "${query}".`),
    sources,
    queriesUsed: queriesUsed.length > 0 ? queriesUsed : [query],
    provider: 'gemini-google-search-grounding',
  };
}

/**
 * Fetches live current weather via OpenWeatherMap API using the server-only
 * `OPENWEATHER_API_KEY` (never sent to or configured in the web client).
 */
export async function executeServerWeatherReport(
  config: ServerConfig,
  params: { location: string; units: 'metric' | 'imperial' },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const apiKey = config.toolsConfig.openWeatherApiKey;
  if (!apiKey) {
    throw new Error('OPENWEATHER_API_KEY is not configured on the server.');
  }

  const location = params.location.trim();
  const units = params.units === 'imperial' ? 'imperial' : 'metric';
  const unitSymbol = units === 'imperial' ? '°F' : '°C';
  const windUnit = units === 'imperial' ? 'mph' : 'm/s';

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=${units}&appid=${encodeURIComponent(apiKey)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      `Weather request failed: ${stripKeyDiagnostics(err instanceof Error ? err.message : String(err))}`,
    );
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(
      `OpenWeather returned status ${response.status}: ${stripKeyDiagnostics(errBody.slice(0, 220))}`,
    );
  }

  const data = (await response.json()) as {
    name?: string;
    sys?: { country?: string };
    weather?: Array<{ main?: string; description?: string }>;
    main?: { temp?: number; feels_like?: number; humidity?: number };
    wind?: { speed?: number };
  };

  const city = data.name?.trim() || location;
  const country = data.sys?.country?.trim() || '';
  const condition = data.weather?.[0]?.main?.trim() || 'Clear';
  const description = data.weather?.[0]?.description?.trim() || condition.toLowerCase();
  const temp = typeof data.main?.temp === 'number' ? Math.round(data.main.temp * 10) / 10 : null;
  const feelsLike =
    typeof data.main?.feels_like === 'number' ? Math.round(data.main.feels_like * 10) / 10 : null;
  const humidityPct = typeof data.main?.humidity === 'number' ? data.main.humidity : null;
  const windSpeed = typeof data.wind?.speed === 'number' ? data.wind.speed : null;

  const placeLabel = country ? `${city}, ${country}` : city;
  const tempPhrase = temp !== null ? `${temp}${unitSymbol}` : 'unknown temperature';
  const feelsPhrase = feelsLike !== null ? `, feels like ${feelsLike}${unitSymbol}` : '';
  const humidityPhrase = humidityPct !== null ? `, humidity ${humidityPct}%` : '';

  return {
    location: city,
    country,
    condition,
    description,
    temp,
    feelsLike,
    humidityPct,
    windSpeed,
    windUnit,
    units,
    unitSymbol,
    spokenBrief: `In ${placeLabel}, it is ${tempPhrase} with ${description}${feelsPhrase}${humidityPhrase}.`,
  };
}
