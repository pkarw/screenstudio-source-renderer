# AGENTS.md

Instructions for agents and contributors working in this repository.

## Product contract

This project is a read-only renderer for native Screen Studio project directories. Never modify, rename or delete anything inside an input `.screenstudio` directory. All generated files belong in a caller-selected output path or an operating-system temporary directory.

The default render contract is **UHD 4K, 3840×2160, 60 fps, H.264/AAC in MP4**. Do not lower that default to make tests faster. Tests and examples that need speed must explicitly select `--preset 1080p`, `--preset 720p` or a short `--duration`.

## Supported output geometry

Every visual change must work in all of these layout classes:

- landscape: `4k`, `1440p`, `1080p`, `720p`
- portrait: `vertical-4k`, `vertical`
- square: `square`
- custom: any positive `--width`, `--height` and `--fps`

Fit the recorded screen inside the canvas without stretching or cropping it. Center it on the unused axis. Camera placement is relative to the output canvas and must remain inside safe margins at every aspect ratio, including while its size changes during zooms.

Supported output containers are MP4, M4V, MOV and MKV. Keep container-specific FFmpeg flags conditional. `+faststart` belongs only to ISO Base Media and MOV outputs, never Matroska.

## Architecture

- `src/project.ts`: source-project parsing, click and cursor normalization
- `src/timeline.ts`: slices, speed changes and source-to-output time mapping
- `src/options.ts`: output presets and container validation
- `src/cursor.ts`: cursor drawing and zoom-aware pointer transforms
- `src/subtitles.ts`: edited audio preparation and local Whisper invocation
- `src/ffmpeg.ts`: filter graph, masks, encoding and process orchestration
- `src/progress.ts`: terminal progress and smoothed ETA
- `src/cli.ts`: argument parsing and user-facing commands
- `src/types.ts`: shared source-project and CLI contracts

Keep parsing, timeline math and formatting as pure functions where possible. FFmpeg expressions should be generated from tested functions rather than assembled inside CLI code.

## Fidelity rules

1. Use the settings saved in `project.json` before inventing defaults.
2. Resolve `follow-click-groups` from the recorded `mouseDown` event inside each zoom range.
3. Normalize global click coordinates through the matching display session bounds.
4. Concatenate recorder sessions in source-time order before applying scene slices.
5. Map zooms through cuts and `timeScale`; never use raw source timestamps on edited output.
6. Prefer enhanced microphone files, but fall back to the original recording.
7. Preserve rounded camera alpha before dynamic scaling.
8. Clamp every zoom crop to the source frame.
9. Map cursor timing through the same slices and speed changes as the screen.
10. Keep subtitle extraction local and use the edited enhanced-audio timeline.
11. Document approximations explicitly. Do not claim pixel parity for features not implemented.

## Required checks

Run before handing off any code change:

```bash
npm test
npm run check
git diff --check
```

Changes to FFmpeg composition, geometry, codecs or containers additionally require real renders from a local fixture:

```bash
# Default contract
node dist/src/cli.js render PROJECT.screenstudio \
  --duration 1 --output /tmp/ss-render-4k.mp4 --overwrite

# Non-landscape layout
node dist/src/cli.js render PROJECT.screenstudio \
  --preset vertical --duration 1 --output /tmp/ss-render-vertical.mov --overwrite

# Matroska flag compatibility
node dist/src/cli.js render PROJECT.screenstudio \
  --preset 720p --duration 1 --output /tmp/ss-render.mkv --overwrite
```

Validate each result with `ffprobe` and a full decode pass using `ffmpeg -v error -i FILE -f null -`. For camera or zoom changes, extract and visually inspect frames before, during and after at least one zoom.

## Documentation

Update README examples and its compatibility table whenever flags, defaults, formats or limitations change. Update `docs/FORMAT.md` only when new facts about the Screen Studio bundle have been verified from actual source projects.

Do not commit recorded media, user project directories, temporary FFmpeg manifests or generated videos. Documentation screenshots are allowed only when they contain no secrets or personal data and are small enough for Git. Avoid absolute user paths in tracked files.
