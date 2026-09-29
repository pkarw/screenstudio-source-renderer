import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const recorderOfType = (metadata, type) => metadata.recorders.find((item) => item.type === type);

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function sourceSessions(recorder, recordingDir, enhanced = false) {
  return recorder.sessions.map((session, index) => {
    const original = path.join(recordingDir, session.outputFilename);
    const enhancedName = `${recorder.id}-${index}-enhanced.m4a`;
    return {
      ...session,
      original,
      enhanced: enhanced ? path.join(recordingDir, 'enhanced', enhancedName) : null,
    };
  });
}

function normalizedTarget(click, displaySession) {
  const bounds = displaySession.bounds;
  return {
    x: Math.max(0, Math.min(1, (click.x - bounds.x) / bounds.width)),
    y: Math.max(0, Math.min(1, (click.y - bounds.y) / bounds.height)),
  };
}

async function collectClicks(recordingDir, inputRecorder, displayRecorder) {
  const result = [];
  let sourceOffsetMs = 0;

  for (let index = 0; index < inputRecorder.sessions.length; index += 1) {
    const inputSession = inputRecorder.sessions[index];
    const displaySession = displayRecorder.sessions[index];
    const clicks = await readJson(path.join(recordingDir, inputSession.mouseClicksFilename));
    for (const click of clicks) {
      if (click.type !== 'mouseDown') continue;
      const sessionTimeMs = click.processTimeMs - inputSession.processTimeStartMs;
      result.push({
        timeMs: sourceOffsetMs + sessionTimeMs,
        ...normalizedTarget(click, displaySession),
      });
    }
    sourceOffsetMs += displaySession.durationMs;
  }
  return result.sort((a, b) => a.timeMs - b.timeMs);
}

function attachZoomTargets(ranges, clicks) {
  return ranges
    .filter((range) => !range.isDisabled)
    .map((range) => {
      const click = clicks.find((item) => item.timeMs >= range.startTime && item.timeMs <= range.endTime);
      return {
        sourceStartMs: range.startTime,
        sourceEndMs: range.endTime,
        zoom: range.zoom,
        type: range.type,
        target: click
          ? { x: click.x, y: click.y }
          : (range.manualTargetPoint ?? { x: 0.5, y: 0.5 }),
        targetSource: click ? 'click' : 'manual',
      };
    });
}

export async function loadProject(projectDir) {
  const absoluteDir = path.resolve(projectDir);
  const projectFile = path.join(absoluteDir, 'project.json');
  const recordingDir = path.join(absoluteDir, 'recording');
  const metadataFile = path.join(recordingDir, 'metadata.json');
  const metaFile = path.join(absoluteDir, 'meta.json');
  const projectEnvelope = await readJson(projectFile);
  const metadata = await readJson(metadataFile);
  const projectMeta = await readJson(metaFile);
  const project = projectEnvelope.json ?? projectEnvelope;
  const scene = project.scenes?.[0];
  if (!scene) throw new Error('Project has no scene.');

  const displayRecorder = recorderOfType(metadata, 'display');
  const webcamRecorder = recorderOfType(metadata, 'webcam');
  const microphoneRecorder = recorderOfType(metadata, 'microphone');
  const inputRecorder = recorderOfType(metadata, 'input');
  if (!displayRecorder || !webcamRecorder || !microphoneRecorder || !inputRecorder) {
    throw new Error('Project must contain display, webcam, microphone and input recorders.');
  }
  const sessionCount = displayRecorder.sessions.length;
  for (const recorder of [webcamRecorder, microphoneRecorder, inputRecorder]) {
    if (recorder.sessions.length !== sessionCount) {
      throw new Error(`Recorder ${recorder.type} has ${recorder.sessions.length} sessions; expected ${sessionCount}.`);
    }
  }

  const display = sourceSessions(displayRecorder, recordingDir);
  const webcam = sourceSessions(webcamRecorder, recordingDir);
  const microphoneCandidates = sourceSessions(microphoneRecorder, recordingDir, true);
  const microphone = [];
  for (const session of microphoneCandidates) {
    microphone.push({
      ...session,
      file: session.enhanced && await exists(session.enhanced) ? session.enhanced : session.original,
      enhancedUsed: Boolean(session.enhanced && await exists(session.enhanced)),
    });
  }

  for (const session of [...display, ...webcam, ...microphone.map((item) => ({ original: item.file }))]) {
    if (!await exists(session.original)) throw new Error(`Missing recording source: ${session.original}`);
  }

  const clicks = await collectClicks(recordingDir, inputRecorder, displayRecorder);
  const slices = (scene.slices?.length ? scene.slices : [{
    sourceStartMs: 0,
    sourceEndMs: display.reduce((sum, item) => sum + item.durationMs, 0),
    timeScale: 1,
  }]).map((slice) => ({
    sourceStartMs: slice.sourceStartMs,
    sourceEndMs: slice.sourceEndMs,
    timeScale: slice.timeScale ?? 1,
  }));

  return {
    directory: absoluteDir,
    name: project.name ?? path.basename(absoluteDir, '.screenstudio'),
    version: projectMeta.json?.version ?? projectMeta.version ?? 'unknown',
    config: project.config ?? {},
    scene,
    sources: {
      display: display.map((item) => item.original),
      webcam: webcam.map((item) => item.original),
      microphone: microphone.map((item) => item.file),
    },
    enhancedAudioSessions: microphone.filter((item) => item.enhancedUsed).length,
    sessionCount,
    displaySize: {
      width: Math.round(displayRecorder.sessions[0].bounds.width / displayRecorder.sessions[0].recordingScale),
      height: Math.round(displayRecorder.sessions[0].bounds.height / displayRecorder.sessions[0].recordingScale),
    },
    slices,
    clicks,
    zooms: attachZoomTargets(scene.zoomRanges ?? [], clicks),
  };
}
