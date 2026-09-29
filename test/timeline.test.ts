import test from 'node:test';
import assert from 'node:assert/strict';
import { clipSlices, durationOfSlices, mapCursorMovesThroughSlices, mapZoomsThroughSlices } from '../src/timeline.js';

test('durationOfSlices respects cuts and speed', () => {
  const slices = [
    { sourceStartMs: 0, sourceEndMs: 10_000, timeScale: 1 },
    { sourceStartMs: 20_000, sourceEndMs: 30_000, timeScale: 2 },
  ];
  assert.equal(durationOfSlices(slices), 15);
});

test('mapCursorMovesThroughSlices maps cursor time and honors hidden slices', () => {
  const moves = [
    { timeMs: 100, x: 0.1, y: 0.2, cursorId: 'arrow' },
    { timeMs: 1_100, x: 0.3, y: 0.4, cursorId: 'pointingHand' },
    { timeMs: 2_100, x: 0.5, y: 0.6, cursorId: 'arrow' },
  ];
  const mapped = mapCursorMovesThroughSlices(moves, [
    { sourceStartMs: 1_000, sourceEndMs: 2_000, timeScale: 1, hideCursor: false },
    { sourceStartMs: 2_000, sourceEndMs: 3_000, timeScale: 1, hideCursor: true },
  ]);
  assert.deepEqual(mapped, [
    { time: 0, x: 0.1, y: 0.2, cursorId: 'arrow' },
    { time: 0.1, x: 0.3, y: 0.4, cursorId: 'pointingHand' },
  ]);
});

test('clipSlices maps a preview range back to source time', () => {
  const slices = [
    { sourceStartMs: 0, sourceEndMs: 10_000, timeScale: 1 },
    { sourceStartMs: 20_000, sourceEndMs: 30_000, timeScale: 2 },
  ];
  assert.deepEqual(clipSlices(slices, 8, 5), [
    { sourceStartMs: 8_000, sourceEndMs: 10_000, timeScale: 1 },
    { sourceStartMs: 20_000, sourceEndMs: 26_000, timeScale: 2 },
  ]);
});

test('mapZoomsThroughSlices removes deleted time', () => {
  const slices = [
    { sourceStartMs: 0, sourceEndMs: 5_000, timeScale: 1 },
    { sourceStartMs: 10_000, sourceEndMs: 15_000, timeScale: 1 },
  ];
  const zooms = [{
    sourceStartMs: 11_000,
    sourceEndMs: 13_000,
    zoom: 1.2,
    type: 'follow-click-groups',
    target: { x: 0.8, y: 0.2 },
    targetSource: 'click' as const,
  }];
  assert.deepEqual(mapZoomsThroughSlices(zooms, slices), [{
    start: 6,
    end: 8,
    zoom: 1.2,
    target: { x: 0.8, y: 0.2 },
    targetSource: 'click',
  }]);
});
