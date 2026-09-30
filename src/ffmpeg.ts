import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resampleCursorMoves, writeCursorAss } from './cursor.js';
import { outputContainer, resolveVideoGeometry } from './options.js';
import { ProgressDisplay } from './progress.js';
import { clipSlices, durationOfSlices, mapCursorMovesThroughSlices, mapZoomsThroughSlices } from './timeline.js';
import type {
  CameraPosition,
  OutputZoom,
  ProgressState,
  RenderOptions,
  ScreenStudioProject,
  TimelineSlice,
} from './types.js';

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
const sec = (milliseconds: number): string => (milliseconds / 1000).toFixed(6);
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function concatEscape(filename: string): string {
  return filename.replaceAll("'", "'\\''");
}

async function writeConcatList(filename: string, files: string[]): Promise<void> {
  await writeFile(filename, `${files.map((file) => `file '${concatEscape(file)}'`).join('\n')}\n`);
}

async function writeRoundedMask(filename: string, width: number, height: number, radius: number): Promise<void> {
  const data = Buffer.alloc(width * height);
  const r = Math.max(0, Math.min(Math.floor(Math.min(width, height) / 2), Math.round(radius)));
  if (r === 0) {
    data.fill(255);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (r === 0) continue;
      const px = x + 0.5;
      const py = y + 0.5;
      const cx = clamp(px, r, width - r);
      const cy = clamp(py, r, height - r);
      const distance = Math.hypot(px - cx, py - cy);
      const coverage = clamp(r + 0.5 - distance, 0, 1);
      data[y * width + x] = Math.round(coverage * 255);
    }
  }
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`);
  await writeFile(filename, Buffer.concat([header, data]));
}

function trimVideo(input: number, slices: TimelineSlice[], prefix: string): string[] {
  const parts = slices.map((slice, index) => {
    const speed = slice.timeScale ?? 1;
    return `[${input}:v]trim=start=${sec(slice.sourceStartMs)}:end=${sec(slice.sourceEndMs)},setpts=(PTS-STARTPTS)/${speed}[${prefix}${index}]`;
  });
  const labels = slices.map((_, index) => `[${prefix}${index}]`).join('');
  parts.push(`${labels}concat=n=${slices.length}:v=1:a=0[${prefix}cut]`);
  return parts;
}

function atempoChain(speed: number): string {
  const filters: string[] = [];
  let value = speed;
  while (value > 2) {
    filters.push('atempo=2');
    value /= 2;
  }
  while (value < 0.5) {
    filters.push('atempo=0.5');
    value /= 0.5;
  }
  filters.push(`atempo=${value}`);
  return filters.join(',');
}

function trimAudio(input: number, slices: TimelineSlice[], prefix: string): string[] {
  const parts = slices.map((slice, index) => {
    const speed = slice.timeScale ?? 1;
    return `[${input}:a]atrim=start=${sec(slice.sourceStartMs)}:end=${sec(slice.sourceEndMs)},asetpts=PTS-STARTPTS,${atempoChain(speed)}[${prefix}${index}]`;
  });
  const labels = slices.map((_, index) => `[${prefix}${index}]`).join('');
  parts.push(`${labels}concat=n=${slices.length}:v=0:a=1[${prefix}cut]`);
  return parts;
}

function rampExpression(zoom: OutputZoom): string {
  if (zoom.instant) return `between(T,${zoom.start.toFixed(6)},${zoom.end.toFixed(6)})`;
  const ramp = Math.min(0.38, Math.max(0.08, (zoom.end - zoom.start) / 3));
  return `sin(min(clip((T-${zoom.start.toFixed(6)})/${ramp.toFixed(6)},0,1),clip((${zoom.end.toFixed(6)}-T)/${ramp.toFixed(6)},0,1))*PI/2)`;
}

interface FocalSegment {
  start: number;
  end: number;
  x: number;
  y: number;
}

function focalSegments(zooms: OutputZoom[]): FocalSegment[] {
  const boundaries = [...new Set(zooms.flatMap((zoom) => [zoom.start, zoom.end]))]
    .sort((left, right) => left - right);
  const segments: FocalSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const midpoint = start + (end - start) / 2;
    let active: OutputZoom | undefined;
    for (const zoom of zooms) {
      if (midpoint >= zoom.start && midpoint < zoom.end) active = zoom;
    }
    if (!active) continue;
    const previous = segments.at(-1);
    if (previous && previous.end === start && previous.x === active.target.x && previous.y === active.target.y) {
      previous.end = end;
    } else {
      segments.push({ start, end, x: active.target.x, y: active.target.y });
    }
  }
  return segments;
}

function focalExpression(segments: FocalSegment[], axis: 'x' | 'y', time: string): string {
  const terms = segments
    .map((segment) => {
      const offset = segment[axis] - 0.5;
      if (Math.abs(offset) < Number.EPSILON) return undefined;
      const condition = `gte(${time},${segment.start.toFixed(6)})*lt(${time},${segment.end.toFixed(6)})`;
      return `(${offset.toFixed(8)})*(${condition})`;
    })
    .filter((term): term is string => term !== undefined);
  return terms.length ? `0.5+${terms.join('+')}` : '0.5';
}

export function zoomExpressions(zooms: OutputZoom[], fps: number): { z: string; tx: string; ty: string; cameraProgress: string } {
  const time = `(on/${fps})`;
  const active = zooms.map((zoom) => ({ ...zoom, progress: rampExpression(zoom).replaceAll('T', time) }));
  const zTerms = active.map((zoom) => `(${(zoom.zoom - 1).toFixed(8)})*(${zoom.progress})`);
  const z = zTerms.length ? `1+${zTerms.join('+')}` : '1';
  const segments = focalSegments(zooms);
  const tx = focalExpression(segments, 'x', time);
  const ty = focalExpression(segments, 'y', time);
  const cameraRamps = zooms.map((zoom) => rampExpression(zoom).replaceAll('T', 't'));
  const cameraProgress = cameraRamps.length ? `min(1,${cameraRamps.map((progress) => `(${progress})`).join('+')})` : '0';
  return { z, tx, ty, cameraProgress };
}

function normalizeHexColor(color: string | undefined, fallback: string): string {
  const value = /^#[0-9a-f]{6}$/i.test(color ?? '') ? (color as string).slice(1) : fallback;
  return `0x${value}`;
}

function filterPath(filename: string): string {
  return filename.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

interface BuildGraphOptions {
  project: ScreenStudioProject;
  options: RenderOptions;
  slices: TimelineSlice[];
  zooms: OutputZoom[];
  width: number;
  height: number;
  fps: number;
  cameraMaskInput: number;
  backgroundImageInput?: number;
  cursorAss?: string;
}

interface GraphResult {
  filters: string[];
  duration: number;
  cameraBase: number;
  cameraRadius: number;
  cameraVisible: boolean;
  screenWidth: number;
  screenHeight: number;
  screenX: number;
  screenY: number;
  backgroundMode: string;
}

function buildFilterGraph(input: BuildGraphOptions): GraphResult {
  const { project, options, slices, zooms, width, height, fps, cameraMaskInput, backgroundImageInput, cursorAss } = input;
  const duration = durationOfSlices(slices);
  const margin = even(width * 0.017);
  const availableWidth = width - margin * 2;
  const availableHeight = height - margin * 2;
  const screenScale = Math.min(availableWidth / project.displaySize.width, availableHeight / project.displaySize.height);
  const screenWidth = even(project.displaySize.width * screenScale);
  const screenHeight = even(project.displaySize.height * screenScale);
  const screenX = even((width - screenWidth) / 2);
  const screenY = even((height - screenHeight) / 2);

  const cameraVisible = options.camera === 'visible' || (options.camera !== 'hidden' && !project.config.hideCamera);
  const cameraSizeSetting = clamp(options.cameraSize ?? project.config.cameraSize ?? 0.35, 0.05, 0.95);
  const cameraBase = even(screenHeight * cameraSizeSetting);
  const cornerMode = options.cameraCorners ?? 'project';
  const projectRadius = project.config.cameraRoundness ?? 0.25;
  const radiusRatio = cornerMode === 'square' ? 0 : options.cameraRadius ?? (cornerMode === 'rounded' ? Math.max(0.2, projectRadius) : projectRadius);
  const cameraRadius = radiusRatio === 0 ? 0 : even(cameraBase * clamp(radiusRatio, 0, 0.5));
  const cameraZoomScale = clamp(options.cameraZoomScale ?? project.config.cameraScaleDuringZoom ?? 0.7, 0.1, 2);
  const cameraCropZoom = clamp(options.cameraZoom ?? 1, 1, 4);
  const namedPositions: Record<CameraPosition, { x: number; y: number }> = {
    'top-left': { x: 0, y: 0 },
    'top-right': { x: 1, y: 0 },
    'bottom-left': { x: 0, y: 1 },
    'bottom-right': { x: 1, y: 1 },
  };
  const namedPoint = options.cameraPosition ? namedPositions[options.cameraPosition] : undefined;
  const projectNamedPoint = project.config.cameraPosition
    ? namedPositions[project.config.cameraPosition]
    : undefined;
  const cameraPoint = namedPoint
    ?? project.config.cameraPositionPoint
    ?? projectNamedPoint
    ?? namedPositions['bottom-right'];
  const cameraX = clamp(options.cameraX ?? cameraPoint.x, 0, 1);
  const cameraY = clamp(options.cameraY ?? cameraPoint.y, 0, 1);

  const gradient = project.config.backgroundGradient?.stops ?? [];
  const backgroundStart = normalizeHexColor(options.backgroundGradient?.[0] ?? gradient[0]?.color ?? project.config.backgroundColor, '171530');
  const backgroundEnd = normalizeHexColor(options.backgroundGradient?.[1] ?? gradient.at(-1)?.color, '5048ad');
  const solidColor = normalizeHexColor(options.backgroundColor ?? project.config.backgroundColor, '3F37C9');
  const expressions = zoomExpressions(zooms, fps);
  const dynamicSize = `trunc((${cameraBase})*(1-(1-${cameraZoomScale})*(${expressions.cameraProgress}))/2)*2`;
  const overlayX = `${margin}+(W-2*${margin}-w)*${cameraX}`;
  const overlayY = `${margin}+(H-2*${margin}-h)*${cameraY}`;
  const cameraFlip = project.config.mirrorCamera ? ',hflip' : '';
  const screenOutput = cursorAss ? 'screenwithcursor' : 'screenzoom';

  const filters: string[] = [
    ...trimVideo(0, slices, 'screen'),
    ...trimVideo(1, slices, 'camera'),
    ...trimAudio(2, slices, 'audio'),
    `[screencut]zoompan=z='${expressions.z}':x='max(0,min(iw-iw/zoom,(${expressions.tx})*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${expressions.ty})*ih-ih/zoom/2))':d=1:s=${screenWidth}x${screenHeight}:fps=${fps},setsar=1[screenzoom]`,
  ];
  if (cursorAss) filters.push(`[screenzoom]ass=filename='${filterPath(cursorAss)}'[screenwithcursor]`);

  let backgroundMode: string;
  if (backgroundImageInput !== undefined) {
    filters.push(`[${backgroundImageInput}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p[background]`);
    backgroundMode = 'image';
  } else if (options.backgroundColor || (!options.backgroundGradient && project.config.backgroundType === 'color')) {
    filters.push(`color=c=${solidColor}:size=${width}x${height}:rate=${fps}:duration=${duration.toFixed(6)},format=yuv420p[background]`);
    backgroundMode = 'color';
  } else {
    filters.push(`gradients=size=${width}x${height}:rate=${fps}:duration=${duration.toFixed(6)}:c0=${backgroundStart}:c1=${backgroundEnd}:x0=0:y0=0:x1=${width}:y1=${height},format=yuv420p[background]`);
    backgroundMode = options.backgroundGradient ? 'gradient' : 'project';
  }

  filters.push(
    `[background]drawbox=x=${screenX + 8}:y=${screenY + 10}:w=${screenWidth}:h=${screenHeight}:color=black@0.32:t=fill[withscreenshadow]`,
    `[withscreenshadow][${screenOutput}]overlay=x=${screenX}:y=${screenY}:shortest=1[stage]`,
  );

  if (!cameraVisible) {
    filters.push('[stage]format=yuv420p[videoout]');
    return { filters, duration, cameraBase, cameraRadius, cameraVisible, screenWidth, screenHeight, screenX, screenY, backgroundMode };
  }

  filters.push(
    `[cameracut]fps=${fps},crop=w='min(iw,ih)/${cameraCropZoom}':h='min(iw,ih)/${cameraCropZoom}':x='(iw-ow)/2':y='(ih-oh)/2',scale=${cameraBase}:${cameraBase}${cameraFlip},setsar=1,format=rgba[camerargba]`,
    `[${cameraMaskInput}:v]format=gray,scale=${cameraBase}:${cameraBase}[cameramask]`,
    '[camerargba][cameramask]alphamerge[roundedcamera]',
    '[roundedcamera]split=2[cameraforshadow][cameraforeground]',
    `[cameraforshadow]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.42,boxblur=10:1,scale=w='${dynamicSize}':h='${dynamicSize}':eval=frame[camerashadow]`,
    `[cameraforeground]scale=w='${dynamicSize}':h='${dynamicSize}':eval=frame[cameraout]`,
    `[stage][camerashadow]overlay=x='${overlayX}+6':y='${overlayY}+8':eval=frame[withcamerashadow]`,
    `[withcamerashadow][cameraout]overlay=x='${overlayX}':y='${overlayY}':eval=frame:shortest=1,format=yuv420p[videoout]`,
  );
  return { filters, duration, cameraBase, cameraRadius, cameraVisible, screenWidth, screenHeight, screenX, screenY, backgroundMode };
}

function parseProgressChunk(state: ProgressState & { buffer: string }, chunk: string, display: ProgressDisplay): void {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const numeric = key === 'speed' ? Number.parseFloat(value.replace('x', '')) : Number(value);
    if (key === 'out_time_us' && Number.isFinite(numeric)) state.elapsed = numeric / 1_000_000;
    if (key === 'speed' && Number.isFinite(numeric)) state.speed = numeric;
    if (key === 'fps' && Number.isFinite(numeric)) state.fps = numeric;
    if (key === 'progress') display.update(state);
  }
}

async function runFfmpeg(args: string[], duration: number): Promise<void> {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const display = new ProgressDisplay(duration);
  const state: ProgressState & { buffer: string } = { buffer: '', elapsed: 0, speed: 0, fps: 0 };
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => parseProgressChunk(state, chunk, display));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode === 0) display.update({ ...state, elapsed: duration });
  display.finish();
  if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}.\n${stderr}`);
}

export interface PreparedRender {
  workDir: string;
  filterFile: string;
  duration: number;
  slices: TimelineSlice[];
  zooms: OutputZoom[];
  geometry: {
    width: number;
    height: number;
    fps: number;
    preset: string;
    cameraSize: number;
    cameraRadius: number;
    cameraVisible: boolean;
    screenWidth: number;
    screenHeight: number;
    screenX: number;
    screenY: number;
    backgroundMode: string;
    cursorEvents: number;
  };
  inputArgs: string[];
}

export async function prepareRender(project: ScreenStudioProject, options: RenderOptions = {}): Promise<PreparedRender> {
  const resolved = resolveVideoGeometry(options);
  const width = even(resolved.width);
  const height = even(resolved.height);
  const fps = Math.max(1, Number(resolved.fps));
  const slices = clipSlices(project.slices, options.start ?? 0, options.duration ?? Infinity);
  if (!slices.length) throw new Error('Requested range is outside the project timeline.');
  const zooms = mapZoomsThroughSlices(project.zooms, slices);
  const cursorMoves = mapCursorMovesThroughSlices(project.cursorMoves, slices);
  const renderedCursorMoves = resampleCursorMoves(cursorMoves, Math.min(fps, 30));
  const cursorVisible = options.cursor !== 'hidden' && renderedCursorMoves.length > 0;
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ss-render-'));
  const displayList = path.join(workDir, 'display.txt');
  const webcamList = path.join(workDir, 'webcam.txt');
  const audioList = path.join(workDir, 'audio.txt');
  const filterFile = path.join(workDir, 'filter.txt');
  const cameraMask = path.join(workDir, 'camera-mask.pgm');
  const cursorAss = cursorVisible ? path.join(workDir, 'cursor.ass') : undefined;
  await Promise.all([
    writeConcatList(displayList, project.sources.display),
    writeConcatList(webcamList, project.sources.webcam),
    writeConcatList(audioList, project.sources.microphone),
  ]);

  const inputArgs = [
    '-f', 'concat', '-safe', '0', '-i', displayList,
    '-f', 'concat', '-safe', '0', '-i', webcamList,
    '-f', 'concat', '-safe', '0', '-i', audioList,
  ];
  let nextInput = 3;
  let backgroundImageInput: number | undefined;
  if (options.backgroundImage) {
    const filename = path.resolve(options.backgroundImage);
    if (!await exists(filename)) throw new Error(`Background image not found: ${filename}`);
    backgroundImageInput = nextInput;
    nextInput += 1;
    inputArgs.push('-loop', '1', '-framerate', String(fps), '-i', filename);
  }
  const cameraMaskInput = nextInput;
  inputArgs.push('-loop', '1', '-framerate', String(fps), '-i', cameraMask);

  const duration = durationOfSlices(slices);
  const preliminary = buildFilterGraph({ project, options, slices, zooms, width, height, fps, cameraMaskInput, ...(backgroundImageInput === undefined ? {} : { backgroundImageInput }) });
  await writeRoundedMask(cameraMask, preliminary.cameraBase, preliminary.cameraBase, preliminary.cameraRadius);
  if (cursorAss) {
    await writeCursorAss({
      filename: cursorAss,
      moves: renderedCursorMoves,
      duration,
      width: preliminary.screenWidth,
      height: preliminary.screenHeight,
      logicalDisplaySize: project.displayLogicalSize,
      definitions: project.cursorDefinitions,
      zooms,
      scale: clamp(options.cursorScale ?? 1, 0.25, 4),
    });
  }
  const graph = buildFilterGraph({
    project, options, slices, zooms, width, height, fps, cameraMaskInput,
    ...(backgroundImageInput === undefined ? {} : { backgroundImageInput }),
    ...(cursorAss ? { cursorAss } : {}),
  });
  await writeFile(filterFile, `${graph.filters.join(';\n')}\n`);
  return {
    workDir,
    filterFile,
    duration: graph.duration,
    slices,
    zooms,
    geometry: {
      width, height, fps, preset: resolved.preset,
      cameraSize: graph.cameraBase,
      cameraRadius: graph.cameraRadius,
      cameraVisible: graph.cameraVisible,
      screenWidth: graph.screenWidth,
      screenHeight: graph.screenHeight,
      screenX: graph.screenX,
      screenY: graph.screenY,
      backgroundMode: graph.backgroundMode,
      cursorEvents: renderedCursorMoves.length,
    },
    inputArgs,
  };
}

export async function renderProject(
  project: ScreenStudioProject,
  output: string,
  options: RenderOptions = {},
): Promise<PreparedRender & { args: string[]; output: string; workDir: string }> {
  const prepared = await prepareRender(project, options);
  const container = outputContainer(output);
  const encoder = options.encoder ?? 'h264_videotoolbox';
  const pixels = prepared.geometry.width * prepared.geometry.height;
  const bitrateDefaults = pixels >= 7_000_000
    ? { video: '35M', max: '55M', buffer: '70M' }
    : pixels >= 3_000_000
      ? { video: '24M', max: '36M', buffer: '48M' }
      : { video: '16M', max: '24M', buffer: '32M' };
  const args = [
    '-hide_banner', options.overwrite ? '-y' : '-n',
    ...prepared.inputArgs,
    '-filter_complex_script', prepared.filterFile,
    '-map', '[videoout]', '-map', '[audiocut]',
    '-t', prepared.duration.toFixed(6),
    '-c:v', encoder,
    ...(encoder === 'libx264'
      ? ['-preset', options.encoderPreset ?? 'medium', '-crf', String(options.crf ?? 18)]
      : ['-b:v', options.videoBitrate ?? bitrateDefaults.video, '-maxrate', options.maxrate ?? bitrateDefaults.max, '-bufsize', options.bufsize ?? bitrateDefaults.buffer]),
    '-c:a', 'aac', '-b:a', options.audioBitrate ?? '192k',
    ...(['.mp4', '.m4v', '.mov'].includes(container) ? ['-movflags', '+faststart'] : []),
    '-progress', 'pipe:1', '-nostats',
    output,
  ];
  if (!options.dryRun) {
    try {
      await runFfmpeg(args, prepared.duration);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      error.message = `${error.message}\nDiagnostic files retained in: ${prepared.workDir}`;
      throw error;
    }
    await rm(prepared.workDir, { recursive: true, force: true });
  }
  return { ...prepared, workDir: options.dryRun ? prepared.workDir : '', args, output };
}
