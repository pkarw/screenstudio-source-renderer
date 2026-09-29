export function durationOfSlices(slices) {
  return slices.reduce((sum, slice) => (
    sum + (slice.sourceEndMs - slice.sourceStartMs) / (slice.timeScale ?? 1)
  ), 0) / 1000;
}

export function clipSlices(slices, startSeconds = 0, durationSeconds = Infinity) {
  const wantedStartMs = Math.max(0, startSeconds * 1000);
  const wantedEndMs = Number.isFinite(durationSeconds)
    ? wantedStartMs + Math.max(0, durationSeconds * 1000)
    : Infinity;
  const result = [];
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

export function mapZoomsThroughSlices(zooms, slices) {
  const mapped = [];
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
      });
    }
    outputCursorMs += (slice.sourceEndMs - slice.sourceStartMs) / scale;
  }
  return mapped;
}
