import { z } from 'zod';

/**
 * Forme dei contenuti di libreria.
 *
 * Qui non c'è nessuna regola di nessun manuale: ci sono le forme che un
 * contenuto può avere. Il motore non sa che cosa sia una palla di fuoco, sa
 * che un incantesimo ha un livello, una gittata e una durata. I valori
 * arrivano dai pacchetti, e un pacchetto si toglie senza toccare il codice.
 *
 * I campi sono quasi tutti facoltativi, di proposito. Un Game Master che si
 * inventa un incantesimo con metà dei dati deve poterlo salvare: uno schema
 * severo qui sarebbe un ostacolo, non una garanzia.
 */

export const LIBRARY_SCHEMA_VERSION = 1 as const;

export const libraryKindSchema = z.enum([
  'spell',
  'monster',
  'item',
  'weapon',
  'armor',
  'class',
  'subclass',
  'species',
  'background',
  'feat',
]);
export type LibraryKind = z.infer<typeof libraryKindSchema>;

/** Come si chiama ogni tipo, al singolare e al plurale, nella lingua del tavolo. */
export const LIBRARY_KIND_LABELS: Record<LibraryKind, { one: string; many: string }> = {
  spell: { one: 'Incantesimo', many: 'Incantesimi' },
  monster: { one: 'Mostro', many: 'Mostri' },
  item: { one: 'Oggetto', many: 'Oggetti' },
  weapon: { one: 'Arma', many: 'Armi' },
  armor: { one: 'Armatura', many: 'Armature' },
  class: { one: 'Classe', many: 'Classi' },
  subclass: { one: 'Sottoclasse', many: 'Sottoclassi' },
  species: { one: 'Specie', many: 'Specie' },
  background: { one: 'Background', many: 'Background' },
  feat: { one: 'Talento', many: 'Talenti' },
};

const shortText = z.string().trim().max(200);
const longText = z.string().max(20_000);

/** Notazione dei dadi, per esempio 8d6 o 2d8+3. Il tiro vero arriva con M6. */
export const diceNotationSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}d\d{1,3}([+-]\d{1,4})?$/iu, 'Notazione dei dadi non valida, atteso per esempio 8d6');

export const damageSchema = z.object({
  dice: diceNotationSchema.optional(),
  flat: z.number().finite().optional(),
  type: shortText.optional(),
});

/**
 * Campi che se li inventa chi gioca.
 *
 * Il valore resta testo, numero o booleano: bastano a scrivere qualsiasi cosa
 * su una scheda, e non aprono la porta a strutture annidate che poi nessuna
 * interfaccia saprebbe mostrare.
 */
export const customFieldsSchema = z.record(
  z.string().trim().min(1).max(80),
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
);
export type CustomFields = z.infer<typeof customFieldsSchema>;

/* ------------------------------ incantesimi ------------------------------ */

export const spellComponentsSchema = z.object({
  verbal: z.boolean().default(false),
  somatic: z.boolean().default(false),
  material: z.boolean().default(false),
  /** Che cosa serve avere in mano, quando serve. */
  materialDescription: shortText.optional(),
  /** Componente consumata dal lancio. */
  consumed: z.boolean().default(false),
});

export const spellDataSchema = z.object({
  /** 0 è un trucchetto. */
  level: z.number().int().min(0).max(9),
  school: shortText.optional(),
  castingTime: shortText.optional(),
  range: shortText.optional(),
  /** Gittata in metri, quando è un numero: serve ai calcoli, non alla scheda. */
  rangeMeters: z.number().nonnegative().max(100_000).nullable().optional(),
  components: spellComponentsSchema.optional(),
  duration: shortText.optional(),
  concentration: z.boolean().default(false),
  ritual: z.boolean().default(false),
  /** Classi che lo hanno in lista, per slug. */
  classes: z.array(shortText).max(40).default([]),
  description: longText.default(''),
  /** Che cosa cambia usando uno slot più alto. */
  atHigherLevels: longText.optional(),
  damage: damageSchema.optional(),
  /** Caratteristica del tiro salvezza, quando ce n'è uno. */
  savingThrow: shortText.optional(),
  /** Forma dell'area: cerchio, cono, linea, quadrato… */
  areaShape: shortText.optional(),
  areaMeters: z.number().nonnegative().max(10_000).optional(),
});
export type SpellData = z.infer<typeof spellDataSchema>;

/* --------------------------------- mostri -------------------------------- */

export const abilityScoresSchema = z.object({
  str: z.number().int().min(0).max(99).optional(),
  dex: z.number().int().min(0).max(99).optional(),
  con: z.number().int().min(0).max(99).optional(),
  int: z.number().int().min(0).max(99).optional(),
  wis: z.number().int().min(0).max(99).optional(),
  cha: z.number().int().min(0).max(99).optional(),
});

/** Un tratto, un'azione, una reazione: cambia solo dove compare sulla scheda. */
export const statBlockEntrySchema = z.object({
  name: shortText,
  description: longText.default(''),
  damage: damageSchema.optional(),
  /** Bonus al tiro per colpire, quando è un attacco. */
  attackBonus: z.number().int().min(-20).max(40).optional(),
  rangeMeters: z.number().nonnegative().max(100_000).optional(),
});

export const monsterDataSchema = z.object({
  size: shortText.optional(),
  creatureType: shortText.optional(),
  alignment: shortText.optional(),
  armorClass: z.number().int().min(0).max(60).optional(),
  armorNote: shortText.optional(),
  hitPoints: z.number().int().min(0).max(100_000).optional(),
  hitDice: diceNotationSchema.optional(),
  /** Velocità in metri, per modo di movimento. */
  speeds: z.record(z.string().trim().min(1).max(40), z.number().nonnegative().max(10_000)).default({}),
  abilities: abilityScoresSchema.default({}),
  savingThrows: z.record(z.string().trim().min(1).max(40), z.number().int().min(-20).max(40)).default({}),
  skills: z.record(z.string().trim().min(1).max(60), z.number().int().min(-20).max(40)).default({}),
  damageResistances: z.array(shortText).max(40).default([]),
  damageImmunities: z.array(shortText).max(40).default([]),
  damageVulnerabilities: z.array(shortText).max(40).default([]),
  conditionImmunities: z.array(shortText).max(40).default([]),
  /** Sensi in metri: scurovisione, vista cieca, percezione tellurica… */
  senses: z.record(z.string().trim().min(1).max(60), z.number().nonnegative().max(10_000)).default({}),
  passivePerception: z.number().int().min(0).max(60).optional(),
  languages: z.array(shortText).max(40).default([]),
  /** Grado di sfida, come numero: 1/8 diventa 0.125. */
  challengeRating: z.number().nonnegative().max(1000).optional(),
  experiencePoints: z.number().int().nonnegative().max(10_000_000).optional(),
  traits: z.array(statBlockEntrySchema).max(60).default([]),
  actions: z.array(statBlockEntrySchema).max(60).default([]),
  bonusActions: z.array(statBlockEntrySchema).max(60).default([]),
  reactions: z.array(statBlockEntrySchema).max(60).default([]),
  legendaryActions: z.array(statBlockEntrySchema).max(60).default([]),
  description: longText.optional(),
  /** Ingombro in caselle della pedina che ne nasce. */
  sizeInCells: z.number().positive().max(20).default(1),
});
export type MonsterData = z.infer<typeof monsterDataSchema>;

/* ---------------------------- oggetti e armi ----------------------------- */

const carriedThing = {
  /** Costo in monete d'oro, o nell'unità della campagna. */
  cost: z.number().nonnegative().max(10_000_000).optional(),
  /** Peso in chilogrammi. */
  weightKg: z.number().nonnegative().max(10_000).optional(),
  rarity: shortText.optional(),
  requiresAttunement: z.boolean().default(false),
  magical: z.boolean().default(false),
  description: longText.default(''),
};

export const itemDataSchema = z.object({
  ...carriedThing,
  category: shortText.optional(),
  /** Cariche, per le bacchette e simili. */
  charges: z.number().int().nonnegative().max(1000).optional(),
});
export type ItemData = z.infer<typeof itemDataSchema>;

export const weaponDataSchema = z.object({
  ...carriedThing,
  category: shortText.optional(),
  damage: damageSchema.optional(),
  /** Danno impugnandola a due mani, quando cambia. */
  versatileDamage: damageSchema.optional(),
  properties: z.array(shortText).max(20).default([]),
  /** Gittata normale e massima, in metri. */
  rangeMeters: z.number().nonnegative().max(100_000).optional(),
  longRangeMeters: z.number().nonnegative().max(100_000).optional(),
  /** Bonus magico al tiro per colpire e al danno. */
  magicBonus: z.number().int().min(-5).max(5).optional(),
  mastery: shortText.optional(),
});
export type WeaponData = z.infer<typeof weaponDataSchema>;

export const armorDataSchema = z.object({
  ...carriedThing,
  category: shortText.optional(),
  baseArmorClass: z.number().int().min(0).max(40).optional(),
  /** Quanto della destrezza si somma: null significa tutta. */
  maxDexterityBonus: z.number().int().min(0).max(20).nullable().optional(),
  /** Forza minima per non essere rallentati. */
  strengthRequirement: z.number().int().min(0).max(40).optional(),
  stealthDisadvantage: z.boolean().default(false),
  magicBonus: z.number().int().min(-5).max(5).optional(),
});
export type ArmorData = z.infer<typeof armorDataSchema>;

/* -------------------------- classi e progressione ------------------------ */

export const levelFeatureSchema = z.object({
  level: z.number().int().min(1).max(30),
  name: shortText,
  description: longText.default(''),
});

export const classDataSchema = z.object({
  hitDie: z.number().int().min(1).max(100).optional(),
  primaryAbilities: z.array(shortText).max(6).default([]),
  savingThrowProficiencies: z.array(shortText).max(6).default([]),
  armorProficiencies: z.array(shortText).max(20).default([]),
  weaponProficiencies: z.array(shortText).max(40).default([]),
  toolProficiencies: z.array(shortText).max(40).default([]),
  skillChoices: z.number().int().min(0).max(20).optional(),
  skillOptions: z.array(shortText).max(40).default([]),
  spellcastingAbility: shortText.optional(),
  features: z.array(levelFeatureSchema).max(200).default([]),
  /** A che livello si sceglie la sottoclasse. */
  subclassLevel: z.number().int().min(1).max(30).optional(),
  description: longText.default(''),
});
export type ClassData = z.infer<typeof classDataSchema>;

export const subclassDataSchema = z.object({
  /** Slug della classe a cui appartiene. */
  parentClass: shortText.optional(),
  features: z.array(levelFeatureSchema).max(200).default([]),
  description: longText.default(''),
});
export type SubclassData = z.infer<typeof subclassDataSchema>;

/* --------------------------- specie e background ------------------------- */

export const traitSchema = z.object({
  name: shortText,
  description: longText.default(''),
});

export const speciesDataSchema = z.object({
  size: shortText.optional(),
  sizeInCells: z.number().positive().max(20).default(1),
  /** Velocità base in metri. */
  speedMeters: z.number().nonnegative().max(10_000).optional(),
  darkvisionMeters: z.number().nonnegative().max(10_000).default(0),
  traits: z.array(traitSchema).max(40).default([]),
  description: longText.default(''),
});
export type SpeciesData = z.infer<typeof speciesDataSchema>;

export const backgroundDataSchema = z.object({
  abilityScores: z.array(shortText).max(6).default([]),
  feat: shortText.optional(),
  skillProficiencies: z.array(shortText).max(20).default([]),
  toolProficiency: shortText.optional(),
  equipment: z.array(shortText).max(40).default([]),
  startingGold: z.number().nonnegative().max(10_000_000).optional(),
  description: longText.default(''),
});
export type BackgroundData = z.infer<typeof backgroundDataSchema>;

export const featDataSchema = z.object({
  category: shortText.optional(),
  prerequisite: shortText.optional(),
  repeatable: z.boolean().default(false),
  benefits: z.array(traitSchema).max(20).default([]),
  description: longText.default(''),
});
export type FeatData = z.infer<typeof featDataSchema>;

/* ------------------------------- dispatch -------------------------------- */

/** La forma di `data`, scelta dal tipo della voce. */
export const LIBRARY_DATA_SCHEMAS = {
  spell: spellDataSchema,
  monster: monsterDataSchema,
  item: itemDataSchema,
  weapon: weaponDataSchema,
  armor: armorDataSchema,
  class: classDataSchema,
  subclass: subclassDataSchema,
  species: speciesDataSchema,
  background: backgroundDataSchema,
  feat: featDataSchema,
} as const satisfies Record<LibraryKind, z.ZodTypeAny>;

export type LibraryData = {
  [K in LibraryKind]: z.infer<(typeof LIBRARY_DATA_SCHEMAS)[K]>;
};

/**
 * Convalida `data` secondo il tipo della voce.
 *
 * Restituisce l'esito invece di sollevare: chi importa un pacchetto deve poter
 * dire quali voci ha scartato e perché, non fermarsi alla prima storta.
 */
export function parseLibraryData(
  kind: LibraryKind,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const result = LIBRARY_DATA_SCHEMAS[kind].safeParse(data ?? {});
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}
