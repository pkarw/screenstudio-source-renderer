import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, formatProgress, renderBar } from '../src/progress.js';

test('formatClock formats minute and hour durations', () => {
  assert.equal(formatClock(65), '01:05');
  assert.equal(formatClock(3661), '1:01:01');
  assert.equal(formatClock(Infinity), '--:--');
});

test('renderBar clamps its input', () => {
  assert.equal(renderBar(0.5, 4), '██░░');
  assert.equal(renderBar(2, 4), '████');
});

test('formatProgress includes percent, speed and ETA', () => {
  const text = formatProgress({ elapsed: 25, total: 100, speed: 2, fps: 60, eta: 37.5 });
  assert.match(text, /25\.0%/);
  assert.match(text, /2\.00x/);
  assert.match(text, /60\.0 fps/);
  assert.match(text, /ETA 00:38/);
});
