#!/usr/bin/env node
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { prepareRender, renderProject } from './ffmpeg.js';
import { outputContainer } from './options.js';
import { loadProject } from './project.js';
import { extractSubtitles } from './subtitles.js';
import { durationOfSlices } from './timeline.js';
import type { CameraCorners, CameraPosition, RenderOptions, ScreenStudioProject, SubtitleOptions } from './types.js';

type ParsedOptions = Record<string, string | boolean>;

function usage(): string {
  return `Screen Studio source renderer

Usage:
  ss-render inspect <project.screenstudio>
  ss-render render <project.screenstudio> --output <video.mp4> [options]
  ss-render subtitles <project.screenstudio> --output <captions.srt> [options]

Video:
  --preset <name>              4k, 1440p, 1080p, 720p, vertical-4k, vertical, square
  --width <px>                 Custom output width (overrides preset)
  --height <px>                Custom output height (overrides preset)
  --fps <number>               Output frame rate (default: 60)
  --start <seconds>            Start on the edited timeline
  --duration <seconds>         Duration from the edited timeline
  --encoder <name>             FFmpeg encoder (default: h264_videotoolbox)

Camera:
  --camera <project|visible|hidden>
  --camera-size <0.05..0.95>   Size relative to the fitted screen height
  --camera-zoom <1..4>         Center crop zoom inside the webcam image
  --camera-corners <project|rounded|square>
  --camera-radius <0..0.5>     Rounded-corner radius as a size ratio
  --camera-zoom-scale <0.1..2> Camera scale while the screen is zoomed
  --camera-position <top-left|top-right|bottom-left|bottom-right>
  --camera-x <0..1>            Custom horizontal location
  --camera-y <0..1>            Custom vertical location
  --rounded-camera             Shortcut for --camera-corners rounded
  --square-camera              Shortcut for --camera-corners square

Cursor and background:
  --cursor <project|visible|hidden>
  --cursor-scale <0.25..4>
  --no-cursor                  Shortcut for --cursor hidden
  --background-color <#RRGGBB>
  --background-gradient <#RRGGBB,#RRGGBB>
  --background-image <file>

Subtitles:
  --format <srt|vtt|both>      Default: inferred from output, otherwise SRT
  --language <code|auto>       Default: auto
  --model <base|small|medium|path> Default: small
  --prompt <text>              Vocabulary hint for Whisper
  --whisper-bin <path>         Override local whisper.cpp executable

General:
  --overwrite                  Replace existing output
  --dry-run                    Build and print the video render plan
  --help                       Show this help
`;
}

export function parseArgs(argv: string[]): { positional: string[]; options: ParsedOptions } {
  const positional: string[] = [];
  const options: ParsedOptions = {};
  const booleanFlags = new Set(['overwrite', 'dry-run', 'help', 'rounded-camera', 'square-camera', 'no-cursor']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    const key = value.slice(2, equals >= 0 ? equals : undefined);
    if (equals >= 0) {
      options[key] = value.slice(equals + 1);
      continue;
    }
    if (booleanFlags.has(key)) {
      options[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = next;
    index += 1;
  }
  return { positional, options };
}

function stringOption(options: ParsedOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

function numberOption(options: ParsedOptions, name: string, minimum = 0, maximum = Infinity): number | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function positiveOption(options: ParsedOptions, name: string): number | undefined {
  return numberOption(options, name, Number.MIN_VALUE);
}

function choiceOption<T extends string>(options: ParsedOptions, name: string, choices: readonly T[]): T | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) throw new Error(`--${name} must be one of: ${choices.join(', ')}.`);
  return value as T;
}

function colorOption(options: ParsedOptions, name: string): string | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} must use #RRGGBB.`);
  return value;
}

function gradientOption(options: ParsedOptions): [string, string] | undefined {
  const value = stringOption(options, 'background-gradient');
  if (!value) return undefined;
  const colors = value.split(',').map((item) => item.trim());
  if (colors.length !== 2 || colors.some((color) => !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new Error('--background-gradient must contain two #RRGGBB colors separated by a comma.');
  }
  return [colors[0] as string, colors[1] as string];
}

async function outputExists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function projectSummary(project: ScreenStudioProject): Record<string, unknown> {
  return {
    name: project.name,
    directory: project.directory,
    screenStudioVersion: project.version,
    sessions: project.sessionCount,
    enhancedAudioSessions: project.enhancedAudioSessions,
    slices: project.slices.length,
    durationSeconds: Number(durationOfSlices(project.slices).toFixed(3)),
    zooms: project.zooms.length,
    clickTargetedZooms: project.zooms.filter((zoom) => zoom.targetSource === 'click').length,
    cursorMoves: project.cursorMoves.length,
    cursorTypes: [...new Set(project.cursorMoves.map((move) => move.cursorId))],
    camera: {
      aspectRatio: project.config.cameraAspectRatio,
      roundness: project.config.cameraRoundness,
      size: project.config.cameraSize,
      scaleDuringZoom: project.config.cameraScaleDuringZoom,
      position: project.config.cameraPosition,
    },
    background: {
      type: project.config.backgroundType,
      systemName: project.config.backgroundSystemName,
      color: project.config.backgroundColor,
    },
  };
}

function renderOptionsFromCli(options: ParsedOptions): RenderOptions {
  const cameraCorners: CameraCorners | undefined = options['rounded-camera']
    ? 'rounded'
    : options['square-camera']
      ? 'square'
      : choiceOption(options, 'camera-corners', ['project', 'rounded', 'square'] as const);
  const cursor = options['no-cursor']
    ? 'hidden'
    : choiceOption(options, 'cursor', ['project', 'visible', 'hidden'] as const);
  return {
    ...(stringOption(options, 'preset') ? { preset: stringOption(options, 'preset') as string } : {}),
    ...(positiveOption(options, 'width') === undefined ? {} : { width: positiveOption(options, 'width') as number }),
    ...(positiveOption(options, 'height') === undefined ? {} : { height: positiveOption(options, 'height') as number }),
    ...(positiveOption(options, 'fps') === undefined ? {} : { fps: positiveOption(options, 'fps') as number }),
    ...(numberOption(options, 'start') === undefined ? {} : { start: numberOption(options, 'start') as number }),
    ...(numberOption(options, 'duration') === undefined ? {} : { duration: numberOption(options, 'duration') as number }),
    ...(stringOption(options, 'encoder') ? { encoder: stringOption(options, 'encoder') as string } : {}),
    overwrite: Boolean(options.overwrite),
    dryRun: Boolean(options['dry-run']),
    ...(choiceOption(options, 'camera', ['project', 'visible', 'hidden'] as const) ? { camera: choiceOption(options, 'camera', ['project', 'visible', 'hidden'] as const) as 'project' | 'visible' | 'hidden' } : {}),
    ...(numberOption(options, 'camera-size', 0.05, 0.95) === undefined ? {} : { cameraSize: numberOption(options, 'camera-size', 0.05, 0.95) as number }),
    ...(numberOption(options, 'camera-zoom', 1, 4) === undefined ? {} : { cameraZoom: numberOption(options, 'camera-zoom', 1, 4) as number }),
    ...(cameraCorners ? { cameraCorners } : {}),
    ...(numberOption(options, 'camera-radius', 0, 0.5) === undefined ? {} : { cameraRadius: numberOption(options, 'camera-radius', 0, 0.5) as number }),
    ...(numberOption(options, 'camera-zoom-scale', 0.1, 2) === undefined ? {} : { cameraZoomScale: numberOption(options, 'camera-zoom-scale', 0.1, 2) as number }),
    ...(choiceOption(options, 'camera-position', ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) ? { cameraPosition: choiceOption(options, 'camera-position', ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) as CameraPosition } : {}),
    ...(numberOption(options, 'camera-x', 0, 1) === undefined ? {} : { cameraX: numberOption(options, 'camera-x', 0, 1) as number }),
    ...(numberOption(options, 'camera-y', 0, 1) === undefined ? {} : { cameraY: numberOption(options, 'camera-y', 0, 1) as number }),
    ...(cursor ? { cursor } : {}),
    ...(numberOption(options, 'cursor-scale', 0.25, 4) === undefined ? {} : { cursorScale: numberOption(options, 'cursor-scale', 0.25, 4) as number }),
    ...(colorOption(options, 'background-color') ? { backgroundColor: colorOption(options, 'background-color') as string } : {}),
    ...(gradientOption(options) ? { backgroundGradient: gradientOption(options) as [string, string] } : {}),
    ...(stringOption(options, 'background-image') ? { backgroundImage: stringOption(options, 'background-image') as string } : {}),
  };
}

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length === 0) {
    process.stdout.write(usage());
    return;
  }
  const [command, projectPath] = positional;
  if (!projectPath) throw new Error('Provide a .screenstudio project directory.');
  process.stderr.write('Inspecting source project…\n');
  const project = await loadProject(projectPath);

  if (command === 'inspect') {
    process.stdout.write(`${JSON.stringify(projectSummary(project), null, 2)}\n`);
    return;
  }

  if (command === 'subtitles') {
    const output = path.resolve(stringOption(options, 'output') ?? `${project.name}.srt`);
    const subtitleOptions: SubtitleOptions = {
      ...(numberOption(options, 'start') === undefined ? {} : { start: numberOption(options, 'start') as number }),
      ...(numberOption(options, 'duration') === undefined ? {} : { duration: numberOption(options, 'duration') as number }),
      ...(stringOption(options, 'language') ? { language: stringOption(options, 'language') as string } : {}),
      ...(stringOption(options, 'model') ? { model: stringOption(options, 'model') as string } : {}),
      ...(stringOption(options, 'prompt') ? { prompt: stringOption(options, 'prompt') as string } : {}),
      ...(choiceOption(options, 'format', ['srt', 'vtt', 'both'] as const) ? { format: choiceOption(options, 'format', ['srt', 'vtt', 'both'] as const) as 'srt' | 'vtt' | 'both' } : {}),
      ...(stringOption(options, 'whisper-bin') ? { whisperBinary: stringOption(options, 'whisper-bin') as string } : {}),
      overwrite: Boolean(options.overwrite),
    };
    const files = await extractSubtitles(project, output, subtitleOptions);
    process.stderr.write(`Subtitles finalized:\n${files.map((file) => `  ${file}`).join('\n')}\n`);
    return;
  }

  if (command !== 'render') throw new Error(`Unknown command: ${command}`);
  const output = path.resolve(stringOption(options, 'output') ?? `${project.name}-rendered.mp4`);
  outputContainer(output);
  if (!options.overwrite && await outputExists(output)) {
    throw new Error(`Output already exists: ${output}. Use --overwrite to replace it.`);
  }
  const renderOptions = renderOptionsFromCli(options);
  process.stderr.write('Building edited timeline and FFmpeg composition…\n');
  const result = renderOptions.dryRun
    ? await prepareRender(project, renderOptions)
    : await renderProject(project, output, renderOptions);
  if (renderOptions.dryRun) {
    process.stdout.write(`${JSON.stringify({
      project: projectSummary(project), output, duration: result.duration,
      slices: result.slices, zooms: result.zooms, geometry: result.geometry,
      workDir: result.workDir, filterFile: result.filterFile,
    }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`Finalized: ${output}\n`);
}

main().catch((caught: unknown) => {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
