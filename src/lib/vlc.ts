/**
 * O player de vídeo do monitor (libVLC numa view nativa — ver src-tauri/src/vlc.rs).
 *
 * O VLC é ESCRAVO do transporte: ele nunca decide onde está: o relógio é o som
 * direto, e este módulo repõe o vídeo na posição que o relógio dita. O áudio da
 * câmera é impossível de sair (a instância é criada com `--no-audio`).
 *
 * A view é NATIVA e fica ACIMA do webview: ela não rola, não é recortada por
 * `overflow`, e nada em HTML a cobre. Por isso o retângulo dela é reportado à
 * mão (`setRect`) e ela é escondida (`setVisible`) quando não deve aparecer.
 */

import { invoke } from "@tauri-apps/api/core";

export interface Rect {
  [k: string]: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Há libVLC utilizável? Sem ela o app roda igual, só sem monitor. */
export async function isAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("vlc_available");
  } catch {
    return false;
  }
}

/** Abre um arquivo, posiciona a view e para em `startMs`. */
export async function open(path: string, startMs: number, rect: Rect): Promise<void> {
  await invoke("vlc_open", { path, startMs: Math.round(startMs), ...rect });
}

export async function setRect(rect: Rect): Promise<void> {
  await invoke("vlc_set_rect", rect);
}

export async function setVisible(visible: boolean): Promise<void> {
  await invoke("vlc_set_visible", { visible });
}

export async function play(): Promise<void> {
  await invoke("vlc_play");
}

export async function pause(): Promise<void> {
  await invoke("vlc_pause");
}

export async function stop(): Promise<void> {
  await invoke("vlc_stop");
}

/** Posição DENTRO do arquivo aberto, em ms. */
export async function seek(ms: number): Promise<void> {
  await invoke("vlc_seek", { ms: Math.round(ms) });
}

/** Posição atual do VLC em ms (-1 = sem player). Serve à correção de deriva. */
export async function time(): Promise<number> {
  try {
    return await invoke<number>("vlc_time");
  } catch {
    return -1;
  }
}

// ── Prévia do bin (segundo player, COM áudio) ────────────────────────────────
// Separado do monitor: instância própria e janela própria. Ver src-tauri/src/vlc.rs.

/** Abre um arquivo na prévia, tocando e com som. `true` = a prévia VLC assumiu
 *  (Windows). `false` = não há motor VLC de prévia aqui (macOS) — o chamador
 *  mantém o `<video>`/aviso. */
export async function previewOpen(path: string, rect: Rect): Promise<boolean> {
  try {
    return await invoke<boolean>("vlc_preview_open", { path, ...rect });
  } catch {
    return false;
  }
}

export async function previewClose(): Promise<void> {
  await invoke("vlc_preview_close");
}

export async function previewSetPaused(paused: boolean): Promise<void> {
  await invoke("vlc_preview_set_paused", { paused });
}

export async function previewSeek(ms: number): Promise<void> {
  await invoke("vlc_preview_seek", { ms: Math.round(ms) });
}

export async function previewSetRect(rect: Rect): Promise<void> {
  await invoke("vlc_preview_set_rect", rect);
}

/** `[tempo, duração]` em ms (-1 quando indisponível). Uma chamada para a barra. */
export async function previewState(): Promise<[number, number]> {
  try {
    return await invoke<[number, number]>("vlc_preview_state");
  } catch {
    return [-1, -1];
  }
}
