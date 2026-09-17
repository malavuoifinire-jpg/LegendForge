import { useState } from 'react';
import {
  LIBRARY_KIND_LABELS,
  type CustomFields,
  type LibraryEntry,
} from '@legendforge/contracts';

interface EntryDetailProps {
  entry: LibraryEntry;
  canEdit: boolean;
  busy: boolean;
  onSave: (patch: { name?: string; data?: unknown; custom?: CustomFields }) => void;
  onCopy: () => void;
  onDelete: () => void;
}

/**
 * Scheda di una voce di libreria.
 *
 * La lettura mostra i campi che contano per quel tipo; la modifica apre il
 * dato grezzo. Non è pigrizia: i contenuti sono di chi gioca, e un modulo con
 * una casella per ogni campo previsto sarebbe una gabbia proprio dove serve
 * più libertà. Quello che si scrive viene comunque convalidato dal server, che
 * risponde dicendo quale campo non gli torna.
 */
export function EntryDetail({ entry, canEdit, busy, onSave, onCopy, onDelete }: EntryDetailProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [raw, setRaw] = useState(() => JSON.stringify(entry.data ?? {}, null, 2));
  const [customRaw, setCustomRaw] = useState(() => JSON.stringify(entry.custom ?? {}, null, 2));
  const [localError, setLocalError] = useState<string | null>(null);

  const start = (): void => {
    setName(entry.name);
    setRaw(JSON.stringify(entry.data ?? {}, null, 2));
    setCustomRaw(JSON.stringify(entry.custom ?? {}, null, 2));
    setLocalError(null);
    setEditing(true);
  };

  const save = (): void => {
    let data: unknown;
    let custom: CustomFields;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      setLocalError('I dati non sono JSON valido.');
      return;
    }
    try {
      custom = JSON.parse(customRaw) as CustomFields;
    } catch {
      setLocalError('I campi personalizzati non sono JSON valido.');
      return;
    }
    setLocalError(null);
    onSave({ name: name.trim() || entry.name, data, custom });
    setEditing(false);
  };

  const label = LIBRARY_KIND_LABELS[entry.kind].one;

  return (
    <section className="panel entry">
      <header className="panel__header">
        <h2>{entry.name}</h2>
        <span className="badge">{label}</span>
      </header>
      {entry.originalName && entry.originalName !== entry.name && (
        <p className="entry__original">{entry.originalName}</p>
      )}
      {entry.readOnly && (
        <p className="panel__hint">
          Arriva da un pacchetto: per cambiarla, fanne una copia tua.
        </p>
      )}

      {!editing && <EntrySummary entry={entry} />}

      {editing && (
        <>
          <label className="field">
            <span className="field__label">Nome</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Dati</span>
            <textarea
              className="entry__code"
              rows={16}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              spellCheck={false}
            />
            <span className="field__hint">
              La forma dipende dal tipo. Il server la controlla e dice quale campo non gli torna.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Campi tuoi</span>
            <textarea
              className="entry__code"
              rows={5}
              value={customRaw}
              onChange={(event) => setCustomRaw(event.target.value)}
              spellCheck={false}
            />
            <span className="field__hint">
              Testo, numeri o vero/falso. Quello che ti serve e non era previsto.
            </span>
          </label>
          {localError && <p className="gate__error">{localError}</p>}
        </>
      )}

      {canEdit && (
        <div className="wizard__actions">
          {!editing && !entry.readOnly && (
            <button type="button" className="panel__action" onClick={start} disabled={busy}>
              Modifica
            </button>
          )}
          {editing && (
            <>
              <button type="button" className="panel__action" onClick={save} disabled={busy}>
                Salva
              </button>
              <button type="button" className="panel__action" onClick={() => setEditing(false)}>
                Annulla
              </button>
            </>
          )}
          {!editing && (
            <button type="button" className="panel__action" onClick={onCopy} disabled={busy}>
              Fanne una copia
            </button>
          )}
          {!editing && !entry.readOnly && (
            <button
              type="button"
              className="panel__action panel__action--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Eliminare "${entry.name}"?`)) onDelete();
              }}
            >
              Elimina
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* --------------------------------- lettura -------------------------------- */

type Bag = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'sì' : null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return null;
}

/** I campi che vale la pena leggere per primi, per ciascun tipo. */
const HEADLINE: Partial<Record<LibraryEntry['kind'], [string, string][]>> = {
  spell: [
    ['level', 'Livello'],
    ['school', 'Scuola'],
    ['castingTime', 'Tempo di lancio'],
    ['range', 'Gittata'],
    ['duration', 'Durata'],
  ],
  monster: [
    ['size', 'Taglia'],
    ['creatureType', 'Tipo'],
    ['armorClass', 'Classe armatura'],
    ['hitPoints', 'Punti ferita'],
    ['challengeRating', 'Grado di sfida'],
  ],
  weapon: [
    ['category', 'Categoria'],
    ['mastery', 'Maestria'],
    ['cost', 'Costo (mo)'],
    ['weightKg', 'Peso (kg)'],
  ],
  armor: [
    ['category', 'Categoria'],
    ['baseArmorClass', 'Classe armatura'],
    ['strengthRequirement', 'Forza richiesta'],
    ['cost', 'Costo (mo)'],
  ],
  item: [
    ['category', 'Categoria'],
    ['rarity', 'Rarità'],
    ['charges', 'Cariche'],
  ],
  class: [
    ['hitDie', 'Dado vita'],
    ['spellcastingAbility', 'Caratteristica da incantatore'],
    ['subclassLevel', 'Sottoclasse al livello'],
  ],
  species: [
    ['size', 'Taglia'],
    ['speedMeters', 'Velocità (m)'],
    ['darkvisionMeters', 'Scurovisione (m)'],
  ],
  feat: [
    ['category', 'Categoria'],
    ['prerequisite', 'Prerequisito'],
  ],
  background: [['feat', 'Talento']],
  subclass: [['parentClass', 'Classe']],
};

function EntrySummary({ entry }: { entry: LibraryEntry }) {
  const data = (entry.data ?? {}) as Bag;
  const rows = (HEADLINE[entry.kind] ?? [])
    .map(([key, label]) => [label, text(data[key])] as const)
    .filter((row): row is readonly [string, string] => row[1] !== null);

  const damage = data.damage as { dice?: string; type?: string } | undefined;
  if (damage?.dice) rows.push(['Danno', `${damage.dice} ${damage.type ?? ''}`.trim()]);
  if (typeof data.rangeMeters === 'number') rows.push(['Gittata', `${data.rangeMeters} m`]);
  if (data.concentration === true) rows.push(['Concentrazione', 'sì']);
  if (data.ritual === true) rows.push(['Rituale', 'sì']);
  if (typeof data.savingThrow === 'string') rows.push(['Tiro salvezza', data.savingThrow]);

  const classes = Array.isArray(data.classes) ? (data.classes as string[]) : [];
  const speeds = (data.speeds ?? {}) as Record<string, number>;
  const senses = (data.senses ?? {}) as Record<string, number>;
  const features = Array.isArray(data.features) ? (data.features as Bag[]) : [];
  const traits = Array.isArray(data.traits) ? (data.traits as Bag[]) : [];
  const actions = Array.isArray(data.actions) ? (data.actions as Bag[]) : [];
  const custom = Object.entries(entry.custom ?? {});

  return (
    <>
      {rows.length > 0 && (
        <dl className="kv kv--compact">
          {rows.map(([label, value]) => (
            <div key={label} className="kv__row">
              <dt>{label}</dt>
              <dd className="kv__value">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {classes.length > 0 && (
        <p className="entry__tags">
          {classes.map((name) => (
            <span key={name} className="chip">
              {name}
            </span>
          ))}
        </p>
      )}

      {Object.keys(speeds).length > 0 && (
        <p className="panel__hint">
          Velocità: {Object.entries(speeds).map(([k, v]) => `${k} ${v} m`).join(' · ')}
        </p>
      )}
      {Object.keys(senses).length > 0 && (
        <p className="panel__hint">
          Sensi: {Object.entries(senses).map(([k, v]) => `${k} ${v} m`).join(' · ')}
        </p>
      )}

      {typeof data.description === 'string' && data.description && (
        <div className="entry__body">
          {data.description.split('\n\n').map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      )}

      {typeof data.atHigherLevels === 'string' && data.atHigherLevels && (
        <p className="entry__body entry__body--note">
          <strong>A livelli superiori.</strong> {data.atHigherLevels}
        </p>
      )}

      <EntryList title="Tratti" items={traits} />
      <EntryList title="Azioni" items={actions} />
      {features.length > 0 && (
        <details className="entry__more">
          <summary>{features.length} privilegi di livello</summary>
          {features.map((feature, index) => (
            <p key={index}>
              <strong>
                Livello {String(feature.level)}: {String(feature.name)}
              </strong>{' '}
              {String(feature.description ?? '').slice(0, 400)}
            </p>
          ))}
        </details>
      )}

      {custom.length > 0 && (
        <dl className="kv kv--compact">
          {custom.map(([key, value]) => (
            <div key={key} className="kv__row">
              <dt>{key}</dt>
              <dd className="kv__value">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

function EntryList({ title, items }: { title: string; items: Bag[] }) {
  if (items.length === 0) return null;
  return (
    <div className="entry__body">
      <h3 className="panel__subheader">{title}</h3>
      {items.map((item, index) => (
        <p key={index}>
          <strong>{String(item.name)}.</strong> {String(item.description ?? '')}
        </p>
      ))}
    </div>
  );
}
