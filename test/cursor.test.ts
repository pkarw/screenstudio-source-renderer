import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCursorAss, resampleCursorMoves, transformCursorPoint, zoomProgressAt } from '../src/cursor.js';
import type { OutputZoom } from '../src/types.js';

const zoom: OutputZoom = {
  start: 1,
  end: 4,
  zoom: 2,
  target: { x: 0.75, y: 0.5 },
  targetSource: 'click',
};

test('zoomProgressAt eases in, holds and eases out', () => {
  assert.equal(zoomProgressAt(zoom, 0), 0);
  assert.equal(zoomProgressAt(zoom, 2), 1);
  assert.equal(zoomProgressAt(zoom, 5), 0);
});

test('transformCursorPoint follows the active zoom crop', () => {
  assert.deepEqual(transformCursorPoint({ x: 0.75, y: 0.5 }, 2, { width: 1000, height: 500, zooms: [zoom] }), { x: 500, y: 250 });
  assert.deepEqual(transformCursorPoint({ x: 0.5, y: 0.5 }, 0, { width: 1000, height: 500, zooms: [zoom] }), { x: 500, y: 250 });
});

test('buildCursorAss emits animated vector cursor events', () => {
  const ass = buildCursorAss({
    moves: [
      { time: 0, x: 0.2, y: 0.3, cursorId: 'arrow' },
      { time: 0.1, x: 0.4, y: 0.5, cursorId: 'pointingHand' },
    ],
    duration: 0.2,
    width: 1280,
    height: 720,
    logicalDisplaySize: { width: 1920, height: 1080 },
    definitions: [{ id: 'arrow', hotSpot: { x: 4, y: 4 }, standardSize: { width: 17, height: 23 }, imagePath: 'arrow.png' }],
    zooms: [],
    scale: 1,
  });
  assert.match(ass, /PlayResX: 1280/);
  assert.match(ass, /Dialogue: 10/);
  assert.match(ass, /\\move\(256\.0,216\.0,512\.0,360\.0/);
  assert.match(ass, /\\p1/);
});

test('resampleCursorMoves keeps one control point per output bucket', () => {
  const moves = [
    { time: 0, x: 0.1, y: 0.1, cursorId: 'arrow' },
    { time: 0.01, x: 0.2, y: 0.2, cursorId: 'arrow' },
    { time: 0.02, x: 0.3, y: 0.3, cursorId: 'pointingHand' },
    { time: 0.04, x: 0.4, y: 0.4, cursorId: 'pointingHand' },
  ];
  assert.deepEqual(resampleCursorMoves(moves, 30), [moves[2], moves[3]]);
  assert.deepEqual(resampleCursorMoves(moves, 0), moves);
});
