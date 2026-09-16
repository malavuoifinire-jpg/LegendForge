import type {
  LightSource,
  SceneVisionSettings,
  SceneVisionState,
  Token,
  Wall,
  WallKind,
} from '@legendforge/contracts';
import { WALL_STYLES } from './visionLayers';

export type VisionTool = 'select' | 'wall' | 'light';

interface VisionPanelProps {
  vision: SceneVisionState;
  sceneVersion: number;
  tool: VisionTool;
  wallKind: WallKind;
  snapWalls: boolean;
  draftLength: number;
  selectedWall: Wall | null;
  selectedLight: LightSource | null;
  tokens: Token[];
  /** Pedina dagli occhi della quale il Game Master sta guardando. */
  previewTokenId: string | null;
  busy: boolean;
  onSettings: (patch: Partial<SceneVisionSettings>) => void;
  onTool: (tool: VisionTool) => void;
  onWallKind: (kind: WallKind) => void;
  onSnapWalls: (snap: boolean) => void;
  onFinishDraft: () => void;
  onCancelDraft: () => void;
  onUpdateWall: (wall: Wall, patch: { kind?: WallKind; doorState?: Wall['doorState'] }) => void;
  onDeleteWall: (wall: Wall) => void;
  onClearWalls: () => void;
  onUpdateLight: (light: LightSource, patch: Record<string, unknown>) => void;
  onDeleteLight: (light: LightSource) => void;
  onPreview: (tokenId: string | null) => void;
}

const KINDS: WallKind[] = ['opaque', 'door', 'window', 'sight_blocker', 'movement_blocker'];

const KIND_HINTS: Record<WallKind, string> = {
  opaque: 'Ferma lo sguardo e il passo.',
  door: 'Chiusa ferma tutto, aperta non ferma niente, bloccata non si apre.',
  window: 'Si vede attraverso, non si passa.',
  sight_blocker: 'Ferma lo sguardo, si attraversa: una tenda, un fumo.',
  movement_blocker: 'Si passa con lo sguardo, non con i piedi: un fossato, una ringhiera.',
};

/**
 * Pannello del buio e dei muri, riservato al Game Master.
 *
 * Tutto quello che c'è qui dentro è una modifica della scena, non una
 * preferenza del browser: chiudere la scheda non cambia niente per gli altri.
 */
export function VisionPanel({
  vision,
  sceneVersion,
  tool,
  wallKind,
  snapWalls,
  draftLength,
  selectedWall,
  selectedLight,
  tokens,
  previewTokenId,
  busy,
  onSettings,
  onTool,
  onWallKind,
  onSnapWalls,
  onFinishDraft,
  onCancelDraft,
  onUpdateWall,
  onDeleteWall,
  onClearWalls,
  onUpdateLight,
  onDeleteLight,
  onPreview,
}: VisionPanelProps) {
  const wallCount = vision.walls?.length ?? 0;
  const lightCount = vision.lights?.length ?? 0;
  void sceneVersion;

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Visione</h2>
        <span className="badge">
          {wallCount} muri · {lightCount} luci
        </span>
      </header>

      <label className="switch">
        <input
          type="checkbox"
          checked={vision.visionEnabled}
          disabled={busy}
          onChange={(event) => onSettings({ visionEnabled: event.target.checked })}
        />
        <span>Campo visivo attivo</span>
      </label>
      {!vision.visionEnabled && (
        <p className="panel__hint">
          Spento, i giocatori vedono tutta la scena. Accendilo quando hai finito di disegnare i
          muri.
        </p>
      )}

      <label className="field">
        <span className="field__label">
          Oscurità ambientale <em>{Math.round(vision.ambientDarkness * 100)}%</em>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={vision.ambientDarkness}
          disabled={busy}
          onChange={(event) => onSettings({ ambientDarkness: Number(event.target.value) })}
        />
        <span className="field__hint">
          {vision.ambientDarkness < 0.34
            ? 'Luce piena: si vede senza scurovisione.'
            : vision.ambientDarkness < 0.67
              ? 'Penombra.'
              : 'Buio: restano solo scurovisione, sensi speciali e torce.'}
        </span>
      </label>

      <label className="field">
        <span className="field__label">Portata della scena (metri)</span>
        <input
          type="number"
          min={1}
          max={10000}
          step={1}
          value={vision.sceneReachMeters}
          disabled={busy}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value) && value > 0) onSettings({ sceneReachMeters: value });
          }}
        />
        <span className="field__hint">
          Fin dove arriva lo sguardo di chi ha vista normale illimitata.
        </span>
      </label>

      {/* ------------------------------- muri -------------------------------- */}

      <h3 className="panel__subheader">Muri</h3>
      <div className="wizard__actions">
        <button
          type="button"
          className={tool === 'wall' ? 'panel__action panel__action--active' : 'panel__action'}
          onClick={() => onTool(tool === 'wall' ? 'select' : 'wall')}
        >
          {tool === 'wall' ? 'Smetti di disegnare' : 'Disegna muri'}
        </button>
        <button
          type="button"
          className={tool === 'light' ? 'panel__action panel__action--active' : 'panel__action'}
          onClick={() => onTool(tool === 'light' ? 'select' : 'light')}
        >
          {tool === 'light' ? 'Smetti' : 'Posiziona luce'}
        </button>
      </div>

      {tool === 'wall' && (
        <>
          <label className="field">
            <span className="field__label">Tipo del prossimo muro</span>
            <select
              value={wallKind}
              onChange={(event) => onWallKind(event.target.value as WallKind)}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {WALL_STYLES[kind].label}
                </option>
              ))}
            </select>
            <span className="field__hint">{KIND_HINTS[wallKind]}</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={snapWalls}
              onChange={(event) => onSnapWalls(event.target.checked)}
            />
            <span>Aggancia agli angoli della griglia</span>
          </label>
          <p className="panel__hint">
            Clicca per posare un vertice dopo l'altro. {draftLength} posati.
          </p>
          <div className="wizard__actions">
            <button
              type="button"
              className="panel__action"
              disabled={draftLength < 2 || busy}
              onClick={onFinishDraft}
            >
              Salva la spezzata
            </button>
            <button type="button" className="panel__action" onClick={onCancelDraft}>
              Annulla
            </button>
          </div>
        </>
      )}

      {selectedWall && tool === 'select' && (
        <div className="panel__box">
          <p className="panel__hint">
            {WALL_STYLES[selectedWall.kind].label} selezionato.
          </p>
          <label className="field">
            <span className="field__label">Tipo</span>
            <select
              value={selectedWall.kind}
              disabled={busy}
              onChange={(event) =>
                onUpdateWall(selectedWall, { kind: event.target.value as WallKind })
              }
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {WALL_STYLES[kind].label}
                </option>
              ))}
            </select>
          </label>
          {selectedWall.kind === 'door' && (
            <label className="field">
              <span className="field__label">Stato della porta</span>
              <select
                value={selectedWall.doorState}
                disabled={busy}
                onChange={(event) =>
                  onUpdateWall(selectedWall, {
                    doorState: event.target.value as Wall['doorState'],
                  })
                }
              >
                <option value="closed">Chiusa</option>
                <option value="open">Aperta</option>
                <option value="locked">Bloccata</option>
              </select>
            </label>
          )}
          <button
            type="button"
            className="panel__action panel__action--danger"
            disabled={busy}
            onClick={() => onDeleteWall(selectedWall)}
          >
            Elimina questo muro
          </button>
        </div>
      )}

      {wallCount > 0 && (
        <button
          type="button"
          className="panel__action panel__action--danger"
          disabled={busy}
          onClick={onClearWalls}
        >
          Cancella tutti i muri
        </button>
      )}

      {/* ------------------------------- luci -------------------------------- */}

      {selectedLight && tool === 'select' && (
        <div className="panel__box">
          <h3 className="panel__subheader">{selectedLight.name}</h3>
          <label className="switch">
            <input
              type="checkbox"
              checked={selectedLight.enabled}
              disabled={busy}
              onChange={(event) =>
                onUpdateLight(selectedLight, { enabled: event.target.checked })
              }
            />
            <span>Accesa</span>
          </label>
          <label className="field">
            <span className="field__label">Luce piena (metri)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={selectedLight.brightRadiusMeters}
              disabled={busy}
              onChange={(event) =>
                onUpdateLight(selectedLight, { brightRadiusMeters: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Penombra (metri)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={selectedLight.dimRadiusMeters}
              disabled={busy}
              onChange={(event) =>
                onUpdateLight(selectedLight, { dimRadiusMeters: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Portata da</span>
            <select
              value={selectedLight.tokenId ?? ''}
              disabled={busy}
              onChange={(event) =>
                onUpdateLight(selectedLight, { tokenId: event.target.value || null })
              }
            >
              <option value="">Ferma sulla mappa</option>
              {tokens.map((token) => (
                <option key={token.id} value={token.id}>
                  {token.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="panel__action panel__action--danger"
            disabled={busy}
            onClick={() => onDeleteLight(selectedLight)}
          >
            Elimina questa luce
          </button>
        </div>
      )}

      {/* ----------------------------- anteprima ----------------------------- */}

      <h3 className="panel__subheader">Anteprima</h3>
      <label className="field">
        <span className="field__label">Guarda con gli occhi di</span>
        <select
          value={previewTokenId ?? ''}
          onChange={(event) => onPreview(event.target.value || null)}
        >
          <option value="">Il Game Master — vede tutto</option>
          {tokens.map((token) => (
            <option key={token.id} value={token.id}>
              {token.name}
            </option>
          ))}
        </select>
        <span className="field__hint">
          In anteprima nemmeno tu ricevi i muri: stai guardando da lì.
        </span>
      </label>
    </section>
  );
}
