import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SUPABASE_INTERMEDIATE_CA_2021,
  SUPABASE_ROOT_CA_2021,
  SUPABASE_ROOT_CA_FINGERPRINT,
} from './supabase-ca.js';

describe('certificati di Supabase incorporati', () => {
  it('la radice ha l impronta attesa', () => {
    const certificate = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(certificate.fingerprint256).toBe(SUPABASE_ROOT_CA_FINGERPRINT);
    expect(certificate.subject).toContain('Supabase Root 2021 CA');
    expect(certificate.ca).toBe(true);
  });

  it('la radice è autofirmata e ancora valida', () => {
    const certificate = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(certificate.subject).toBe(certificate.issuer);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it('l intermedio è firmato dalla radice ed è ancora valido', () => {
    const root = new X509Certificate(SUPABASE_ROOT_CA_2021);
    const intermediate = new X509Certificate(SUPABASE_INTERMEDIATE_CA_2021);
    expect(intermediate.issuer).toBe(root.subject);
    expect(intermediate.verify(root.publicKey)).toBe(true);
    expect(intermediate.ca).toBe(true);
    expect(new Date(intermediate.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
