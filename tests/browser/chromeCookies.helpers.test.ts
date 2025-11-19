import { describe, expect, test } from 'vitest';
import { __test__ } from '../../src/browser/chromeCookies.js';

describe('chromeCookies helpers', () => {
  test('buildHostFilters returns suffixes for multi-part hosts', () => {
    expect(__test__.buildHostFilters('sub.example.co.uk')).toEqual([
      'sub.example.co.uk',
      'example.co.uk',
      'co.uk',
      'uk',
    ]);
  });

  test('domain matching treats leading dots as wildcards', () => {
    expect(__test__.domainMatches('chat.openai.com', '.openai.com')).toBe(true);
    expect(__test__.domainMatches('openai.com', '.openai.com')).toBe(true);
    expect(__test__.domainMatches('example.com', '.openai.com')).toBe(false);
  });

  test('path matching honors RFC 6265 semantics', () => {
    expect(__test__.pathMatches('/foo/bar', '/foo')).toBe(true);
    expect(__test__.pathMatches('/foo/bar', '/foo/bar')).toBe(true);
    expect(__test__.pathMatches('/foo', '/foo/bar')).toBe(false);
    expect(__test__.pathMatches('/foobar', '/foo')).toBe(false);
  });

  test('determineKeychainLabel detects Edge/Chromium paths', () => {
    const edge = __test__.determineKeychainLabel('/Users/me/Library/Application Support/Microsoft Edge/Profile 1/Cookies');
    expect(edge.service).toBe('Microsoft Edge Safe Storage');
    const chromium = __test__.determineKeychainLabel('/Users/me/Library/Application Support/Chromium/Default/Cookies');
    expect(chromium.service).toBe('Chromium Safe Storage');
  });
});
