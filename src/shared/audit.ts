import { db } from './db';
import { createHash } from 'crypto';

interface AuditEntry {
  actor: { type: string; id: string };
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** B02: canonical JSON — recursively sort object keys so JSONB round-trips don't break the hash */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  // recurse into values
  return '{' + Object.keys(sorted).map((k) => JSON.stringify(k) + ':' + canonicalJson(sorted[k])).join(',') + '}';
}

function buildPayload(e: AuditEntry, createdAt: Date): string {
  return canonicalJson({
    actorType: e.actor.type,
    actorId: e.actor.id,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    createdAt: createdAt.toISOString(),
  });
}

export const audit = {
  async log(e: AuditEntry) {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(777)`;
      const last = await tx.auditLog.findFirst({
        orderBy: { id: 'desc' },
        select: { hash: true },
      });
      const prevHash = last?.hash ?? 'GENESIS';
      const createdAt = new Date();
      const payload = buildPayload(e, createdAt);
      const hash = createHash('sha256').update(prevHash + payload).digest('hex');
      return tx.auditLog.create({
        data: {
          actorType: e.actor.type,
          actorId: e.actor.id,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId,
          before: e.before as never,
          after: e.after as never,
          prevHash,
          hash,
          createdAt,
        },
      });
    });
  },

  async verify(): Promise<{ ok: boolean; firstMismatch?: string }> {
    const logs = await db.auditLog.findMany({ orderBy: { id: 'asc' } });
    let prevHash = 'GENESIS';
    for (const log of logs) {
      const payload = buildPayload(
        {
          actor: { type: log.actorType, id: log.actorId },
          action: log.action,
          entity: log.entity,
          entityId: log.entityId,
          before: log.before,
          after: log.after,
        },
        log.createdAt,
      );
      const expected = createHash('sha256').update(prevHash + payload).digest('hex');
      if (expected !== log.hash) {
        // B02: return string not BigInt
        return { ok: false, firstMismatch: log.id.toString() };
      }
      prevHash = log.hash;
    }
    return { ok: true };
  },
};
