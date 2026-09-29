export const VIDEO_PRESETS = Object.freeze({
  '4k': { width: 3840, height: 2160, label: 'UHD 4K landscape' },
  '1440p': { width: 2560, height: 1440, label: 'QHD landscape' },
  '1080p': { width: 1920, height: 1080, label: 'Full HD landscape' },
  '720p': { width: 1280, height: 720, label: 'HD landscape' },
  'vertical-4k': { width: 2160, height: 3840, label: 'UHD 4K portrait' },
  'vertical': { width: 1080, height: 1920, label: 'Full HD portrait' },
  'square': { width: 2160, height: 2160, label: 'Square 4K-height' },
});

export function resolveVideoGeometry(options = {}) {
  const presetName = options.preset ?? '4k';
  const preset = VIDEO_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset: ${presetName}. Available: ${Object.keys(VIDEO_PRESETS).join(', ')}`);
  }
  return {
    preset: presetName,
    width: options.width ?? preset.width,
    height: options.height ?? preset.height,
    fps: options.fps ?? 60,
  };
}

export function outputContainer(filename) {
  const extension = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  const supported = new Set(['.mp4', '.m4v', '.mov', '.mkv']);
  if (!extension || !supported.has(extension)) {
    throw new Error('Output must use a supported container extension: .mp4, .m4v, .mov or .mkv.');
  }
  return extension;
}
