import type { CorsOptions } from 'cors';

const normalizeOrigin = (value: string) => value.trim().replace(/\/$/, '');

// Built from the environment when called (not at import time) so dotenv has already run.
export function buildCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const rootDomain = env.ROOT_DOMAIN || 'erp.com';

  const configuredOrigins = [env.FRONTEND_URL, env.MARKETING_URL, env.CORS_ORIGINS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map(normalizeOrigin)
    .filter(Boolean);

  const allowedExplicitOrigins = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8081',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:8081',
    'https://erp-frontend-green.vercel.app',
    'https://erp-frontend-beryl.vercel.app',
    ...configuredOrigins,
  ]);

  return {
    origin: (origin, callback) => {
      // Allow non-browser requests (e.g. mobile apps, server-to-server, curl, Postman)
      if (!origin) return callback(null, true);

      const normalized = normalizeOrigin(origin);
      if (allowedExplicitOrigins.has(normalized)) {
        return callback(null, true);
      }

      try {
        const parsed = new URL(origin);
        const host = parsed.hostname;

        // Allow localhost and any *.localhost subdomains on any port (for multi-tenant local dev)
        if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1') {
          return callback(null, true);
        }

        // Allow production root domain and all *.rootDomain subdomains (e.g. *.erp.com)
        if (host === rootDomain || host.endsWith(`.${rootDomain}`)) {
          return callback(null, true);
        }
      } catch {
        // Fall through
      }

      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
    // Without this a browser on another origin cannot read the header, so the frontend never
    // learns that a change was saved but its audit entry could not be recorded.
    exposedHeaders: ['X-Audit-Warning'],
  };
}
