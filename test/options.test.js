import test from 'node:test';
import assert from 'node:assert/strict';
import { outputContainer, resolveVideoGeometry, VIDEO_PRESETS } from '../src/options.js';

test('default geometry is UHD 4K at 60 fps', () => {
  assert.deepEqual(resolveVideoGeometry(), {
    preset: '4k',
    width: 3840,
    height: 2160,
    fps: 60,
  });
});

test('presets cover landscape, portrait and square output', () => {
  assert.deepEqual(VIDEO_PRESETS['1080p'], { width: 1920, height: 1080, label: 'Full HD landscape' });
  assert.deepEqual(VIDEO_PRESETS.vertical, { width: 1080, height: 1920, label: 'Full HD portrait' });
  assert.deepEqual(VIDEO_PRESETS.square, { width: 2160, height: 2160, label: 'Square 4K-height' });
});

test('custom dimensions override a preset', () => {
  assert.deepEqual(resolveVideoGeometry({ preset: '720p', width: 1000, height: 1002, fps: 30 }), {
    preset: '720p',
    width: 1000,
    height: 1002,
    fps: 30,
  });
});

test('unknown presets and unsupported containers fail early', () => {
  assert.throws(() => resolveVideoGeometry({ preset: 'cinema' }), /Unknown preset/);
  assert.equal(outputContainer('lesson.MOV'), '.mov');
  assert.equal(outputContainer('lesson.mkv'), '.mkv');
  assert.throws(() => outputContainer('lesson.webm'), /supported container/);
});
