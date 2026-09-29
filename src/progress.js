import readline from 'node:readline';

export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function renderBar(ratio, width = 24) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function formatProgress({ elapsed, total, speed, fps, eta }) {
  const ratio = total > 0 ? elapsed / total : 0;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  const speedText = Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(2)}x` : '--x';
  const fpsText = Number.isFinite(fps) && fps > 0 ? `${fps.toFixed(1)} fps` : '-- fps';
  return `${renderBar(ratio)} ${percent.toFixed(1).padStart(5)}%  ${formatClock(elapsed)} / ${formatClock(total)}  ${fpsText}  ${speedText}  ETA ${formatClock(eta)}`;
}

export class ProgressDisplay {
  constructor(totalSeconds, output = process.stderr) {
    this.total = totalSeconds;
    this.output = output;
    this.startedAt = performance.now();
    this.lastLogAt = 0;
    this.smoothedSpeed = null;
  }

  update({ elapsed = 0, speed = 0, fps = 0 }) {
    if (speed > 0) {
      this.smoothedSpeed = this.smoothedSpeed === null ? speed : this.smoothedSpeed * 0.82 + speed * 0.18;
    }
    const eta = this.smoothedSpeed > 0 ? Math.max(0, this.total - elapsed) / this.smoothedSpeed : Infinity;
    const line = `Rendering  ${formatProgress({ elapsed, total: this.total, speed, fps, eta })}`;
    if (this.output.isTTY) {
      readline.clearLine(this.output, 0);
      readline.cursorTo(this.output, 0);
      this.output.write(line);
      return;
    }
    const now = performance.now();
    if (now - this.lastLogAt >= 5000 || elapsed >= this.total) {
      this.output.write(`${line}\n`);
      this.lastLogAt = now;
    }
  }

  finish() {
    if (this.output.isTTY) this.output.write('\n');
  }
}
