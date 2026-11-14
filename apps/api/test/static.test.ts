// API serves the built web frontend (same origin, one deploy) when
// apps/web/dist exists; API routes and JSON 404s are unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, store, findWebDist } from '../src/server.js';
import { seed } from '../src/seed.js';
import { signSession } from '../src/auth.js';

const SECRET = 'test-secret-only';
let app: ReturnType<typeof buildServer>;
const owner = () => signSession({ sub: 'user-owner', tenantId: 'tenant-demo-cafe', role: 'owner' }, SECRET);
const H = (t: string) => ({ authorization: `Bearer ${t}` });

test.before(async () => {
  await seed();
  app = buildServer({ jwtSecret: SECRET, breakGlassEnabled: false });
  await app.ready();
});
test.after(async () => { await app.close(); });

test('Frontend serving: / returns the dashboard HTML when the web bundle is built', async () => {
  const webDist = findWebDist();
  const res = await app.inject({ method: 'GET', url: '/' });
  if (!webDist) {
    assert.equal(res.statusCode, 404); // API-only mode (web not built)
    return;
  }
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /HR &amp; Payroll/);
  // Static asset from the bundle (hash read from the served HTML, not hardcoded).
  const assetSrc = res.body.match(/\/assets\/[^"']+\.js/)?.[0];
  assert.ok(assetSrc, 'bundle script referenced in index.html');
  const asset = await app.inject({ method: 'GET', url: assetSrc });
  assert.equal(asset.statusCode, 200);
  // PWA files served too.
  const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
  assert.equal(manifest.statusCode, 200);
});

test('Frontend serving: API routes still win, unknown /api paths stay JSON 404', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, 'ok');
  const missing = await app.inject({ method: 'GET', url: '/api/no-such-route', headers: H(owner()) });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'not found');
  // An app path that is not a file falls back to the dashboard (SPA) when built.
  if (findWebDist()) {
    const fallback = await app.inject({ method: 'GET', url: '/dashboard' });
    assert.equal(fallback.statusCode, 200);
    assert.match(fallback.body, /HR &amp; Payroll/);
  }
});
