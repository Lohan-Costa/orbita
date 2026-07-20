import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type LiveClip, type LiveSound } from "../store/appStore";
import { decodePeaks } from "../lib/peaks";

/**
 * Eventos emitidos pelo Rust (`lib.rs`) a partir do progresso do sidecar.
 * `data.kind` discrimina o tipo.
 */
interface SidecarProgressEvent {
  command: string;
  data: Record<string, unknown> & {
    /** `peaks` = uma waveform de câmera chegando em segundo plano, depois do sync. */
    kind?: "status" | "sound" | "clip" | "peaks";
    message?: string;
    current?: number;
    total?: number;
    path?: string;
    peaks?: string | null;
    peak_rate?: number;
  };
}

/**
 * Escuta o progresso do sidecar e alimenta a store.
 *
 * Monta UMA VEZ, no App — nunca no clique do botão: um listener registrado só
 * quando a operação começa perderia os primeiros eventos.
 */
export function useSidecarProgress(): void {
  const setSyncProgress = useAppStore((s) => s.setSyncProgress);
  const setPeaks = useAppStore((s) => s.setPeaks);
  const upsertLiveSound = useAppStore((s) => s.upsertLiveSound);
  const upsertLiveClip = useAppStore((s) => s.upsertLiveClip);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<SidecarProgressEvent>("sidecar:progress", (event) => {
      const d = event.payload.data;
      if (!d) return;

      // Peaks entram no mesmo mapa (por path) venham de onde vierem: do sync (som
      // direto, e câmeras baratas) ou do passe de segundo plano (câmeras caras).
      if (d.path && d.peaks) {
        setPeaks(d.path, decodePeaks(d.peaks), d.peak_rate ?? 50);
      }

      switch (d.kind) {
        case "sound":
          upsertLiveSound(d as unknown as LiveSound);
          break;

        case "clip":
          upsertLiveClip(d as unknown as LiveClip);
          break;

        case "peaks":
          break;   // já entrou no mapa acima; não mexe no resultado do sync

        // "status" — e também eventos sem kind, de comandos antigos.
        default:
          setSyncProgress({
            message: d.message ?? "",
            current: d.current ?? 0,
            total: d.total ?? 0,
          });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setSyncProgress, setPeaks, upsertLiveSound, upsertLiveClip]);
}
