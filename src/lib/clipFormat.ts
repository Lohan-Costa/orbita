import type { SourceKind } from "../store/appStore";

/** Formatação de metadados de clipe para a UI — fps e duração em timecode. */

/**
 * Cor de uma fonte no bin — a MESMA paleta ciclada da Timeline (`--tl-track-N`,
 * 6 matizes) para câmeras, e o verde de referência para som. `hue` é a posição
 * da fonte entre as CÂMERAS da diária (ver `Timeline`/`types/timeline.ts:
 * hue: result.camera_groups.findIndex(...)`) — mesma conta, pra CAM B ser a
 * mesma cor no bin e na track, sem duplicar a paleta em dois lugares.
 */
export function sourceColor(kind: SourceKind, hue?: number): string {
  if (kind === "sound") return "var(--tl-reference)";
  if (hue == null || hue < 0) return "var(--color-text-tertiary)";
  return `var(--tl-track-${(hue % 6) + 1})`;
}

/** Tamanho em disco, na unidade que couber. `Intl` cuida do separador decimal
 *  (vírgula em pt-BR, ponto em en) — o mesmo motivo de usá-lo em datas e TC. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fmt = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: v < 10 && i > 0 ? 1 : 0,
  });
  return `${fmt.format(v)} ${units[i]}`;
}

export function formatFps(fps?: number): string {
  if (!fps) return "—";
  return fps % 1 === 0 ? fps.toFixed(0) : fps.toFixed(3);
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
