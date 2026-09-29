import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProject } from '../src/project.js';

test('loadProject resolves a click zoom and enhanced audio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ss-project-test-'));
  const recording = path.join(root, 'recording');
  await mkdir(path.join(recording, 'enhanced'), { recursive: true });
  const touch = (name: string) => writeFile(path.join(recording, name), 'fixture');
  await Promise.all([
    touch('display.mp4'), touch('camera.mp4'), touch('mic.m4a'),
    writeFile(path.join(recording, 'enhanced', 'channel-2-microphone-0-enhanced.m4a'), 'fixture'),
  ]);
  await writeFile(path.join(root, 'meta.json'), JSON.stringify({ json: { version: '3.7.5-test' } }));
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ json: {
    name: 'fixture', config: { cameraRoundness: 0.25 }, scenes: [{
      slices: [{ sourceStartMs: 0, sourceEndMs: 10_000, timeScale: 1 }],
      zoomRanges: [
        { startTime: 1_000, endTime: 2_000, zoom: 1.2, type: 'follow-click-groups' },
        { startTime: 3_000, endTime: 4_000, zoom: 1.4, type: 'manual', manualTargetPoint: { x: 0.2, y: 0.8 } },
      ],
    }],
  } }));
  await writeFile(path.join(recording, 'mouseclicks-0.json'), JSON.stringify([
    { type: 'mouseDown', processTimeMs: 1_500, x: 500, y: 250 },
  ]));
  await writeFile(path.join(recording, 'mousemoves-0.json'), JSON.stringify([
    { type: 'mouseMoved', processTimeMs: 500, x: 250, y: 125, cursorId: 'arrow' },
  ]));
  await writeFile(path.join(recording, 'cursors.json'), JSON.stringify([
    { id: 'arrow', hotSpot: { x: 4, y: 4 }, standardSize: { width: 17, height: 23 } },
  ]));
  await writeFile(path.join(recording, 'metadata.json'), JSON.stringify({ recorders: [
    { type: 'display', sessions: [{ outputFilename: 'display.mp4', durationMs: 10_000, processTimeStartMs: 0, bounds: { x: 0, y: 0, width: 1_000, height: 500 }, recordingScale: 0.5 }] },
    { type: 'webcam', sessions: [{ outputFilename: 'camera.mp4', durationMs: 10_000 }] },
    { id: 'channel-2-microphone', type: 'microphone', sessions: [{ outputFilename: 'mic.m4a', durationMs: 10_000 }] },
    { type: 'input', sessions: [{ mouseClicksFilename: 'mouseclicks-0.json', mouseMovesFilename: 'mousemoves-0.json', processTimeStartMs: 0, durationMs: 10_000 }] },
  ] }));

  const project = await loadProject(root);
  assert.equal(project.version, '3.7.5-test');
  assert.equal(project.enhancedAudioSessions, 1);
  assert.deepEqual(project.displaySize, { width: 2_000, height: 1_000 });
  assert.equal(project.zooms[0]?.targetSource, 'click');
  assert.deepEqual(project.zooms[0]?.target, { x: 0.5, y: 0.5 });
  assert.equal(project.zooms[1]?.targetSource, 'manual');
  assert.deepEqual(project.zooms[1]?.target, { x: 0.2, y: 0.8 });
  assert.deepEqual(project.cursorMoves, [{ timeMs: 500, x: 0.25, y: 0.25, cursorId: 'arrow' }]);
  assert.equal(project.cursorDefinitions[0]?.id, 'arrow');
});
