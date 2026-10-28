/**
 * Rough spend tracking so a personal agent can't quietly run up a bill.
 * Prices are USD per million tokens (first-party API list prices).
 */

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

const WEB_SEARCH_USD = 0.01;

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
  iterations?: Array<{ type?: string; input_tokens?: number | null; output_tokens?: number | null }> | null;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  costUsd: number;
}

export function summarizeUsage(model: string, usage: UsageLike | null | undefined): UsageSummary {
  const price = PRICES[model] ?? PRICES['claude-opus-5-5'];
  let inputTokens = usage?.input_tokens ?? 0;
  let outputTokens = usage?.output_tokens ?? 0;
  // Compaction requests report zero at the top level; the work is in iterations.
  if (inputTokens === 0 && outputTokens === 0 && usage?.iterations?.length) {
    for (const it of usage.iterations) {
      inputTokens += it.input_tokens ?? 0;
      outputTokens += it.output_tokens ?? 0;
    }
  }
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const webSearches = usage?.server_tool_use?.web_search_requests ?? 0;
  const costUsd =
    (inputTokens * price.input + outputTokens * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) /
      1_000_000 +
    webSearches * WEB_SEARCH_USD;
  return { inputTokens, outputTokens, cacheRead, cacheWrite, webSearches, costUsd };
}

/** Size of the context the next request will send (for deciding when to compact). */
export function contextSize(usage: UsageLike | null | undefined): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.output_tokens ?? 0)
  );
}
