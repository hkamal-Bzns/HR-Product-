import 'dotenv/config';
import { buildServer, store } from './server.js';
import { seed } from './seed.js';

const port = Number(process.env.PORT ?? 3001);
const app = buildServer({
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-to-a-long-random-secret-before-any-real-use',
  breakGlassEnabled: process.env.BREAK_GLASS_ENABLED === 'true',
});

app.listen({ port, host: '0.0.0.0' }).then(async () => {
  if (store.tenants.size === 0) await seed();
  console.log(`hr-payroll api listening on :${port} (M4 AI agents v1 — LLM STUBBED)`);
});
