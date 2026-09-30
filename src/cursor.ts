import { writeFile } from 'node:fs/promises';
import type { CursorDefinition, OutputCursorMove, OutputZoom, Point, Size } from './types.js';

interface CursorTransformOptions {
  width: number;
  height: number;
  zooms: OutputZoom[];
}

interface CursorAssOptions extends CursorTransformOptions {
  filename: string;
  moves: OutputCursorMove[];
  duration: number;
  logicalDisplaySize: Size;
  definitions: CursorDefinition[];
  scale: number;
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function resampleCursorMoves(moves: OutputCursorMove[], maximumRate = 30): OutputCursorMove[] {
  if (moves.length < 2 || !Number.isFinite(maximumRate) || maximumRate <= 0) return [...moves];
  const sampled: OutputCursorMove[] = [];
  let currentBucket = -1;
  for (const move of moves) {
    const bucket = Math.floor(move.time * maximumRate);
    if (bucket === currentBucket) {
      sampled[sampled.length - 1] = move;
    } else {
      sampled.push(move);
      currentBucket = bucket;
    }
  }
  return sampled;
}

export function zoomProgressAt(zoom: OutputZoom, time: number): number {
  if (time < zoom.start || time > zoom.end) return 0;
  if (zoom.instant) return 1;
  const ramp = Math.min(0.38, Math.max(0.08, (zoom.end - zoom.start) / 3));
  const progress = Math.min(
    clamp((time - zoom.start) / ramp, 0, 1),
    clamp((zoom.end - time) / ramp, 0, 1),
  );
  return Math.sin(progress * Math.PI / 2);
}

export function transformCursorPoint(
  point: Point,
  time: number,
  { width, height, zooms }: CursorTransformOptions,
): Point {
  const active = zooms.filter((zoom) => time >= zoom.start && time <= zoom.end);
  const zoomValue = 1 + active.reduce((sum, zoom) => sum + (zoom.zoom - 1) * zoomProgressAt(zoom, time), 0);
  const target = active.at(-1)?.target ?? { x: 0.5, y: 0.5 };
  const cropWidth = 1 / zoomValue;
  const cropHeight = 1 / zoomValue;
  const cropX = clamp(target.x - cropWidth / 2, 0, 1 - cropWidth);
  const cropY = clamp(target.y - cropHeight / 2, 0, 1 - cropHeight);
  return {
    x: clamp((point.x - cropX) * zoomValue * width, 0, width),
    y: clamp((point.y - cropY) * zoomValue * height, 0, height),
  };
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secs = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

function cursorDrawing(cursorId: string): { path: string; nominalHeight: number } {
  if (/ibeam/i.test(cursorId)) {
    return { path: 'm -7 -15 l 7 -15 l 7 -11 l 2 -11 l 2 11 l 7 11 l 7 15 l -7 15 l -7 11 l -2 11 l -2 -11 l -7 -11', nominalHeight: 30 };
  }
  if (/pointinghand|openhand|closedhand/i.test(cursorId)) {
    return { path: 'm 0 0 l 6 0 l 6 11 l 9 8 l 13 9 l 16 12 l 17 22 l 13 30 l 2 30 l -4 20 l -4 13 l 0 13', nominalHeight: 30 };
  }
  if (/operationnotallowed/i.test(cursorId)) {
    return { path: 'm 0 -14 b 8 -14 14 -8 14 0 b 14 8 8 14 0 14 b -8 14 -14 8 -14 0 b -14 -8 -8 -14 0 -14 m -9 -9 l 9 9', nominalHeight: 28 };
  }
  if (/resize|windowresize/i.test(cursorId)) {
    return { path: 'm -14 0 l -5 -8 l -5 -3 l 5 -3 l 5 -8 l 14 0 l 5 8 l 5 3 l -5 3 l -5 8 l -5 -8 l -5 -3 l -5 3', nominalHeight: 28 };
  }
  return { path: 'm 0 0 l 0 30 l 7 23 l 13 37 l 19 34 l 13 21 l 24 21', nominalHeight: 37 };
}

function dialogue(
  start: number,
  end: number,
  from: Point,
  to: Point,
  cursorId: string,
  scalePercent: number,
): string {
  const drawing = cursorDrawing(cursorId);
  const durationMs = Math.max(1, Math.round((end - start) * 1000));
  const movement = Math.abs(from.x - to.x) + Math.abs(from.y - to.y) < 0.5
    ? `\\pos(${from.x.toFixed(1)},${from.y.toFixed(1)})`
    : `\\move(${from.x.toFixed(1)},${from.y.toFixed(1)},${to.x.toFixed(1)},${to.y.toFixed(1)},0,${durationMs})`;
  const tags = `{${movement}\\p1\\an7\\fscx${scalePercent.toFixed(2)}\\fscy${scalePercent.toFixed(2)}\\bord2.5\\shad1\\1c&HFFFFFF&\\3c&H101018&\\4c&H000000&}`;
  return `Dialogue: 10,${assTime(start)},${assTime(end)},Cursor,,0,0,0,,${tags}${drawing.path}`;
}

export function buildCursorAss(options: Omit<CursorAssOptions, 'filename'>): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${options.width}
PlayResY: ${options.height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cursor,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00101018,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  if (options.moves.length === 0) return `${header}\n`;
  const definitions = new Map(options.definitions.map((definition) => [definition.id, definition]));
  const lines: string[] = [];

  for (let index = 0; index < options.moves.length; index += 1) {
    const move = options.moves[index];
    if (!move) continue;
    const next = options.moves[index + 1];
    const end = Math.min(options.duration, next?.time ?? options.duration);
    if (end - move.time < 0.01) continue;
    const currentPoint = transformCursorPoint(move, move.time, options);
    const nextPoint = next ? transformCursorPoint(next, end, options) : currentPoint;
    const definition = definitions.get(move.cursorId) ?? definitions.get('arrow');
    const standardHeight = definition?.standardSize.height ?? 23;
    const drawing = cursorDrawing(move.cursorId);
    const desiredHeight = standardHeight * (options.width / options.logicalDisplaySize.width) * options.scale;
    const scalePercent = desiredHeight / drawing.nominalHeight * 100;
    const gap = end - move.time;
    if (next && gap > 0.12) {
      const movementStart = end - 0.08;
      lines.push(dialogue(move.time, movementStart, currentPoint, currentPoint, move.cursorId, scalePercent));
      lines.push(dialogue(movementStart, end, currentPoint, nextPoint, move.cursorId, scalePercent));
    } else {
      lines.push(dialogue(move.time, end, currentPoint, nextPoint, move.cursorId, scalePercent));
    }
  }
  return `${header}\n${lines.join('\n')}\n`;
}

export async function writeCursorAss(options: CursorAssOptions): Promise<void> {
  await writeFile(options.filename, buildCursorAss(options), 'utf8');
}
