import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CursorDefinition,
  Point,
  ProjectConfig,
  ScreenStudioProject,
  SourceClick,
  SourceCursorMove,
  SourceZoom,
  TimelineSlice,
} from './types.js';

interface RecorderSession {
  outputFilename?: string;
  mouseClicksFilename?: string;
  mouseMovesFilename?: string;
  processTimeStartMs?: number;
  durationMs: number;
  recordingScale?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface Recorder {
  id?: string;
  type: string;
  sessions: RecorderSession[];
}

interface RecordingMetadata {
  recorders: Recorder[];
}

interface RawPointerEvent extends Point {
  type: string;
  processTimeMs: number;
  cursorId?: string;
}

interface RawZoomRange {
  startTime: number;
  endTime: number;
  zoom: number;
  type: string;
  isDisabled?: boolean;
  hasInstantAnimation?: boolean;
  manualTargetPoint?: Point;
}

interface RawSlice {
  sourceStartMs: number;
  sourceEndMs: number;
  timeScale?: number;
  hideCursor?: boolean;
}

interface RawScene extends Record<string, unknown> {
  slices?: RawSlice[];
  zoomRanges?: RawZoomRange[];
}

interface RawProject {
  name?: string;
  config?: ProjectConfig;
  scenes?: RawScene[];
}

interface ProjectEnvelope {
  json?: RawProject;
  name?: string;
  config?: ProjectConfig;
  scenes?: RawScene[];
}

interface ProjectMetaEnvelope {
  json?: { version?: string };
  version?: string;
}

interface RawCursorDefinition {
  id: string;
  hotSpot: Point;
  standardSize: { width: number; height: number };
}

interface ResolvedSourceSession extends RecorderSession {
  original: string;
  enhanced: string | null;
}

const recorderOfType = (metadata: RecordingMetadata, type: string): Recorder | undefined => (
  metadata.recorders.find((item) => item.type === type)
);

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, 'utf8')) as T;
}

function sourceSessions(recorder: Recorder, recordingDir: string, enhanced = false): ResolvedSourceSession[] {
  return recorder.sessions.map((session, index) => {
    if (!session.outputFilename) throw new Error(`Recorder ${recorder.type} session ${index} has no output filename.`);
    const original = path.join(recordingDir, session.outputFilename);
    const enhancedName = `${recorder.id ?? 'microphone'}-${index}-enhanced.m4a`;
    return {
      ...session,
      original,
      enhanced: enhanced ? path.join(recordingDir, 'enhanced', enhancedName) : null,
    };
  });
}

function normalizedTarget(event: Point, displaySession: RecorderSession): Point {
  const bounds = displaySession.bounds;
  if (!bounds) throw new Error('Display session is missing bounds.');
  return {
    x: Math.max(0, Math.min(1, (event.x - bounds.x) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.y - bounds.y) / bounds.height)),
  };
}

async function collectPointerData(
  recordingDir: string,
  inputRecorder: Recorder,
  displayRecorder: Recorder,
): Promise<{ clicks: SourceClick[]; cursorMoves: SourceCursorMove[] }> {
  const clicks: SourceClick[] = [];
  const cursorMoves: SourceCursorMove[] = [];
  let sourceOffsetMs = 0;

  for (let index = 0; index < inputRecorder.sessions.length; index += 1) {
    const inputSession = inputRecorder.sessions[index];
    const displaySession = displayRecorder.sessions[index];
    if (!inputSession || !displaySession) throw new Error(`Missing pointer/display session ${index}.`);
    const processStart = inputSession.processTimeStartMs ?? 0;
    if (inputSession.mouseClicksFilename) {
      const events = await readJson<RawPointerEvent[]>(path.join(recordingDir, inputSession.mouseClicksFilename));
      for (const event of events) {
        if (event.type !== 'mouseDown') continue;
        clicks.push({
          timeMs: sourceOffsetMs + event.processTimeMs - processStart,
          ...normalizedTarget(event, displaySession),
        });
      }
    }
    if (inputSession.mouseMovesFilename) {
      const events = await readJson<RawPointerEvent[]>(path.join(recordingDir, inputSession.mouseMovesFilename));
      for (const event of events) {
        cursorMoves.push({
          timeMs: sourceOffsetMs + event.processTimeMs - processStart,
          cursorId: event.cursorId ?? 'arrow',
          ...normalizedTarget(event, displaySession),
        });
      }
    }
    sourceOffsetMs += displaySession.durationMs;
  }
  return {
    clicks: clicks.sort((a, b) => a.timeMs - b.timeMs),
    cursorMoves: cursorMoves.sort((a, b) => a.timeMs - b.timeMs),
  };
}

function attachZoomTargets(ranges: RawZoomRange[], clicks: SourceClick[]): SourceZoom[] {
  return ranges
    .filter((range) => !range.isDisabled)
    .map((range) => {
      const followsClicks = range.type === 'follow-click-groups';
      const click = followsClicks
        ? clicks.find((item) => item.timeMs >= range.startTime && item.timeMs <= range.endTime)
        : undefined;
      return {
        sourceStartMs: range.startTime,
        sourceEndMs: range.endTime,
        zoom: range.zoom,
        type: range.type,
        target: click ? { x: click.x, y: click.y } : (range.manualTargetPoint ?? { x: 0.5, y: 0.5 }),
        targetSource: click ? 'click' : 'manual',
        instant: range.hasInstantAnimation ?? false,
      };
    });
}

async function loadCursorDefinitions(recordingDir: string): Promise<CursorDefinition[]> {
  const cursorFile = path.join(recordingDir, 'cursors.json');
  if (!await exists(cursorFile)) return [];
  const definitions = await readJson<RawCursorDefinition[]>(cursorFile);
  return definitions.map((definition) => ({
    ...definition,
    imagePath: path.join(recordingDir, 'cursors', `${definition.id}.png`),
  }));
}

export async function loadProject(projectDir: string): Promise<ScreenStudioProject> {
  const absoluteDir = path.resolve(projectDir);
  const recordingDir = path.join(absoluteDir, 'recording');
  const projectEnvelope = await readJson<ProjectEnvelope>(path.join(absoluteDir, 'project.json'));
  const metadata = await readJson<RecordingMetadata>(path.join(recordingDir, 'metadata.json'));
  const projectMeta = await readJson<ProjectMetaEnvelope>(path.join(absoluteDir, 'meta.json'));
  const project: RawProject = projectEnvelope.json ?? projectEnvelope;
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
  const microphone: Array<ResolvedSourceSession & { file: string; enhancedUsed: boolean }> = [];
  for (const session of microphoneCandidates) {
    const enhancedUsed = Boolean(session.enhanced && await exists(session.enhanced));
    microphone.push({ ...session, file: enhancedUsed ? session.enhanced as string : session.original, enhancedUsed });
  }

  for (const filename of [...display.map((item) => item.original), ...webcam.map((item) => item.original), ...microphone.map((item) => item.file)]) {
    if (!await exists(filename)) throw new Error(`Missing recording source: ${filename}`);
  }

  const pointer = await collectPointerData(recordingDir, inputRecorder, displayRecorder);
  const fallbackDuration = display.reduce((sum, item) => sum + item.durationMs, 0);
  const slices: TimelineSlice[] = (scene.slices?.length ? scene.slices : [{ sourceStartMs: 0, sourceEndMs: fallbackDuration }])
    .map((slice) => ({
      sourceStartMs: slice.sourceStartMs,
      sourceEndMs: slice.sourceEndMs,
      timeScale: slice.timeScale ?? 1,
      hideCursor: slice.hideCursor ?? false,
    }));
  const firstDisplay = displayRecorder.sessions[0];
  if (!firstDisplay?.bounds || !firstDisplay.recordingScale) throw new Error('First display session is missing size metadata.');

  return {
    directory: absoluteDir,
    recordingDirectory: recordingDir,
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
      width: Math.round(firstDisplay.bounds.width / firstDisplay.recordingScale),
      height: Math.round(firstDisplay.bounds.height / firstDisplay.recordingScale),
    },
    displayLogicalSize: { width: firstDisplay.bounds.width, height: firstDisplay.bounds.height },
    slices,
    clicks: pointer.clicks,
    cursorMoves: pointer.cursorMoves,
    cursorDefinitions: await loadCursorDefinitions(recordingDir),
    zooms: attachZoomTargets(scene.zoomRanges ?? [], pointer.clicks),
  };
}
