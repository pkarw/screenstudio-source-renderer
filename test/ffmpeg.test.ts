import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { prepareRender, zoomExpressions } from '../src/ffmpeg.js';
import type { ScreenStudioProject } from '../src/types.js';

function pgmPixels(mask: Buffer): Buffer {
  const thirdNewline = mask.indexOf(10, mask.indexOf(10, mask.indexOf(10) + 1) + 1);
  return mask.subarray(thirdNewline + 1);
}

test('zoom expressions use zoompan frame time and filter time separately', () => {
  const expressions = zoomExpressions([{
    start: 2,
    end: 5,
    zoom: 1.2,
    target: { x: 0.75, y: 0.25 },
    targetSource: 'manual',
  }], 60);
  assert.match(expressions.z, /on\/60/);
  assert.match(expressions.tx, /0\.75000000/);
  assert.match(expressions.ty, /0\.25000000/);
  assert.match(expressions.cameraProgress, /\(t-2\.000000\)/);
  assert.doesNotMatch(expressions.cameraProgress, /on\/60/);
});

test('later overlapping zooms win the focal point', () => {
  const expressions = zoomExpressions([
    { start: 1, end: 6, zoom: 1.2, target: { x: 0.2, y: 0.3 }, targetSource: 'manual' },
    { start: 4, end: 5, zoom: 1.4, target: { x: 0.8, y: 0.7 }, targetSource: 'manual' },
  ], 60);
  assert.match(expressions.tx, /^if\(between\(\(on\/60\),4\.000000,5\.000000\),0\.80000000,/);
  assert.match(expressions.ty, /^if\(between\(\(on\/60\),4\.000000,5\.000000\),0\.70000000,/);
});

test('prepareRender applies square camera, color background and cursor track', async () => {
  const project: ScreenStudioProject = {
    directory: '/tmp/project.screenstudio',
    recordingDirectory: '/tmp/project.screenstudio/recording',
    name: 'fixture',
    version: 'test',
    config: { cameraSize: 0.35, cameraRoundness: 0.25, cameraPosition: 'bottom-right' },
    scene: {},
    sources: { display: ['/tmp/display.mp4'], webcam: ['/tmp/camera.mp4'], microphone: ['/tmp/audio.m4a'] },
    enhancedAudioSessions: 1,
    sessionCount: 1,
    displaySize: { width: 1920, height: 1080 },
    displayLogicalSize: { width: 1920, height: 1080 },
    slices: [{ sourceStartMs: 0, sourceEndMs: 1_000, timeScale: 1 }],
    clicks: [],
    cursorMoves: [{ timeMs: 0, x: 0.5, y: 0.5, cursorId: 'arrow' }],
    cursorDefinitions: [],
    zooms: [],
  };
  const prepared = await prepareRender(project, {
    preset: '720p', cameraCorners: 'square', cameraPosition: 'top-left', backgroundColor: '#112233', dryRun: true,
  });
  const graph = await readFile(prepared.filterFile, 'utf8');
  assert.equal(prepared.geometry.cameraRadius, 0);
  assert.equal(prepared.geometry.backgroundMode, 'color');
  assert.equal(prepared.geometry.cursorEvents, 1);
  assert.match(graph, /color=c=0x112233/);
  assert.match(graph, /ass=filename=/);
  assert.match(graph, /\*0/);
  const squarePixels = pgmPixels(await readFile(`${prepared.workDir}/camera-mask.pgm`));
  assert.ok(squarePixels.every((value) => value === 255));
  await rm(prepared.workDir, { recursive: true, force: true });
});

test('rounded camera mask has a smooth antialiased edge', async () => {
  const project: ScreenStudioProject = {
    directory: '/tmp/project.screenstudio', recordingDirectory: '/tmp/project.screenstudio/recording',
    name: 'fixture', version: 'test', config: { cameraSize: 0.35, cameraRoundness: 0.25, backgroundType: 'color', backgroundColor: '#abcdef' }, scene: {},
    sources: { display: ['/tmp/display.mp4'], webcam: ['/tmp/camera.mp4'], microphone: ['/tmp/audio.m4a'] },
    enhancedAudioSessions: 1, sessionCount: 1,
    displaySize: { width: 1920, height: 1080 }, displayLogicalSize: { width: 1920, height: 1080 },
    slices: [{ sourceStartMs: 0, sourceEndMs: 1_000, timeScale: 1 }],
    clicks: [], cursorMoves: [], cursorDefinitions: [], zooms: [],
  };
  const prepared = await prepareRender(project, {
    preset: '720p', cameraCorners: 'rounded', backgroundGradient: ['#112233', '#445566'], dryRun: true,
  });
  const pixels = pgmPixels(await readFile(`${prepared.workDir}/camera-mask.pgm`));
  assert.ok(pixels.some((value) => value > 0 && value < 255));
  assert.equal(prepared.geometry.cameraRadius, Math.round(prepared.geometry.cameraSize * 0.25 / 2) * 2);
  assert.equal(prepared.geometry.backgroundMode, 'gradient');
  await rm(prepared.workDir, { recursive: true, force: true });
});

test('zoom expressions remain valid when no zooms exist', () => {
  assert.deepEqual(zoomExpressions([], 60), {
    z: '1',
    tx: '0.5',
    ty: '0.5',
    cameraProgress: '0',
  });
});
