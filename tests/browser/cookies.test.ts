import { beforeEach, describe, expect, test, vi } from 'vitest';
import { syncCookies, ChromeCookieSyncError } from '../../src/browser/cookies.js';
import type { ChromeClient } from '../../src/browser/types.js';

const loadChromeCookies = vi.fn();
vi.mock('../../src/browser/chromeCookies.ts', () => ({ loadChromeCookies }));

const logger = vi.fn();

beforeEach(() => {
  loadChromeCookies.mockReset();
  logger.mockReset();
});

describe('syncCookies', () => {
  test('replays cookies via DevTools Network.setCookie', async () => {
    loadChromeCookies.mockResolvedValue([
      { name: 'sid', value: 'abc', domain: '.chatgpt.com' },
      { name: 'csrftoken', value: 'xyz', domain: 'chatgpt.com' },
    ]);
    const setCookie = vi.fn().mockResolvedValue({ success: true });
    const applied = await syncCookies(
      { setCookie } as unknown as ChromeClient['Network'],
      'https://chatgpt.com',
      null,
      logger,
    );
    expect(applied).toBe(2);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });

  test('throws when cookie load fails', async () => {
    loadChromeCookies.mockRejectedValue(new Error('boom'));
    await expect(
      syncCookies({ setCookie: vi.fn() } as unknown as ChromeClient['Network'], 'https://chatgpt.com', null, logger),
    ).rejects.toBeInstanceOf(ChromeCookieSyncError);
  });

  test('can opt into continuing on cookie failures', async () => {
    loadChromeCookies.mockRejectedValue(new Error('boom'));
    const applied = await syncCookies(
      { setCookie: vi.fn() } as unknown as ChromeClient['Network'],
      'https://chatgpt.com',
      null,
      logger,
      { allowErrors: true },
    );
    expect(applied).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Cookie sync failed (continuing with override)'));
  });
});
