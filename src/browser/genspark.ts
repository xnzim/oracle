import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import type { BrowserAttachment, BrowserLogger, BrowserRunOptions, BrowserRunResult, ChromeClient } from './types.js';
import { resolveBrowserConfig } from './config.js';
import { defaultBrowserUrl } from './provider.js';
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToChrome,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
} from './chromeLifecycle.js';
import { syncCookies } from './cookies.js';
import { delay, estimateTokenCount } from './utils.js';
import { buildClickDispatcher } from './actions/domEvents.js';
import { ensureNotBlocked } from './actions/navigation.js';
import { transferAttachmentViaDataTransfer } from './actions/attachmentDataTransfer.js';
import {
  cleanupStaleProfileState,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from './profileState.js';
import { BrowserAutomationError } from '../oracle/errors.js';
import type { LaunchedChrome } from 'chrome-launcher';
import type Protocol from 'devtools-protocol';

const GENSPARK_PROMPT_SELECTORS = [
  'textarea[placeholder*="Ask" i]',
  'textarea[placeholder*="Message" i]',
  'textarea',
  'div[contenteditable="true"]',
  '[role="textbox"]',
];

const GENSPARK_SEND_SELECTORS = [
  'button[type="submit"]',
  'button[aria-label*="send" i]',
  'button[aria-label*="submit" i]',
  'button[data-testid*="send"]',
  'button[data-testid*="submit"]',
];

const GENSPARK_FILE_INPUT_SELECTORS = [
  'input[type="file"]',
  'input[type="file"][multiple]',
  'input[type="file"][accept]',
  'input[type="file"][data-testid*="file"]',
  'input[type="file"][data-testid*="upload"]',
  'input[type="file"][data-testid*="attachment"]',
];

const GENSPARK_ATTACHMENT_TRIGGER_SELECTORS = [
  '.upload-trigger-button',
  '.upload-attachments',
  '.upload-from-multiple-source-container',
  '.input-icon',
  '.icon-group',
  '.cursor-pointer',
  'button[aria-label*="upload" i]',
  'button[aria-label*="attach" i]',
  'button[aria-label*="attachment" i]',
  'button[aria-label*="file" i]',
  'button[title*="upload" i]',
  'button[title*="attach" i]',
  'button[title*="attachment" i]',
  'button[title*="file" i]',
  '[role="button"][aria-label*="upload" i]',
  '[role="button"][aria-label*="attach" i]',
  '[role="button"][aria-label*="attachment" i]',
  '[role="button"][aria-label*="file" i]',
  '[data-testid*="upload"]',
  '[data-testid*="attachment"]',
  '[data-testid*="file"]',
  '[class*="upload-"]',
  '[class*="attachment"]',
  '[class*="file"]',
];

const GENSPARK_ATTACHMENT_MENU_SELECTORS = [
  '.upload-option-item',
  '.upload-options-popover',
  '[data-testid*="upload-option"]',
  '[class*="upload-option"]',
  '[role="menuitem"]',
];

const GENSPARK_RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  '[data-turn="assistant"]',
  '.assistant',
  '.assistant-message',
  '.assistant_response',
  '[data-testid*="assistant"]',
  'main article',
  'article',
];

const GENSPARK_MODEL_TRIGGER_SELECTORS = [
  '[role="combobox"]',
  'button[aria-haspopup="listbox"]',
  'button[aria-haspopup="menu"]',
  '[role="button"][aria-haspopup="listbox"]',
  '[role="button"][aria-haspopup="menu"]',
  'button[aria-label*="model" i]',
  'button[title*="model" i]',
  '[role="button"][aria-label*="model" i]',
  '[role="button"][title*="model" i]',
  '[data-testid*="model"]',
  '[data-testid*="llm"]',
  '[data-testid*="selector"]',
  '[data-testid*="dropdown"]',
  '[data-testid*="engine"]',
  '.model-selection-icon-container',
  '.model-selection-button',
  '.model-selection-container',
  '.model-label',
  '.dropdown-icon',
  '[class*="model-selection"]',
  '[class*="model-label"]',
  '[class*="dropdown-icon"]',
];

const GENSPARK_MODEL_MENU_SELECTORS = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[data-radix-collection-root]',
  '[data-radix-popper-content-wrapper]',
  '[data-state="open"]',
  '[data-testid*="menu"]',
  '[data-testid*="list"]',
  '[class*="model-menu"]',
  '[class*="model-list"]',
  '[class*="dropdown-menu"]',
  '[class*="dropdown-list"]',
  '.model-dropdown',
  '.dropdown-content',
  '.model-options-container',
  '.model-options-scroll',
];

const GENSPARK_MODEL_OPTION_SELECTORS = [
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="menuitem"]',
  'button',
  'li',
  '[role="button"]',
  'a',
  'div',
  'span',
  '[class*="model-item"]',
  '[class*="model-option"]',
  '[class*="dropdown-item"]',
  '.model-option',
  '.model-option .text',
];

const GENSPARK_MODEL_OPTION_FALLBACK_SELECTORS = [
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="menuitem"]',
  'button',
  'li',
  '[role="button"]',
  'a',
  'div',
  'span',
  '.model-option',
  '.model-option .text',
];

const DEFAULT_DEBUG_PORT = 9222;

export async function runGensparkBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error('Prompt text is required when using browser mode.');
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];

  let config = resolveBrowserConfig({ ...(options.config ?? {}), provider: 'genspark' });
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(`DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`);
    }
    config = { ...config, debugPort: availablePort };
  }

  if (config.remoteChrome) {
    return runRemoteGensparkMode(promptText, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : path.join(os.homedir(), '.oracle', 'browser-profile');
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), 'oracle-browser-'));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
  const startedAt = Date.now();
  const chrome =
    reusedChrome ??
    (await launchChrome(
      {
        ...config,
        remoteChrome: config.remoteChrome,
      },
      userDataDir,
      logger,
    ));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? '127.0.0.1';
  if (manualLogin && chrome.port) {
    await writeDevToolsActivePort(userDataDir, chrome.port);
    if (!reusedChrome && chrome.pid) {
      await writeChromePid(userDataDir, chrome.pid);
    }
  }

  let removeTerminationHooks: (() => void) | null = null;
  let client: ChromeClient | null = null;
  let runStatus: 'attempted' | 'complete' = 'attempted';
  let connectionClosedUnexpectedly = false;
  let answerText = '';
  let answerHtml = '';
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb || !chrome?.port) {
      return;
    }
    await runtimeHintCb({
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      userDataDir,
      controllerPid: process.pid,
    });
  };

  try {
    removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, effectiveKeepBrowser, logger, {
      isInFlight: () => runStatus !== 'complete',
      emitRuntimeHint,
      preserveUserDataDir: manualLogin,
    });

    try {
      client = await connectToChrome(chrome.port, logger, chromeHost);
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }

    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on('disconnect', () => {
        connectionClosedUnexpectedly = true;
        logger('Chrome window closed; attempting to abort run.');
        reject(new Error('Chrome window closed before oracle finished. Please keep it open until completion.'));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);

    const { Network, Page, Runtime, Input, DOM } = client;
    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === 'function') {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);

    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
    let appliedCookies = 0;
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger('Manual login mode: seeding persistent profile with cookies from your Chrome profile.');
      }
      if (!config.inlineCookies) {
        logger(
          'Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.',
        );
      }
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
      });
      appliedCookies = cookieCount;
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? 'Default'}`
          : config.inlineCookies
            ? 'No inline cookies applied; continuing without session reuse'
            : 'No Chrome cookies found; continuing without session reuse',
      );
    } else {
      logger(
        manualLogin
          ? 'Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in.'
          : 'Skipping Chrome cookie sync (--browser-no-cookie-sync)',
      );
    }
    if (cookieSyncEnabled && !manualLogin && appliedCookies === 0 && !config.inlineCookies) {
      logger('No Genspark cookies were applied; you may need to sign in for the prompt to appear.');
    }

    await raceWithDisconnect(navigateToUrl(Page, Runtime, config.url, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    await raceWithDisconnect(waitForGensparkPrompt(Runtime, config.inputTimeoutMs ?? 60_000));
    await raceWithDisconnect(maybeSelectGensparkModel(Page, Runtime, Input, config.desiredModel, logger));
    await raceWithDisconnect(uploadGensparkAttachments(Page, Runtime, Input, attachments, logger));

    await captureRuntimeSnapshot(Runtime, async (url, targetId) => {
      lastUrl = url ?? lastUrl;
      lastTargetId = targetId ?? lastTargetId;
      await emitRuntimeHint();
    });

    await focusPrompt(Runtime);
    await Input.insertText({ text: promptText });
    await delay(300);
    const clicked = await attemptSendButton(Runtime);
    if (!clicked) {
      await dispatchEnter(Input);
      logger('Submitted prompt via Enter key');
    } else {
      logger('Clicked send button');
    }

    const baselineSnapshot = await readLatestAssistantSnapshot(Runtime, promptText);
    const baselineText = baselineSnapshot.text;
    const response = await waitForGensparkResponse(Runtime, promptText, baselineText, config.timeoutMs ?? 1_200_000, logger);
    answerText = response.text;
    answerHtml = response.html;
    runStatus = 'complete';
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Genspark browser automation failed.';
    throw new BrowserAutomationError(message, { stage: 'execute-browser', details: { provider: 'genspark' } }, error);
  } finally {
    if (client) {
      client.close();
      client = null;
    }
    if (removeTerminationHooks) {
      removeTerminationHooks();
    }
    if (chrome && !config.remoteChrome) {
      if (!effectiveKeepBrowser || connectionClosedUnexpectedly) {
        try {
          await Promise.resolve(chrome.kill());
        } catch {
          // Ignore chrome shutdown failures.
        }
        if (manualLogin) {
          const shouldCleanup = await shouldCleanupManualLoginProfileState(
            userDataDir,
            logger.verbose ? logger : undefined,
            {
              connectionClosedUnexpectedly,
              host: chromeHost,
            },
          );
          if (shouldCleanup) {
            await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'never' }).catch(() => undefined);
          }
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      } else if (!connectionClosedUnexpectedly) {
        logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
      }
    }
  }

  const answerMarkdown = answerText;
  return {
    answerText,
    answerMarkdown,
    answerHtml,
    tookMs: Date.now() - startedAt,
    answerTokens: estimateTokenCount(answerText),
    answerChars: answerText.length,
    chromePid: (chrome as LaunchedChrome | null | undefined)?.pid,
    chromePort: (chrome as LaunchedChrome | null | undefined)?.port,
    chromeHost: (chrome as { host?: string } | null | undefined)?.host ?? '127.0.0.1',
    userDataDir,
    chromeTargetId: lastTargetId,
    tabUrl: lastUrl,
    controllerPid: process.pid,
  };
}

async function runRemoteGensparkMode(
  promptText: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error('Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.');
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let lastUrl: string | undefined;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    await runtimeHintCb({
      chromePort: port,
      chromeHost: host,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    });
  };
  const startedAt = Date.now();
  let answerText = '';
  let answerHtml = '';
  let connectionClosedUnexpectedly = false;

  try {
    const connection = await connectToRemoteChrome(host, port, logger, config.url);
    client = connection.client;
    remoteTargetId = connection.targetId ?? null;
    await emitRuntimeHint();
    client.on('disconnect', () => {
      connectionClosedUnexpectedly = true;
    });
    const { Network, Page, Runtime, Input, DOM } = client;
    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === 'function') {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    logger('Skipping cookie sync for remote Chrome (using existing session)');

    await navigateToUrl(Page, Runtime, config.url, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await waitForGensparkPrompt(Runtime, config.inputTimeoutMs ?? 60_000);
    await maybeSelectGensparkModel(Page, Runtime, Input, config.desiredModel, logger);
    await uploadGensparkAttachments(Page, Runtime, Input, options.attachments ?? [], logger);
    const urlSnapshot = await captureRuntimeSnapshot(Runtime, async (url) => {
      lastUrl = url ?? lastUrl;
      await emitRuntimeHint();
    });
    if (urlSnapshot?.url) {
      lastUrl = urlSnapshot.url;
      await emitRuntimeHint();
    }
    await focusPrompt(Runtime);
    await Input.insertText({ text: promptText });
    await delay(300);
    const clicked = await attemptSendButton(Runtime);
    if (!clicked) {
      await dispatchEnter(Input);
      logger('Submitted prompt via Enter key');
    } else {
      logger('Clicked send button');
    }
    const baselineSnapshot = await readLatestAssistantSnapshot(Runtime, promptText);
    const response = await waitForGensparkResponse(Runtime, promptText, baselineSnapshot.text, config.timeoutMs ?? 1_200_000, logger);
    answerText = response.text;
    answerHtml = response.html;
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Genspark browser automation failed.';
    throw new BrowserAutomationError(message, { stage: 'execute-browser', details: { provider: 'genspark' } }, error);
  } finally {
    if (client) {
      client.close();
    }
    if (remoteTargetId) {
      await closeRemoteChromeTarget(host, port, remoteTargetId ?? undefined, logger);
    }
    if (!connectionClosedUnexpectedly) {
      const tookMs = Date.now() - startedAt;
      logger(`Remote Genspark run finished after ${tookMs}ms`);
    }
  }

  return {
    answerText,
    answerMarkdown: answerText,
    answerHtml,
    tookMs: Date.now() - startedAt,
    answerTokens: estimateTokenCount(answerText),
    answerChars: answerText.length,
    chromePort: port,
    chromeHost: host,
    chromeTargetId: remoteTargetId ?? undefined,
    tabUrl: lastUrl,
    controllerPid: process.pid,
  };
}

async function waitForGensparkPrompt(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: buildPromptPresenceExpression(),
      returnByValue: true,
    });
    if (result?.value) {
      return;
    }
    await delay(200);
  }
  throw new Error('Prompt textarea did not appear before timeout (Genspark).');
}

async function dispatchNativeClick(
  Input: ChromeClient['Input'],
  target: { x: number; y: number } | null | undefined,
): Promise<void> {
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
  const x = Math.max(0, target.x);
  const y = Math.max(0, target.y);
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function maybeSelectGensparkModel(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'],
  desiredModel: string | null | undefined,
  logger: BrowserLogger,
): Promise<void> {
  const trimmed = desiredModel?.trim();
  if (!trimmed) {
    return;
  }
  const log = logger.verbose ? logger : () => {};
  let contexts = await resolveGensparkExecutionContexts(Page, log);
  const attemptSelect = async (ctxs = contexts): Promise<unknown[]> =>
    evaluateInContexts(Runtime, ctxs, buildModelSelectExpression(trimmed));
  const attemptOpen = async (ctxs = contexts): Promise<unknown[]> =>
    evaluateInContexts(Runtime, ctxs, buildModelPickerOpenExpression(trimmed));
  const attemptOpenTarget = async (ctxs = contexts): Promise<unknown[]> =>
    evaluateInContexts(Runtime, ctxs, buildModelPickerTargetExpression(trimmed));
  const attemptOptionTarget = async (ctxs = contexts): Promise<unknown[]> =>
    evaluateInContexts(Runtime, ctxs, buildModelOptionTargetExpression(trimmed));
  const findSelected = (results: unknown[]):
    | { alreadySelected?: boolean; label?: string }
    | undefined =>
    results.find((result) => result && (result as { selected?: boolean }).selected) as
      | { alreadySelected?: boolean; label?: string }
      | undefined;
  const findTarget = (
    results: unknown[],
  ): { target: { x: number; y: number }; label?: string; alreadySelected?: boolean } | null => {
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const target = (result as { target?: { x?: number; y?: number } }).target;
      if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
        return {
          target: { x: target.x as number, y: target.y as number },
          label: (result as { label?: string }).label,
          alreadySelected: (result as { alreadySelected?: boolean }).alreadySelected,
        };
      }
    }
    return null;
  };
  const waitForSelection = async (
    ctxs: number[],
    timeoutMs: number,
  ): Promise<{ alreadySelected?: boolean; label?: string } | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const results = await attemptSelect(ctxs);
      const match = findSelected(results);
      if (match) return match;
      await delay(250);
    }
    return null;
  };

  try {
    log(`Attempting to select Genspark model: ${trimmed}`);
    const initialMatch = findSelected(await attemptSelect());
    if (initialMatch) {
      const status = initialMatch.alreadySelected ? 'already selected' : 'selected';
      log(`Genspark model ${status}: ${initialMatch.label ?? trimmed}`);
      return;
    }

    const openedResults = await attemptOpen();
    const openedMatch = openedResults.find((result) => result && (result as { opened?: boolean }).opened);
    if (!openedMatch) {
      const first = openedResults.find((result) => result && typeof result === 'object') as
        | { reason?: string; count?: number; sample?: string[] }
        | undefined;
      const reason = first?.reason ?? 'unknown';
      const count = first?.count;
      const sample = first?.sample;
      const extra = [
        typeof count === 'number' ? `count=${count}` : null,
        Array.isArray(sample) && sample.length ? `sample=${sample.slice(0, 3).join(' | ')}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      log(`Unable to locate Genspark model picker (${reason}${extra ? `; ${extra}` : ''}).`);
    }

    const refreshed = await resolveGensparkExecutionContexts(Page, log);
    if (refreshed.length) {
      contexts = refreshed;
    }

    const followMatch = await waitForSelection(contexts, 5_000);
    if (followMatch) {
      const status = followMatch.alreadySelected ? 'already selected' : 'selected';
      log(`Genspark model ${status}: ${followMatch.label ?? trimmed}`);
      return;
    }

    const pickerTarget = findTarget(await attemptOpenTarget());
    if (pickerTarget?.target) {
      log('Retrying Genspark model picker click via native mouse event.');
      await dispatchNativeClick(Input, pickerTarget.target);
      await delay(300);
    }

    const optionTarget = findTarget(await attemptOptionTarget());
    if (optionTarget?.alreadySelected) {
      log(`Genspark model already selected: ${optionTarget.label ?? trimmed}`);
      return;
    }
    if (optionTarget?.target) {
      log(`Selecting Genspark model via native mouse event: ${optionTarget.label ?? trimmed}`);
      await dispatchNativeClick(Input, optionTarget.target);
      await delay(300);
    }

    const finalMatch = await waitForSelection(contexts, 2_000);
    if (finalMatch) {
      const status = finalMatch.alreadySelected ? 'already selected' : 'selected';
      log(`Genspark model ${status}: ${finalMatch.label ?? trimmed}`);
      return;
    }

    log(`Genspark model not found in picker: ${trimmed}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Genspark model selection failed: ${message}`);
  }
}

async function uploadGensparkAttachments(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'],
  attachments: BrowserAttachment[],
  logger: BrowserLogger,
): Promise<void> {
  if (!attachments.length) return;
  const log = logger.verbose ? logger : () => {};
  let contexts = await resolveGensparkExecutionContexts(Page, log);
  if (!contexts.length) {
    contexts = [];
  }
  let target = await resolveGensparkFileInput(Runtime, Input, contexts, logger);
  if (!target) {
    throw new BrowserAutomationError('Unable to locate a Genspark file attachment input.', {
      stage: 'execute-browser',
      details: { provider: 'genspark' },
    });
  }
  if (attachments.length > 1 && target.multiple === false) {
    throw new BrowserAutomationError(
      'Genspark file input does not accept multiple files. Use --browser-bundle-files or pass a single file.',
      { stage: 'execute-browser', details: { provider: 'genspark' } },
    );
  }

  for (const attachment of attachments) {
    target = (await resolveGensparkFileInput(Runtime, Input, contexts, logger)) ?? target;
    logger(`Uploading attachment: ${attachment.displayPath}`);
    const transferResult = await transferAttachmentViaDataTransfer(Runtime, attachment, target.selector, {
      contextId: target.contextId,
      append: true,
    });
    if (transferResult.alreadyPresent) {
      log(`Attachment already queued: ${transferResult.fileName}`);
      continue;
    }
    await waitForGensparkAttachmentQueued(
      Runtime,
      target.selector,
      path.basename(attachment.path),
      target.contextId,
      15_000,
      logger,
    );
    await delay(250);
  }
}

async function resolveGensparkFileInput(
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'],
  contexts: number[],
  logger: BrowserLogger,
): Promise<{ selector: string; contextId?: number; multiple?: boolean } | null> {
  const log = logger.verbose ? logger : () => {};
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const results = await evaluateInContextsWithIds(Runtime, contexts, buildGensparkFileInputExpression());
    const found = results.find((result) => result.value && (result.value as { found?: boolean }).found);
    if (found?.value && typeof found.value === 'object') {
      const value = found.value as { selector?: string; multiple?: boolean };
      if (value.selector) {
        return { selector: value.selector, multiple: value.multiple, contextId: found.contextId };
      }
    }
    const clicked = results.some((result) => result.value && (result.value as { clicked?: boolean }).clicked);
    if (clicked) {
      await delay(500);
      continue;
    }
    break;
  }

  const targetResult = findTargetInContextResults(
    await evaluateInContextsWithIds(Runtime, contexts, buildGensparkAttachmentTriggerTargetExpression()),
  );
  if (targetResult?.target) {
    log('Retrying Genspark attachment picker click via native mouse event.');
    await dispatchNativeClick(Input, targetResult.target);
    await delay(600);
    const results = await evaluateInContextsWithIds(Runtime, contexts, buildGensparkFileInputExpression());
    const found = results.find((result) => result.value && (result.value as { found?: boolean }).found);
    if (found?.value && typeof found.value === 'object') {
      const value = found.value as { selector?: string; multiple?: boolean };
      if (value.selector) {
        return { selector: value.selector, multiple: value.multiple, contextId: found.contextId };
      }
    }
  }

  return null;
}

async function waitForGensparkAttachmentQueued(
  Runtime: ChromeClient['Runtime'],
  selector: string,
  expectedName: string,
  contextId: number | undefined,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastNames: string[] = [];
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: buildGensparkAttachmentQueuedExpression(selector, expectedName),
      returnByValue: true,
      contextId,
    });
    const value = result?.value as { queued?: boolean; names?: string[] } | undefined;
    if (value?.queued) return;
    if (Array.isArray(value?.names)) {
      lastNames = value?.names ?? lastNames;
    }
    await delay(200);
  }
  const suffix = lastNames.length > 0 ? ` (input has: ${lastNames.join(', ')})` : '';
  logger(`Attachment did not appear in the file input before timeout${suffix}`);
}

function findTargetInContextResults(
  results: Array<{ contextId?: number; value: unknown }>,
): { target: { x: number; y: number }; label?: string } | null {
  for (const result of results) {
    if (!result?.value || typeof result.value !== 'object') continue;
    const target = (result.value as { target?: { x?: number; y?: number } }).target;
    if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
      return { target: { x: target.x as number, y: target.y as number }, label: (result.value as { label?: string }).label };
    }
  }
  return null;
}

async function focusPrompt(Runtime: ChromeClient['Runtime']): Promise<void> {
  const { result } = await Runtime.evaluate({
    expression: buildPromptFocusExpression(),
    returnByValue: true,
  });
  if (!result?.value?.focused) {
    throw new Error('Failed to focus Genspark prompt input.');
  }
}

async function attemptSendButton(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: buildSendButtonExpression(),
    returnByValue: true,
  });
  return Boolean(result?.value?.clicked);
}

async function dispatchEnter(Input: ChromeClient['Input']): Promise<void> {
  const event = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  } as const;
  await Input.dispatchKeyEvent({ type: 'keyDown', ...event, text: '\r', unmodifiedText: '\r' });
  await Input.dispatchKeyEvent({ type: 'keyUp', ...event });
}

async function waitForGensparkResponse(
  Runtime: ChromeClient['Runtime'],
  promptText: string,
  baselineText: string,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let lastHtml = '';
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readLatestAssistantSnapshot(Runtime, promptText);
    const text = snapshot.text;
    if (text && text !== baselineText) {
      if (text === lastText) {
        stableCount += 1;
      } else {
        lastText = text;
        lastHtml = snapshot.html;
        stableCount = 0;
      }
      if (stableCount >= 3) {
        return { text: lastText, html: lastHtml };
      }
    }
    await delay(500);
  }
  if (lastText) {
    logger('Response timed out before stabilizing; returning the latest captured text.');
    return { text: lastText, html: lastHtml };
  }
  throw new Error(`Timed out waiting for Genspark response after ${Math.round(timeoutMs / 1000)}s.`);
}

async function readLatestAssistantSnapshot(
  Runtime: ChromeClient['Runtime'],
  promptText: string,
): Promise<{ text: string; html: string }> {
  const { result } = await Runtime.evaluate({
    expression: buildLatestAssistantExpression(promptText),
    returnByValue: true,
  });
  const text = result?.value?.text ?? '';
  const html = result?.value?.html ?? '';
  return { text, html };
}

function buildPromptPresenceExpression(): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_PROMPT_SELECTORS);
  return `(() => {
    const selectors = ${selectorsLiteral};
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 80 && rect.height > 24;
    };
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const disabled = node.getAttribute?.('disabled') != null || node.getAttribute?.('aria-disabled') === 'true';
        if (disabled) continue;
        if (isVisible(node)) return true;
      }
    }
    return false;
  })()`;
}

function buildModelPickerOpenExpression(desiredModel: string): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_MODEL_TRIGGER_SELECTORS);
  const promptSelectorsLiteral = JSON.stringify(GENSPARK_PROMPT_SELECTORS);
  const desiredLiteral = JSON.stringify(desiredModel);
  return `(() => {
    ${buildClickDispatcher()}
    const selectors = ${selectorsLiteral};
    const promptSelectors = ${promptSelectorsLiteral};
    const desired = ${desiredLiteral};
    const normalize = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const desiredNormalized = normalize(desired);
    const collectRoots = (root) => {
      const roots = [root];
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        const walkerRoot = current instanceof Document ? current.body : current;
        if (!walkerRoot) continue;
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }
      return roots;
    };
    const queryAllDeep = (selector, root = document) => {
      const results = [];
      const roots = collectRoots(root);
      for (const rootNode of roots) {
        if (rootNode.querySelectorAll) {
          results.push(...rootNode.querySelectorAll(selector));
        }
      }
      return results;
    };
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };
    const isDisabled = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      if (node.getAttribute?.('disabled') != null) return true;
      if (node.getAttribute?.('aria-disabled') === 'true') return true;
      return node.classList.contains('disabled');
    };
    const readPickerLabel = (node) => {
      if (!node || !(node instanceof HTMLElement)) return '';
      const container =
        node.closest?.('.model-selection-icon-container, .model-selection-container') ?? node;
      const labelNode = container?.querySelector?.('.model-label, [class*="model-label"]');
      return (labelNode?.innerText || labelNode?.textContent || '').trim();
    };
    const candidates = [];
    const addCandidate = (node) => {
      if (!node || !(node instanceof HTMLElement)) return;
      if (!isVisible(node)) return;
      const isPickerNode = node.matches?.(
        '.model-selection-icon-container, .model-selection-container, .model-selection-button, .dropdown-icon, [class*="model-selection"]'
      );
      const text = (node.innerText || node.textContent || '').trim();
      const aria = node.getAttribute?.('aria-label') || '';
      const title = node.getAttribute?.('title') || '';
      const pickerLabel = isPickerNode ? readPickerLabel(node) : '';
      const combined = [text, aria, title, pickerLabel].filter(Boolean).join(' ').trim();
      if (!combined && !isPickerNode) return;
      const normalized = normalize(combined);
      if (/send|submit|upload/.test(normalized)) return;
      let score = 0;
      if (normalized.includes('model')) score += 3;
      if (desiredNormalized && normalized.includes(desiredNormalized)) score += 3;
      if (/gpt|claude|gemini|grok|o\\d|pro|instant|haiku|sonnet|opus/.test(normalized)) score += 2;
      if (node.getAttribute?.('aria-haspopup')) score += 1;
      if (node.getAttribute?.('aria-expanded') === 'false') score += 1;
      const rect = node.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.75) score += 0.5;
      if (isDisabled(node) && !isPickerNode) return;
      candidates.push({ node, score, label: combined || pickerLabel });
    };
    const collectFromRoot = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      for (const selector of selectors) {
        const nodes = Array.from(queryAllDeep(selector, root));
        nodes.forEach((node) => addCandidate(node));
      }
      // Fallback: any clickable element with a model-like label.
      const fallbackNodes = Array.from(queryAllDeep('button, [role="button"], [role="combobox"]', root));
      for (const node of fallbackNodes) {
        const text = (node.innerText || node.textContent || '').toLowerCase();
        if (!text) continue;
        if (!/gpt|claude|gemini|grok|o\\d|pro|instant|haiku|sonnet|opus/.test(text)) continue;
        addCandidate(node);
      }
    };
    const promptNodes = [];
    for (const selector of promptSelectors) {
      promptNodes.push(...Array.from(queryAllDeep(selector)));
    }
    const prompt = promptNodes.find((node) => isVisible(node));
    if (prompt) {
      const container = prompt.closest('form') ?? prompt.closest('section') ?? prompt.parentElement;
      if (container) {
        collectFromRoot(container);
        let ancestor = container.parentElement;
        for (let i = 0; i < 4 && ancestor; i += 1) {
          collectFromRoot(ancestor);
          ancestor = ancestor.parentElement;
        }
      }
    }
    collectFromRoot(document);
    if (!candidates.length) return { opened: false, reason: 'no-trigger' };
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score <= 0) {
      return { opened: false, reason: 'low-score', count: candidates.length, sample: candidates.slice(0, 5).map((entry) => entry.label) };
    }
    const container = best.node.closest?.('.model-selection-icon-container, .model-selection-container');
    const button = best.node.closest?.('.model-selection-button');
    const clickable =
      container ??
      (!isDisabled(button) ? button : null) ??
      best.node.closest?.(
        '.model-selection-icon-container, .model-selection-container, .model-selection-button, [class*="model-selection"], button, [role="button"], [role="combobox"]'
      ) ??
      best.node;
    dispatchClickSequence(clickable);
    return { opened: true, label: best.label, count: candidates.length };
  })()`;
}

function buildModelPickerTargetExpression(desiredModel: string): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_MODEL_TRIGGER_SELECTORS);
  const promptSelectorsLiteral = JSON.stringify(GENSPARK_PROMPT_SELECTORS);
  const desiredLiteral = JSON.stringify(desiredModel);
  return `(() => {
    const selectors = ${selectorsLiteral};
    const promptSelectors = ${promptSelectorsLiteral};
    const desired = ${desiredLiteral};
    const normalize = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const desiredNormalized = normalize(desired);
    const collectRoots = (root) => {
      const roots = [root];
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        const walkerRoot = current instanceof Document ? current.body : current;
        if (!walkerRoot) continue;
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }
      return roots;
    };
    const queryAllDeep = (selector, root = document) => {
      const results = [];
      const roots = collectRoots(root);
      for (const rootNode of roots) {
        if (rootNode.querySelectorAll) {
          results.push(...rootNode.querySelectorAll(selector));
        }
      }
      return results;
    };
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };
    const isDisabled = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      if (node.getAttribute?.('disabled') != null) return true;
      if (node.getAttribute?.('aria-disabled') === 'true') return true;
      return node.classList.contains('disabled');
    };
    const readPickerLabel = (node) => {
      if (!node || !(node instanceof HTMLElement)) return '';
      const container =
        node.closest?.('.model-selection-icon-container, .model-selection-container') ?? node;
      const labelNode = container?.querySelector?.('.model-label, [class*="model-label"]');
      return (labelNode?.innerText || labelNode?.textContent || '').trim();
    };
    const toTarget = (node) => {
      if (!node || !(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 1 || rect.height <= 1) return null;
      let x = rect.left + rect.width / 2;
      let y = rect.top + rect.height / 2;
      if (window.frameElement instanceof HTMLElement) {
        const frameRect = window.frameElement.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
      }
      return { x, y };
    };
    const candidates = [];
    const addCandidate = (node) => {
      if (!node || !(node instanceof HTMLElement)) return;
      if (!isVisible(node)) return;
      const isPickerNode = node.matches?.(
        '.model-selection-icon-container, .model-selection-container, .model-selection-button, .dropdown-icon, [class*="model-selection"]'
      );
      const text = (node.innerText || node.textContent || '').trim();
      const aria = node.getAttribute?.('aria-label') || '';
      const title = node.getAttribute?.('title') || '';
      const pickerLabel = isPickerNode ? readPickerLabel(node) : '';
      const combined = [text, aria, title, pickerLabel].filter(Boolean).join(' ').trim();
      if (!combined && !isPickerNode) return;
      const normalized = normalize(combined);
      if (/send|submit|upload/.test(normalized)) return;
      let score = 0;
      if (normalized.includes('model')) score += 3;
      if (desiredNormalized && normalized.includes(desiredNormalized)) score += 3;
      if (/gpt|claude|gemini|grok|o\\d|pro|instant|haiku|sonnet|opus/.test(normalized)) score += 2;
      if (node.getAttribute?.('aria-haspopup')) score += 1;
      if (node.getAttribute?.('aria-expanded') === 'false') score += 1;
      const rect = node.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.75) score += 0.5;
      if (isDisabled(node) && !isPickerNode) return;
      candidates.push({ node, score, label: combined || pickerLabel });
    };
    const collectFromRoot = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      for (const selector of selectors) {
        const nodes = Array.from(queryAllDeep(selector, root));
        nodes.forEach((node) => addCandidate(node));
      }
      const fallbackNodes = Array.from(queryAllDeep('button, [role="button"], [role="combobox"]', root));
      for (const node of fallbackNodes) {
        const text = (node.innerText || node.textContent || '').toLowerCase();
        if (!text) continue;
        if (!/gpt|claude|gemini|grok|o\\d|pro|instant|haiku|sonnet|opus/.test(text)) continue;
        addCandidate(node);
      }
    };
    const promptNodes = [];
    for (const selector of promptSelectors) {
      promptNodes.push(...Array.from(queryAllDeep(selector)));
    }
    const prompt = promptNodes.find((node) => isVisible(node));
    if (prompt) {
      const container = prompt.closest('form') ?? prompt.closest('section') ?? prompt.parentElement;
      if (container) {
        collectFromRoot(container);
        let ancestor = container.parentElement;
        for (let i = 0; i < 4 && ancestor; i += 1) {
          collectFromRoot(ancestor);
          ancestor = ancestor.parentElement;
        }
      }
    }
    collectFromRoot(document);
    if (!candidates.length) return { found: false, reason: 'no-trigger' };
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score <= 0) {
      return { found: false, reason: 'low-score', count: candidates.length, sample: candidates.slice(0, 5).map((entry) => entry.label) };
    }
    const container = best.node.closest?.('.model-selection-icon-container, .model-selection-container');
    const button = best.node.closest?.('.model-selection-button');
    const clickable =
      container ??
      (!isDisabled(button) ? button : null) ??
      best.node.closest?.(
        '.model-selection-icon-container, .model-selection-container, .model-selection-button, [class*="model-selection"], button, [role="button"], [role="combobox"]'
      ) ??
      best.node;
    const target = toTarget(clickable);
    if (!target) return { found: false, reason: 'no-target' };
    return { found: true, label: best.label, target };
  })()`;
}

function buildModelSelectExpression(desiredModel: string): string {
  const menuSelectorsLiteral = JSON.stringify(GENSPARK_MODEL_MENU_SELECTORS);
  const optionSelectorsLiteral = JSON.stringify(GENSPARK_MODEL_OPTION_SELECTORS);
  const optionFallbackSelectorsLiteral = JSON.stringify(GENSPARK_MODEL_OPTION_FALLBACK_SELECTORS);
  const promptSelectorsLiteral = JSON.stringify(GENSPARK_PROMPT_SELECTORS);
  const desiredLiteral = JSON.stringify(desiredModel);
  return `(() => {
    ${buildClickDispatcher()}
    const menuSelectors = ${menuSelectorsLiteral};
    const optionSelectors = ${optionSelectorsLiteral};
    const optionFallbackSelectors = ${optionFallbackSelectorsLiteral};
    const promptSelectors = ${promptSelectorsLiteral};
    const desired = ${desiredLiteral};
    const normalize = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const desiredNormalized = normalize(desired);
    const desiredParts = desiredNormalized.split(' ').filter(Boolean);
    if (!desiredParts.length) return { selected: false, reason: 'empty' };
    const collectRoots = (root) => {
      const roots = [root];
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        const walkerRoot = current instanceof Document ? current.body : current;
        if (!walkerRoot) continue;
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }
      return roots;
    };
    const queryAllDeep = (selector, root = document) => {
      const results = [];
      const roots = collectRoots(root);
      for (const rootNode of roots) {
        if (rootNode.querySelectorAll) {
          results.push(...rootNode.querySelectorAll(selector));
        }
      }
      return results;
    };
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };
    const matches = (text) => {
      const normalized = normalize(text);
      return desiredParts.every((part) => normalized.includes(part));
    };
    const readLabelFromOption = (option) => {
      if (!option || !(option instanceof HTMLElement)) return '';
      const labelNode =
        option.querySelector?.('.text, .model-label, [class*="model-label"]') ?? option.querySelector?.('[data-testid*="label"]');
      let label = (labelNode?.innerText || labelNode?.textContent || '').trim();
      if (!label) {
        const img = option.querySelector?.('img[alt]');
        label = (img?.getAttribute?.('alt') || '').trim();
      }
      return label;
    };
    const roots = [];
    for (const selector of menuSelectors) {
      const nodes = Array.from(queryAllDeep(selector));
      for (const node of nodes) {
        if (isVisible(node)) roots.push(node);
      }
    }
    const useFallback = roots.length === 0;
    if (!roots.length) roots.push(document.body ?? document);

    const promptCandidates = [];
    for (const selector of promptSelectors) {
      promptCandidates.push(...Array.from(queryAllDeep(selector)));
    }
    const prompt = promptCandidates.find((node) => isVisible(node));
    if (prompt) {
      const container = prompt.closest('form') ?? prompt.closest('section') ?? prompt.parentElement;
      if (container) {
        const modelButtons = queryAllDeep('button, [role="button"], [role="combobox"]', container);
        for (const node of modelButtons) {
          if (!isVisible(node)) continue;
          const text = (node.innerText || node.textContent || '').trim();
          if (!text) continue;
          if (matches(text)) {
            return { selected: true, alreadySelected: true, label: text };
          }
        }
      }
    }
    const candidates = [];
    const addCandidate = (node) => {
      if (!node || !(node instanceof HTMLElement)) return;
      if (!isVisible(node)) return;
      const text =
        (node.innerText || node.textContent || '').trim() ||
        (node.getAttribute?.('aria-label') || '').trim() ||
        (node.getAttribute?.('title') || '').trim();
      if (!text || !matches(text)) return;
      const normalized = normalize(text);
      let score = desiredParts.reduce((sum, part) => sum + (normalized.includes(part) ? 2 : 0), 0);
      if (normalized === desiredNormalized) score += 3;
      score += Math.max(0, 1 - Math.abs(normalized.length - desiredNormalized.length) / 60);
      const ariaChecked = node.getAttribute?.('aria-checked') === 'true' || node.getAttribute?.('aria-selected') === 'true';
      const inputChecked = node.querySelector?.('input[type="radio"]:checked, input[type="checkbox"]:checked');
      const optionRoot =
        node.closest?.('.model-option') ??
        node.closest?.('[role="menuitemradio"], [role="menuitem"], [role="option"], button, [role="button"], li') ??
        node;
      const rootSelected = optionRoot instanceof HTMLElement && optionRoot.classList.contains('selected');
      candidates.push({
        node,
        score,
        label: text,
        alreadySelected: ariaChecked || Boolean(inputChecked) || rootSelected,
        optionRoot,
      });
    };
    const selectorsToUse = useFallback ? optionFallbackSelectors : optionSelectors;
    const optionRoots = [];
    for (const root of roots) {
      optionRoots.push(...queryAllDeep('.model-option', root));
    }
    for (const option of optionRoots) {
      if (!isVisible(option)) continue;
      const label = readLabelFromOption(option);
      if (!label || !matches(label)) continue;
      const optionSelected =
        option.classList.contains('selected') ||
        Boolean(option.querySelector?.('input[type="radio"]:checked, input[type="checkbox"]:checked'));
      if (optionSelected) return { selected: true, alreadySelected: true, label };
      dispatchClickSequence(option);
      return { selected: true, label };
    }
    for (const root of roots) {
      const nodes = queryAllDeep(selectorsToUse.join(','), root);
      nodes.forEach((node) => addCandidate(node));
    }
    if (!candidates.length) return { selected: false, reason: 'no-match' };
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.alreadySelected) return { selected: true, alreadySelected: true, label: best.label };
    const clickable =
      best.optionRoot ??
      best.node.closest?.('button, [role="menuitemradio"], [role="menuitem"], [role="option"], [role="button"], li, a') ??
      best.node;
    dispatchClickSequence(clickable);
    return { selected: true, label: best.label };
  })()`;
}

function buildModelOptionTargetExpression(desiredModel: string): string {
  const menuSelectorsLiteral = JSON.stringify(GENSPARK_MODEL_MENU_SELECTORS);
  const desiredLiteral = JSON.stringify(desiredModel);
  return `(() => {
    const menuSelectors = ${menuSelectorsLiteral};
    const desired = ${desiredLiteral};
    const normalize = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const desiredNormalized = normalize(desired);
    const desiredParts = desiredNormalized.split(' ').filter(Boolean);
    if (!desiredParts.length) return { found: false, reason: 'empty' };
    const collectRoots = (root) => {
      const roots = [root];
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        const walkerRoot = current instanceof Document ? current.body : current;
        if (!walkerRoot) continue;
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }
      return roots;
    };
    const queryAllDeep = (selector, root = document) => {
      const results = [];
      const roots = collectRoots(root);
      for (const rootNode of roots) {
        if (rootNode.querySelectorAll) {
          results.push(...rootNode.querySelectorAll(selector));
        }
      }
      return results;
    };
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };
    const matches = (text) => {
      const normalized = normalize(text);
      return desiredParts.every((part) => normalized.includes(part));
    };
    const readLabelFromOption = (option) => {
      if (!option || !(option instanceof HTMLElement)) return '';
      const labelNode =
        option.querySelector?.('.text, .model-label, [class*="model-label"]') ?? option.querySelector?.('[data-testid*="label"]');
      let label = (labelNode?.innerText || labelNode?.textContent || '').trim();
      if (!label) {
        const img = option.querySelector?.('img[alt]');
        label = (img?.getAttribute?.('alt') || '').trim();
      }
      return label;
    };
    const toTarget = (node) => {
      if (!node || !(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 1 || rect.height <= 1) return null;
      let x = rect.left + rect.width / 2;
      let y = rect.top + rect.height / 2;
      if (window.frameElement instanceof HTMLElement) {
        const frameRect = window.frameElement.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
      }
      return { x, y };
    };
    const roots = [];
    for (const selector of menuSelectors) {
      const nodes = Array.from(queryAllDeep(selector));
      for (const node of nodes) {
        if (isVisible(node)) roots.push(node);
      }
    }
    if (!roots.length) roots.push(document.body ?? document);

    const optionNodes = [];
    for (const root of roots) {
      optionNodes.push(...queryAllDeep('.model-option', root));
    }
    const samples = [];
    for (const option of optionNodes) {
      if (!isVisible(option)) continue;
      const label = readLabelFromOption(option);
      if (!label) continue;
      if (samples.length < 5) samples.push(label);
      if (!matches(label)) continue;
      const alreadySelected =
        option.classList.contains('selected') ||
        Boolean(option.querySelector?.('input[type="radio"]:checked, input[type="checkbox"]:checked'));
      const target = toTarget(option);
      return { found: true, label, alreadySelected, target };
    }
    return { found: false, reason: 'no-match', sample: samples };
  })()`;
}

function buildGensparkFileInputExpression(): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_FILE_INPUT_SELECTORS);
  const triggerSelectorsLiteral = JSON.stringify(GENSPARK_ATTACHMENT_TRIGGER_SELECTORS);
  const menuSelectorsLiteral = JSON.stringify(GENSPARK_ATTACHMENT_MENU_SELECTORS);
  return `(() => {
    ${buildClickDispatcher()}
    const selectors = ${selectorsLiteral};
    const triggerSelectors = ${triggerSelectorsLiteral};
    const menuSelectors = ${menuSelectorsLiteral};
    const keywords = /(upload|attach|attachment|file|paperclip|clip)/i;
    const localKeywords = /(browse\\s+local\\s+files|local\\s+files|from\\s+computer|from\\s+device|upload\\s+from\\s+computer)/i;
    const menuSelector = menuSelectors.join(',');
    const collectRoots = (root) => {
      const roots = [root];
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        const walkerRoot = current instanceof Document ? current.body : current;
        if (!walkerRoot) continue;
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }
      return roots;
    };
    const queryAllDeep = (selector, root = document) => {
      const results = [];
      const roots = collectRoots(root);
      for (const rootNode of roots) {
        if (rootNode.querySelectorAll) {
          results.push(...rootNode.querySelectorAll(selector));
        }
      }
      return results;
    };
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };
    const isDisabled = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      if (node.getAttribute?.('disabled') != null) return true;
      if (node.getAttribute?.('aria-disabled') === 'true') return true;
      return node.classList.contains('disabled');
    };
    const isMenuNode = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      if (menuSelector && node.matches?.(menuSelector)) return true;
      if (menuSelector && node.closest?.(menuSelector)) return true;
      return false;
    };
    const markInput = (input) => {
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return null;
      input.setAttribute('data-oracle-genspark-input', 'true');
      return {
        found: true,
        selector: 'input[data-oracle-genspark-input="true"]',
        multiple: Boolean(input.multiple),
      };
    };
    const findInput = () => {
      for (const selector of selectors) {
        const inputs = queryAllDeep(selector);
        for (const input of inputs) {
          if (input instanceof HTMLInputElement && input.type === 'file') {
            return input;
          }
        }
      }
      return null;
    };
    const existing = findInput();
    if (existing) {
      return markInput(existing);
    }

    const findInputNear = (node) => {
      if (!node || !(node instanceof HTMLElement)) return null;
      const direct = node.querySelector?.('input[type="file"]');
      if (direct instanceof HTMLInputElement) return direct;
      const container = node.closest?.('.upload-options-popover, .upload-from-multiple-source-container, .upload-attachments');
      if (container) {
        const nested = container.querySelector?.('input[type="file"]');
        if (nested instanceof HTMLInputElement) return nested;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibling = parent.querySelector?.('input[type="file"]');
        if (sibling instanceof HTMLInputElement) return sibling;
      }
      return null;
    };
    const findMenuItem = () => {
      const items = [];
      for (const selector of menuSelectors) {
        const nodes = queryAllDeep(selector);
        for (const node of nodes) {
          if (!isVisible(node) || isDisabled(node)) continue;
          const text = (node.innerText || node.textContent || '').trim();
          const aria = node.getAttribute?.('aria-label') || '';
          const title = node.getAttribute?.('title') || '';
          const testId = node.getAttribute?.('data-testid') || '';
          const className =
            typeof node.className === 'string'
              ? node.className
              : node.className && typeof node.className.baseVal === 'string'
                ? node.className.baseVal
                : '';
          const label = [text, aria, title, testId, className].filter(Boolean).join(' ').trim();
          if (!label) continue;
          const input = findInputNear(node);
          if (localKeywords.test(label)) {
            return { node, input };
          }
          items.push({ node, input });
        }
      }
      return items.length > 0 ? items[0] : null;
    };

    const menuItem = findMenuItem();
    if (menuItem?.input) {
      return markInput(menuItem.input);
    }
    if (menuItem?.node) {
      return { found: false, reason: 'menu-no-input' };
    }

    const candidates = [];
    for (const selector of triggerSelectors) {
      const nodes = queryAllDeep(selector);
      for (const node of nodes) {
        if (!isVisible(node) || isDisabled(node)) continue;
        if (isMenuNode(node)) continue;
        candidates.push(node);
      }
    }
    if (candidates.length === 0) {
      const buttons = queryAllDeep('button, [role="button"]');
      for (const node of buttons) {
        if (!isVisible(node) || isDisabled(node)) continue;
        if (isMenuNode(node)) continue;
        const text = (node.innerText || node.textContent || '').trim();
        const aria = node.getAttribute?.('aria-label') || '';
        const title = node.getAttribute?.('title') || '';
        const testId = node.getAttribute?.('data-testid') || '';
        const className =
          typeof node.className === 'string'
            ? node.className
            : node.className && typeof node.className.baseVal === 'string'
              ? node.className.baseVal
              : '';
        const label = [text, aria, title, testId, className].filter(Boolean).join(' ').trim();
        if (keywords.test(label)) {
          candidates.push(node);
        }
      }
    }
    if (candidates.length > 0) {
      dispatchClickSequence(candidates[0]);
      const after = findInput();
      if (after) return markInput(after);
      const afterMenu = findMenuItem();
      if (afterMenu?.input) return markInput(afterMenu.input);
      return { found: false, clicked: true };
    }
    return { found: false, reason: 'no-input' };
  })()`;
}

function buildGensparkAttachmentTriggerTargetExpression(): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_ATTACHMENT_TRIGGER_SELECTORS);
  return `(() => {
    const selectors = ${selectorsLiteral};
    const keywords = /(upload|attach|attachment|file|paperclip|clip)/i;
    const collectRoots = (root) => {
      const roots = [root];
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        const walkerRoot = current instanceof Document ? current.body : current;
        if (!walkerRoot) continue;
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }
      return roots;
    };
    const queryAllDeep = (selector, root = document) => {
      const results = [];
      const roots = collectRoots(root);
      for (const rootNode of roots) {
        if (rootNode.querySelectorAll) {
          results.push(...rootNode.querySelectorAll(selector));
        }
      }
      return results;
    };
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };
    const isDisabled = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      if (node.getAttribute?.('disabled') != null) return true;
      if (node.getAttribute?.('aria-disabled') === 'true') return true;
      return node.classList.contains('disabled');
    };
    const toTarget = (node) => {
      if (!node || !(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 1 || rect.height <= 1) return null;
      let x = rect.left + rect.width / 2;
      let y = rect.top + rect.height / 2;
      if (window.frameElement instanceof HTMLElement) {
        const frameRect = window.frameElement.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
      }
      return { x, y };
    };
    const candidates = [];
    for (const selector of selectors) {
      const nodes = queryAllDeep(selector);
      for (const node of nodes) {
        if (!isVisible(node) || isDisabled(node)) continue;
        const text = (node.innerText || node.textContent || '').trim();
        const aria = node.getAttribute?.('aria-label') || '';
        const title = node.getAttribute?.('title') || '';
        const testId = node.getAttribute?.('data-testid') || '';
        const className =
          typeof node.className === 'string'
            ? node.className
            : node.className && typeof node.className.baseVal === 'string'
              ? node.className.baseVal
              : '';
        const label = [text, aria, title, testId, className].filter(Boolean).join(' ').trim();
        if (!label) continue;
        if (!keywords.test(label)) continue;
        candidates.push({ node, label });
      }
    }
    if (candidates.length === 0) {
      const buttons = queryAllDeep('button, [role="button"]');
      for (const node of buttons) {
        if (!isVisible(node) || isDisabled(node)) continue;
        const text = (node.innerText || node.textContent || '').trim();
        const aria = node.getAttribute?.('aria-label') || '';
        const title = node.getAttribute?.('title') || '';
        const testId = node.getAttribute?.('data-testid') || '';
        const className =
          typeof node.className === 'string'
            ? node.className
            : node.className && typeof node.className.baseVal === 'string'
              ? node.className.baseVal
              : '';
        const label = [text, aria, title, testId, className].filter(Boolean).join(' ').trim();
        if (!label) continue;
        if (!keywords.test(label)) continue;
        candidates.push({ node, label });
      }
    }
    if (!candidates.length) return { found: false, reason: 'no-trigger' };
    const best = candidates[0];
    const target = toTarget(best.node);
    if (!target) return { found: false, reason: 'no-target' };
    return { found: true, label: best.label, target };
  })()`;
}

function buildGensparkAttachmentQueuedExpression(selector: string, expectedName: string): string {
  const selectorLiteral = JSON.stringify(selector);
  const expectedLiteral = JSON.stringify(expectedName.toLowerCase());
  return `(() => {
    const input = document.querySelector(${selectorLiteral});
    const names = [];
    if (input && input instanceof HTMLInputElement) {
      for (const file of Array.from(input.files || [])) {
        if (file?.name) names.push(file.name.toLowerCase());
      }
    }
    const expected = ${expectedLiteral};
    const queued = names.includes(expected);
    if (queued) return { queued, names };
    const textMatch = (() => {
      const haystack = Array.from(document.querySelectorAll('[data-testid*="upload"],[data-testid*="attachment"],[class*="upload"],[class*="attachment"],[aria-label*="remove"],[title*="remove"]'));
      for (const node of haystack) {
        const text = (node.textContent || '').toLowerCase();
        if (text && text.includes(expected)) return true;
      }
      return false;
    })();
    return { queued: queued || textMatch, names };
  })()`;
}

function buildPromptFocusExpression(): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_PROMPT_SELECTORS);
  return `(() => {
    ${buildClickDispatcher()}
    const selectors = ${selectorsLiteral};
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 80 && rect.height > 24;
    };
    const candidates = [];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const disabled = node.getAttribute?.('disabled') != null || node.getAttribute?.('aria-disabled') === 'true';
        if (disabled) continue;
        if (!isVisible(node)) continue;
        const rect = node.getBoundingClientRect();
        candidates.push({ node, area: rect.width * rect.height });
      }
    }
    if (!candidates.length) return { focused: false };
    candidates.sort((a, b) => b.area - a.area);
    const target = candidates[0].node;
    dispatchClickSequence(target);
    if (typeof target.focus === 'function') {
      target.focus();
    }
    const selection = target.ownerDocument?.getSelection?.();
    if (selection && target instanceof HTMLElement && target.isContentEditable) {
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { focused: true };
  })()`;
}

function buildSendButtonExpression(): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_SEND_SELECTORS);
  return `(() => {
    ${buildClickDispatcher()}
    const selectors = ${selectorsLiteral};
    const isVisible = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };
    const canClick = (node) => {
      if (!node || !(node instanceof HTMLElement)) return false;
      const disabled = node.getAttribute?.('disabled') != null || node.getAttribute?.('aria-disabled') === 'true';
      return !disabled && isVisible(node);
    };
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (canClick(node)) {
        dispatchClickSequence(node);
        return { clicked: true };
      }
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const node of buttons) {
      const label = (node.textContent ?? '').toLowerCase();
      if (!label) continue;
      if (!/send|submit|ask|go/.test(label)) continue;
      if (canClick(node)) {
        dispatchClickSequence(node);
        return { clicked: true };
      }
    }
    return { clicked: false };
  })()`;
}

function buildLatestAssistantExpression(promptText: string): string {
  const selectorsLiteral = JSON.stringify(GENSPARK_RESPONSE_SELECTORS);
  const promptLiteral = JSON.stringify(promptText ?? '');
  return `(() => {
    const selectors = ${selectorsLiteral};
    const promptRaw = ${promptLiteral};
    const normalize = (value) =>
      (value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const promptNormalized = normalize(promptRaw);
    const shouldSkip = (text) => {
      if (!promptNormalized) return false;
      const normalized = normalize(text);
      if (normalized === promptNormalized) return true;
      if (promptNormalized.length > 32) {
        const prefix = promptNormalized.slice(0, Math.min(160, promptNormalized.length));
        if (normalized.startsWith(prefix)) return true;
      }
      return false;
    };
    const root = document.querySelector('main') ?? document.body;
    if (!root) return { text: '', html: '' };
    const nodes = Array.from(root.querySelectorAll(selectors.join(',')));
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (!node || !(node instanceof HTMLElement)) continue;
      const text = (node.innerText || '').trim();
      if (!text) continue;
      if (shouldSkip(text)) continue;
      return { text, html: node.innerHTML ?? '' };
    }
    return { text: '', html: '' };
  })()`;
}

async function navigateToUrl(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
): Promise<void> {
  const targetUrl = url || defaultBrowserUrl('genspark');
  logger(`Navigating to ${targetUrl}`);
  await Page.navigate({ url: targetUrl });
  await waitForDocumentReady(Runtime, 45_000);
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Page did not reach ready state in time.');
}

async function captureRuntimeSnapshot(
  Runtime: ChromeClient['Runtime'],
  onSnapshot: (url?: string, targetId?: string) => Promise<void>,
): Promise<{ url?: string }> {
  let url: string | undefined;
  try {
    const { result } = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    if (typeof result?.value === 'string') {
      url = result.value;
    }
  } catch {
    return {};
  }
  await onSnapshot(url, undefined);
  return { url };
}

async function resolveGensparkExecutionContexts(
  Page: ChromeClient['Page'],
  log: (message: string) => void,
): Promise<number[]> {
  try {
    const frameTree = await Page.getFrameTree();
    const frameIds = collectFrameIds(frameTree.frameTree);
    const contexts: number[] = [];
    for (const frameId of frameIds) {
      try {
        const { executionContextId } = await Page.createIsolatedWorld({
          frameId,
          worldName: '__oracle_genspark',
          grantUniveralAccess: true,
        });
        if (executionContextId) {
          contexts.push(executionContextId);
        }
      } catch {
        // ignore frame failures (cross-origin or detached)
      }
    }
    if (contexts.length > 0) {
      return contexts;
    }
  } catch {
    // ignore and fall back
  }
  log('Unable to enumerate frame contexts; falling back to main document evaluation.');
  return [];
}

async function evaluateInContexts(
  Runtime: ChromeClient['Runtime'],
  contexts: number[],
  expression: string,
): Promise<unknown[]> {
  if (!contexts.length) {
    const single = await Runtime.evaluate({ expression, returnByValue: true });
    return single?.result?.value ? [single.result.value] : [];
  }
  const results: unknown[] = [];
  for (const contextId of contexts) {
    try {
      const evalResult = await Runtime.evaluate({
        expression,
        returnByValue: true,
        contextId,
      });
      if (evalResult?.result?.value !== undefined) {
        results.push(evalResult.result.value);
      }
    } catch {
      // ignore evaluation failures in a given context
    }
  }
  return results;
}

async function evaluateInContextsWithIds(
  Runtime: ChromeClient['Runtime'],
  contexts: number[],
  expression: string,
): Promise<Array<{ contextId?: number; value: unknown }>> {
  if (!contexts.length) {
    const single = await Runtime.evaluate({ expression, returnByValue: true });
    if (single?.result?.value === undefined) return [];
    return [{ value: single.result.value }];
  }
  const results: Array<{ contextId?: number; value: unknown }> = [];
  for (const contextId of contexts) {
    try {
      const evalResult = await Runtime.evaluate({
        expression,
        returnByValue: true,
        contextId,
      });
      if (evalResult?.result?.value !== undefined) {
        results.push({ contextId, value: evalResult.result.value });
      }
    } catch {
      // ignore evaluation failures in a given context
    }
  }
  return results;
}

function collectFrameIds(frameTree: Protocol.Page.FrameTree): string[] {
  const ids = [frameTree.frame.id];
  for (const child of frameTree.childFrames ?? []) {
    ids.push(...collectFrameIds(child));
  }
  return ids;
}

async function maybeReuseRunningChrome(userDataDir: string, logger: BrowserLogger): Promise<LaunchedChrome | null> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) return null;

  const probe = await verifyDevToolsReachable({ port });
  if (!probe.ok) {
    logger(`DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`);
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'if_oracle_pid_dead' });
    return null;
  }

  const pid = await readChromePid(userDataDir);
  logger(`Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ''})`);
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

async function resolveUserDataBaseDir(): Promise<string> {
  const tmp = path.join(os.tmpdir(), 'oracle-browser');
  await mkdir(tmp, { recursive: true });
  return tmp;
}

async function pickAvailableDebugPort(preferredPort: number, logger: BrowserLogger): Promise<number> {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to acquire ephemeral port')));
      }
    });
  });
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (host === '127.0.0.1' || host === 'localhost') return null;
  return `DevTools port ${port} is not reachable from ${host}. Check firewall rules or open port ${port}.`;
}
