import type {
  OutputCursorMove,
  OutputZoom,
  SourceCursorMove,
  SourceZoom,
  TimelineSlice,
} from './types.js';

export function durationOfSlices(slices: TimelineSlice[]): number {
  return slices.reduce((sum, slice) => (
    sum + (slice.sourceEndMs - slice.sourceStartMs) / (slice.timeScale ?? 1)
  ), 0) / 1000;
}

export function clipSlices(slices: TimelineSlice[], startSeconds = 0, durationSeconds = Infinity): TimelineSlice[] {
  const wantedStartMs = Math.max(0, startSeconds * 1000);
  const wantedEndMs = Number.isFinite(durationSeconds)
    ? wantedStartMs + Math.max(0, durationSeconds * 1000)
    : Infinity;
  const result: TimelineSlice[] = [];
  let outputCursorMs = 0;

  for (const slice of slices) {
    const scale = slice.timeScale ?? 1;
    const sliceOutputDurationMs = (slice.sourceEndMs - slice.sourceStartMs) / scale;
    const sliceOutputStartMs = outputCursorMs;
    const sliceOutputEndMs = outputCursorMs + sliceOutputDurationMs;
    const overlapStartMs = Math.max(wantedStartMs, sliceOutputStartMs);
    const overlapEndMs = Math.min(wantedEndMs, sliceOutputEndMs);
    if (overlapEndMs > overlapStartMs) {
      result.push({
        ...slice,
        sourceStartMs: slice.sourceStartMs + (overlapStartMs - sliceOutputStartMs) * scale,
        sourceEndMs: slice.sourceStartMs + (overlapEndMs - sliceOutputStartMs) * scale,
        timeScale: scale,
      });
    }
    outputCursorMs = sliceOutputEndMs;
    if (outputCursorMs >= wantedEndMs) break;
  }
  return result;
}

export function mapZoomsThroughSlices(zooms: SourceZoom[], slices: TimelineSlice[]): OutputZoom[] {
  const mapped: OutputZoom[] = [];
  let outputCursorMs = 0;
  for (const slice of slices) {
    const scale = slice.timeScale ?? 1;
    for (const zoom of zooms) {
      const overlapStartMs = Math.max(slice.sourceStartMs, zoom.sourceStartMs);
      const overlapEndMs = Math.min(slice.sourceEndMs, zoom.sourceEndMs);
      if (overlapEndMs <= overlapStartMs) continue;
      mapped.push({
        start: (outputCursorMs + (overlapStartMs - slice.sourceStartMs) / scale) / 1000,
        end: (outputCursorMs + (overlapEndMs - slice.sourceStartMs) / scale) / 1000,
        zoom: zoom.zoom,
        target: zoom.target,
        targetSource: zoom.targetSource,
        ...(zoom.instant === undefined ? {} : { instant: zoom.instant }),
      });
    }
    outputCursorMs += (slice.sourceEndMs - slice.sourceStartMs) / scale;
  }
  return mapped;
}

export function mapCursorMovesThroughSlices(
  moves: SourceCursorMove[],
  slices: TimelineSlice[],
): OutputCursorMove[] {
  const mapped: OutputCursorMove[] = [];
  let outputCursorMs = 0;

  for (const slice of slices) {
    const scale = slice.timeScale ?? 1;
    const outputDurationMs = (slice.sourceEndMs - slice.sourceStartMs) / scale;
    if (!slice.hideCursor) {
      let prior: SourceCursorMove | undefined;
      for (let index = moves.length - 1; index >= 0; index -= 1) {
        const candidate = moves[index];
        if (candidate && candidate.timeMs <= slice.sourceStartMs) {
          prior = candidate;
          break;
        }
      }
      if (prior) mapped.push({ time: outputCursorMs / 1000, x: prior.x, y: prior.y, cursorId: prior.cursorId });
      for (const move of moves) {
        if (move.timeMs < slice.sourceStartMs) continue;
        if (move.timeMs >= slice.sourceEndMs) break;
        mapped.push({
          time: (outputCursorMs + (move.timeMs - slice.sourceStartMs) / scale) / 1000,
          x: move.x,
          y: move.y,
          cursorId: move.cursorId,
        });
      }
    }
    outputCursorMs += outputDurationMs;
  }

  return mapped
    .sort((a, b) => a.time - b.time)
    .filter((move, index, all) => index === 0 || move.time > (all[index - 1]?.time ?? -1));
}
