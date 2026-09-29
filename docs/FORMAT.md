# Screen Studio 3.7 source notes

The project directory is a readable source bundle rather than a single opaque media file.

- `project.json` contains scene slices, zoom ranges and visual configuration.
- `meta.json` contains the Screen Studio version.
- `recording/metadata.json` lists recorder sessions and timing.
- `recording/channel-1-display-N.mp4` is the screen stream.
- `recording/channel-3-webcam-N.mp4` is the webcam stream.
- `recording/enhanced/channel-2-microphone-N-enhanced.m4a` is preferred over the original microphone recording.
- `recording/mouseclicks-N.json` stores global logical display coordinates.
- `recording/mousemoves-N.json` stores timestamped pointer positions and cursor IDs.
- `recording/cursors.json` describes recorded cursor hotspots and standard sizes; PNG artwork lives in `recording/cursors/`.

Session source time is formed by concatenating session durations. A click's local time is `processTimeMs - processTimeStartMs`; its project source time adds all preceding display session durations. Coordinates are normalized through the matching display session `bounds`.

Scene slices refer to that source timeline. Deleted gaps must be removed before mapping zooms to output time. `timeScale` changes both media timestamps and the output positions of zoom ranges.

The same mapping is required for mouse movement. A slice with `hideCursor` omits its pointer track. Otherwise the last pointer position before the slice becomes its starting position, avoiding a cursor pop after a cut.

For `follow-click-groups`, Screen Studio starts a zoom shortly before the triggering mouse down. This renderer uses the first mouse down inside the saved zoom range as the focal point and falls back to `manualTargetPoint` when no click is present.

Manual ranges always use `manualTargetPoint`; they must not accidentally snap to a click inside the same time range. `hasInstantAnimation` distinguishes instant zooms from eased zooms.

## Local transcription assets

On Screen Studio 3.7.x for Apple Silicon, the packaged whisper.cpp executable is under the application bundle at `Contents/Resources/app.asar.unpacked/bin/whisper-darwin-arm64`. Downloaded ggml models are stored in Screen Studio's application-support `models` directory. These locations are implementation details, so the CLI also accepts explicit binary and model paths.

Subtitle audio is not raw session audio. Recorder sessions are concatenated first, then scene slices, deletions and `timeScale` are applied before the stream is converted to 16 kHz mono PCM for transcription.
