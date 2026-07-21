/**
 * A montagem de um TRECHO da timeline, para uma track.
 *
 * É aqui que o sync entre as tracks acontece — e por isso mora numa função pura,
 * separada do transporte: o alinhamento entre uma câmera e o som direto é a
 * promessa central do app, e uma promessa dessas merece um teste que a prove
 * (`window.test.ts` mede o deslocamento entre duas tracks contra mídia real, e
 * exige ZERO amostras).
 *
 * A ideia: um trecho não é "o clipe tocando"; é uma fatia da TIMELINE. Cada clipe
 * que a atravessa é copiado para a sua posição DENTRO do buffer, e o resto é
 * silêncio. Quem toca o buffer não precisa saber de clipe nenhum — só apertar
 * play. Todas as tracks recebem buffers assim, e todos partem no mesmo instante:
 * o alinhamento entre elas é exato por construção, não por correção.
 */

import { RATE, copyInto, prepare } from "./pcmCache";

export interface Segment {
  path: string;
  startSec: number;
  durationSec: number;
}

/** Um clipe atravessando o trecho, já recortado a ele. `t0`/`t1` são da TIMELINE. */
export interface Part {
  seg: Segment;
  t0: number;
  t1: number;
}

/** Os pedaços de `segments` que caem dentro de [startSec, endSec). */
export function partsIn(segments: Segment[], startSec: number, endSec: number): Part[] {
  const parts: Part[] = [];
  for (const seg of segments) {
    const t0 = Math.max(startSec, seg.startSec);
    const t1 = Math.min(endSec, seg.startSec + seg.durationSec);
    if (t1 <= t0) continue;
    parts.push({ seg, t0, t1 });
  }
  return parts;
}

/** Traz para a memória o áudio de que `parts` vai precisar. `null` = já está tudo lá. */
export function prepareParts(parts: Part[]): Promise<void> | null {
  const pending: Promise<void>[] = [];
  for (const { seg, t0, t1 } of parts) {
    const p = prepare(seg.path, t0 - seg.startSec, t1 - seg.startSec);
    if (p) pending.push(p);
  }
  return pending.length > 0 ? Promise.all(pending).then(() => undefined) : null;
}

/**
 * Escreve os clipes de `parts` dentro de `planes`, nas posições que a timeline
 * manda. `planes` chega zerado, e o que nenhum clipe cobrir continua zerado —
 * silêncio é a resposta certa para um buraco entre tomadas.
 *
 * As duas conversões para amostra (onde no BUFFER, e onde no ARQUIVO) arredondam
 * cada uma para o vizinho mais próximo, então o erro entre duas tracks fica em no
 * máximo uma amostra: 20 µs. Um frame a 24 fps tem 41 000 µs.
 */
export function fillWindow(planes: Float32Array[], parts: Part[], startSec: number): void {
  for (const { seg, t0, t1 } of parts) {
    copyInto(
      planes,
      Math.round((t0 - startSec) * RATE),
      seg.path,
      t0 - seg.startSec,
      t1 - seg.startSec
    );
  }
}
