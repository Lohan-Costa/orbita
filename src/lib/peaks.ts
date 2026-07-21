/**
 * Peaks de waveform: envelope de energia RMS, um byte por bloco (0..255),
 * normalizado ao próprio pico de cada clipe (ver src-python/sync/waveform.py).
 */

/** base64 → Uint8Array. */
export function decodePeaks(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Maior valor de peaks em [from, to) — o valor a desenhar numa coluna de pixel
 * que cobre vários peaks.
 *
 * Usa o MÁXIMO (não a média) de propósito: a média some com transientes curtos
 * (uma palma, uma batida), que são justamente o que dá forma reconhecível à
 * waveform quando ela está com zoom afastado.
 */
export function bucketMax(peaks: Uint8Array, from: number, to: number): number {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(peaks.length, Math.max(lo + 1, Math.ceil(to)));
  let max = 0;
  for (let i = lo; i < hi; i++) {
    if (peaks[i] > max) max = peaks[i];
  }
  return max;
}
