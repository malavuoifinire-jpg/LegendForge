import { useState } from 'react';
import type { GridState } from '@legendforge/contracts';
import {
  calibrateFromTwoPoints,
  cellsToMeters,
  metersToCells,
  type GridConfiguration,
  type ImagePoint,
} from '@legendforge/core';

interface CalibrationPanelProps {
  grid: GridState;
  gridVisible: boolean;
  detectionConfidence: number | null;
  saving: boolean;
  picking: boolean;
  pickedPoints: ImagePoint[];
  onToggleVisible: (visible: boolean) => void;
  onPreview: (patch: Partial<GridConfiguration>) => void;
  onSave: (patch: Partial<GridConfiguration>, confirm?: boolean) => void;
  onStartPicking: () => void;
  onCancelPicking: () => void;
}

export function CalibrationPanel({
  grid,
  gridVisible,
  detectionConfidence,
  saving,
  picking,
  pickedPoints,
  onToggleVisible,
  onPreview,
  onSave,
  onStartPicking,
  onCancelPicking,
}: CalibrationPanelProps) {
  const [cellsBetween, setCellsBetween] = useState(5);
  const first = pickedPoints[0];
  const second = pickedPoints[1];
  const calibration =
    first && second ? calibrateFromTwoPoints(first, second, cellsBetween) : null;

  const statusLabel: Record<GridState['status'], string> = {
    unconfigured: 'da configurare',
    suggested: 'proposta dal rilevamento',
    confirmed: 'confermata',
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Griglia</h2>
        <span className={`chip chip--${grid.status}`}>{statusLabel[grid.status]}</span>
      </header>

      {detectionConfidence !== null && grid.status !== 'confirmed' && (
        <p className="panel__hint">
          Confidenza del rilevamento: {Math.round(detectionConfidence * 100)}%.{' '}
          {detectionConfidence < 0.55
            ? 'Troppo bassa per fidarsi: calibra a mano.'
            : 'Controlla la sovrapposizione prima di confermare.'}
        </p>
      )}

      <label className="toggle">
        <input
          type="checkbox"
          checked={gridVisible}
          onChange={(event) => onToggleVisible(event.target.checked)}
        />
        <span>Mostra la griglia</span>
      </label>

      <Slider
        label="Lato della casella"
        unit="px"
        min={8}
        max={400}
        step={0.5}
        value={grid.cellSizePx}
        onInput={(cellSizePx) => onPreview({ cellSizePx })}
        onCommit={(cellSizePx) => onSave({ cellSizePx })}
      />
      <Slider
        label="Offset orizzontale"
        unit="px"
        min={-400}
        max={400}
        step={0.5}
        value={grid.offsetX}
        onInput={(offsetX) => onPreview({ offsetX })}
        onCommit={(offsetX) => onSave({ offsetX })}
      />
      <Slider
        label="Offset verticale"
        unit="px"
        min={-400}
        max={400}
        step={0.5}
        value={grid.offsetY}
        onInput={(offsetY) => onPreview({ offsetY })}
        onCommit={(offsetY) => onSave({ offsetY })}
      />
      <Slider
        label="Rotazione"
        unit="°"
        min={-15}
        max={15}
        step={0.05}
        value={grid.rotationDeg}
        onInput={(rotationDeg) => onPreview({ rotationDeg })}
        onCommit={(rotationDeg) => onSave({ rotationDeg })}
      />
      <Slider
        label="Metri per casella"
        unit="m"
        min={0.5}
        max={6}
        step={0.1}
        value={grid.metersPerCell}
        onInput={(metersPerCell) => onPreview({ metersPerCell })}
        onCommit={(metersPerCell) => onSave({ metersPerCell })}
      />

      <label className="toggle">
        <input
          type="checkbox"
          checked={grid.snapEnabled}
          onChange={(event) => onSave({ snapEnabled: event.target.checked })}
        />
        <span>Aggancia le pedine alla griglia</span>
      </label>

      <div className="wizard">
        <h3>Calibrazione da due incroci</h3>
        {!picking && (
          <>
            <p className="panel__hint">
              Se il rilevamento sbaglia: indica due incroci della griglia sulla stessa riga o sulla
              stessa colonna, e quante caselle li separano.
            </p>
            <button type="button" className="panel__action" onClick={onStartPicking}>
              Indica due incroci
            </button>
          </>
        )}

        {picking && (
          <>
            <p className="panel__hint">
              Punti indicati: {pickedPoints.length} su 2. Clicca sulla mappa.
            </p>
            <label className="field">
              <span className="field__label">
                Caselle fra i due punti <output>{cellsBetween}</output>
              </span>
              <input
                type="range"
                min={1}
                max={30}
                step={1}
                value={cellsBetween}
                onChange={(event) => setCellsBetween(Number(event.target.value))}
              />
            </label>
            {calibration && (
              <dl className="kv kv--compact">
                <dt>Lato risultante</dt>
                <dd className="kv__value">{calibration.cellSizePx.toFixed(1)} px</dd>
                <dt>Rotazione</dt>
                <dd className="kv__value">{calibration.rotationDeg.toFixed(2)}°</dd>
              </dl>
            )}
            <div className="wizard__actions">
              <button type="button" className="panel__action" onClick={onCancelPicking}>
                Annulla
              </button>
              <button
                type="button"
                className="primary"
                disabled={!calibration || saving}
                onClick={() => calibration && onSave(calibration)}
              >
                Applica
              </button>
            </div>
          </>
        )}
      </div>

      <dl className="kv kv--compact">
        <dt>Una casella</dt>
        <dd className="kv__value">{round(cellsToMeters(1, grid))} m</dd>
        <dt>Scurovisione</dt>
        <dd className="kv__value">
          18 m = {round(metersToCells(18, grid))} · 36 m = {round(metersToCells(36, grid))} caselle
        </dd>
      </dl>

      {grid.status !== 'confirmed' && (
        <button
          type="button"
          className="primary panel__wide"
          disabled={saving}
          onClick={() => onSave({}, true)}
        >
          Confermo: una casella vale {round(cellsToMeters(1, grid))} metri
        </button>
      )}
    </section>
  );
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

interface SliderProps {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (value: number) => void;
  onCommit: (value: number) => void;
}

/**
 * Cursore che aggiorna l'anteprima a ogni movimento ma salva solo al rilascio:
 * trascinare non deve generare una richiesta per pixel.
 */
function Slider({ label, unit, min, max, step, value, onInput, onCommit }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider__label">
        {label}
        <output>
          {Number(value.toFixed(2))} {unit}
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onInput(Number(event.target.value))}
        onPointerUp={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
      />
    </label>
  );
}
