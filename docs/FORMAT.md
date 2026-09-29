# Screen Studio 3.7 source notes

The project directory is a readable source bundle rather than a single opaque media file.

- `project.json` contains scene slices, zoom ranges and visual configuration.
- `meta.json` contains the Screen Studio version.
- `recording/metadata.json` lists recorder sessions and timing.
- `recording/channel-1-display-N.mp4` is the screen stream.
- `recording/channel-3-webcam-N.mp4` is the webcam stream.
- `recording/enhanced/channel-2-microphone-N-enhanced.m4a` is preferred over the original microphone recording.
- `recording/mouseclicks-N.json` stores global logical display coordinates.

Session source time is formed by concatenating session durations. A click's local time is `processTimeMs - processTimeStartMs`; its project source time adds all preceding display session durations. Coordinates are normalized through the matching display session `bounds`.

Scene slices refer to that source timeline. Deleted gaps must be removed before mapping zooms to output time. `timeScale` changes both media timestamps and the output positions of zoom ranges.

For `follow-click-groups`, Screen Studio starts a zoom shortly before the triggering mouse down. This renderer uses the first mouse down inside the saved zoom range as the focal point and falls back to `manualTargetPoint` when no click is present.
