/**
 * Single-port local server for the Ridgeline lab.
 *
 * Serves the JSON API and the web client on 127.0.0.1:4174. In dev (`yarn dev`) Vite runs
 * as middleware on the same port; in prod (`--prod`) the built `dist/` is served
 * statically. Requests are only accepted with a loopback Host header and, for POSTs, a
 * same-origin Origin header. Logs carry method, path, status, and timing only, never
 * bodies or tokens.
 */

import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  ACTION_SPECS,
  ActionStaging,
  draftedMessage,
  resolvedMessage,
  stagedMessage,
  StagingFullError,
} from './actions.ts';
import {generate, GenerationError, type GenerateOptions} from './agent.ts';
import {validateActionEvent} from './protocol.ts';
import {findScenario, scenarios} from './scenarios.ts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4174;
const BODY_LIMIT_BYTES = 64 * 1024;
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type))
    throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT_BYTES) throw new HttpError(413, 'Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'Request body must be a JSON object.');
  return parsed;
}

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
  return match?.[1]?.toLowerCase();
}

/** Rejects DNS-rebinding hosts and cross-origin writes. */
function checkRequestOrigin(req: IncomingMessage): void {
  const hostname = hostnameOf(req.headers.host);
  if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname))
    throw new HttpError(421, 'This server only answers on a loopback host.');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`)
      throw new HttpError(403, 'Cross-origin requests are not allowed.');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 200)
    throw new HttpError(400, `${key} must be a non-empty string.`);
  return value;
}

function summarize(errors: string[], max = 5): string {
  const shown = errors.slice(0, max).join(' ');
  return errors.length > max ? `${shown} (+${errors.length - max} more)` : shown;
}

export interface ApiOptions {
  staging?: ActionStaging;
  generateOptions?: GenerateOptions;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** Builds the `/api/*` handler. Resolves to false for requests outside `/api/`. */
export function createApiHandler(options: ApiOptions = {}): ApiHandler {
  const staging = options.staging ?? new ActionStaging();

  const routes: Record<
    string,
    {method: 'GET' | 'POST'; run: (req: IncomingMessage) => Promise<[number, unknown]>}
  > = {
    '/api/scenarios': {
      method: 'GET',
      run: async () => [
        200,
        {
          scenarios: scenarios.map(({id, title, product, description, prompt, mobile}) => ({
            id,
            title,
            product,
            description,
            prompt,
            ...(mobile === undefined ? {} : {mobile}),
          })),
        },
      ],
    },
    '/api/generate': {
      method: 'POST',
      run: async req => {
        const body = await readJsonBody(req);
        const scenarioId = requireString(body, 'scenarioId');
        const mode = body.mode;
        if (mode !== 'stub' && mode !== 'live')
          throw new HttpError(400, 'mode must be "stub" or "live".');
        const scenario = findScenario(scenarioId);
        if (!scenario) throw new HttpError(404, `Unknown scenario "${scenarioId}".`);
        return [200, await generate(scenario, mode, options.generateOptions)];
      },
    },
    '/api/action': {
      method: 'POST',
      run: async req => {
        const body = await readJsonBody(req);
        const scenarioId = requireString(body, 'scenarioId');
        if (!findScenario(scenarioId))
          throw new HttpError(404, `Unknown scenario "${scenarioId}".`);
        const checked = validateActionEvent(body.event);
        if (!checked.ok)
          throw new HttpError(400, `Invalid action event. ${summarize(checked.errors)}`);
        const {action} = checked.message;
        if (action.surfaceId !== scenarioId)
          throw new HttpError(400, 'The action did not come from this scenario’s surface.');
        const spec = ACTION_SPECS.get(action.name);
        if (!spec || spec.scenarioId !== scenarioId)
          throw new HttpError(400, `Action "${action.name}" is not allowed here.`);
        const parsed = spec.parse(action.context);
        if (!parsed.ok) throw new HttpError(422, summarize(parsed.errors));
        if (spec.kind === 'draft') {
          return [200, {status: 'drafted', message: draftedMessage(spec, parsed.arguments)}];
        }
        try {
          const staged = staging.stage(spec.name, scenarioId, parsed.arguments);
          return [
            200,
            {
              status: 'confirmation_required',
              action: staged,
              message: stagedMessage(spec, parsed.arguments),
            },
          ];
        } catch (error) {
          if (error instanceof StagingFullError) throw new HttpError(429, error.message);
          throw error;
        }
      },
    },
  };

  for (const status of ['confirmed', 'cancelled'] as const) {
    routes[status === 'confirmed' ? '/api/confirm' : '/api/cancel'] = {
      method: 'POST',
      run: async req => {
        const body = await readJsonBody(req);
        const result = staging.resolve(body.id, body.token, status);
        if (!result.ok) {
          const code = {not_found: 404, expired: 410, forbidden: 403}[result.code];
          throw new HttpError(code, result.error);
        }
        return [
          200,
          {
            status: result.status,
            message: resolvedMessage(result.name, result.status, result.arguments),
          },
        ];
      },
    };
  }

  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;
    try {
      checkRequestOrigin(req);
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
      if (!route) throw new HttpError(404, 'Not found.');
      if (req.method !== route.method) {
        res.setHeader('Allow', route.method);
        throw new HttpError(405, `Use ${route.method}.`);
      }
      const [status, body] = await route.run(req);
      sendJson(res, status, body);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, {error: error.message});
      } else if (error instanceof GenerationError) {
        const detail = error.details.length > 0 ? ` ${summarize(error.details)}` : '';
        console.error(
          `generate failed: ${error.message} (${error.details.length} validation problem(s))`,
        );
        sendJson(res, error.status, {error: `${error.message}${detail}`});
      } else {
        console.error(
          `unexpected error on ${pathname}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
        sendJson(res, 500, {error: 'Internal server error.'});
      }
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Static files (prod)
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {'Allow': 'GET, HEAD'}).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(DIST_DIR, `.${path.posix.normalize(pathname)}`);
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  let info = await stat(file).catch(() => undefined);
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html');
    info = await stat(file).catch(() => undefined);
  }
  if (!info?.isFile()) {
    // SPA fallback for extensionless routes; missing assets stay 404.
    if (path.extname(pathname) !== '') {
      res.writeHead(404).end();
      return;
    }
    file = path.join(DIST_DIR, 'index.html');
    info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      res
        .writeHead(503, {'Content-Type': 'text/plain; charset=utf-8'})
        .end('Run the build script before starting in --prod mode.');
      return;
    }
  }
  const immutable = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function setSecurityHeaders(res: ServerResponse, prod: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Vite's dev client injects inline scripts, so the strict policy applies to prod only.
  if (prod) res.setHeader('Content-Security-Policy', PROD_CSP);
}

function logRequests(req: IncomingMessage, res: ServerResponse): void {
  const started = performance.now();
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  res.on('finish', () => {
    if (pathname.startsWith('/api/')) {
      console.log(
        `${req.method} ${pathname} ${res.statusCode} ${Math.round(performance.now() - started)}ms`,
      );
    }
  });
}

export interface StartOptions {
  prod?: boolean;
  port?: number;
}

export async function startServer(options: StartOptions = {}): Promise<Server> {
  const prod = options.prod ?? false;
  const port = options.port ?? DEFAULT_PORT;
  const api = createApiHandler();
  const server = createServer();

  let fallback: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  let closeVite: (() => Promise<void>) | undefined;
  if (prod) {
    fallback = serveStatic;
  } else {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      root: PROJECT_ROOT,
      configFile: path.join(PROJECT_ROOT, 'vite.config.ts'),
      appType: 'spa',
      server: {middlewareMode: true, hmr: {server}},
    });
    fallback = (req, res) => vite.middlewares(req, res);
    closeVite = () => vite.close();
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res, prod);
    logRequests(req, res);
    void (async () => {
      try {
        if (await api(req, res)) return;
        const hostname = hostnameOf(req.headers.host);
        if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) {
          res.writeHead(421).end();
          return;
        }
        await fallback(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      }
    })();
  });

  const shutdown = (): void => {
    void closeVite?.();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve());
  });
  console.log(`Ridgeline lab (${prod ? 'prod' : 'dev'}) on http://${HOST}:${port}`);
  return server;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  const portEnv = Number.parseInt(process.env.RIDGELINE_PORT ?? '', 10);
  startServer({
    prod: process.argv.includes('--prod'),
    port: Number.isInteger(portEnv) ? portEnv : DEFAULT_PORT,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
