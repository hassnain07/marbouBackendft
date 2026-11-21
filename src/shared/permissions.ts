import type { AdminRole } from '@prisma/client';

const ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  SUPER_ADMIN: ['*'],
  CONTENT_MODERATOR: [
    'listings.moderate',
    'users.suspend',
    'reports.manage',
    'appeals.manage',
    'blacklist.manage',
    'verification.review',
    'analytics.read',
    'users.read',
  ],
  SUPPORT_AGENT: [
    'tickets.manage',
    'cv.manage',
    'verification.review',
    'users.read',
    'lookup.rentals_appointments',
    'analytics.read',
  ],
  FINANCIAL_AUDITOR: [
    'payments.decide',
    'payments.read',
    'auditlog.read',
    'analytics.read',
    'users.read',
  ],
};

export function hasPerm(role: AdminRole, perm: string): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return perms.includes('*') || perms.includes(perm);
}
