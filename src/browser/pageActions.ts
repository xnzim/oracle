import path from 'node:path';
import type { ChromeClient, BrowserLogger, BrowserAttachment } from './types.js';
import {
  ANSWER_SELECTORS,
  COPY_BUTTON_SELECTOR,
  INPUT_SELECTORS,
  MODEL_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  FILE_INPUT_SELECTOR,
  GENERIC_FILE_INPUT_SELECTOR,
} from './constants.js';
import { delay } from './utils.js';

export async function navigateToChatGPT(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export async function ensureNotBlocked(Runtime: ChromeClient['Runtime'], headless: boolean, logger: BrowserLogger) {
  if (await isCloudflareInterstitial(Runtime)) {
    const message = headless
      ? 'Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge.'
      : 'Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.';
    logger('Cloudflare anti-bot page detected');
    throw new Error(message);
  }
}

async function isCloudflareInterstitial(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  const title = typeof titleResult.value === 'string' ? titleResult.value : '';
  if (title.toLowerCase().includes('just a moment')) {
    return true;
  }

  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector('script[src*="/challenge-platform/"]'))`,
    returnByValue: true,
  });
  return Boolean(result.value);
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Page did not reach ready state in time');
}

export async function ensurePromptReady(Runtime: ChromeClient['Runtime'], timeoutMs: number, logger: BrowserLogger) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    await logDomFailure(Runtime, logger, 'prompt-textarea');
    throw new Error('Prompt textarea did not appear before timeout');
  }
  logger('Prompt textarea ready');
}

async function waitForPrompt(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    });
    if (result?.value) {
      return true;
    }
    await delay(200);
  }
  return false;
}

export async function ensureModelSelection(
  Runtime: ChromeClient['Runtime'],
  desiredModel: string,
  logger: BrowserLogger,
) {
  const outcome = await Runtime.evaluate({
    expression: buildModelSelectionExpression(desiredModel),
    awaitPromise: true,
    returnByValue: true,
  });

  const result = outcome.result?.value as
    | { status: 'already-selected'; label?: string | null }
    | { status: 'switched'; label?: string | null }
    | { status: 'option-not-found' }
    | { status: 'button-missing' }
    | undefined;

  switch (result?.status) {
    case 'already-selected':
    case 'switched': {
      const label = result.label ?? desiredModel;
      logger(`Model picker: ${label}`);
      return;
    }
    case 'option-not-found': {
      await logDomFailure(Runtime, logger, 'model-switcher-option');
      throw new Error(`Unable to find model option matching "${desiredModel}" in the model switcher.`);
    }
    default: {
      await logDomFailure(Runtime, logger, 'model-switcher-button');
      throw new Error('Unable to locate the ChatGPT model selector button.');
    }
  }
}

function buildModelSelectionExpression(targetModel: string): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  return `(() => {
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const CLICK_INTERVAL_MS = 50;
    const MAX_WAIT_MS = 12000;
    const normalizeText = (value) => {
      if (!value) {
        return '';
      }
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    };

    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      return { status: 'button-missing' };
    }

    let lastPointerClick = 0;
    const pointerClick = () => {
      const down = new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const up = new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const click = new MouseEvent('click', { bubbles: true });
      button.dispatchEvent(down);
      button.dispatchEvent(up);
      button.dispatchEvent(click);
      lastPointerClick = performance.now();
    };

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
        return true;
      }
      return false;
    };

    const findOption = () => {
      const menus = Array.from(document.querySelectorAll('[role="menu"], [data-radix-collection-root]'));
      for (const menu of menus) {
        const buttons = Array.from(
          menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]'),
        );
        for (const option of buttons) {
          const testid = (option.getAttribute('data-testid') ?? '').toLowerCase();
          const text = option.textContent ?? '';
          const normalizedText = normalizeText(text);
          const matchesTestId = testid && TEST_IDS.some((id) => testid.includes(id));
          const matchesText = LABEL_TOKENS.some((token) => {
            const normalizedToken = normalizeText(token);
            if (!normalizedToken) {
              return false;
            }
            return normalizedText.includes(normalizedToken);
          });
          if (matchesTestId || matchesText) {
            return option;
          }
        }
      }
      return null;
    };

    pointerClick();
    return new Promise((resolve) => {
      const start = performance.now();
      const ensureMenuOpen = () => {
        const menuOpen = document.querySelector('[role="menu"], [data-radix-collection-root]');
        if (!menuOpen && performance.now() - lastPointerClick > 300) {
          pointerClick();
        }
      };
      const attempt = () => {
        ensureMenuOpen();
        const option = findOption();
        if (option) {
          if (optionIsSelected(option)) {
            resolve({ status: 'already-selected', label: getOptionLabel(option) });
            return;
          }
          option.click();
          resolve({ status: 'switched', label: getOptionLabel(option) });
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({ status: 'option-not-found' });
          return;
        }
        if (performance.now() - lastPointerClick > 500) {
          pointerClick();
        }
        setTimeout(attempt, CLICK_INTERVAL_MS);
      };
      attempt();
    });
  })()`;
}

function buildModelMatchersLiteral(targetModel: string): { labelTokens: string[]; testIdTokens: string[] } {
  const base = targetModel.trim().toLowerCase();
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, ' '), labelTokens);
  const collapsed = base.replace(/\s+/g, '');
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, '');
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);
  base
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      push(token, labelTokens);
    });

  const hyphenated = base.replace(/\s+/g, '-');
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, '-'));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
  };
}

export async function submitPrompt(
  deps: { runtime: ChromeClient['Runtime']; input: ChromeClient['Input'] },
  prompt: string,
  logger: BrowserLogger,
) {
  const { runtime, input } = deps;
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const dispatchPointer = (target) => {
        if (!(target instanceof HTMLElement)) {
          return;
        }
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        dispatchPointer(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (!node) continue;
        if (focusNode(node)) {
          return { focused: true };
        }
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, 'focus-textarea');
    throw new Error('Failed to focus prompt textarea');
  }

  await input.insertText({ text: prompt });

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
      };
    })()`,
    returnByValue: true,
  });

  const editorText = verification.result?.value?.editorText?.trim?.() ?? '';
  const fallbackValue = verification.result?.value?.fallbackValue?.trim?.() ?? '';
  if (!editorText && !fallbackValue) {
      await runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector(${primarySelectorLiteral});
        if (editor) {
          editor.textContent = ${encodedPrompt};
        }
      })()`,
    });
  }

  const clicked = await attemptSendButton(runtime);
  if (!clicked) {
    await input.dispatchKeyEvent({
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await input.dispatchKeyEvent({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    logger('Submitted prompt via Enter key');
  } else {
    logger('Clicked send button');
  }

  await verifyPromptCommitted(runtime, prompt, 30_000, logger);
}

export async function uploadAttachmentFile(
  deps: { runtime: ChromeClient['Runtime']; dom?: ChromeClient['DOM'] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
) {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error('DOM domain unavailable while uploading attachments.');
  }
  const documentNode = await dom.getDocument();
  const selectors = [FILE_INPUT_SELECTOR, GENERIC_FILE_INPUT_SELECTOR];
  let targetNodeId: number | undefined;
  for (const selector of selectors) {
    const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
    if (result.nodeId) {
      targetNodeId = result.nodeId;
      break;
    }
  }
  if (!targetNodeId) {
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }
  await dom.setFileInputFiles({ nodeId: targetNodeId, files: [attachment.path] });
  const expectedName = path.basename(attachment.path);
  const ready = await waitForAttachmentSelection(runtime, expectedName, 10_000);
  if (!ready) {
    throw new Error('Attachment did not register with the ChatGPT composer in time.');
  }
  logger(`Attachment queued: ${attachment.displayPath}`);
}

export async function waitForAttachmentCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const button = document.querySelector('${SEND_BUTTON_SELECTOR}');
    if (!button) {
      return { state: 'missing', uploading: false };
    }
    const disabled = button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';
    const uploadingSelectors = [
      '[data-testid*="upload"]',
      '[data-testid*="attachment"]',
      '[data-state="loading"]',
      '[aria-live="polite"]'
    ];
    const uploading = uploadingSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((node) => {
        const text = node.textContent?.toLowerCase?.() ?? '';
        return text.includes('upload') || text.includes('processing');
      });
    });
    return { state: disabled ? 'disabled' : 'ready', uploading };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as { state?: string; uploading?: boolean } | undefined;
    if (value && value.state === 'ready' && !value.uploading) {
      return;
    }
    await delay(250);
  }
  logger?.('Attachment upload timed out while waiting for ChatGPT composer to become ready.');
  throw new Error('Attachments did not finish uploading before timeout.');
}

async function verifyPromptCommitted(
  Runtime: ChromeClient['Runtime'],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
) {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const script = `(() => {
    const editor = document.querySelector(${primarySelectorLiteral});
    const fallback = document.querySelector(${fallbackSelectorLiteral});
    const normalize = (value) => value?.toLowerCase?.().replace(/\\s+/g, ' ').trim() ?? '';
    const normalizedPrompt = normalize(${encodedPrompt});
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const userMatched = articles.some((node) => normalize(node?.innerText).includes(normalizedPrompt));
    return {
      userMatched,
      fallbackValue: fallback?.value ?? '',
      editorValue: editor?.innerText ?? '',
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as { userMatched: boolean };
    if (info?.userMatched) {
      return;
    }
    await delay(100);
  }
  if (logger) {
    await logDomFailure(Runtime, logger, 'prompt-commit');
  }
  throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}

async function waitForAttachmentSelection(
  Runtime: ChromeClient['Runtime'],
  expectedName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const selector = ${JSON.stringify(GENERIC_FILE_INPUT_SELECTOR)};
    const input = document.querySelector(selector);
    if (!input || !input.files) {
      return { matched: false, names: [] };
    }
    const names = Array.from(input.files).map((file) => file?.name ?? '');
    return { matched: names.some((name) => name === ${JSON.stringify(expectedName)}), names };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const matched = Boolean(result?.value?.matched);
    if (matched) {
      return true;
    }
    await delay(150);
  }
  return false;
}

async function attemptSendButton(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const script = `(() => {
    const button = document.querySelector('${SEND_BUTTON_SELECTOR}');
    if (!button) {
      return 'missing';
    }
    const ariaDisabled = button.getAttribute('aria-disabled');
    const disabled = button.hasAttribute('disabled') || ariaDisabled === 'true';
    if (disabled || window.getComputedStyle(button).display === 'none') {
      return 'disabled';
    }
    button.click();
    return 'clicked';
  })()`;

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === 'clicked') {
      return true;
    }
    if (result.value === 'missing') {
      break;
    }
    await delay(100);
  }
  return false;
}

const ASSISTANT_POLL_TIMEOUT_ERROR = 'assistant-response-watchdog-timeout';

export async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } }> {
  logger('Waiting for ChatGPT response');
  const expression = buildResponseObserverExpression(timeoutMs);
  const evaluationPromise = Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: 'evaluation' as const, value }),
    (error) => {
      throw { source: 'evaluation' as const, error };
    },
  );
  const pollerPromise = pollAssistantCompletion(Runtime, timeoutMs).then(
    (value) => {
      if (!value) {
        throw { source: 'poll' as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      return { kind: 'poll' as const, value };
    },
    (error) => {
      throw { source: 'poll' as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === 'poll') {
      logger('Captured assistant response via snapshot watchdog');
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    evaluation = winner.value;
  } catch (wrappedError) {
    if (wrappedError && typeof wrappedError === 'object' && 'source' in wrappedError && 'error' in wrappedError) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (source === 'poll' && error instanceof Error && error.message === ASSISTANT_POLL_TIMEOUT_ERROR) {
        evaluation = await evaluationPromise;
      } else if (source === 'poll') {
        throw error;
      } else if (source === 'evaluation') {
        const recovered = await recoverAssistantResponse(Runtime, timeoutMs, logger);
        if (recovered) {
          return recovered;
        }
        throw error ?? new Error('Failed to capture assistant response');
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    throw new Error('Failed to capture assistant response');
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, timeoutMs, logger);
  if (parsed) {
    return parsed;
  }
  throw new Error('Unable to capture assistant response');
}

async function recoverAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const snapshot = await waitForAssistantSnapshot(Runtime, Math.min(timeoutMs, 10_000));
  const recovered = normalizeAssistantSnapshot(snapshot);
  if (recovered) {
    logger('Recovered assistant response via polling fallback');
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  Runtime: ChromeClient['Runtime'],
  evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>>,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const { result } = evaluation;
  if (result.type === 'object' && result.value && typeof result.value === 'object' && 'text' in result.value) {
    const html = typeof (result.value as { html?: unknown }).html === 'string' ? ((result.value as { html?: string }).html ?? undefined) : undefined;
    const turnId = typeof (result.value as { turnId?: unknown }).turnId === 'string' ? ((result.value as { turnId?: string }).turnId ?? undefined) : undefined;
    const messageId = typeof (result.value as { messageId?: unknown }).messageId === 'string' ? ((result.value as { messageId?: string }).messageId ?? undefined) : undefined;
    return {
      text: String((result.value as { text: unknown }).text ?? ''),
      html,
      meta: { turnId, messageId },
    };
  }
  const fallbackText = typeof result.value === 'string' ? (result.value as string) : '';
  if (!fallbackText) {
    const recovered = await recoverAssistantResponse(Runtime, Math.min(timeoutMs, 10_000), logger);
    if (recovered) {
      return recovered;
    }
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function terminateRuntimeExecution(Runtime: ChromeClient['Runtime']): Promise<void> {
  if (typeof Runtime.terminateExecution !== 'function') {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  let previousLength = 0;
  let stableCycles = 0;
  const requiredStableCycles = 6;
  while (Date.now() < watchdogDeadline) {
    const snapshot = await readAssistantSnapshot(Runtime);
    const normalized = normalizeAssistantSnapshot(snapshot);
    if (normalized) {
      const currentLength = normalized.text.length;
      if (currentLength > previousLength) {
        previousLength = currentLength;
        stableCycles = 0;
      } else {
        stableCycles += 1;
      }
      const stopVisible = await isStopButtonVisible(Runtime);
      if (!stopVisible && stableCycles >= requiredStableCycles) {
        return normalized;
      }
    } else {
      previousLength = 0;
      stableCycles = 0;
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `Boolean(document.querySelector('${STOP_BUTTON_SELECTOR}'))`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

function normalizeAssistantSnapshot(
  snapshot: AssistantSnapshot | null,
): { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null {
  const text = snapshot?.text?.trim();
  if (!text) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

async function logConversationSnapshot(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  const debugExpression = buildConversationDebugExpression();
  const { result } = await Runtime.evaluate({ expression: debugExpression, returnByValue: true });
  if (Array.isArray(result.value)) {
    const recent = (result.value as Array<Record<string, unknown>>).slice(-3);
    logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
  }
}

async function logDomFailure(Runtime: ChromeClient['Runtime'], logger: BrowserLogger, context: string) {
  if (!logger?.verbose) {
    return;
  }
  try {
    const entry = `Browser automation failure (${context}); capturing DOM snapshot for debugging...`;
    logger(entry);
    if (logger.sessionLog && logger.sessionLog !== logger) {
      logger.sessionLog(entry);
    }
    await logConversationSnapshot(Runtime, logger);
  } catch {
    // ignore snapshot failures
  }
}

function buildAssistantExtractor(functionName: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          button.click();
        }
      }
    };

    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred =
        messageRoot.querySelector('.markdown') ||
        messageRoot.querySelector('[data-message-content]') ||
        messageRoot;
      const text = preferred?.innerText ?? '';
      const html = preferred?.innerHTML ?? '';
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      if (text.trim()) {
        return { text, html, messageId, turnId };
      }
    }
    return null;
  };`;
}

function buildResponseObserverExpression(timeoutMs: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  return `(() => {
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const settleDelayMs = 800;
    ${buildAssistantExtractor('extractFromTurns')}

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let stopInterval = null;
        const observer = new MutationObserver(() => {
          const extracted = extractFromTurns();
          if (extracted) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            resolve(extracted);
          } else if (Date.now() > deadline) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            reject(new Error('Response timeout'));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        stopInterval = setInterval(() => {
          const stop = document.querySelector('${STOP_BUTTON_SELECTOR}');
          if (!stop) {
            return;
          }
          const ariaLabel = stop.getAttribute('aria-label') || '';
          if (ariaLabel.toLowerCase().includes('stop')) {
            return;
          }
          stop.click();
        }, 500);
        setTimeout(() => {
          if (stopInterval) {
            clearInterval(stopInterval);
          }
          observer.disconnect();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    const waitForSettle = async (snapshot) => {
      const settleWindowMs = 5000;
      const settleIntervalMs = 400;
      const deadline = Date.now() + settleWindowMs;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshed = extractFromTurns();
        if (refreshed && (refreshed.text?.length ?? 0) >= lastLength) {
          latest = refreshed;
          lastLength = refreshed.text?.length ?? lastLength;
        }
        const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        if (!stopVisible) {
          break;
        }
      }
      return latest ?? snapshot;
    };

    const extracted = extractFromTurns();
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantSnapshotExpression(): string {
  return `(() => {
    ${buildAssistantExtractor('extractAssistantTurn')}
    return extractAssistantTurn();
  })()`;
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
}

export async function readAssistantSnapshot(Runtime: ChromeClient['Runtime']): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({ expression: buildAssistantSnapshotExpression(), returnByValue: true });
  const value = result?.value;
  if (value && typeof value === 'object') {
    return value as AssistantSnapshot;
  }
  return null;
}

async function waitForAssistantSnapshot(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<AssistantSnapshot | null> {
  return waitForCondition(() => readAssistantSnapshot(Runtime), timeoutMs);
}

async function waitForCondition<T>(getter: () => Promise<T | null>, timeoutMs: number, pollIntervalMs = 400): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildConversationDebugExpression(): string {
  return `(() => {
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    return turns.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText?.slice(0, 200),
      testid: node.getAttribute('data-testid'),
    }));
  })()`;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient['Runtime'],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === 'string') {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== 'missing-button') {
    logger(`Copy button fallback status: ${status}`);
  }
  return null;
}

export function __buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function __buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 5000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      return all.at(-1) ?? null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '' };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (types.includes('text/plain') && typeof item.getType === 'function') {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              state.text = text ?? '';
              break;
            }
          }
        } catch {
          state.text = '';
        }
        return Promise.resolve();
      };
      return {
        state,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const button = locateButton();
      if (!button) {
        resolve({ success: false, status: 'missing-button' });
        return;
      }
      const interception = interceptClipboard();
      let settled = false;
      let pollId = null;
      let timeoutId = null;
      const finish = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        if (pollId) {
          clearInterval(pollId);
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        button.removeEventListener('copy', handleCopy, true);
        interception.restore?.();
        resolve(payload);
      };

      const readIntercepted = () => {
        const markdown = interception.state.text ?? '';
        return { success: Boolean(markdown.trim()), markdown };
      };

      const handleCopy = () => {
        finish(readIntercepted());
      };

      button.addEventListener('copy', handleCopy, true);
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      button.click();
      pollId = setInterval(() => {
        const payload = readIntercepted();
        if (payload.success) {
          finish(payload);
        }
      }, 100);
      timeoutId = setTimeout(() => {
        button.removeEventListener('copy', handleCopy, true);
        finish({ success: false, status: 'timeout' });
      }, TIMEOUT_MS);
    });
  })()`;
}
