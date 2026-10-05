import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildCorsOptions } from './cors';

const makeApp = (env: NodeJS.ProcessEnv = {}) => {
  const app = express();
  app.use(cors(buildCorsOptions(env)));
  app.post('/save', (_req, res) => { res.setHeader('X-Audit-Warning', 'write-failed'); res.json({ ok: true }); });
  app.use((err: any, _req: any, res: any, _next: any) => res.status(403).json({ message: err.message }));
  return app;
};

describe('CORS', () => {
  it('exposes X-Audit-Warning so a browser on another origin can read it (the toast depends on it)', async () => {
    const res = await request(makeApp()).post('/save').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Audit-Warning/i);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['x-audit-warning']).toBe('write-failed');
  });

  it('allows tenant subdomains of the root domain and configured origins', async () => {
    const app = makeApp({ ROOT_DOMAIN: 'acme.test', FRONTEND_URL: 'https://app.example.com/' });
    expect((await request(app).post('/save').set('Origin', 'https://t1.acme.test')).headers['access-control-allow-origin']).toBe('https://t1.acme.test');
    expect((await request(app).post('/save').set('Origin', 'https://app.example.com')).headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('rejects an unknown origin', async () => {
    const res = await request(makeApp()).post('/save').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
