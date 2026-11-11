// WhatsApp notifier — STUBBED in M2. No real provider, no real sends.
// The StubWhatsAppProvider records every message in the tenant outbox with
// status 'queued_stubbed' and returns it. Nothing here claims delivery.
// A live provider (360dialog / Gupshup) replaces this adapter in V1.
import { newId, type MemoryStore } from '@hr-payroll/db';

export interface WhatsAppMessage {
  toPhone: string;
  template: string;
  body: string;
}

export interface WhatsAppSendResult {
  provider: 'stub';
  status: 'queued_stubbed';
  outboxId: string;
  /** Never 'delivered' while stubbed. */
  delivered: false;
}

export interface WhatsAppProvider {
  send(store: MemoryStore, tenantId: string, msg: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

export const StubWhatsAppProvider: WhatsAppProvider = {
  async send(store, tenantId, msg): Promise<WhatsAppSendResult> {
    const id = newId('msg');
    store.outbox.push({
      id, tenantId, toPhone: msg.toPhone, template: msg.template, body: msg.body,
      status: 'queued_stubbed', provider: 'stub', createdAt: new Date().toISOString(),
    });
    store.log({
      tenantId, actorUserId: null, actorKind: 'system', action: 'whatsapp.stub_queued',
      entity: 'outbox', detail: { outboxId: id, template: msg.template, toPhone: msg.toPhone, note: 'STUBBED — not sent, no delivery' },
    });
    return { provider: 'stub', status: 'queued_stubbed', outboxId: id, delivered: false };
  },
};

/** Convenience: queue a stubbed WhatsApp message for one employee. */
export async function notifyEmployee(
  store: MemoryStore, tenantId: string, employee: { phone: string },
  template: string, body: string,
): Promise<WhatsAppSendResult> {
  return StubWhatsAppProvider.send(store, tenantId, { toPhone: employee.phone, template, body });
}
