import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomExpressions } from '../src/ffmpeg.js';

test('zoom expressions use zoompan frame time and filter time separately', () => {
  const expressions = zoomExpressions([{
    start: 2,
    end: 5,
    zoom: 1.2,
    target: { x: 0.75, y: 0.25 },
  }], 60);
  assert.match(expressions.z, /on\/60/);
  assert.match(expressions.tx, /0\.75000000/);
  assert.match(expressions.ty, /0\.25000000/);
  assert.match(expressions.cameraProgress, /\(t-2\.000000\)/);
  assert.doesNotMatch(expressions.cameraProgress, /on\/60/);
});

test('zoom expressions remain valid when no zooms exist', () => {
  assert.deepEqual(zoomExpressions([], 60), {
    z: '1',
    tx: '0.5',
    ty: '0.5',
    cameraProgress: '0',
  });
});
