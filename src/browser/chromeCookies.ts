import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'node:url';
import keytar from 'keytar';
import type { CookieParam } from './types.js';

const KEY_LENGTH = 16;
const SALT = 'saltysalt';
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const SQLITE_NODE_PATTERN = /node_sqlite3\.node/i;
const SQLITE_BINDINGS_PATTERN = /bindings file/i;
const SQLITE_SELF_REGISTER_PATTERN = /Module did not self-register/i;
const SQLITE_BINDING_HINT = [
  'Chrome cookie sync needs sqlite3 bindings for Node 25.',
  'If the automatic rebuild fails, run:',
  '  PYTHON=/usr/bin/python3 npm_config_build_from_source=1 pnpm rebuild sqlite3 keytar win-dpapi --workspace-root',
].join('\n');

const WORKSPACE_MANIFEST_PATH = fileURLToPath(new URL('../../pnpm-workspace.yaml', import.meta.url));
const HAS_PNPM_WORKSPACE = existsSync(WORKSPACE_MANIFEST_PATH);

type RawCookieRow = {
  host_key: string;
  path: string;
  is_secure: number;
  expires_utc: number;
  name: string;
  value: string;
  encrypted_value: Buffer;
  creation_utc: number;
  is_httponly: number;
};

type DpapiModule = {
  unprotectData: (encrypted: Buffer, optionalEntropy: Buffer | null, scope: 'CurrentUser' | 'LocalMachine') => Buffer;
};

interface DecryptContext {
  legacyKey?: Buffer;
  v10Key?: Buffer;
  dpapi?: DpapiModule;
}

export interface LoadChromeCookiesOptions {
  targetUrl: string;
  profile?: string | null;
  explicitCookiePath?: string | null;
  filterNames?: Set<string>;
}

let cachedMacKey: { label: string; key: Buffer } | null = null;
let cachedLinuxKey: Buffer | null = null;
let cachedDpapi: DpapiModule | null = null;
let attemptedSqliteRebuild = false;

export async function loadChromeCookies({
  targetUrl,
  profile,
  explicitCookiePath,
  filterNames,
}: LoadChromeCookiesOptions): Promise<CookieParam[]> {
  const parsed = new URL(targetUrl);
  if (!parsed.hostname) {
    throw new Error(`Invalid target URL: ${targetUrl}`);
  }
  const host = parsed.hostname;
  const requestPath = parsed.pathname && parsed.pathname.length > 0 ? parsed.pathname : '/';
  const isHttps = parsed.protocol === 'https:';
  const cookiePath = await resolveCookieFilePath({ explicitPath: explicitCookiePath, profile });
  const decryptContext = await buildDecryptContext(cookiePath);
  const rows = await readCookieRows(cookiePath, buildHostFilters(host));
  const cookies: CookieParam[] = [];
  for (const row of rows) {
    const value = await decryptCookieValue(row, decryptContext);
    if (value == null) {
      continue;
    }
    if (!domainMatches(host, row.host_key)) {
      continue;
    }
    if (!pathMatches(requestPath, row.path ?? '/')) {
      continue;
    }
    if (row.is_secure && !isHttps) {
      continue;
    }
    if (filterNames && filterNames.size > 0 && !filterNames.has(row.name)) {
      continue;
    }
    cookies.push({
      name: row.name,
      value,
      domain: normalizeDomain(row.host_key),
      path: row.path ?? '/',
      expires: convertChromiumTimestamp(row.expires_utc),
      secure: Boolean(row.is_secure),
      httpOnly: Boolean(row.is_httponly),
    });
  }
  return cookies;
}

async function readCookieRows(cookiePath: string, hostFilters: string[]): Promise<RawCookieRow[]> {
  const placeholders = hostFilters.length ? hostFilters.map(() => 'host_key LIKE ?').join(' OR ') : '1=1';
  const sql = `SELECT host_key, path, is_secure, expires_utc, name, value, encrypted_value, creation_utc, is_httponly FROM cookies WHERE ${placeholders} ORDER BY LENGTH(path) DESC, creation_utc ASC`;
  const params = hostFilters.length ? hostFilters.map((suffix) => `%${suffix}`) : [];
  try {
    return await new Promise<RawCookieRow[]>((resolve, reject) => {
      const db = new sqlite3.Database(cookiePath, sqlite3.OPEN_READONLY, (openErr) => {
        if (openErr) {
          reject(openErr);
          return;
        }
        db.all(sql, params, (err, rows) => {
          db.close();
          if (err) {
            reject(err);
            return;
          }
          resolve(rows as RawCookieRow[]);
        });
      });
    });
  } catch (error) {
    if (isSqliteBindingError(error)) {
      const rebuilt = await attemptSqliteRebuild();
      if (rebuilt) {
        return readCookieRows(cookiePath, hostFilters);
      }
      throw new Error(SQLITE_BINDING_HINT);
    }
    throw error;
  }
}

async function buildDecryptContext(cookiePath: string): Promise<DecryptContext> {
  if (process.platform === 'win32') {
    const dpapi = await loadDpapiModule();
    const localStatePath = await findLocalStatePath(cookiePath);
    const v10Key = localStatePath ? await readWindowsV10Key(localStatePath, dpapi) : undefined;
    return { dpapi, v10Key };
  }

  if (process.platform === 'darwin') {
    const label = determineKeychainLabel(cookiePath);
    if (cachedMacKey && cachedMacKey.label === label.key) {
      return { legacyKey: cachedMacKey.key };
    }
    const password = await keytar.getPassword(label.service, label.account);
    if (!password) {
      throw new Error(`Unable to read ${label.service} from Keychain (account: ${label.account}).`);
    }
    const derivedKey = await pbkdf2Async(password, MAC_ITERATIONS);
    cachedMacKey = { label: label.key, key: derivedKey };
    return { legacyKey: derivedKey };
  }

  if (process.platform === 'linux') {
    if (cachedLinuxKey) {
      return { legacyKey: cachedLinuxKey };
    }
    const key = await pbkdf2Async('peanuts', LINUX_ITERATIONS);
    cachedLinuxKey = key;
    return { legacyKey: key };
  }

  throw new Error(`Unsupported platform for browser cookie sync: ${process.platform}`);
}

async function decryptCookieValue(row: RawCookieRow, context: DecryptContext): Promise<string | null> {
  if (row.value && row.value.length > 0) {
    return row.value;
  }
  const encrypted = row.encrypted_value;
  if (!encrypted || encrypted.length === 0) {
    return null;
  }
  if (isV10(encrypted)) {
    if (!context.v10Key) {
      throw new Error('Unable to decrypt Chrome cookies: missing AES key.');
    }
    return decryptV10(context.v10Key, encrypted);
  }
  if (process.platform === 'win32') {
    if (!context.dpapi) {
      throw new Error('win-dpapi unavailable on Windows.');
    }
    return context.dpapi.unprotectData(encrypted, null, 'CurrentUser').toString('utf8');
  }
  if (!context.legacyKey) {
    throw new Error('Unable to derive Chrome cookie key.');
  }
  return decryptLegacy(context.legacyKey, encrypted);
}

function decryptLegacy(key: Buffer, encrypted: Buffer): string {
  const iv = Buffer.alloc(KEY_LENGTH, ' ');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const sliced = encrypted.slice(3);
  let decoded = Buffer.concat([decipher.update(sliced), decipher.final()]);
  const padding = decoded[decoded.length - 1];
  if (padding) {
    decoded = decoded.slice(0, decoded.length - padding);
  }
  return decoded.toString('utf8');
}

function decryptV10(key: Buffer, encrypted: Buffer): string {
  const nonce = encrypted.subarray(3, 15);
  const tag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(15, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

async function resolveCookieFilePath({
  explicitPath,
  profile,
}: {
  explicitPath?: string | null;
  profile?: string | null;
}): Promise<string> {
  if (explicitPath && explicitPath.trim().length > 0) {
    return ensureCookieFile(explicitPath);
  }
  if (profile && looksLikePath(profile)) {
    return ensureCookieFile(profile);
  }
  const profileName = profile && profile.trim().length > 0 ? profile : 'Default';
  const baseDir = defaultProfileRoot();
  return ensureCookieFile(path.join(baseDir, profileName));
}

async function ensureCookieFile(inputPath: string): Promise<string> {
  const expanded = expandPath(inputPath);
  try {
    const stat = await fs.stat(expanded);
    if (stat.isDirectory()) {
      const directFile = path.join(expanded, 'Cookies');
      if (await fileExists(directFile)) {
        return directFile;
      }
      const networkFile = path.join(expanded, 'Network', 'Cookies');
      if (await fileExists(networkFile)) {
        return networkFile;
      }
      throw new Error(`No Cookies DB found under ${expanded}`);
    }
    return expanded;
  } catch (error) {
    throw new Error(`Unable to locate Chrome cookie DB at ${expanded}: ${(error as Error).message}`);
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function expandPath(input: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function defaultProfileRoot(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function buildHostFilters(host: string): string[] {
  const segments = host.split('.').filter(Boolean);
  if (segments.length === 0) {
    return [host];
  }
  const filters: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const suffix = segments.slice(i).join('.');
    filters.push(suffix);
  }
  // Ensure the exact host is first so we prioritize tight matches.
  if (!filters.includes(host)) {
    filters.unshift(host);
  }
  return filters;
}

function domainMatches(host: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  if (host === normalized) {
    return true;
  }
  return host.endsWith(`.${normalized}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) {
    return true;
  }
  if (!requestPath.startsWith('/')) {
    return false;
  }
  if (!cookiePath.endsWith('/')) {
    return requestPath.startsWith(`${cookiePath}/`);
  }
  return requestPath.startsWith(cookiePath);
}

function normalizeDomain(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain;
}

function convertChromiumTimestamp(timestamp: number): number | undefined {
  if (!timestamp || Number.isNaN(timestamp)) {
    return undefined;
  }
  if (timestamp > 1_000_000_000_000) {
    return Math.round(timestamp / 1_000_000 - 11644473600);
  }
  if (timestamp > 1_000_000_000) {
    return Math.round(timestamp / 1000);
  }
  return Math.round(timestamp);
}

function isV10(encrypted: Buffer): boolean {
  return encrypted.length > 3 && encrypted[0] === 0x76 && encrypted[1] === 0x31 && encrypted[2] === 0x30;
}

async function pbkdf2Async(password: string, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, SALT, iterations, KEY_LENGTH, 'sha1', (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

async function loadDpapiModule(): Promise<DpapiModule> {
  if (cachedDpapi) {
    return cachedDpapi;
  }
  try {
    const mod = await import('win-dpapi');
    cachedDpapi = (mod.default ?? mod) as DpapiModule;
    return cachedDpapi;
  } catch (error) {
    throw new Error(`win-dpapi is required on Windows to decrypt Chrome cookies: ${(error as Error).message}`);
  }
}

async function readWindowsV10Key(localStatePath: string, dpapi: DpapiModule): Promise<Buffer | undefined> {
  try {
    const raw = await fs.readFile(localStatePath, 'utf8');
    const parsed = JSON.parse(raw) as { os_crypt?: { encrypted_key?: string } };
    const encryptedKey = parsed.os_crypt?.encrypted_key;
    if (!encryptedKey) {
      return undefined;
    }
    const keyWithHeader = Buffer.from(encryptedKey, 'base64');
    const key = keyWithHeader.slice(5);
    return dpapi.unprotectData(key, null, 'CurrentUser');
  } catch {
    return undefined;
  }
}

async function findLocalStatePath(cookiePath: string): Promise<string | null> {
  let dir = path.dirname(cookiePath);
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    const candidate = path.join(dir, 'Local State');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function determineKeychainLabel(cookiePath: string): { service: string; account: string; key: string } {
  const lower = cookiePath.toLowerCase();
  if (lower.includes('microsoft edge')) {
    return {
      service: 'Microsoft Edge Safe Storage',
      account: 'Microsoft Edge',
      key: 'edge',
    };
  }
  if (lower.includes('brave')) {
    return {
      service: 'Brave Safe Storage',
      account: 'Brave',
      key: 'brave',
    };
  }
  if (lower.includes('vivaldi')) {
    return {
      service: 'Vivaldi Safe Storage',
      account: 'Vivaldi',
      key: 'vivaldi',
    };
  }
  if (lower.includes('chromium')) {
    return {
      service: 'Chromium Safe Storage',
      account: 'Chromium',
      key: 'chromium',
    };
  }
  return {
    service: 'Chrome Safe Storage',
    account: 'Chrome',
    key: 'chrome',
  };
}

function isSqliteBindingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message ?? '';
  return (
    SQLITE_NODE_PATTERN.test(message) || SQLITE_BINDINGS_PATTERN.test(message) || SQLITE_SELF_REGISTER_PATTERN.test(message)
  );
}

async function attemptSqliteRebuild(): Promise<boolean> {
  // biome-ignore lint/nursery/noUnnecessaryConditions: guard ensures rebuild runs at most once per process
  if (attemptedSqliteRebuild) {
    return false;
  }
  attemptedSqliteRebuild = true;
  if (process.env.ORACLE_ALLOW_SQLITE_REBUILD !== '1') {
    console.warn(
      '[oracle] sqlite3 bindings missing. Set ORACLE_ALLOW_SQLITE_REBUILD=1 to attempt an automatic rebuild, or run `pnpm rebuild sqlite3 keytar win-dpapi --workspace-root` manually.'
    );
    return false;
  }
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = ['rebuild', 'sqlite3', 'keytar', 'win-dpapi'];
  if (HAS_PNPM_WORKSPACE) {
    args.push('--workspace-root');
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  childEnv.npm_config_build_from_source = '1';
  childEnv.PYTHON = childEnv.PYTHON ?? '/usr/bin/python3';
  console.warn('[oracle] Attempting to rebuild sqlite3 bindings automatically…');
  console.warn(
    `[oracle] Running: npm_config_build_from_source=1 PYTHON=${childEnv.PYTHON} ${pnpmCommand} ${args.join(' ')}`,
  );
  return new Promise((resolve) => {
    const child = spawn(pnpmCommand, args, { stdio: 'inherit', env: childEnv });
    child.on('exit', (code) => {
      if (code === 0) {
        console.warn('[oracle] sqlite3 rebuild completed successfully.');
        resolve(true);
      } else {
        console.warn('[oracle] sqlite3 rebuild failed with exit code', code ?? 0);
        resolve(false);
      }
    });
    child.on('error', (error) => {
      console.warn('[oracle] Unable to spawn pnpm to rebuild sqlite3:', error);
      resolve(false);
    });
  });
}

// biome-ignore lint/style/useNamingConvention: legacy test helper naming for vitest mocks
export const __test__ = {
  buildHostFilters,
  domainMatches,
  pathMatches,
  determineKeychainLabel,
};
