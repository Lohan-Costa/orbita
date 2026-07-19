/** Formatação de metadados de clipe para a UI — fps e duração em timecode. */

export function formatFps(fps?: number): string {
  if (!fps) return "—";
  return `${fps % 1 === 0 ? fps.toFixed(0) : fps.toFixed(3)} fps`;
}

/** Duração em HH:MM:SS:FF, medida na grade do próprio clipe (ms + fps). */
export function formatDuration(ms?: number, fps?: number): string {
  if (!ms || !fps) return "—";
  const totalFrames = Math.round((ms / 1000) * fps);
  const fpsInt = Math.round(fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(totalFrames / fpsInt / 3600))}:${p(
    Math.floor(totalFrames / fpsInt / 60) % 60
  )}:${p(Math.floor(totalFrames / fpsInt) % 60)}:${p(totalFrames % fpsInt)}`;
}
