import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhisperArgs, subtitleOutputPaths } from '../src/subtitles.js';

test('subtitleOutputPaths supports SRT, VTT and both', () => {
  assert.deepEqual(subtitleOutputPaths('/tmp/lesson.srt', 'srt'), ['/tmp/lesson.srt']);
  assert.deepEqual(subtitleOutputPaths('/tmp/lesson', 'vtt'), ['/tmp/lesson.vtt']);
  assert.deepEqual(subtitleOutputPaths('/tmp/lesson.srt', 'both'), ['/tmp/lesson.srt', '/tmp/lesson.vtt']);
});

test('buildWhisperArgs enables local multilingual SRT and VTT output', () => {
  const args = buildWhisperArgs('/tmp/audio.wav', '/tmp/lesson', '/tmp/ggml-small.bin', {
    format: 'both',
    language: 'pl',
    prompt: 'Open Mercato, ERP',
  });
  assert.deepEqual(args.slice(0, 6), ['-m', '/tmp/ggml-small.bin', '-l', 'pl', '-of', '/tmp/lesson']);
  assert.ok(args.includes('-osrt'));
  assert.ok(args.includes('-ovtt'));
  assert.ok(args.includes('--prompt'));
  assert.ok(args.includes('-sow'));
  assert.ok(args.includes('-ml'));
  assert.equal(args.at(-1), '/tmp/audio.wav');
});
