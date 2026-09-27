import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeDshWebOptions {
  token?: string;
  bundles?: unknown;
  plugins?: unknown;
  loginStatus?: number;
  loginCookie?: boolean;
  apiStatus?: number;
  apiBody?: string;
  rejectMethod?: string;
  delayMs?: number;
}

export interface FakeDshWebRequest {
  method: string;
  path: string;
  cookie?: string;
  body?: unknown;
}

export interface FakeDshWeb {
  url: string;
  origin: string;
  token: string;
  cookie: string;
  requests: FakeDshWebRequest[];
  close(): Promise<void>;
}

// Mirrors the dsh web 0.1.7-rc.2 login and pluginManager RPC wire format.
export async function startFakeDshWeb(options: FakeDshWebOptions = {}): Promise<FakeDshWeb> {
  const token = options.token ?? 'SECRET-TOKEN-123';
  const cookie = 'dsh_session=COOKIE-VALUE-456';
  const requests: FakeDshWebRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake.invalid');
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? '', path: url.pathname, cookie: req.headers.cookie, body });
      const respond = (): void => {
        if (req.method === 'GET' && url.pathname === '/') {
          if (options.loginStatus !== undefined) {
            res.writeHead(options.loginStatus);
            res.end();
            return;
          }
          if (url.searchParams.getAll('token').join('') !== token) {
            res.writeHead(401, { 'content-type': 'text/plain' });
            res.end('dsh web authentication required; reopen the URL printed by dsh web.');
            return;
          }
          res.writeHead(303, {
            location: './',
            ...(options.loginCookie === false ? {} : { 'set-cookie': `${cookie}; Path=/; HttpOnly` })
          });
          res.end();
          return;
        }
        const match = /^\/api\/pluginManager\/(\w+)$/.exec(url.pathname);
        const method = match?.[1];
        const known = method === 'listBundles' || method === 'listPlugins';
        if (req.method !== 'POST' || !known) {
          res.writeHead(404, { 'content-type': 'text/plain;charset=UTF-8' });
          res.end('not found');
          return;
        }
        if (req.headers.cookie !== cookie) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('unauthorized');
          return;
        }
        if (options.apiStatus !== undefined) {
          res.writeHead(options.apiStatus);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (options.apiBody !== undefined) {
          res.end(options.apiBody);
          return;
        }
        const result =
          method === options.rejectMethod
            ? { ok: false, error: { code: 'gateway/internal', message: 'boom', details: {} } }
            : { ok: true, value: (method === 'listBundles' ? options.bundles : options.plugins) ?? [] };
        const rpcId = (body as { rpcId?: unknown } | undefined)?.rpcId;
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
      };
      if (options.delayMs !== undefined) {
        setTimeout(respond, options.delayMs);
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/?token=${token}`,
    origin,
    token,
    cookie,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
