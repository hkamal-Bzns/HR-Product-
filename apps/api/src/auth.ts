// Auth: bcrypt password hashing, JWT sessions, API keys with scopes.
// Roles: owner | accountant | branch_manager | employee (Brief §10 matrix).
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import type { Role, SuperadminRole } from '@hr-payroll/shared';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface SessionClaims { sub: string; tenantId: string | null; role: Role | 'superadmin'; superadminRole?: SuperadminRole; mfaVerified?: boolean; }
export function signSession(claims: SessionClaims, secret: string): string {
  return jwt.sign(claims, secret, { expiresIn: '8h' });
}
export function verifySession(token: string, secret: string): SessionClaims {
  return jwt.verify(token, secret) as SessionClaims;
}

/** API keys: `hrpk_<random>` shown once at creation; only the hash is stored. */
export function newApiKey(): { key: string; keyHash: string } {
  const key = `hrpk_${randomBytes(24).toString('hex')}`;
  return { key, keyHash: createHash('sha256').update(key).digest('hex') };
}
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function requireRole(claims: SessionClaims, allowed: Role[]): void {
  if (claims.role === 'superadmin' || allowed.includes(claims.role as Role)) return;
  throw new Error('forbidden: role not allowed');
}
