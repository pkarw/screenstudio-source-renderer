import test from 'node:test';
import assert from 'node:assert/strict';
import { clipSlices, durationOfSlices, mapZoomsThroughSlices } from '../src/timeline.js';

test('durationOfSlices respects cuts and speed', () => {
  const slices = [
    { sourceStartMs: 0, sourceEndMs: 10_000, timeScale: 1 },
    { sourceStartMs: 20_000, sourceEndMs: 30_000, timeScale: 2 },
  ];
  assert.equal(durationOfSlices(slices), 15);
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
    target: { x: 0.8, y: 0.2 },
    targetSource: 'click',
  }];
  assert.deepEqual(mapZoomsThroughSlices(zooms, slices), [{
    start: 6,
    end: 8,
    zoom: 1.2,
    target: { x: 0.8, y: 0.2 },
    targetSource: 'click',
  }]);
});
