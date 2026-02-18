export const DEFAULT_OPENCLAW_MODEL = 'anthropic/claude-opus-4-6';

const STATIC_CATALOG = [
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4-5',
  'openai/gpt-5.3',
  'openai/gpt-5.2',
  'openai/gpt-4o',
  'google/gemini-3-pro',
  'openrouter/moonshotai/kimi-k2',
];

const MODEL_PATTERN = /[a-z0-9-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*/gi;
const DOCS_URL = 'https://docs.openclaw.ai/concepts/models';
const FETCH_TIMEOUT_MS = 5000;

export async function fetchModelCatalog(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(DOCS_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return STATIC_CATALOG;

    const html = await response.text();
    const matches = html.match(MODEL_PATTERN);
    if (!matches || matches.length === 0) return STATIC_CATALOG;

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const models: string[] = [];
    for (const m of matches) {
      const lower = m.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        models.push(lower);
      }
    }

    return models.length > 0 ? models : STATIC_CATALOG;
  } catch {
    return STATIC_CATALOG;
  }
}

export interface ModelChoice {
  value: string;
  name: string;
}

const CUSTOM_SENTINEL = '__custom__';
const DEFAULT_SENTINEL = '__default__';

export async function getModelChoices(): Promise<ModelChoice[]> {
  const catalog = await fetchModelCatalog();

  const choices: ModelChoice[] = catalog.map((model) => ({
    value: model,
    name: model === DEFAULT_OPENCLAW_MODEL ? `${model} (recommended)` : model,
  }));

  choices.push({ value: CUSTOM_SENTINEL, name: 'Custom model' });
  choices.push({ value: DEFAULT_SENTINEL, name: `System default (${DEFAULT_OPENCLAW_MODEL})` });

  return choices;
}

export function isCustomSentinel(value: string): boolean {
  return value === CUSTOM_SENTINEL;
}

export function isDefaultSentinel(value: string): boolean {
  return value === DEFAULT_SENTINEL;
}

export const MODEL_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i;
