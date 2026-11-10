// Fastify API — M1 Foundation only.
// Routes: /health, /auth/login, /api/settings, /api/superadmin/*
// No payroll, no clock-in, no WhatsApp, no AI in M1.
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { MemoryStore } from '@hr-payroll/db';
import { normalizePhone, SETTINGS_AREAS, type SettingsArea } from '@hr-payroll/shared';
import { verifyPassword, verifySession, signSession } from './auth.js';
import { changeSettings } from './settings.js';

export const store = new MemoryStore();

export function buildServer(opts: { jwtSecret: string; breakGlassEnabled?: boolean }): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });

  const auth = (req: { headers: Record<string, string | string[] | undefined> }): ReturnType<typeof verifySession> => {
    const h = req.headers.authorization;
    const token = Array.isArray(h) ? h[0] : h;
    if (!token?.startsWith('Bearer ')) throw new Error('missing bearer token');
    return verifySession(token.slice(7), opts.jwtSecret);
  };

  app.get('/health', async () => ({ status: 'ok', scope: 'm1', tenantCount: store.tenants.size }));

  app.post('/auth/login', async (req, reply) => {
    const body = req.body as { tenantSlug?: string; email?: string; password?: string };
    if (!body?.email || !body?.password) return reply.code(400).send({ error: 'email and password required' });
    const tenant = [...store.tenants.values()].find((t) => t.slug === body.tenantSlug);
    if (!tenant) return reply.code(401).send({ error: 'unknown tenant' });
    const user = store.findUserByEmail(tenant.id, body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const token = signSession({ sub: user.id, tenantId: tenant.id, role: user.role }, opts.jwtSecret);
    return { token, role: user.role, tenantId: tenant.id };
  });

  // --- Settings (§10) ------------------------------------------------------
  app.get('/api/settings/:area', async (req, reply) => {
    try {
      const claims = auth(req);
      if (!claims.tenantId) return reply.code(403).send({ error: 'tenant session required' });
      const area = (req.params as { area: string }).area as SettingsArea;
      if (!SETTINGS_AREAS.includes(area)) return reply.code(400).send({ error: 'unknown settings area' });
      return { area, latest: store.latestSettings(claims.tenantId, area) ?? null };
    } catch { return reply.code(401).send({ error: 'unauthorised' }); }
  });

  app.post('/api/settings/:area', async (req, reply) => {
    try {
      const claims = auth(req);
      if (!claims.tenantId) return reply.code(403).send({ error: 'tenant session required' });
      const area = (req.params as { area: string }).area as SettingsArea;
      const body = req.body as { value?: Record<string, unknown>; reason?: string; effectiveFrom?: string };
      if (!body?.value || !body?.reason || !body?.effectiveFrom) {
        return reply.code(400).send({ error: 'value, reason and effectiveFrom are required' });
      }
      const result = changeSettings({
        store, tenantId: claims.tenantId, area, value: body.value,
        changedByUserId: claims.sub, role: claims.role as never,
        reason: body.reason, effectiveFrom: body.effectiveFrom,
      });
      return reply.code(201).send(result);
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.startsWith('forbidden') ? 403 : 400).send({ error: msg });
    }
  });

  // --- Superadmin Lite (§11) ----------------------------------------------
  // Separate area. MFA flag is required on the session. By default it can see
  // aggregates only — never salaries, photos or payslips. Break-glass is a
  // stub, disabled by default (BREAK_GLASS_ENABLED=false), and every attempt
  // is written to the cross-tenant audit log.
  const superadmin = (req: { headers: Record<string, string | string[] | undefined> }) => {
    const claims = auth(req);
    if (claims.role !== 'superadmin') throw new Error('superadmin only');
    if (process.env.SUPERADMIN_MFA_REQUIRED !== 'false' && !claims.mfaVerified) {
      throw new Error('superadmin MFA verification required');
    }
    return claims;
  };

  app.get('/api/superadmin/tenants', async (req, reply) => {
    try {
      const claims = superadmin(req);
      store.log({ tenantId: null, actorUserId: claims.sub, actorKind: 'superadmin', action: 'superadmin.tenants.list', entity: 'tenants', detail: {} });
      return { tenants: [...store.tenants.values()].map((t) => ({ id: t.id, slug: t.slug, nameEn: t.nameEn, status: t.status, plan: t.plan, staffCap: t.staffCap })) };
    } catch (e) { return reply.code(403).send({ error: (e as Error).message }); }
  });

  app.post('/api/superadmin/tenants/:id/plan', async (req, reply) => {
    try {
      const claims = superadmin(req);
      const tenant = store.getTenant((req.params as { id: string }).id);
      if (!tenant) return reply.code(404).send({ error: 'tenant not found' });
      const body = req.body as { plan?: string };
      if (!['free', 'starter', 'growth', 'pro'].includes(body?.plan ?? '')) return reply.code(400).send({ error: 'invalid plan' });
      tenant.plan = body.plan as never;
      store.log({ tenantId: tenant.id, actorUserId: claims.sub, actorKind: 'superadmin', action: 'superadmin.tenant.plan_change', entity: 'tenant', detail: { plan: body.plan } });
      return { id: tenant.id, plan: tenant.plan };
    } catch (e) { return reply.code(403).send({ error: (e as Error).message }); }
  });

  app.post('/api/superadmin/tenants/:id/flags', async (req, reply) => {
    try {
      const claims = superadmin(req);
      const body = req.body as { key?: string; enabled?: boolean };
      if (!body?.key || typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'key and enabled required' });
      store.featureFlags.set(`${(req.params as { id: string }).id}:${body.key}`, body.enabled);
      store.log({ tenantId: (req.params as { id: string }).id, actorUserId: claims.sub, actorKind: 'superadmin', action: 'superadmin.feature_flag', entity: 'feature_flag', detail: { key: body.key, enabled: body.enabled } });
      return { key: body.key, enabled: body.enabled };
    } catch (e) { return reply.code(403).send({ error: (e as Error).message }); }
  });

  app.post('/api/superadmin/break-glass', async (req, reply) => {
    const claims = (() => { try { return superadmin(req); } catch (e) { return null; } })();
    if (!claims) return reply.code(403).send({ error: 'superadmin only (MFA required)' });
    const body = req.body as { tenantId?: string; ticketId?: string; reason?: string };
    store.log({ tenantId: body?.tenantId ?? null, actorUserId: claims.sub, actorKind: 'superadmin', action: 'superadmin.break_glass.attempt', entity: 'tenant', detail: { ticketId: body?.ticketId, reason: body?.reason, enabled: !!opts.breakGlassEnabled } });
    if (!opts.breakGlassEnabled) {
      return reply.code(403).send({ error: 'break-glass is disabled by default — enable only for a time-boxed, ticket-justified support case, with tenant notification' });
    }
    return reply.code(501).send({ error: 'break-glass entry is a stub in M1 — full time-boxed impersonation ships with the full Superadmin console in V1' });
  });

  // Demo helper (dev only): normalise a phone, proving the shared helper is wired in.
  app.get('/api/phone', async (req) => {
    const q = (req.query as { phone?: string }).phone ?? '';
    try { return { input: q, normalised: normalizePhone(q) }; } catch (e) { return { error: (e as Error).message }; }
  });

  return app;
}
