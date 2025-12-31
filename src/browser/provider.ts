import { CHATGPT_URL } from './constants.js';

export type BrowserProvider = 'chatgpt' | 'genspark';

export const GENSPARK_URL = 'https://www.genspark.ai/agents?type=ai_chat';
export const DEFAULT_BROWSER_PROVIDER: BrowserProvider = 'chatgpt';

export function normalizeBrowserProvider(value?: string | null): BrowserProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'chatgpt' || normalized === 'openai' || normalized === 'gpt') {
    return 'chatgpt';
  }
  if (normalized === 'genspark' || normalized === 'gen-spark' || normalized === 'spark') {
    return 'genspark';
  }
  return undefined;
}

export function inferProviderFromUrl(url?: string | null): BrowserProvider | undefined {
  if (!url) return undefined;
  try {
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('genspark.ai')) {
      return 'genspark';
    }
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
      return 'chatgpt';
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function defaultBrowserUrl(provider: BrowserProvider): string {
  return provider === 'genspark' ? GENSPARK_URL : CHATGPT_URL;
}

export function resolveBrowserProvider(input?: {
  provider?: BrowserProvider | string | null;
  url?: string | null;
  chatgptUrl?: string | null;
}): BrowserProvider {
  const normalized = normalizeBrowserProvider(input?.provider);
  if (normalized) return normalized;
  const inferred = inferProviderFromUrl(input?.url ?? input?.chatgptUrl ?? null);
  return inferred ?? DEFAULT_BROWSER_PROVIDER;
}
