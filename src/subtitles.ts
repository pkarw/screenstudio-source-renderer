import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clipSlices } from './timeline.js';
import type { ScreenStudioProject, SubtitleOptions, TimelineSlice } from './types.js';

const SCREEN_STUDIO_WHISPER = '/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/whisper-darwin-arm64';
const SCREEN_STUDIO_MODELS = path.join(os.homedir(), 'Library', 'Application Support', 'Screen Studio', 'models');

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

function sec(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(6);
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

export function subtitleOutputPaths(output: string, format: SubtitleOptions['format'] = 'srt'): string[] {
  const extension = path.extname(output).toLowerCase();
  const base = ['.srt', '.vtt'].includes(extension) ? output.slice(0, -extension.length) : output;
  if (format === 'both') return [`${base}.srt`, `${base}.vtt`];
  return [`${base}.${format}`];
}

export function buildWhisperArgs(
  audioFile: string,
  outputBase: string,
  modelFile: string,
  options: SubtitleOptions,
): string[] {
  const format = options.format ?? 'srt';
  return [
    '-m', modelFile,
    '-l', options.language ?? 'auto',
    '-of', outputBase,
    ...(format === 'srt' || format === 'both' ? ['-osrt'] : []),
    ...(format === 'vtt' || format === 'both' ? ['-ovtt'] : []),
    ...(options.prompt ? ['--prompt', options.prompt] : []),
    '-ml', '42',
    '-sow',
    '-pp',
    audioFile,
  ];
}

export async function resolveWhisperBinary(requested?: string): Promise<string> {
  const explicit = requested ?? process.env.SCREENSTUDIO_WHISPER_BIN;
  if (explicit) {
    if (explicit.includes(path.sep) && !await exists(path.resolve(explicit))) throw new Error(`Whisper binary not found: ${explicit}`);
    return explicit;
  }
  if (await exists(SCREEN_STUDIO_WHISPER)) return SCREEN_STUDIO_WHISPER;
  const which = spawnSync('which', ['whisper-cli'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new Error('No local whisper.cpp binary found. Install Screen Studio or pass --whisper-bin /path/to/whisper-cli.');
}

export async function resolveWhisperModel(requested = 'small'): Promise<string> {
  const configured = process.env.SCREENSTUDIO_WHISPER_MODEL;
  const value = configured ?? requested;
  const looksLikePath = value.includes(path.sep) || value.endsWith('.bin');
  const filename = looksLikePath ? path.resolve(value) : path.join(SCREEN_STUDIO_MODELS, `ggml-${value}.bin`);
  if (!await exists(filename)) {
    throw new Error(`Whisper model not found: ${filename}. Generate/download the model in Screen Studio or pass --model /path/to/ggml-model.bin.`);
  }
  return filename;
}

async function runProcess(command: string, args: string[], phase: string): Promise<void> {
  process.stderr.write(`${phase}…\n`);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => process.stderr.write(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
    if (/progress|%|loading model|auto-detected language/i.test(chunk)) process.stderr.write(chunk);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`${phase} failed with exit code ${code}.\n${stderr}`);
}

function audioFilters(slices: TimelineSlice[]): string[] {
  const filters = slices.map((slice, index) => (
    `[0:a]atrim=start=${sec(slice.sourceStartMs)}:end=${sec(slice.sourceEndMs)},asetpts=PTS-STARTPTS,${atempoChain(slice.timeScale)}[a${index}]`
  ));
  filters.push(`${slices.map((_, index) => `[a${index}]`).join('')}concat=n=${slices.length}:v=0:a=1[aout]`);
  return filters;
}

export async function extractSubtitles(
  project: ScreenStudioProject,
  output: string,
  options: SubtitleOptions = {},
): Promise<string[]> {
  const format = options.format ?? (path.extname(output).toLowerCase() === '.vtt' ? 'vtt' : 'srt');
  const normalizedOptions: SubtitleOptions = { ...options, format };
  const outputs = subtitleOutputPaths(path.resolve(output), format);
  if (!options.overwrite) {
    for (const filename of outputs) {
      if (await exists(filename)) throw new Error(`Subtitle output already exists: ${filename}. Use --overwrite to replace it.`);
    }
  }
  const slices = clipSlices(project.slices, options.start ?? 0, options.duration ?? Infinity);
  if (!slices.length) throw new Error('Requested subtitle range is outside the project timeline.');

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ss-subtitles-'));
  const audioList = path.join(workDir, 'audio.txt');
  const filterFile = path.join(workDir, 'audio-filter.txt');
  const waveFile = path.join(workDir, 'edited-audio.wav');
  const outputExtension = path.extname(outputs[0] as string);
  const outputBase = (outputs[0] as string).slice(0, -outputExtension.length);
  await writeFile(audioList, `${project.sources.microphone.map((file) => `file '${concatEscape(file)}'`).join('\n')}\n`);
  await writeFile(filterFile, `${audioFilters(slices).join(';\n')}\n`);

  try {
    await runProcess('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', audioList,
      '-filter_complex_script', filterFile,
      '-map', '[aout]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', waveFile,
    ], 'Preparing edited audio');
    const [binary, model] = await Promise.all([
      resolveWhisperBinary(options.whisperBinary),
      resolveWhisperModel(options.model),
    ]);
    await runProcess(binary, buildWhisperArgs(waveFile, outputBase, model, normalizedOptions), 'Transcribing locally');
    for (const filename of outputs) {
      if (!await exists(filename)) throw new Error(`Whisper completed but did not create ${filename}.`);
    }
    return outputs;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
