// M4 agent core — LLM provider interface + agent-run record, cost ledger,
// kill switches, offline-record signing. No real LLM key exists in M4 and no
// real API calls are made: the STUBBED provider composes outputs
// deterministically from structured inputs (see packages/shared/src/agents.ts).
// A real provider can be plugged in later via the LLM_API_KEY env var —
// never committed, never read from anywhere else. The HttpLlmProvider below
// only runs when that env var is set; tests and dev always use the stub.
import { createHash, createHmac } from 'node:crypto';
import { newId, type MemoryStore, type AgentRunRecord } from '@hr-payroll/db';
import {
  AGENT_COST_PIASTERS_PER_RUN, DEFAULT_AGENT_MONTHLY_CAP_PIASTERS, costCapStatus,
  isAgentPaused, monthKey, type AgentId,
} from '@hr-payroll/shared';

export interface LlmGenerateInput {
  agentId: AgentId;
  /** Human-readable prompt (for a future real provider). The stub ignores it. */
  prompt: string;
  /** JSON-schema-shaped description of the expected output (stub ignores it). */
  schema: Record<string, unknown>;
  /** Structured context the output is composed from. The stub returns this
   *  verbatim as the output — numbers are rendered from data, never generated. */
  structuredContext: unknown;
}
export interface LlmGenerateResult {
  output: unknown;
  /** STUBBED cost estimate in piasters (see AGENT_COST_PIASTERS_PER_RUN). */
  costPiasters: number;
  model: string;
  provider: 'stub' | 'http';
}

export interface LlmProvider {
  name: 'stub' | 'http';
  generateStructured(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

/** STUBBED/demo provider: deterministic, no network, no key, no cost beyond
 *  the fixed estimate. Its output IS the structured context — the agent
 *  logic in @hr-payroll/shared does the composing. */
export class StubLlmProvider implements LlmProvider {
  name = 'stub' as const;
  async generateStructured(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    return {
      output: input.structuredContext,
      costPiasters: AGENT_COST_PIASTERS_PER_RUN[input.agentId],
      model: 'stub-deterministic-v1',
      provider: 'stub',
    };
  }
}

/** Real-provider adapter interface (OpenAI-compatible chat-completions
 *  endpoint). Only constructed when LLM_API_KEY is set; it throws a clear
 *  error otherwise and is never used in M4 tests/dev. The key is read from
 *  the environment at construction time and never logged or stored. */
export class HttpLlmProvider implements LlmProvider {
  name = 'http' as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    private readonly model: string = process.env.LLM_MODEL ?? 'gpt-4o-mini',
  ) {
    if (!apiKey) throw new Error('LLM_API_KEY is not set — set it in the environment to enable the real LLM provider (never commit a key)');
  }
  async generateStructured(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a deterministic HR assistant. Answer ONLY from the structured data provided. Render names, dates and amounts from that data exactly; never invent figures. Reply in Arabic first. Output JSON matching the provided schema.' },
          { role: 'user', content: `${input.prompt}\n\nStructured data:\n${JSON.stringify(input.structuredContext)}` },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`LLM provider error: ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
    const text = data.choices?.[0]?.message?.content ?? '{}';
    // Cost is unknown until the provider bills it; callers must replace the
    // stub estimate with the provider's real usage accounting in V1.
    return { output: JSON.parse(text), costPiasters: AGENT_COST_PIASTERS_PER_RUN[input.agentId], model: this.model, provider: 'http' };
  }
}

/** Stub unless a real key is configured. Never throws in M4. */
export function createLlmProvider(): LlmProvider {
  const key = process.env.LLM_API_KEY;
  if (key) return new HttpLlmProvider(key);
  return new StubLlmProvider();
}

// --- Agent-run record + cost ledger ------------------------------------------

/** Stable hash of the structured inputs (sorted keys) — the audit trail
 *  proves which data an agent run was based on. */
export function hashAgentInput(input: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, val]) => [k, stable(val)]));
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
}

export function recordAgentRun(
  store: MemoryStore, tenantId: string, agentId: AgentId, input: unknown, output: unknown,
  opts: { costPiasters: number; provider: 'stub' | 'http'; status?: AgentRunRecord['status']; employeeId?: string | null },
): AgentRunRecord {
  const month = monthKey(new Date().toISOString());
  const run: AgentRunRecord = {
    id: newId('agentrun'), tenantId, agentId, month,
    inputHash: hashAgentInput(input), output,
    costPiasters: opts.costPiasters, provider: opts.provider,
    status: opts.status ?? 'completed', humanDecision: null, decisions: [],
    decidedByUserId: null, employeeId: opts.employeeId ?? null,
    createdAt: new Date().toISOString(),
  };
  store.agentRuns.push(run);
  store.agentCosts.push({
    id: newId('agentcost'), tenantId, agentId, month,
    costPiasters: opts.costPiasters, runId: run.id, createdAt: run.createdAt,
  });
  store.log({
    tenantId, actorUserId: null, actorKind: 'system', action: `agent.${agentId}.run`,
    entity: 'agent_run', detail: { runId: run.id, agentId, costPiasters: opts.costPiasters, provider: opts.provider, status: run.status, inputHash: run.inputHash },
  });
  return run;
}

// --- Cost caps + kill switches ------------------------------------------------

/** Effective monthly cap for one agent: explicit per-agent override, then a
 *  tenant-wide override, then the AI-agents Settings value, then the default. */
export function agentCapFor(store: MemoryStore, tenantId: string, agentId: AgentId): number {
  const perAgent = store.agentCostCaps.get(`${tenantId}:${agentId}`);
  if (perAgent !== undefined) return perAgent;
  const all = store.agentCostCaps.get(`${tenantId}:all`);
  if (all !== undefined) return all;
  const latest = store.latestSettings(tenantId, 'ai_agents');
  const v = latest?.value as { monthlyCapPiastersPerAgent?: unknown } | undefined;
  if (typeof v?.monthlyCapPiastersPerAgent === 'number') return v.monthlyCapPiastersPerAgent;
  return DEFAULT_AGENT_MONTHLY_CAP_PIASTERS;
}

export function agentKillState(store: MemoryStore, tenantId: string, agentId: AgentId): {
  globalKilled: boolean; tenantKilled: boolean; settingsKilled: boolean;
} {
  const latest = store.latestSettings(tenantId, 'ai_agents');
  const v = latest?.value as { killSwitches?: Record<string, unknown> } | undefined;
  return {
    globalKilled: store.agentKillSwitches.get(`global:${agentId}`) === true,
    tenantKilled: store.agentKillSwitches.get(`${tenantId}:${agentId}`) === true,
    settingsKilled: v?.killSwitches?.[agentId] === true,
  };
}

export function agentStatus(store: MemoryStore, tenantId: string, agentId: AgentId, month = monthKey(new Date().toISOString())): {
  agentId: AgentId; paused: boolean; globalKilled: boolean; tenantKilled: boolean;
  monthCostPiasters: number; capPiasters: number; capExceeded: boolean; remainingPiasters: number;
} {
  const kills = agentKillState(store, tenantId, agentId);
  const monthCost = store.agentMonthCost(tenantId, agentId, month);
  const cap = agentCapFor(store, tenantId, agentId);
  const capCheck = costCapStatus(monthCost, cap);
  const paused = isAgentPaused({ globalKilled: kills.globalKilled, tenantKilled: kills.tenantKilled || kills.settingsKilled, capExceeded: capCheck.exceeded });
  return {
    agentId, paused, globalKilled: kills.globalKilled,
    tenantKilled: kills.tenantKilled || kills.settingsKilled,
    monthCostPiasters: monthCost, capPiasters: cap, capExceeded: capCheck.exceeded,
    remainingPiasters: capCheck.remainingPiasters,
  };
}

/** Throws when the agent is paused (kill switch or cap). Callers surface a
 *  409 with a clear reason; attendance and payroll never call this. */
export function ensureAgentAllowed(store: MemoryStore, tenantId: string, agentId: AgentId): void {
  const s = agentStatus(store, tenantId, agentId);
  if (s.globalKilled) throw new Error(`agent ${agentId} is paused globally (kill switch)`);
  if (s.tenantKilled) throw new Error(`agent ${agentId} is paused for this tenant (kill switch)`);
  if (s.capExceeded) throw new Error(`agent ${agentId} is paused: monthly cost cap of EGP ${(s.capPiasters / 100).toFixed(2)} reached (spent EGP ${(s.monthCostPiasters / 100).toFixed(2)})`);
}

// --- Offline-record signing ---------------------------------------------------
// HMAC-SHA256 over tenant|employee|deviceAt|branch. Strict verification only
// applies when OFFLINE_SIGNING_SECRET is configured; without it the M2
// legacy behaviour holds (any non-empty signature is accepted, flagged
// 'legacy') so existing kiosk clients keep working until they are upgraded
// to sign records. A bad signature under strict mode is NEVER silently
// accepted — the record goes to the review queue.
export function offlineSigningSecret(): string | null {
  return process.env.OFFLINE_SIGNING_SECRET ?? null;
}

export function signOfflineRecord(secret: string, tenantId: string, employeeId: string, deviceAt: string, branchId: string): string {
  return createHmac('sha256', secret).update(`${tenantId}|${employeeId}|${deviceAt}|${branchId}`).digest('hex');
}

export function verifyOfflineSignature(
  tenantId: string, employeeId: string, deviceAt: string, branchId: string, signature: string | undefined,
): { status: 'verified' | 'legacy' | 'invalid' | 'missing'; valid: boolean | null } {
  if (!signature) return { status: 'missing', valid: false };
  const secret = offlineSigningSecret();
  if (!secret) return { status: 'legacy', valid: null }; // no strict verification configured
  const expected = signOfflineRecord(secret, tenantId, employeeId, deviceAt, branchId);
  return expected === signature ? { status: 'verified', valid: true } : { status: 'invalid', valid: false };
}
