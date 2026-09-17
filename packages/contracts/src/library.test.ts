import { describe, expect, it } from 'vitest';
import {
  LIBRARY_KIND_LABELS,
  libraryKindSchema,
  parseLibraryData,
  spellDataSchema,
} from './library.js';
import { contentPackFileSchema } from './index.js';

describe('forme dei contenuti', () => {
  it('ogni tipo ha unetichetta e uno schema che accetta una voce vuota', () => {
    for (const kind of libraryKindSchema.options) {
      expect(LIBRARY_KIND_LABELS[kind].one.length).toBeGreaterThan(0);
      expect(LIBRARY_KIND_LABELS[kind].many.length).toBeGreaterThan(0);
      // Tutti tranne gli incantesimi, che senza livello non vogliono dire niente.
      if (kind !== 'spell') expect(parseLibraryData(kind, {}).ok).toBe(true);
    }
  });

  it('a un incantesimo basta il livello', () => {
    expect(parseLibraryData('spell', { level: 3 }).ok).toBe(true);
    expect(parseLibraryData('spell', {}).ok).toBe(false);
  });

  it('rifiuta un livello impossibile spiegando dove', () => {
    const esito = parseLibraryData('spell', { level: 12 });
    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.issues.join(' ')).toContain('level');
  });

  it('i valori assenti prendono il loro default', () => {
    const spell = spellDataSchema.parse({ level: 0 });
    expect(spell.concentration).toBe(false);
    expect(spell.ritual).toBe(false);
    expect(spell.classes).toEqual([]);
    expect(spell.description).toBe('');
  });

  it('la notazione dei dadi viene controllata', () => {
    expect(parseLibraryData('monster', { hitDice: '8d10+16' }).ok).toBe(true);
    expect(parseLibraryData('monster', { hitDice: 'otto dadi' }).ok).toBe(false);
  });

  it('un mostro inventato a meta si salva lo stesso', () => {
    // E il caso normale: il Game Master scrive due righe e va avanti.
    expect(parseLibraryData('monster', { creatureType: 'aberrazione', hitPoints: 30 }).ok).toBe(
      true,
    );
  });

  it('i campi personalizzati accettano testo, numeri, booleani e niente', () => {
    const pacchetto = contentPackFileSchema.safeParse({
      format: 'legendforge-pack',
      schemaVersion: 1,
      slug: 'prova',
      name: 'Prova',
      license: 'CC-BY-4.0',
      entries: [
        {
          kind: 'item',
          name: 'Corda',
          slug: 'corda',
          custom: { origine: 'nanica', lunghezzaMetri: 15, benedetta: true, note: null },
        },
      ],
    });
    expect(pacchetto.success).toBe(true);
  });
});

describe('formato dei pacchetti', () => {
  it('licenza e attribuzione viaggiano con il contenuto', () => {
    const esito = contentPackFileSchema.safeParse({
      format: 'legendforge-pack',
      schemaVersion: 1,
      slug: 'srd-5-2-1',
      name: 'SRD 5.2.1',
      license: 'CC-BY-4.0',
      attribution: 'This work includes material from the SRD 5.2 by Wizards of the Coast LLC.',
      sourceUrl: 'https://www.dndbeyond.com/srd',
      entries: [],
    });
    expect(esito.success).toBe(true);
    if (esito.success) {
      expect(esito.data.license).toBe('CC-BY-4.0');
      expect(esito.data.packVersion).toBe('1');
    }
  });

  it('un pacchetto senza licenza dichiarata viene rifiutato', () => {
    const esito = contentPackFileSchema.safeParse({
      format: 'legendforge-pack',
      schemaVersion: 1,
      slug: 'anonimo',
      name: 'Anonimo',
      entries: [],
    });
    expect(esito.success).toBe(false);
  });

  it('uno slug con spazi viene rifiutato', () => {
    const esito = contentPackFileSchema.safeParse({
      format: 'legendforge-pack',
      schemaVersion: 1,
      slug: 'con spazi',
      name: 'X',
      license: 'proprio',
      entries: [],
    });
    expect(esito.success).toBe(false);
  });
});
