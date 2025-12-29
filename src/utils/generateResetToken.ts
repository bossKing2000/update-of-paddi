import crypto from 'crypto';

export function generateResetToken(length = 6): string {
  // Characters allowed: 0-9, A-Z (uppercase), a-z (lowercase)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let token = '';
  for (let i = 0; i < length; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}
