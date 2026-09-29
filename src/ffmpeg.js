import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProgressDisplay } from './progress.js';
import { clipSlices, durationOfSlices, mapZoomsThroughSlices } from './timeline.js';
import { outputContainer, resolveVideoGeometry } from './options.js';

const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const sec = (milliseconds) => (milliseconds / 1000).toFixed(6);

function concatEscape(filename) {
  return filename.replaceAll("'", "'\\''");
}

async function writeConcatList(filename, files) {
  await writeFile(filename, `${files.map((file) => `file '${concatEscape(file)}'`).join('\n')}\n`);
}

async function writeRoundedMask(filename, width, height, radius) {
  const data = Buffer.alloc(width * height);
  const r = Math.max(0, Math.min(Math.floor(Math.min(width, height) / 2), Math.round(radius)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cx = x < r ? r : x >= width - r ? width - r - 1 : x;
      const cy = y < r ? r : y >= height - r ? height - r - 1 : y;
      const dx = x - cx;
      const dy = y - cy;
      data[y * width + x] = dx * dx + dy * dy <= r * r ? 255 : 0;
    }
  }
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`);
  await writeFile(filename, Buffer.concat([header, data]));
}

function trimVideo(input, slices, prefix) {
  const parts = slices.map((slice, index) => {
    const speed = slice.timeScale ?? 1;
    return `[${input}:v]trim=start=${sec(slice.sourceStartMs)}:end=${sec(slice.sourceEndMs)},setpts=(PTS-STARTPTS)/${speed}[${prefix}${index}]`;
  });
  const labels = slices.map((_, index) => `[${prefix}${index}]`).join('');
  parts.push(`${labels}concat=n=${slices.length}:v=1:a=0[${prefix}cut]`);
  return parts;
}

function atempoChain(speed) {
  const filters = [];
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

function trimAudio(input, slices, prefix) {
  const parts = slices.map((slice, index) => {
    const speed = slice.timeScale ?? 1;
    return `[${input}:a]atrim=start=${sec(slice.sourceStartMs)}:end=${sec(slice.sourceEndMs)},asetpts=PTS-STARTPTS,${atempoChain(speed)}[${prefix}${index}]`;
  });
  const labels = slices.map((_, index) => `[${prefix}${index}]`).join('');
  parts.push(`${labels}concat=n=${slices.length}:v=0:a=1[${prefix}cut]`);
  return parts;
}

function rampExpression(zoom) {
  const ramp = Math.min(0.38, Math.max(0.08, (zoom.end - zoom.start) / 3));
  return `sin(min(clip((T-${zoom.start.toFixed(6)})/${ramp.toFixed(6)},0,1),clip((${zoom.end.toFixed(6)}-T)/${ramp.toFixed(6)},0,1))*PI/2)`;
}

export function zoomExpressions(zooms, fps) {
  const time = `(on/${fps})`;
  const active = zooms.map((zoom) => ({ ...zoom, progress: rampExpression(zoom).replaceAll('T', time) }));
  const zTerms = active.map((zoom) => `(${(zoom.zoom - 1).toFixed(8)})*(${zoom.progress})`);
  const z = zTerms.length ? `1+${zTerms.join('+')}` : '1';
  let tx = '0.5';
  let ty = '0.5';
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const zoom = active[index];
    const condition = `between(${time},${zoom.start.toFixed(6)},${zoom.end.toFixed(6)})`;
    tx = `if(${condition},${zoom.target.x.toFixed(8)},${tx})`;
    ty = `if(${condition},${zoom.target.y.toFixed(8)},${ty})`;
  }
  const cameraRamps = zooms.map((zoom) => rampExpression(zoom).replaceAll('T', 't'));
  const cameraProgress = cameraRamps.length
    ? `min(1,${cameraRamps.map((progress) => `(${progress})`).join('+')})`
    : '0';
  return { z, tx, ty, cameraProgress };
}

function hexColor(color, fallback) {
  const value = /^#[0-9a-f]{6}$/i.test(color ?? '') ? color.slice(1) : fallback;
  return `0x${value}`;
}

function buildFilterGraph({ project, slices, zooms, width, height, fps, cameraMaskInput }) {
  const duration = durationOfSlices(slices);
  const margin = even(width * 0.017);
  const availableWidth = width - margin * 2;
  const availableHeight = height - margin * 2;
  const screenScale = Math.min(
    availableWidth / project.displaySize.width,
    availableHeight / project.displaySize.height,
  );
  const screenWidth = even(project.displaySize.width * screenScale);
  const screenHeight = even(project.displaySize.height * screenScale);
  const screenX = even((width - screenWidth) / 2);
  const screenY = even((height - screenHeight) / 2);
  const cameraSizeSetting = project.config.cameraSize ?? 0.35;
  const cameraBase = even(screenHeight * cameraSizeSetting);
  const cameraRadius = even(cameraBase * (project.config.cameraRoundness ?? 0.25) / 2);
  const cameraZoomScale = project.config.cameraScaleDuringZoom ?? 0.7;
  const namedPositions = {
    'top-left': { x: 0, y: 0 },
    'top-right': { x: 1, y: 0 },
    'bottom-left': { x: 0, y: 1 },
    'bottom-right': { x: 1, y: 1 },
  };
  const cameraPoint = project.config.cameraPositionPoint
    ?? namedPositions[project.config.cameraPosition]
    ?? namedPositions['bottom-right'];
  const cameraX = Math.max(0, Math.min(1, cameraPoint.x));
  const cameraY = Math.max(0, Math.min(1, cameraPoint.y));
  const gradient = project.config.backgroundGradient?.stops ?? [];
  const backgroundStart = hexColor(gradient[0]?.color, '171530');
  const backgroundEnd = hexColor(gradient.at(-1)?.color, '5048ad');
  const expressions = zoomExpressions(zooms, fps);
  const dynamicSize = `trunc((${cameraBase})*(1-(1-${cameraZoomScale})*(${expressions.cameraProgress}))/2)*2`;
  const overlayX = `${margin}+(W-2*${margin}-w)*${cameraX}`;
  const overlayY = `${margin}+(H-2*${margin}-h)*${cameraY}`;
  const cameraFlip = project.config.mirrorCamera ? ',hflip' : '';

  const filters = [
    ...trimVideo(0, slices, 'screen'),
    ...trimVideo(1, slices, 'camera'),
    ...trimAudio(2, slices, 'audio'),
    `[screencut]zoompan=z='${expressions.z}':x='max(0,min(iw-iw/zoom,(${expressions.tx})*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${expressions.ty})*ih-ih/zoom/2))':d=1:s=${screenWidth}x${screenHeight}:fps=${fps},setsar=1[screenzoom]`,
    `gradients=size=${width}x${height}:rate=${fps}:duration=${duration.toFixed(6)}:c0=${backgroundStart}:c1=${backgroundEnd}:x0=0:y0=0:x1=${width}:y1=${height},format=yuv420p[background]`,
    `[background]drawbox=x=${screenX + 8}:y=${screenY + 10}:w=${screenWidth}:h=${screenHeight}:color=black@0.32:t=fill[withscreenshadow]`,
    `[withscreenshadow][screenzoom]overlay=x=${screenX}:y=${screenY}:shortest=1[stage]`,
    `[cameracut]fps=${fps},crop=w='min(iw,ih)':h='min(iw,ih)':x='(iw-ow)/2':y='(ih-oh)/2',scale=${cameraBase}:${cameraBase}${cameraFlip},setsar=1,format=rgba[camerargba]`,
    `[${cameraMaskInput}:v]format=gray,scale=${cameraBase}:${cameraBase}[cameramask]`,
    `[camerargba][cameramask]alphamerge[roundedcamera]`,
    `[roundedcamera]split=2[cameraforshadow][cameraforeground]`,
    `[cameraforshadow]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.42,boxblur=10:1,scale=w='${dynamicSize}':h='${dynamicSize}':eval=frame[camerashadow]`,
    `[cameraforeground]scale=w='${dynamicSize}':h='${dynamicSize}':eval=frame[cameraout]`,
    `[stage][camerashadow]overlay=x='${overlayX}+6':y='${overlayY}+8':eval=frame[withcamerashadow]`,
    `[withcamerashadow][cameraout]overlay=x='${overlayX}':y='${overlayY}':eval=frame:shortest=1,format=yuv420p[videoout]`,
  ];
  return { filters, duration, cameraBase, cameraRadius, screenWidth, screenHeight };
}

function parseProgressChunk(state, chunk, display) {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'out_time_us') state.elapsed = Number(value) / 1_000_000;
    if (key === 'speed') state.speed = Number.parseFloat(value.replace('x', ''));
    if (key === 'fps') state.fps = Number(value);
    if (key === 'progress') display.update(state);
  }
}

async function runFfmpeg(args, duration) {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const display = new ProgressDisplay(duration);
  const state = { buffer: '', elapsed: 0, speed: 0, fps: 0 };
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => parseProgressChunk(state, chunk, display));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20000);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (exitCode === 0) display.update({ ...state, elapsed: duration });
  display.finish();
  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}.\n${stderr}`);
  }
}

export async function prepareRender(project, options = {}) {
  const resolved = resolveVideoGeometry(options);
  const width = even(resolved.width);
  const height = even(resolved.height);
  const fps = Math.max(1, Number(resolved.fps));
  const slices = clipSlices(project.slices, options.start ?? 0, options.duration ?? Infinity);
  if (!slices.length) throw new Error('Requested range is outside the project timeline.');
  const zooms = mapZoomsThroughSlices(project.zooms, slices);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ss-render-'));
  const displayList = path.join(workDir, 'display.txt');
  const webcamList = path.join(workDir, 'webcam.txt');
  const audioList = path.join(workDir, 'audio.txt');
  const filterFile = path.join(workDir, 'filter.txt');
  const cameraMask = path.join(workDir, 'camera-mask.pgm');
  await Promise.all([
    writeConcatList(displayList, project.sources.display),
    writeConcatList(webcamList, project.sources.webcam),
    writeConcatList(audioList, project.sources.microphone),
  ]);

  const graph = buildFilterGraph({ project, slices, zooms, width, height, fps, cameraMaskInput: 3 });
  await writeRoundedMask(cameraMask, graph.cameraBase, graph.cameraBase, graph.cameraRadius);
  await writeFile(filterFile, `${graph.filters.join(';\n')}\n`);
  return {
    workDir,
    filterFile,
    duration: graph.duration,
    slices,
    zooms,
    geometry: {
      width,
      height,
      fps,
      preset: resolved.preset,
      cameraSize: graph.cameraBase,
      cameraRadius: graph.cameraRadius,
      screenWidth: graph.screenWidth,
      screenHeight: graph.screenHeight,
    },
    inputArgs: [
      '-f', 'concat', '-safe', '0', '-i', displayList,
      '-f', 'concat', '-safe', '0', '-i', webcamList,
      '-f', 'concat', '-safe', '0', '-i', audioList,
      '-loop', '1', '-framerate', String(fps), '-i', cameraMask,
    ],
  };
}

export async function renderProject(project, output, options = {}) {
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
      ? ['-preset', options.preset ?? 'medium', '-crf', String(options.crf ?? 18)]
      : ['-b:v', options.videoBitrate ?? bitrateDefaults.video, '-maxrate', options.maxrate ?? bitrateDefaults.max, '-bufsize', options.bufsize ?? bitrateDefaults.buffer]),
    '-c:a', 'aac', '-b:a', options.audioBitrate ?? '192k',
    ...(['.mp4', '.m4v', '.mov'].includes(container) ? ['-movflags', '+faststart'] : []),
    '-progress', 'pipe:1', '-nostats',
    output,
  ];
  if (!options.dryRun) {
    try {
      await runFfmpeg(args, prepared.duration);
    } catch (error) {
      error.message = `${error.message}\nDiagnostic files retained in: ${prepared.workDir}`;
      throw error;
    }
    await rm(prepared.workDir, { recursive: true, force: true });
  }
  return { ...prepared, workDir: options.dryRun ? prepared.workDir : null, args, output };
}
