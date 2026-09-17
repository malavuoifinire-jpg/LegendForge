/**
 * Regole configurabili.
 *
 * Nessun valore di regola va scritto nel motore o nella UI: tutto passa da un
 * RuleSet, salvato per campagna e modificabile dal Game Master senza toccare il
 * codice.
 */

export const RULESET_SCHEMA_VERSION = 1 as const;

/** Modalità di conteggio delle diagonali su griglia quadrata. */
export type DiagonalRule =
  /** Ogni diagonale costa una casella. */
  | 'equidistant'
  /** Costo alternato: la prima diagonale 1 casella, la seconda 2, e così via. */
  | 'alternating'
  /** Distanza euclidea reale. */
  | 'euclidean';

export interface GridRules {
  kind: 'square';
  /** Lato della casella in metri. Default di prodotto: 1,5 m. */
  defaultMetersPerCell: number;
  defaultSnapEnabled: boolean;
  /** Confidenza minima per proporre l'accettazione di un rilevamento. */
  autoDetectAcceptThreshold: number;
}

export interface MovementRules {
  diagonalRule: DiagonalRule;
  difficultTerrainMultiplier: number;
  /** Se true il server rifiuta movimenti oltre il budget disponibile. */
  enforceBudget: boolean;
  /** Il Game Master può sempre autorizzare il superamento. */
  allowGameMasterOverride: boolean;
  /**
   * Il Game Master può spostare le pedine assegnate ai giocatori.
   *
   * Spenta, quelle pedine le muove solo chi le possiede: al Game Master
   * restano tutte le altre facoltà — nasconderle, rinominarle, eliminarle —
   * perché sono gestione della scena, non il personaggio di qualcun altro che
   * cammina da solo. Per i casi in cui il controllo passa davvero di mano, per
   * esempio un incantesimo di dominio, c'è l'apposito interruttore sulla
   * singola pedina, che vince su questa regola.
   */
  gameMasterMovesPlayerTokens: boolean;
  /** Costo in metri di un tratto di salto, in attesa dell'automazione completa. */
  jumpSegmentCostMeters: number;
}

export interface VisionRules {
  /** 18 m = 12 caselle a 1,5 m per casella. */
  defaultDarkvisionMeters: number;
  /** 36 m = 24 caselle a 1,5 m per casella. */
  extendedDarkvisionMeters: number;
  torchBrightRadiusMeters: number;
  torchDimRadiusMeters: number;
}

export interface UnitRules {
  system: 'metric';
  displayUnit: 'meters';
  displayPrecision: number;
}

export interface RuleSet {
  schemaVersion: typeof RULESET_SCHEMA_VERSION;
  grid: GridRules;
  movement: MovementRules;
  vision: VisionRules;
  units: UnitRules;
}

export const DEFAULT_RULE_SET: RuleSet = {
  schemaVersion: RULESET_SCHEMA_VERSION,
  grid: {
    kind: 'square',
    defaultMetersPerCell: 1.5,
    defaultSnapEnabled: true,
    autoDetectAcceptThreshold: 0.55,
  },
  movement: {
    diagonalRule: 'alternating',
    difficultTerrainMultiplier: 2,
    enforceBudget: true,
    allowGameMasterOverride: true,
    gameMasterMovesPlayerTokens: true,
    jumpSegmentCostMeters: 1.5,
  },
  vision: {
    defaultDarkvisionMeters: 18,
    extendedDarkvisionMeters: 36,
    torchBrightRadiusMeters: 6,
    torchDimRadiusMeters: 12,
  },
  units: { system: 'metric', displayUnit: 'meters', displayPrecision: 1 },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function cloneRuleSet(source: RuleSet): RuleSet {
  return {
    schemaVersion: RULESET_SCHEMA_VERSION,
    grid: { ...source.grid },
    movement: { ...source.movement },
    vision: { ...source.vision },
    units: { ...source.units },
  };
}

/** Fonde un RuleSet parziale sui default, senza mutare gli input. */
export function mergeRuleSet(partial: DeepPartial<RuleSet> | null | undefined): RuleSet {
  const base = cloneRuleSet(DEFAULT_RULE_SET);
  if (!partial) return base;
  return {
    schemaVersion: RULESET_SCHEMA_VERSION,
    grid: { ...base.grid, ...(partial.grid ?? {}) },
    movement: { ...base.movement, ...(partial.movement ?? {}) },
    vision: { ...base.vision, ...(partial.vision ?? {}) },
    units: { ...base.units, ...(partial.units ?? {}) },
  };
}
