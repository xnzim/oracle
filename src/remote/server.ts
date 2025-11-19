import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import type { BrowserAttachment, BrowserLogger } from '../browser/types.js';
import { runBrowserMode } from '../browserMode.js';
import type { BrowserRunResult } from '../browserMode.js';
import type { RemoteRunPayload, RemoteRunEvent } from './types.js';

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  logger?: (message: string) => void;
}

interface RemoteServerDeps {
  runBrowser?: typeof runBrowserMode;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const server = http.createServer();
  const logger = options.logger ?? console.log;
  const authToken = options.token ?? randomBytes(16).toString('hex');
  // Single-flight guard: remote Chrome can only host one run at a time, so we serialize requests.
  let busy = false;

  server.on('request', async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/runs') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${authToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    // biome-ignore lint/nursery/noUnnecessaryConditions: busy guard protects single-run host
    if (busy) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'busy' }));
      return;
    }
    busy = true;

    let payload: RemoteRunPayload | null = null;
    try {
      const body = await readRequestBody(req);
      payload = JSON.parse(body) as RemoteRunPayload;
    } catch (_error) {
      busy = false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

    const runId = randomUUID();
    // Each run gets an isolated temp dir so attachments/logs don't collide.
    const runDir = await mkdtemp(path.join(os.tmpdir(), `oracle-serve-${runId}-`));
    const attachmentDir = path.join(runDir, 'attachments');
    await mkdir(attachmentDir, { recursive: true });

    const sendEvent = (event: RemoteRunEvent) => {
      res.write(`${JSON.stringify(event)}\n`);
    };

    const attachments: BrowserAttachment[] = [];
    try {
      const attachmentsPayload = Array.isArray(payload.attachments) ? payload.attachments : [];
      for (const [index, attachment] of attachmentsPayload.entries()) {
        const safeName = sanitizeName(attachment.fileName ?? `attachment-${index + 1}`);
        const filePath = path.join(attachmentDir, safeName);
        await writeFile(filePath, Buffer.from(attachment.contentBase64, 'base64'));
        attachments.push({
          path: filePath,
          displayPath: attachment.displayPath,
          sizeBytes: attachment.sizeBytes,
        });
      }

      // Reuse the existing browser logger surface so clients see the same log stream.
      const automationLogger: BrowserLogger = ((message?: string) => {
        if (typeof message === 'string') {
          sendEvent({ type: 'log', message });
        }
      }) as BrowserLogger;
      automationLogger.verbose = Boolean(payload.options.verbose);

      const result = await runBrowser({
        prompt: payload.prompt,
        attachments,
        config: payload.browserConfig,
        log: automationLogger,
        heartbeatIntervalMs: payload.options.heartbeatIntervalMs,
        verbose: payload.options.verbose,
      });

      sendEvent({ type: 'result', result: sanitizeResult(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendEvent({ type: 'error', message });
    } finally {
      busy = false;
      res.end();
      try {
        await rm(runDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine server address.');
  }
  logger(`Remote Oracle listening at ${address.address}:${address.port}`);

  return {
    port: address.port,
    token: authToken,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function serveRemote(options: RemoteServerOptions = {}): Promise<void> {
  const server = await createRemoteServer(options);
  console.log(`Access token: ${server.token}`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('Shutting down remote service...');
      server
        .close()
        .catch((error) => console.error('Failed to close remote server:', error))
        .finally(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sanitizeResult(result: BrowserRunResult): BrowserRunResult {
  return {
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerChars,
    chromePid: undefined,
    chromePort: undefined,
    userDataDir: undefined,
  };
}
