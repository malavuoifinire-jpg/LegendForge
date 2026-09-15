import type { z } from 'zod';
import { HttpError } from './http.js';

/**
 * Convalida il corpo di una richiesta contro uno schema condiviso.
 *
 * I dettagli restituiti al client dicono quale campo è sbagliato e perché, ma
 * non riespongono il valore inviato.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    'invalid_input',
    'Dati non validi',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(radice)',
      message: issue.message,
    })),
  );
}
