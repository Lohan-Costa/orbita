/**
 * O motor de vídeo do monitor SEM player nativo.
 *
 * Para o que o WebView não decodifica (ProRes…), em vez de um VLC nativo por cima
 * do webview (que MENTE no seek pausado e traz o bug de z-order), o ffmpeg gera um
 * proxy leve que o PRÓPRIO `<video>` toca frame-exato. Dois modos:
 *
 *  - `frame()`  — UM quadro exato (o still de pausa/scrub, o momento do sync-check).
 *    Vem do RUST (`monitor_frame`, ver src-tauri/src/frame.rs), fora do mutex
 *    serial do sidecar — não fica preso atrás de um transcode em curso.
 *  - `window()` — proxy H.264 ALL-INTRA de um trecho, cacheado (sidecar
 *    `monitor_window`, ver src-python/media/proxy.py). Pode demorar; o still cobre
 *    a espera.
 *
 * O teto é Full HD respeitando o aspect ratio (`full`/`half`/`quarter`); o áudio
 * NÃO vem daqui — quem toca o som é o transporte.
 */

import { invoke } from "@tauri-apps/api/core";

export type Resolution = "full" | "half" | "quarter";

/** Um quadro exato de `path` em `sec`, como bytes de um JPEG. */
export async function frame(
  path: string,
  sec: number,
  resolution: Resolution
): Promise<ArrayBuffer> {
  return await invoke<ArrayBuffer>("monitor_frame", { path, sec, resolution });
}

/** Proxy H.264 all-intra do trecho `[start, start+dur)`. Devolve o caminho do
 *  `.mp4` (cacheado). O proxy começa em t=0 — quem chama mapeia a posição da
 *  timeline para o tempo-local do proxy (`localSec - start`). */
export async function window(
  path: string,
  start: number,
  dur: number,
  resolution: Resolution
): Promise<string> {
  const res = await invoke<{ path: string }>("sidecar_call", {
    command: "monitor_window",
    params: { path, start, dur, resolution },
  });
  return res.path;
}

/** Proxy do CLIPE INTEIRO, COM áudio, para a prévia do bin (tocado no
 *  `<video controls>` nativo). Diferente do `window()`: inteiro, com som, GOP
 *  normal. Devolve o caminho do `.mp4` (cacheado). */
export async function preview(
  path: string,
  resolution: Resolution
): Promise<string> {
  const res = await invoke<{ path: string }>("sidecar_call", {
    command: "monitor_preview",
    params: { path, resolution },
  });
  return res.path;
}
