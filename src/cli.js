#!/usr/bin/env node
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadProject } from './project.js';
import { prepareRender, renderProject } from './ffmpeg.js';
import { durationOfSlices } from './timeline.js';
import { outputContainer } from './options.js';

function usage() {
  return `Screen Studio source renderer

Usage:
  ss-render inspect <project.screenstudio>
  ss-render render <project.screenstudio> --output <video.mp4> [options]

Options:
  --preset <name>       4k, 1440p, 1080p, 720p, vertical-4k, vertical, square
  --width <px>          Custom output width (overrides preset)
  --height <px>         Custom output height (overrides preset)
  --fps <number>        Output frame rate (default: 60)
  --start <seconds>     Preview start on edited timeline
  --duration <seconds>  Preview duration
  --encoder <name>      FFmpeg encoder (default: h264_videotoolbox)
  --overwrite           Replace an existing output
  --dry-run             Build and print the render plan without encoding
  --help                 Show this help
`;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  const booleanFlags = new Set(['overwrite', 'dry-run', 'help']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (booleanFlags.has(key)) {
      options[key.replace('-', '')] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`Missing value for --${key}`);
    options[key] = next;
    index += 1;
  }
  return { positional, options };
}

function numberOption(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be a non-negative number.`);
  return number;
}

function positiveOption(value, name) {
  const number = numberOption(value, name);
  if (number === 0) throw new Error(`--${name} must be greater than zero.`);
  return number;
}

async function outputExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function projectSummary(project) {
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
    camera: {
      aspectRatio: project.config.cameraAspectRatio,
      roundness: project.config.cameraRoundness,
      size: project.config.cameraSize,
      scaleDuringZoom: project.config.cameraScaleDuringZoom,
      position: project.config.cameraPosition,
    },
  };
}

async function main() {
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
  if (command !== 'render') throw new Error(`Unknown command: ${command}`);

  const output = path.resolve(options.output ?? `${project.name}-rendered.mp4`);
  outputContainer(output);
  if (!options.overwrite && await outputExists(output)) {
    throw new Error(`Output already exists: ${output}. Use --overwrite to replace it.`);
  }
  const renderOptions = {
    preset: options.preset,
    width: positiveOption(options.width, 'width'),
    height: positiveOption(options.height, 'height'),
    fps: positiveOption(options.fps, 'fps'),
    start: numberOption(options.start, 'start'),
    duration: numberOption(options.duration, 'duration'),
    encoder: options.encoder,
    overwrite: options.overwrite,
    dryRun: options.dryrun,
  };
  process.stderr.write('Building edited timeline and FFmpeg composition…\n');
  const result = options.dryrun
    ? await prepareRender(project, renderOptions)
    : await renderProject(project, output, renderOptions);
  if (options.dryrun) {
    process.stdout.write(`${JSON.stringify({
      project: projectSummary(project),
      output,
      duration: result.duration,
      slices: result.slices,
      zooms: result.zooms,
      geometry: result.geometry,
      workDir: result.workDir,
      filterFile: result.filterFile,
    }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`Finalized: ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
