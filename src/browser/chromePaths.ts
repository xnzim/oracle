import { existsSync } from 'node:fs';
import path from 'node:path';
import { Launcher } from 'chrome-launcher';

export type BrowserExecutableSource = 'explicit' | 'env' | 'chrome' | 'brave' | 'none';

export function resolveBrowserExecutablePath(explicitPath?: string | null): {
  path?: string;
  source: BrowserExecutableSource;
} {
  if (explicitPath) {
    return { path: explicitPath, source: 'explicit' };
  }
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    return { path: envPath, source: 'env' };
  }
  const chromePath = safeGetChromeInstallation();
  if (chromePath) {
    return { path: chromePath, source: 'chrome' };
  }
  const bravePath = resolveBraveInstallation();
  if (bravePath) {
    return { path: bravePath, source: 'brave' };
  }
  return { path: undefined, source: 'none' };
}

export function resolveBraveInstallation(): string | undefined {
  const envPath = pickEnvPath(['BRAVE_PATH', 'ORACLE_BRAVE_PATH']);
  if (envPath) {
    return envPath;
  }

  const candidates = [...bravePathsForPlatform()];
  return candidates.find((candidate) => existsSync(candidate));
}

function safeGetChromeInstallation(): string | undefined {
  try {
    return Launcher.getFirstInstallation() ?? undefined;
  } catch {
    return undefined;
  }
}

function pickEnvPath(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && existsSync(value)) {
      return value;
    }
  }
  return undefined;
}

function bravePathsForPlatform(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
        '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
        '/Applications/Brave Browser Dev.app/Contents/MacOS/Brave Browser Dev',
      ];
    case 'win32':
      return [
        resolveWindowsPath(process.env.ProgramFiles),
        resolveWindowsPath(process.env['ProgramFiles(x86)']),
        resolveWindowsPath(process.env.LOCALAPPDATA),
      ].filter((candidate): candidate is string => Boolean(candidate));
    default:
      return ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/snap/bin/brave-browser'];
  }
}

function resolveWindowsPath(root?: string): string | null {
  if (!root) {
    return null;
  }
  return path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
}
