import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Token di sessione opaco: 256 bit di entropia. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Del token di sessione il database conserva solo l'impronta: chi leggesse la
 * tabella non potrebbe usarla per entrare.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

// Alfabeto senza caratteri ambigui: niente 0/O, 1/I/L, 8/B.
const RECOVERY_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ2346789';

/**
 * Codice di recupero mostrato una sola volta: cinque gruppi da cinque
 * caratteri, circa 120 bit di entropia, leggibile e trascrivibile a mano.
 */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g += 1) {
    let group = '';
    for (let i = 0; i < 5; i += 1) {
      group += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Codice di una campagna: due gruppi da quattro caratteri, leggibile a voce e
 * trascrivibile senza ambiguità. Non è un segreto forte come un link d'invito,
 * quindi i tentativi sono limitati e il Game Master può rigenerarlo.
 */
export function generateJoinCode(): string {
  const group = (): string => {
    let out = '';
    for (let i = 0; i < 4; i += 1) out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return out;
  };
  return `${group()}-${group()}`;
}

/** Normalizza un codice digitato dall'utente prima del confronto. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

export function canonicalRecoveryCode(code: string): string {
  return normalizeRecoveryCode(code);
}

/** Riporta un codice campagna alla forma con cui è salvato. */
export function canonicalJoinCode(input: string): string {
  const cleaned = normalizeRecoveryCode(input);
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}
