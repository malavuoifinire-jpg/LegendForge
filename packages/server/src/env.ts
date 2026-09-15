import { z } from 'zod';

/**
 * Configurazione letta dall'ambiente.
 *
 * Nessun segreto ha un valore predefinito: se manca, il servizio lo dichiara
 * invece di funzionare a metà in silenzio.
 */
const schema = z.object({
  databaseUrl: z.string().min(1).optional(),
  /**
   * Verifica del certificato TLS verso il database. Disattivarla è accettabile
   * solo per diagnosi temporanee, mai come configurazione stabile.
   */
  databaseSslInsecure: z.boolean().default(false),
  build: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof schema>;

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value);
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return schema.parse({
    databaseUrl: source.DATABASE_URL ?? source.SUPABASE_DB_POOLED_URL ?? undefined,
    databaseSslInsecure: truthy(source.DATABASE_SSL_INSECURE),
    build: source.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    region: source.VERCEL_REGION ?? null,
    nodeEnv: (source.NODE_ENV as ServerEnv['nodeEnv']) ?? 'development',
  });
}
