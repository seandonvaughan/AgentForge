export interface TokenPricing {
  input: number;
  output: number;
  cachedInput?: number;
}

export interface OpenAiCostEstimateOptions {
  webSearchCalls?: number;
}

export const OPENAI_WEB_SEARCH_CALL_USD = 10 / 1_000;

export const OPENAI_MODEL_PRICING: Record<string, TokenPricing> = {
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
};

const DEFAULT_OPENAI_PRICING = OPENAI_MODEL_PRICING['gpt-5.3-codex']!;

export function resolveOpenAiPricing(modelId: string): TokenPricing {
  const normalized = normalizeOpenAiModelId(modelId);
  return OPENAI_MODEL_PRICING[normalized] ?? DEFAULT_OPENAI_PRICING;
}

export function estimateOpenAiCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  options: OpenAiCostEstimateOptions = {},
): number {
  const pricing = resolveOpenAiPricing(modelId);
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (options.webSearchCalls ?? 0) * OPENAI_WEB_SEARCH_CALL_USD
  );
}

export function normalizeOpenAiModelId(modelId: string): string {
  const lower = modelId.toLowerCase();
  for (const known of Object.keys(OPENAI_MODEL_PRICING)) {
    if (lower === known || lower.startsWith(`${known}-20`)) return known;
  }
  return lower;
}
