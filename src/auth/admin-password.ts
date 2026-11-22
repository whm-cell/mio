import { hashPassword, verifyPassword } from 'better-auth/crypto';

/** Reuse Better Auth's vetted scrypt KDF for isolated administrator credentials. */
export function hashAdminPassword(password: string): Promise<string> {
  return hashPassword(password);
}

export function verifyAdminPassword(hash: string, password: string): Promise<boolean> {
  return verifyPassword({ hash, password });
}
