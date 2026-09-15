import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE_SET, mergeRuleSet } from './ruleset.js';

describe('RuleSet', () => {
  it('i default rispettano i vincoli di prodotto', () => {
    expect(DEFAULT_RULE_SET.grid.defaultMetersPerCell).toBe(1.5);
    expect(DEFAULT_RULE_SET.vision.defaultDarkvisionMeters).toBe(18);
    expect(DEFAULT_RULE_SET.vision.extendedDarkvisionMeters).toBe(36);
    expect(DEFAULT_RULE_SET.movement.allowGameMasterOverride).toBe(true);
  });

  it('fonde le sovrascritture parziali senza mutare i default', () => {
    const merged = mergeRuleSet({ movement: { diagonalRule: 'euclidean' } });
    expect(merged.movement.diagonalRule).toBe('euclidean');
    expect(merged.movement.difficultTerrainMultiplier).toBe(2);
    expect(DEFAULT_RULE_SET.movement.diagonalRule).toBe('alternating');
  });

  it('restituisce i default quando non c è nulla di persistito', () => {
    expect(mergeRuleSet(null)).toEqual(DEFAULT_RULE_SET);
  });
});
