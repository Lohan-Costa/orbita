import { bucketMax } from "../../lib/peaks";
import { chooseTickStepSec } from "../../lib/timecode";
import { timelineTc, type TimelineData } from "../../types/timeline";

export const RULER_H = 22;
export const TRACK_H = 56;
export const TRACK_GAP = 4;
export const CLIP_PAD_Y = 3;

/** Zoom máximo. Fixado à taxa dos peaks (50 Hz): a 100 px/s, 1 peak = 2 px —
 *  ou seja, no zoom mais fechado a waveform já tem resolução de sobra. */
export const MAX_PX_PER_SEC = 100;

/** Entrada dos clipes: desliza da esquerda com desaceleração. Curto de
 *  propósito — a timeline se preenche em ~10s e uma animação longa viraria
 *  ruído visual. */
export const APPEAR_MS = 260;
export const APPEAR_SLIDE_PX = 14;

export const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

export interface DrawView {
  /** Largura VISÍVEL (o canvas tem o tamanho do viewport, não da timeline
   *  inteira: a 100 px/s por 95 min daria 570.000 px, muito além do limite de
   *  ~32.767 px de um canvas). */
  width: number;
  height: number;
  scrollLeft: number;
  pxPerSec: number;
  dpr: number;
  selectedPaths: Set<string>;
  /** path → instante (performance.now) em que o clipe apareceu. */
  appearedAt: Map<string, number>;
  now: number;
  /** Posição da agulha (eixo interno da timeline). `null` = sem transporte. */
  playheadSec: number | null;
}

export interface DrawTheme {
  surface: string;
  surfaceLane: string;
  line: string;
  ink3: string;
  accent: string;
  trackHues: string[];
  waveform: string;
  waveformRef: string;
  reference: string;
  flagged: string;
  flaggedHatch: string;
  adjusted: string;
  confirmed: string;
  timecode: string;
  playhead: string;
}

/**
 * Cor do corpo do clipe — quatro estados, nesta ordem de precedência:
 *   confirmado   → teal   (revisado pelo usuário; o alerta saiu)
 *   sinalizado   → âmbar  (o sistema desconfia do sync)
 *   movido à mão → roxo   (o usuário mexeu, mas ainda não confirmou)
 *   só timecode  → ardósia (posicionado pelo TC, NÃO verificado pelo áudio)
 *   normal       → cor da câmera / verde do som direto
 *
 * "Mover" NÃO tira o alerta: mover não prova que ficou certo — só confirmar.
 *
 * ⚠️ A ardósia do TC vem ANTES do "normal" (azul da câmera / verde do som): um sync
 * por timecode puro NÃO foi verificado contra o áudio e não pode se pintar da mesma
 * cor de um que foi — a cor viva dava a falsa impressão de "sincronizado e conferido".
 * Mas vem DEPOIS de confirmado/sinalizado/roxo: se o usuário já revisou (teal), ou o
 * sistema desconfia (âmbar), ou ele mexeu à mão (roxo), esse estado é o que importa.
 */
export function clipColor(
  clip: {
    flagged: boolean;
    confirmed: boolean;
    manuallyAdjusted: boolean;
    syncSource?: "waveform" | "timecode" | null;
  },
  isRef: boolean,
  theme: DrawTheme,
  hue: number
): string {
  if (clip.confirmed) return theme.confirmed;
  if (clip.flagged) return theme.flagged;
  if (clip.manuallyAdjusted) return theme.adjusted;
  if (clip.syncSource === "timecode") return theme.timecode;
  if (isRef) return theme.reference;
  return theme.trackHues[hue % theme.trackHues.length];
}

export function trackTop(index: number): number {
  return RULER_H + index * (TRACK_H + TRACK_GAP);
}

export function totalHeight(trackCount: number): number {
  return RULER_H + trackCount * (TRACK_H + TRACK_GAP);
}

/** Um retângulo em coordenadas do CONTEÚDO (o scroll já somado no x). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Os clipes que um LAÇO de seleção toca.
 *
 * Mora aqui, junto de `trackTop`, porque é a mesma geometria que DESENHA a timeline —
 * e é a única forma de o que o laço pega ser o que o usuário vê. Se a conta do y
 * vivesse no componente, uma mudança em `TRACK_H` a deixaria para trás em silêncio: o
 * laço passaria a pegar a lane de cima, e nada quebraria.
 *
 * **Interseção, não contenção**: encostar é escolher. Exigir engolir o clipe inteiro
 * obrigaria a laçar de ponta a ponta um clipe que, no zoom, tem metros de largura.
 *
 * O `rect` vem em coordenadas de CONTEÚDO — quem chama já somou o `scrollLeft`. Um
 * laço medido em coordenadas de JANELA pegaria, depois de rolar, os clipes que
 * estivessem naquele ponto da TELA e não daquele instante do TEMPO.
 */
export function clipsInRect(
  data: TimelineData,
  rect: Rect,
  pxPerSec: number
): string[] {
  const x1 = Math.min(rect.x0, rect.x1);
  const x2 = Math.max(rect.x0, rect.x1);
  const y1 = Math.min(rect.y0, rect.y1);
  const y2 = Math.max(rect.y0, rect.y1);

  const hits: string[] = [];
  data.tracks.forEach((track, i) => {
    const top = trackTop(i) + CLIP_PAD_Y;
    const bottom = top + (TRACK_H - CLIP_PAD_Y * 2);
    if (bottom < y1 || top > y2) return;   // a lane inteira está fora do laço

    for (const clip of track.clips) {
      const left = (clip.startSec - data.originSec) * pxPerSec;
      // A mesma largura mínima que o desenho usa: um clipe curtíssimo continua
      // laçável, em vez de virar uma fatia de zero pixel que nada alcança.
      const right = left + Math.max(2, clip.durationSec * pxPerSec);
      if (right >= x1 && left <= x2) hits.push(clip.path);
    }
  });
  return hits;
}

/** x em pixels do canvas (viewport) para um instante da timeline. */
function xOf(sec: number, data: TimelineData, view: DrawView): number {
  return (sec - data.originSec) * view.pxPerSec - view.scrollLeft;
}

/** true se ainda há clipe animando (o chamador reagenda um frame). */
export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  data: TimelineData,
  view: DrawView,
  peaks: Map<string, Uint8Array>,
  peakRate: number,
  theme: DrawTheme
): boolean {
  const { width, height, dpr } = view;
  let animating = false;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  drawRuler(ctx, data, view, theme);

  data.tracks.forEach((track, i) => {
    const top = trackTop(i);

    // Fundo da lane
    ctx.fillStyle = theme.surfaceLane;
    ctx.fillRect(0, top, width, TRACK_H);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + TRACK_H + 0.5);
    ctx.lineTo(width, top + TRACK_H + 0.5);
    ctx.stroke();

    const isRef = track.kind === "sound";
    const waveColor = isRef ? theme.waveformRef : theme.waveform;

    for (const clip of track.clips) {
      // Entrada: desliza da esquerda e ganha opacidade.
      const t0 = view.appearedAt.get(clip.path);
      const p = t0 === undefined ? 1 : Math.min(1, (view.now - t0) / APPEAR_MS);
      if (p < 1) animating = true;
      const ease = easeOutCubic(p);
      const slide = (1 - ease) * APPEAR_SLIDE_PX;

      const x = xOf(clip.startSec, data, view) - slide;
      const w = clip.durationSec * view.pxPerSec;

      // Fora do viewport → nem desenha (é o que mantém o custo constante,
      // independente do tamanho da timeline).
      if (x + w < 0 || x > width) continue;

      const y = top + CLIP_PAD_Y;
      const h = TRACK_H - CLIP_PAD_Y * 2;

      ctx.save();
      ctx.globalAlpha = ease;
      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(1, w), h, 3);
      ctx.clip();

      ctx.fillStyle = clipColor(clip, isRef, theme, track.hue);
      ctx.fillRect(x, y, Math.max(1, w), h);

      if (clip.flagged) drawHatch(ctx, x, y, Math.max(1, w), h, theme.flaggedHatch);

      const clipPeaks = peaks.get(clip.path);
      if (clipPeaks && clipPeaks.length > 0) {
        drawWaveform(ctx, clip.startSec, clip.durationSec, x, y, w, h, clipPeaks, peakRate, data, view, waveColor, slide);
      }

      ctx.restore();
    }
  });

  // Por último: a agulha atravessa tudo, inclusive os clipes.
  drawPlayhead(ctx, data, view, theme);

  return animating;
}

/**
 * A agulha: linha vertical da régua até o fim das tracks, com uma cabeça
 * triangular na régua (a área onde se pode arrastá-la).
 */
function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  data: TimelineData,
  view: DrawView,
  theme: DrawTheme
): void {
  if (view.playheadSec === null) return;

  const x = Math.round(xOf(view.playheadSec, data, view)) + 0.5;
  if (x < -HEAD_W || x > view.width + HEAD_W) return;

  ctx.strokeStyle = theme.playhead;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, RULER_H - HEAD_H);
  ctx.lineTo(x, view.height);
  ctx.stroke();

  // Cabeça: pentágono apontado para baixo (a ponta marca o frame exato).
  ctx.fillStyle = theme.playhead;
  ctx.beginPath();
  ctx.moveTo(x - HEAD_W / 2, RULER_H - HEAD_H);
  ctx.lineTo(x + HEAD_W / 2, RULER_H - HEAD_H);
  ctx.lineTo(x + HEAD_W / 2, RULER_H - 4);
  ctx.lineTo(x, RULER_H);
  ctx.lineTo(x - HEAD_W / 2, RULER_H - 4);
  ctx.closePath();
  ctx.fill();
}

const HEAD_W = 11;
const HEAD_H = 12;

function drawHatch(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  color: string
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const step = 7;
  for (let i = -h; i < w + h; i += step) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  clipStartSec: number,
  clipDurationSec: number,
  clipX: number,
  clipY: number,
  clipW: number,
  clipH: number,
  peaks: Uint8Array,
  peakRate: number,
  data: TimelineData,
  view: DrawView,
  color: string,
  /** Deslocamento da animação de entrada — a onda tem que deslizar junto com o
   *  retângulo, senão ela fica "parada" enquanto o clipe entra. */
  slide: number
): void {
  const midY = clipY + clipH / 2;
  const halfH = clipH / 2 - 2;

  const from = Math.max(0, Math.floor(clipX));
  const to = Math.min(view.width, Math.ceil(clipX + clipW));
  const secPerPx = 1 / view.pxPerSec;

  ctx.fillStyle = color;

  for (let px = from; px < to; px++) {
    // Instante coberto por esta coluna, relativo ao INÍCIO DA MÍDIA do clipe.
    const tSec = data.originSec + (px + slide + view.scrollLeft) * secPerPx;
    const localSec = tSec - clipStartSec;
    if (localSec < 0 || localSec > clipDurationSec) continue;

    const i0 = localSec * peakRate;
    const i1 = (localSec + secPerPx) * peakRate;
    const v = bucketMax(peaks, i0, i1) / 255;

    // sqrt levanta as partes baixas: o RMS cru desenha um fio fino e a forma
    // fica ilegível.
    const h = Math.sqrt(v) * halfH;
    if (h < 0.5) continue;
    ctx.fillRect(px, midY - h, 1, h * 2);
  }
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  data: TimelineData,
  view: DrawView,
  theme: DrawTheme
): void {
  const { width, pxPerSec, scrollLeft } = view;

  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H + 0.5);
  ctx.lineTo(width, RULER_H + 0.5);
  ctx.stroke();

  // As marcas caem em segundos redondos do TIMECODE (não do eixo interno), para
  // que os rótulos leiam 00:01:00:00 e não 00:00:59:23 — a régua é uma régua de
  // timecode, e o zero dela é o primeiro clipe.
  const step = chooseTickStepSec(pxPerSec);
  const startSec = data.originSec + scrollLeft / pxPerSec;
  const endSec = startSec + width / pxPerSec;
  const first =
    Math.floor((startSec + data.tcOffsetSec) / step) * step - data.tcOffsetSec;

  ctx.fillStyle = theme.ink3;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";

  for (let sec = first; sec <= endSec; sec += step) {
    const x = Math.round(xOf(sec, data, view)) + 0.5;
    if (x < -50 || x > width + 50) continue;

    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H - 5);
    ctx.lineTo(x, RULER_H);
    ctx.stroke();

    ctx.fillText(timelineTc(data, sec), x + 4, RULER_H / 2 - 1);
  }
}
