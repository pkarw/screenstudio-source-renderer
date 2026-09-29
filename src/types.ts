export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TimelineSlice {
  sourceStartMs: number;
  sourceEndMs: number;
  timeScale: number;
  hideCursor?: boolean;
}

export interface SourceClick extends Point {
  timeMs: number;
}

export interface SourceCursorMove extends Point {
  timeMs: number;
  cursorId: string;
}

export interface OutputCursorMove extends Point {
  time: number;
  cursorId: string;
}

export interface CursorDefinition {
  id: string;
  hotSpot: Point;
  standardSize: Size;
  imagePath: string;
}

export interface SourceZoom {
  sourceStartMs: number;
  sourceEndMs: number;
  zoom: number;
  type: string;
  target: Point;
  targetSource: 'click' | 'manual';
  instant?: boolean;
}

export interface OutputZoom {
  start: number;
  end: number;
  zoom: number;
  target: Point;
  targetSource: 'click' | 'manual';
  instant?: boolean;
}

export interface GradientStop {
  color: string;
  at: number;
}

export interface ProjectConfig {
  backgroundType?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  backgroundSystemName?: string;
  backgroundGradient?: { stops?: GradientStop[] };
  backgroundPaddingRatio?: number;
  cameraSize?: number;
  cameraRoundness?: number;
  cameraScaleDuringZoom?: number;
  cameraPosition?: CameraPosition;
  cameraPositionPoint?: Point;
  cameraAspectRatio?: string;
  hideCamera?: boolean;
  mirrorCamera?: boolean;
  [key: string]: unknown;
}

export type CameraPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type CameraCorners = 'project' | 'rounded' | 'square';

export interface ScreenStudioProject {
  directory: string;
  recordingDirectory: string;
  name: string;
  version: string;
  config: ProjectConfig;
  scene: Record<string, unknown>;
  sources: {
    display: string[];
    webcam: string[];
    microphone: string[];
  };
  enhancedAudioSessions: number;
  sessionCount: number;
  displaySize: Size;
  displayLogicalSize: Size;
  slices: TimelineSlice[];
  clicks: SourceClick[];
  cursorMoves: SourceCursorMove[];
  cursorDefinitions: CursorDefinition[];
  zooms: SourceZoom[];
}

export interface VideoGeometryOptions {
  preset?: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface RenderOptions extends VideoGeometryOptions {
  start?: number;
  duration?: number;
  encoder?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  crf?: number;
  encoderPreset?: string;
  videoBitrate?: string;
  maxrate?: string;
  bufsize?: string;
  audioBitrate?: string;
  camera?: 'project' | 'visible' | 'hidden';
  cameraSize?: number;
  cameraZoom?: number;
  cameraCorners?: CameraCorners;
  cameraRadius?: number;
  cameraZoomScale?: number;
  cameraPosition?: CameraPosition;
  cameraX?: number;
  cameraY?: number;
  backgroundColor?: string;
  backgroundGradient?: [string, string];
  backgroundImage?: string;
  cursor?: 'project' | 'visible' | 'hidden';
  cursorScale?: number;
}

export interface SubtitleOptions {
  start?: number;
  duration?: number;
  language?: string;
  model?: string;
  prompt?: string;
  format?: 'srt' | 'vtt' | 'both';
  whisperBinary?: string;
  overwrite?: boolean;
}

export interface ProgressState {
  buffer?: string;
  elapsed: number;
  speed: number;
  fps: number;
}
