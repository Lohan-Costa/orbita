/**
 * O LAÇO DE SELEÇÃO — a geometria que pode errar em silêncio.
 *
 * Um laço que pega o clipe errado não quebra nada: ele seleciona, o usuário aperta a
 * seta, e o clipe ERRADO se move. O erro só aparece depois, na timeline, como um sync
 * que "se desfez sozinho". Por isso a conta mora em `draw.ts`, junto da que DESENHA, e
 * por isso ela tem teste.
 */

import { describe, expect, it } from "vitest";
import type { TimelineData } from "../../types/timeline";
import { clipsInRect, trackTop, RULER_H, TRACK_H, CLIP_PAD_Y } from "./draw";

const PX = 10;   // 10 px por segundo

/** Duas lanes. Em cada uma, dois clipes de 2 s: em 0–2 s e em 10–12 s. */
function fixture(): TimelineData {
  const clip = (path: string, trackId: string, startSec: number) => ({
    id: path,
    path,
    name: path,
    trackId,
    startSec,
    durationSec: 2,
    flagged: false,
    flagReason: null,
    confidence: 0,
    editable: true,
    manuallyAdjusted: false,
    confirmed: false,
    hasCheckpoint: false,
    startFrames: startSec * 24,
    fps: 24,
    isSound: false,
  });

  return {
    fps: 24,
    originSec: 0,
    spanSec: 20,
    tcOffsetSec: 0,
    tracks: [
      {
        id: "camA", label: "CAM A", kind: "camera", hue: 0,
        clips: [clip("/a1.mov", "camA", 0), clip("/a2.mov", "camA", 10)],
      },
      {
        id: "camB", label: "CAM B", kind: "camera", hue: 1,
        clips: [clip("/b1.mov", "camB", 0), clip("/b2.mov", "camB", 10)],
      },
    ],
  };
}

/** O meio vertical da lane `i` — onde um laço "normal" passaria. */
const midY = (i: number) => trackTop(i) + TRACK_H / 2;

describe("laço de seleção", () => {
  it("pega os clipes que TOCA, nas lanes que cruza", () => {
    // Um laço de 0 a 5 s cobrindo as duas lanes: pega os dois primeiros clipes.
    const hits = clipsInRect(
      fixture(),
      { x0: 0, y0: midY(0), x1: 5 * PX, y1: midY(1) },
      PX
    );
    expect(hits.sort()).toEqual(["/a1.mov", "/b1.mov"]);
  });

  it("não pega a lane que NÃO cruza", () => {
    // Só a lane de cima.
    const hits = clipsInRect(
      fixture(),
      { x0: 0, y0: midY(0), x1: 5 * PX, y1: midY(0) },
      PX
    );
    expect(hits).toEqual(["/a1.mov"]);
  });

  it("ENCOSTAR é escolher — não precisa engolir o clipe inteiro", () => {
    // O laço cobre só de 1 s a 1,5 s: um pedacinho do clipe que vai de 0 a 2 s.
    // Exigir contenção obrigaria a laçar de ponta a ponta um clipe que, no zoom,
    // tem metros de largura.
    const hits = clipsInRect(
      fixture(),
      { x0: 1 * PX, y0: midY(0), x1: 1.5 * PX, y1: midY(0) },
      PX
    );
    expect(hits).toEqual(["/a1.mov"]);
  });

  it("o laço desenhado PARA TRÁS vale igual", () => {
    // Arrastar da direita para a esquerda (e de baixo para cima) é o mesmo laço —
    // quem escreve `x0 < x1` sem normalizar acaba com um laço que só funciona num
    // sentido, e o usuário jura que o app "às vezes não seleciona".
    const daEsquerda = clipsInRect(
      fixture(), { x0: 0, y0: midY(0), x1: 5 * PX, y1: midY(1) }, PX
    );
    const daDireita = clipsInRect(
      fixture(), { x0: 5 * PX, y0: midY(1), x1: 0, y1: midY(0) }, PX
    );
    expect(daDireita.sort()).toEqual(daEsquerda.sort());
  });

  it("um laço no VAZIO entre os clipes não pega nada", () => {
    // Entre 4 s e 8 s não há clipe nenhum.
    const hits = clipsInRect(
      fixture(),
      { x0: 4 * PX, y0: midY(0), x1: 8 * PX, y1: midY(1) },
      PX
    );
    expect(hits).toEqual([]);
  });

  it("o laço na RÉGUA (acima das lanes) não pega nada", () => {
    const hits = clipsInRect(
      fixture(),
      { x0: 0, y0: 0, x1: 20 * PX, y1: RULER_H - 1 },
      PX
    );
    expect(hits).toEqual([]);
  });

  it("o laço respeita a folga ENTRE as lanes", () => {
    // A faixa entre o fim do clipe da lane 0 e o começo do da lane 1 é gap: um laço
    // fino ali não seleciona ninguém. É o que impede um arrasto quase-horizontal de
    // pegar as duas lanes sem querer.
    const gapY = trackTop(0) + TRACK_H - CLIP_PAD_Y + 1;
    const hits = clipsInRect(
      fixture(),
      { x0: 0, y0: gapY, x1: 20 * PX, y1: gapY },
      PX
    );
    expect(hits).toEqual([]);
  });

  it("o ZOOM entra na conta: o mesmo laço em pixels pega menos tempo", () => {
    // A 100 px/s, um laço de 50 px cobre 0,5 s — e não alcança o clipe que começa
    // aos 10 s. Se o laço ignorasse `pxPerSec`, ele pegaria o clipe errado assim que
    // o usuário desse zoom.
    const hits = clipsInRect(
      fixture(),
      { x0: 0, y0: midY(0), x1: 50, y1: midY(1) },
      100
    );
    expect(hits.sort()).toEqual(["/a1.mov", "/b1.mov"]);
  });

  it("a ORIGEM da vista entra na conta (um sub-grupo que começa aos 10 s)", () => {
    // Numa cena, `originSec` não é zero: o clipe que começa aos 10 s é desenhado no
    // x=0. Um laço no começo da tela tem de pegar ELE — e não o clipe do segundo 0,
    // que nem está nesta vista.
    const cena: TimelineData = { ...fixture(), originSec: 10 };
    const hits = clipsInRect(
      cena,
      { x0: 0, y0: midY(0), x1: 5 * PX, y1: midY(1) },
      PX
    );
    expect(hits.sort()).toEqual(["/a2.mov", "/b2.mov"]);
  });
});
