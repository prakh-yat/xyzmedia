import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

export interface WaitForCallbackOpts {
  port: number;
  expectedState: string;
  timeoutMs?: number;
}

export async function waitForCallback(opts: WaitForCallbackOpts): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
      if (url.pathname !== '/api/oauth/callback') {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain');
        res.end('not found');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const detail = url.searchParams.get('error_description') ?? '';
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html');
        res.end(`<h1>OAuth error</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(detail)}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error} ${detail}`));
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain');
        res.end('missing code');
        return;
      }
      if (state !== opts.expectedState) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain');
        res.end('state mismatch');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF attempt'));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><html><body style="font-family: system-ui; padding: 40px; max-width: 600px;">' +
          '<h1 style="color: #16a34a;">✓ Authorization received</h1>' +
          '<p>You can close this tab and return to your terminal.</p>' +
          '</body></html>',
      );
      server.close();
      resolve({ code });
    });
    server.on('error', (err) => reject(err));
    server.listen(opts.port, '127.0.0.1');
    if (opts.timeoutMs) {
      setTimeout(() => {
        try {
          server.close();
        } catch {
          // ignore
        }
        reject(new Error('OAuth callback timed out'));
      }, opts.timeoutMs).unref();
    }
  });
}

export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the other process or set GHL_REDIRECT_URI ` +
              "to a different port (and update the marketplace app's Redirect URLs to match).",
          ),
        );
      } else {
        reject(err);
      }
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve());
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
