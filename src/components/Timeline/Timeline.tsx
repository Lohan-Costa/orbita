import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  IconWaveSquare,
  IconZoomIn,
  IconZoomOut,
  IconArrowsHorizontal,
  IconAlertTriangle,
  IconCheck,
  IconLock,
  IconLockOpen,
  IconPlayerPlayFilled,
  IconPlayerPauseFilled,
  IconX,
  IconChevronDown,
  IconLayoutAlignLeft,
} from "@tabler/icons-react";
import { transport } from "../../lib/transport";
import { useAppStore, useActiveResult } from "../../store/appStore";
import { useI18n } from "../../hooks/useI18n";
import { timelineTc, type TimelineClip } from "../../types/timeline";
import { useTimelineData } from "../../hooks/useTimelineData";
import { ProcessingPanel, useProcessingState } from "../ProcessingPanel";
import {
  clipsInRect,
  drawTimeline,
  trackTop,
  totalHeight,
  RULER_H,
  TRACK_H,
  CLIP_PAD_Y,
  MAX_PX_PER_SEC,
  type DrawTheme,
} from "./draw";

const LABEL_W = 104;

/** Lido do CSS para a timeline seguir o design system em vez de cores soltas. */
function readTheme(el: HTMLElement): DrawTheme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    surface: v("--tl-surface", "#f5f5f3"),
    surfaceLane: v("--tl-lane", "#ececea"),
    line: v("--tl-line", "#dcdcd8"),
    ink3: v("--tl-ink-3", "#8a8a85"),
    accent: v("--tl-accent", "#378add"),
    trackHues: [
      v("--tl-track-1", "#4a90d9"),
      v("--tl-track-2", "#5aa9a0"),
      v("--tl-track-3", "#8f7fd1"),
      v("--tl-track-4", "#d99a4a"),
      v("--tl-track-5", "#c96a8e"),
      v("--tl-track-6", "#6ab04a"),
    ],
    waveform: v("--tl-waveform", "rgba(255,255,255,0.55)"),
    waveformRef: v("--tl-waveform-ref", "rgba(255,255,255,0.6)"),
    reference: v("--tl-reference", "#3f9d6b"),
    flagged: v("--tl-flagged", "#d99a4a"),
    flaggedHatch: v("--tl-flagged-hatch", "rgba(0,0,0,0.18)"),
    adjusted: v("--tl-adjusted", "#7d63c9"),
    confirmed: v("--tl-confirmed", "#2f8f8a"),
    timecode: v("--tl-timecode", "#7f8a9c"),
    playhead: v("--tl-playhead", "#e04545"),
  };
}

/** Arrasto em andamento. Vive no state do React (e não num ref) para que os divs
 *  DOM e o canvas leiam a MESMA posição — foi a divergência entre os dois que
 *  causou o bug do clipe fantasma. */
interface DragState {
  path: string;
  startX: number;
  /** Posição do clipe quando o arrasto começou, e onde ele está agora. */
  startFrames0: number;
  startFrames: number;
}

interface TimelineProps {
  height: number;
}

export function Timeline({ height: panelHeight }: TimelineProps) {
  const t = useI18n();
  const {
    syncVersion,
    peakRate,
    peaksVersion,
    timelineLocked,
    setTimelineLocked,
    moveCamera,
    moveSound,
    pairByOverlap,
    soloTracks,
    mutedTracks,
    toggleSolo,
    toggleMute,
    audibleTracks,
    peaksProgress,
    cancelPeaks,
    syncGroups,
    activeGroupId,
    setActiveGroupId,
    activeSubGroupId,
    setActiveSubGroupId,
    closeGaps,
    previewClip,
    setPreviewClip,
  } = useAppStore();
  const syncResult = useActiveResult();

  /** O grupo (a diária) na tela — dono das FONTES que o payload do resync precisa
   *  (o mesmo `group_id`/`kind` que o "Sincronizar" cheio já manda). */
  const group = syncGroups.find((g) => g.id === activeGroupId) ?? null;

  /** As cenas da diária na tela. Um sub-grupo não atravessa diárias — as da terça
   *  não têm o que fazer no seletor da quarta. */
  const subGroups = group?.subGroups ?? [];

  const [drag, setDrag] = useState<DragState | null>(null);
  /**
   * Multi-seleção — na STORE, porque as AÇÕES sobre ela vivem na barra de baixo
   * (`SelectionActions`), junto do Sincronizar/Exportar. O `anchor` (de onde um
   * shift-clique mede o intervalo) fica local: é detalhe da interação com o
   * canvas, e ninguém mais precisa dele.
   *
   * Lida aqui em cima porque a pré-visualização do arrasto (`data`, logo abaixo)
   * precisa saber QUEM está selecionado — todos se movem juntos.
   */
  const selected = useAppStore((s) => s.timelineSelection);
  const setSelected = useAppStore((s) => s.setTimelineSelection);
  const [anchor, setAnchor] = useState<string | null>(null);

  // Durante o sync, a timeline se monta a partir dos eventos que vão chegando —
  // a track do som direto aparece inteira logo de cara e os clipes surgem um a
  // um. Quando o sync termina, o resultado autoritativo assume. O monitor lê a
  // MESMA construção (ver useTimelineData).
  const base = useTimelineData();

  /** A fase de processamento em curso — a MESMA que a barra de status lê. */
  const processing = useProcessingState();

  const [arrangeMenu, setArrangeMenu] = useState(false);
  /**
   * Arrumar a timeline só vale na DIÁRIA inteira.
   *
   * Numa cena, os buracos existem porque outros clipes — que a vista esconde —
   * ocupam aquele tempo. Fechá-los ali moveria as tomadas por cima deles na
   * diária, que é onde os mutadores de fato escrevem (uma cena é uma VISTA, não
   * uma cópia). Melhor desabilitar e dizer por quê.
   */
  const canArrange = !!syncResult && !activeSubGroupId;

  // A posição provisória do arrasto entra AQUI, na fonte única de dados — assim
  // canvas e divs não têm como divergir (foi essa divergência que causou o bug do
  // clipe fantasma).
  //
  // TODOS os selecionados se movem, pelo mesmo Δ — não só o que está sob o mouse.
  // Se só ele andasse na tela e os outros pulassem ao soltar, o usuário não teria
  // como saber, ANTES de soltar, o que ia acontecer.
  const data = useMemo(() => {
    if (!base || !drag) return base;
    const delta = drag.startFrames - drag.startFrames0;
    if (delta === 0) return base;
    return {
      ...base,
      tracks: base.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) =>
          selected.has(c.path) && c.editable
            ? {
                ...c,
                startFrames: c.startFrames + delta,
                startSec: (c.startFrames + delta) / c.fps,
              }
            : c
        ),
      })),
    };
  }, [base, drag, selected]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeRef = useRef<DrawTheme | null>(null);
  /** path → quando o clipe apareceu pela primeira vez (para a animação de
   *  entrada). Vive num ref: não deve provocar re-render. */
  const appearedAt = useRef<Map<string, number>>(new Map());
  const animRaf = useRef(0);
  /** Sempre a versão mais recente de `draw` — ver comentário no loop de animação. */
  const drawRef = useRef<() => void>(() => {});

  const [viewportW, setViewportW] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(0);

  // Só o estado GROSSO do transporte entra no React (o botão play/pause). A
  // POSIÇÃO não: ela muda a cada frame e é lida imperativamente no draw.
  const isPlaying = useSyncExternalStore(
    (cb) => transport.subscribe(cb),
    () => transport.isPlaying
  );
  /** Onde o TC da agulha é escrito — por textContent, não por render. */
  const playheadTcRef = useRef<HTMLSpanElement>(null);

  // O transporte toca TODAS as tracks (as câmeras e o som direto), cada uma com o
  // seu solo/mute. Ele é remontado quando os clipes se movem (uma correção manual
  // muda as posições, e o transporte precisa saber onde tudo está).
  const transportTracks = useMemo(
    () =>
      (data?.tracks ?? []).map((tr) => ({
        id: tr.id,
        kind: tr.kind,
        segments: tr.clips.map((c) => ({
          path: c.path,
          startSec: c.startSec,
          durationSec: c.durationSec,
        })),
      })),
    [data]
  );
  useEffect(() => {
    if (!data) return;
    transport.setSource(transportTracks, {
      originSec: data.originSec,
      endSec: data.originSec + data.spanSec,
    });
    transport.setAudible(audibleTracks(transportTracks.map((t) => t.id)));
  }, [data, transportTracks, audibleTracks, soloTracks, mutedTracks]);

  /** Zoom mínimo = tudo cabe na janela. Nunca deixa afastar além disso. */
  const minPxPerSec = useMemo(() => {
    if (!data || viewportW <= 0) return 0.01;
    return Math.max(0.001, viewportW / data.spanSec);
  }, [data, viewportW]);

  const effectivePx = pxPerSec > 0 ? pxPerSec : minPxPerSec;
  const contentW = data ? data.spanSec * effectivePx : 0;
  const height = data ? totalHeight(data.tracks.length) : 0;

  // ── Tamanho do viewport ────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, [data]);

  // ── Desenho ────────────────────────────────────────────────────────────────
  // Imperativo e agendado por rAF: o scroll NUNCA passa pelo state do React
  // (seria um re-render por frame de rolagem).
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const scroll = scrollRef.current;
    if (!canvas || !scroll || !data || viewportW <= 0) return;

    if (!themeRef.current) themeRef.current = readTheme(canvas);

    const dpr = window.devicePixelRatio || 1;
    const w = viewportW;
    const h = totalHeight(data.tracks.length);

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Os peaks são lidos imperativamente: são centenas de KB e não devem
    // participar do ciclo de render do React.
    const { peaks } = useAppStore.getState();

    // Primeira vez que vemos um clipe → marca o início da animação de entrada.
    const now = performance.now();
    for (const track of data.tracks) {
      for (const clip of track.clips) {
        if (!appearedAt.current.has(clip.path)) {
          appearedAt.current.set(clip.path, now);
        }
      }
    }

    const playheadSec = transport.hasSource ? transport.positionSec : null;

    let animating = drawTimeline(
      ctx,
      data,
      {
        width: w,
        height: h,
        scrollLeft: scroll.scrollLeft,
        pxPerSec: effectivePx,
        dpr,
        selectedPaths: selected,
        appearedAt: appearedAt.current,
        now,
        playheadSec,
      },
      peaks,
      peakRate,
      themeRef.current
    );

    // O TC da agulha é escrito no DOM na mão. Passá-lo por state faria um
    // re-render da árvore inteira a cada frame de reprodução — pelo mesmo motivo
    // que o scrollLeft não passa por lá.
    if (playheadTcRef.current) {
      playheadTcRef.current.textContent =
        playheadSec === null ? "" : timelineTc(data, playheadSec);
    }

    // Tocando, a agulha anda: o loop tem que continuar mesmo sem clipe animando.
    if (transport.isPlaying) animating = true;

    // Enquanto algum clipe estiver entrando, mantém o loop de animação.
    // Chama via ref, NUNCA a `draw` capturada aqui: se os dados mudarem antes do
    // frame disparar (a 2ª passada do sync reposiciona clipes ambíguos), a
    // closure velha redesenharia o estado antigo POR CIMA do novo — o canvas
    // ficava mostrando o clipe no lugar errado enquanto o div DOM já estava no
    // certo.
    if (animating && !animRaf.current) {
      animRaf.current = requestAnimationFrame(() => {
        animRaf.current = 0;
        drawRef.current();
      });
    }
  }, [data, viewportW, effectivePx, peakRate, selected]);

  // Mantém a referência sempre na versão mais recente de `draw`.
  useLayoutEffect(() => {
    drawRef.current = draw;
  });

  useEffect(() => {
    draw();
  }, [draw, peaksVersion]);

  // Play/pause arranca (ou deixa morrer) o loop de animação: `draw` não depende
  // de `isPlaying`, então sem isto o primeiro frame da reprodução nunca viria.
  useEffect(() => {
    drawRef.current();
  }, [isPlaying]);

  // ── Agulha: scrub na régua ─────────────────────────────────────────────────
  /** x na tela → instante da timeline. */
  const secAtClientX = useCallback(
    (clientX: number): number => {
      const scroll = scrollRef.current;
      if (!scroll || !data) return 0;
      const rect = scroll.getBoundingClientRect();
      const xInContent = clientX - rect.left + scroll.scrollLeft;
      return data.originSec + xInContent / effectivePx;
    },
    [data, effectivePx]
  );

  const scrubbing = useRef(false);

  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!transport.hasSource) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbing.current = true;
      transport.seek(secAtClientX(e.clientX));
      drawRef.current();
    },
    [secAtClientX]
  );

  const onRulerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbing.current) return;
      transport.seek(secAtClientX(e.clientX));
      drawRef.current();
    },
    [secAtClientX]
  );

  const onRulerPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    scrubbing.current = false;
  }, []);

  // Espaço = tocar/pausar, como em qualquer NLE.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      // Não sequestrar a barra de espaço de quem está digitando (o campo de
      // timecode do projeto, por exemplo).
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (!transport.hasSource) return;
      e.preventDefault();
      transport.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // O canvas é redesenhado a cada frame de rolagem (os divs o browser move de
  // graça; os corpos e as waveformas são desenhados aqui).
  //
  // A dependência em `data` é OBRIGATÓRIA: enquanto não há sync, o corpo da
  // timeline renderiza o estado vazio e o div de scroll NÃO EXISTE — com deps
  // vazias, este efeito rodava uma vez, encontrava `scrollRef.current === null`,
  // desistia, e nunca mais era reinstalado. Resultado: rolar a timeline movia as
  // bordas (que são divs) e deixava os clipes congelados no canvas, até um clique
  // forçar um redraw por outro caminho.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawRef.current();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [data]);

  // ── Zoom ancorado ──────────────────────────────────────────────────────────
  // Guarda o instante sob a âncora, muda a escala, e depois do commit reposiciona
  // o scroll para que aquele instante continue no mesmo lugar da tela.
  const anchorRef = useRef<{ sec: number; viewportX: number } | null>(null);

  const zoomTo = useCallback(
    (nextPx: number, viewportX?: number) => {
      const scroll = scrollRef.current;
      if (!scroll || !data) return;

      // Sem uma âncora explícita (o pinch dá a do cursor), o zoom ancora na
      // AGULHA — é onde a atenção está, e aproximar afastando-se do ponto que se
      // quer inspecionar é exatamente o contrário do que se pede a um zoom. O
      // centro da tela só entra em cena se a agulha estiver fora do viewport.
      let anchorX = viewportX;
      if (anchorX === undefined) {
        const headX =
          (transport.positionSec - data.originSec) * effectivePx - scroll.scrollLeft;
        anchorX =
          transport.hasSource && headX >= 0 && headX <= viewportW
            ? headX
            : viewportW / 2;
      }

      const anchorSec =
        data.originSec + (scroll.scrollLeft + anchorX) / effectivePx;

      const clamped = Math.min(MAX_PX_PER_SEC, Math.max(minPxPerSec, nextPx));
      anchorRef.current = { sec: anchorSec, viewportX: anchorX };
      setPxPerSec(clamped);
    },
    [data, effectivePx, minPxPerSec, viewportW]
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const anchor = anchorRef.current;
    if (!scroll || !anchor || !data) return;
    anchorRef.current = null;
    scroll.scrollLeft =
      (anchor.sec - data.originSec) * effectivePx - anchor.viewportX;
    draw();
  }, [effectivePx, data, draw]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Pinch do trackpad no macOS chega como wheel + ctrlKey.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = scrollRef.current?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : undefined;
      zoomTo(effectivePx * Math.pow(1.0015, -e.deltaY), x);
    },
    [effectivePx, zoomTo]
  );

  // ── Correção manual: arrasto + setas ───────────────────────────────────────

  /** Os clipes como estão DESENHADOS (com a pré-visualização do arrasto aplicada). */
  const clipByPath = useMemo(() => {
    const m = new Map<string, TimelineClip>();
    for (const tr of data?.tracks ?? []) for (const c of tr.clips) m.set(c.path, c);
    return m;
  }, [data]);

  /**
   * Os clipes como estão NA STORE — sem a pré-visualização do arrasto.
   *
   * É desta que as MUTAÇÕES leem a posição. `clipByPath` deriva de `data`, que
   * durante um arrasto já vem deslocado pelo Δ: somar o Δ de novo o aplicaria DUAS
   * vezes, e o clipe pularia o dobro ao soltar.
   */
  const baseByPath = useMemo(() => {
    const m = new Map<string, TimelineClip>();
    for (const tr of base?.tracks ?? []) for (const c of tr.clips) m.set(c.path, c);
    return m;
  }, [base]);

  const canEdit = !timelineLocked && !!syncResult;

  /**
   * A ORDEM da timeline — é o que "intervalo" quer dizer num shift-clique.
   *
   * Não é a ordem do DOM nem a de chegada: é (track de cima para baixo, e dentro
   * dela o tempo). Sai de `data`, a mesma fonte que desenha — assim o que o usuário
   * seleciona é o que ele vê.
   */
  const ordered = useMemo(() => {
    const out: string[] = [];
    for (const tr of data?.tracks ?? []) {
      for (const c of [...tr.clips].sort((a, b) => a.startSec - b.startSec)) {
        out.push(c.path);
      }
    }
    return out;
  }, [data]);

  /**
   * Mover VÁRIOS clipes pelo mesmo Δ é seguro em qualquer ordem — e isso não é
   * sorte.
   *
   * `moveCamera` recalcula `offset = pos_câmera − pos_som_ATUAL`; `placeSound`
   * recalcula `offset = pos_câmera_ATUAL − pos_som`. Com o mesmo Δ nos dois:
   * `(cam+Δ) − (snd+Δ) = cam − snd` — o offset original, seja qual for a ordem em que
   * se aplicam. O invariante se AUTOCURA porque os dois mutadores derivam de posições
   * ABSOLUTAS, nunca de deltas. É consequência direta de `placeSound` ser o dono único
   * da conta (ver appStore), e tem teste.
   */
  const moveBy = useCallback(
    (deltaFrames: number) => {
      if (deltaFrames === 0) return;
      for (const path of selected) {
        // `baseByPath`, não `clipByPath`: a posição de ORIGEM, sem o Δ da
        // pré-visualização já somado (ver o comentário de `baseByPath`).
        const clip = baseByPath.get(path);
        if (!clip?.editable) continue;
        const next = clip.startFrames + deltaFrames;
        if (clip.isSound) moveSound(path, next);
        else moveCamera(path, next);
      }
    },
    [selected, baseByPath, moveCamera, moveSound]
  );

  /**
   * O LAÇO DE SELEÇÃO (marquee): arrastar no vazio da timeline.
   *
   * Coordenadas de CONTEÚDO, não de tela — o eixo x soma o `scrollLeft`. Sem isso, um
   * laço desenhado depois de rolar pegaria os clipes errados (os que estivessem
   * naquela posição da JANELA, e não do TEMPO).
   *
   * Com Shift/Cmd, SOMA à seleção em vez de substituí-la. É a mesma convenção do
   * clique, e a que qualquer NLE usa.
   */
  interface Marquee {
    x0: number;
    y0: number;
    x: number;
    y: number;
    /** Somar à seleção que já havia, em vez de trocá-la. */
    additive: boolean;
    base: Set<string>;
  }
  const [marquee, setMarquee] = useState<Marquee | null>(null);

  /** Ponto do evento em coordenadas do CONTEÚDO (com o scroll somado). */
  const contentPoint = useCallback((e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: e.clientX - r.left + el.scrollLeft,
      y: e.clientY - r.top,
    };
  }, []);

  /** Os clipes que o laço toca. A GEOMETRIA vive em `draw.ts`, junto da que desenha —
   *  ver `clipsInRect`. */
  const laced = useCallback(
    (m: Marquee): string[] =>
      data
        ? clipsInRect(data, { x0: m.x0, y0: m.y0, x1: m.x, y1: m.y }, effectivePx)
        : [],
    [data, effectivePx]
  );

  const onBgPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const p = contentPoint(e);
      if (!p) return;

      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      e.currentTarget.setPointerCapture(e.pointerId);
      setMarquee({
        x0: p.x, y0: p.y, x: p.x, y: p.y,
        additive,
        base: additive ? new Set(selected) : new Set(),
      });
    },
    [contentPoint, selected]
  );

  const onBgPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!marquee) return;
      const p = contentPoint(e);
      if (!p) return;
      setMarquee({ ...marquee, x: p.x, y: p.y });
    },
    [marquee, contentPoint]
  );

  const onBgPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!marquee) return;
      e.currentTarget.releasePointerCapture(e.pointerId);

      // Um CLIQUE (sem arrasto) no vazio desseleciona — era o comportamento antes do
      // laço existir, e continua sendo. O limiar existe porque a mão treme: sem ele,
      // todo clique viraria um laço de 1px e a desseleção nunca aconteceria.
      const arrastou =
        Math.abs(marquee.x - marquee.x0) > 3 || Math.abs(marquee.y - marquee.y0) > 3;

      if (!arrastou) {
        if (!marquee.additive) {
          setSelected(new Set());
          setAnchor(null);
        }
      } else {
        const next = new Set([...marquee.base, ...laced(marquee)]);
        setSelected(next);
        // A âncora do shift-clique seguinte é o PRIMEIRO da seleção na ordem da
        // timeline — o intervalo cresce dali, que é o menos surpreendente.
        setAnchor(ordered.find((p) => next.has(p)) ?? null);
      }
      setMarquee(null);
    },
    [marquee, laced, ordered]
  );

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, path: string) => {
      const clip = clipByPath.get(path);
      if (!clip) return;

      // Não deixa o clique chegar ao fundo (que desselecionaria).
      e.stopPropagation();

      // Selecionar SEMPRE — inclusive com a trava ligada. A trava impede mover,
      // não impede inspecionar/selecionar (e sem seleção não há atalho de
      // teclado nem botão de confirmar).
      let next: Set<string>;
      if (e.shiftKey && anchor) {
        // Intervalo, na ordem da TIMELINE (ver `ordered`).
        const a = ordered.indexOf(anchor);
        const b = ordered.indexOf(path);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        next = new Set(ordered.slice(lo, hi + 1));
      } else if (e.metaKey || e.ctrlKey) {
        next = new Set(selected);
        next.has(path) ? next.delete(path) : next.add(path);
        setAnchor(path);
      } else if (selected.has(path) && selected.size > 1) {
        // Clicar num clipe JÁ selecionado não desmonta a seleção — senão seria
        // impossível arrastar vários: o pointerdown mataria a seleção antes do
        // arrasto começar.
        next = selected;
      } else {
        next = new Set([path]);
        setAnchor(path);
      }
      setSelected(next);

      if (!clip.editable || !canEdit) return;
      const base0 = baseByPath.get(path);
      if (!base0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({
        path,
        startX: e.clientX,
        startFrames0: base0.startFrames,
        startFrames: base0.startFrames,
      });
    },
    [clipByPath, baseByPath, canEdit, selected, anchor, ordered]
  );

  const onClipPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag || !data) return;
      const clip = clipByPath.get(drag.path);
      if (!clip) return;
      const deltaFrames = Math.round(
        ((e.clientX - drag.startX) / effectivePx) * clip.fps
      );
      setDrag({ ...drag, startFrames: drag.startFrames0 + deltaFrames });
    },
    [drag, data, clipByPath, effectivePx]
  );

  const onClipPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      // Só grava se realmente moveu — um clique simples não deve marcar o clipe
      // como "ajustado à mão".
      if (drag.startFrames !== drag.startFrames0) {
        // Arrastar um clipe arrasta TODOS os selecionados, pelo mesmo Δ. Arrastar um
        // SOM o move contra as câmeras dele (que ficam paradas); arrastar uma CÂMERA a
        // move contra o som da tomada. Ver appStore.
        moveBy(drag.startFrames - drag.startFrames0);
        // AO SOLTAR: se um clipe solto (órfão) caiu SOBRE o seu par, cria o sync ali.
        // Só no drop (não nas setas): parear a cada 1 frame de nudge surpreenderia.
        pairByOverlap([...selected]);
      }
      setDrag(null);
    },
    [drag, moveBy, pairByOverlap, selected]
  );

  // Setas movem 1 frame (Shift = 10) — é o ajuste fino que o arrasto não dá num
  // zoom afastado, onde 1 px pode valer muitos frames. Movem TODOS os selecionados.
  useEffect(() => {
    if (selected.size === 0 || !canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      moveBy((e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, canEdit, moveBy]);

  const selectedClips = useMemo(
    () => [...selected].map((p) => clipByPath.get(p)).filter((c): c is TimelineClip => !!c),
    [selected, clipByPath]
  );
  /** A barra mostra o clipe quando há UM só. Com vários, ela mostra a contagem. */
  const selectedClip = selectedClips.length === 1 ? selectedClips[0] : undefined;

  // Reseta o zoom num sync NOVO — ou ao TROCAR DE DIÁRIA OU DE CENA. Depender de
  // `syncResult` aqui resetaria zoom e seleção a cada tecla de seta, já que editar cria
  // um objeto novo; e não depender do escopo deixaria a nova vista herdar o zoom e a
  // rolagem da anterior, que descrevem outro trecho de tempo — entrar numa cena que só
  // começa aos 5 min deixaria a tela parada num ponto onde a cena não tem nada.
  useEffect(() => {
    setPxPerSec(0);
    setSelected(new Set());
    setAnchor(null);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [syncVersion, activeGroupId, activeSubGroupId]);

  // Sync novo (a timeline zerou) → esquece as entradas antigas, para que os
  // clipes voltem a animar em vez de aparecerem prontos.
  useEffect(() => {
    if (!data) appearedAt.current.clear();
  }, [data]);

  useEffect(
    () => () => {
      if (animRaf.current) cancelAnimationFrame(animRaf.current);
    },
    []
  );

  const flaggedCount = useMemo(
    () =>
      data
        ? data.tracks.reduce(
            (n, tr) => n + tr.clips.filter((c) => c.flagged).length,
            0
          )
        : 0,
    [data]
  );
  const clipCount = useMemo(
    () =>
      data
        ? data.tracks
            .filter((tr) => tr.kind === "camera")
            .reduce((n, tr) => n + tr.clips.length, 0)
        : 0,
    [data]
  );

  const flagReasons = t.timeline.flagReasons as Record<string, string>;

  /** Quais tracks estão soando — para apagar o rótulo das que não estão. */
  const audible = useMemo(
    () => audibleTracks((data?.tracks ?? []).map((tr) => tr.id)),
    [data, audibleTracks, soloTracks, mutedTracks]
  );

  return (
    <div
      className="flex flex-col flex-shrink-0 bg-surface overflow-hidden"
      style={{ height: panelHeight }}
      // Um clique em QUALQUER lugar da timeline devolve o monitor ao vídeo
      // sincronizado — a prévia do bin (duplo-clique num clipe do painel de
      // mídia) e o monitor da timeline são o MESMO elemento de tela (motor
      // único), então só um dos dois pode estar em cima por vez. Captura (não
      // bubble): tem que valer mesmo se um handler interno parar a propagação
      // (drag de clipe, laço de seleção etc.). Só vale havendo `syncResult`:
      // sem sync, o monitor da timeline não tem NADA para mostrar (tela preta),
      // e fechar a prévia trocaria "algo" por "nada".
      onMouseDownCapture={() => {
        if (previewClip && syncResult) setPreviewClip(null);
      }}
    >
      {/* Toolbar.
          `overflow-hidden` + `flex-shrink-0` nos itens + `truncate` no que pode
          encolher: a barra tem altura FIXA (h-8), então um texto sem
          `whitespace-nowrap` não some — ele QUEBRA A LINHA dentro de 32 px e
          vaza por cima do resto. Quem encolhe aqui é o nome do clipe
          selecionado, que é o único item de tamanho imprevisível. */}
      <div className="flex items-center gap-2 px-4 h-8 border-b border-line flex-shrink-0 overflow-hidden">
        <span className="panel-title flex-shrink-0">{t.timeline.title}</span>

        {/* Qual DIÁRIA está na tela. Com uma só, o seletor não aparece — não há o
            que escolher, e um seletor de um item só é ruído. */}
        {syncGroups.length > 1 && (
          <select
            className="text-[11px] bg-surface-2 border border-line rounded px-1.5 py-0.5 text-ink outline-none focus:border-accent"
            value={activeGroupId ?? ""}
            onChange={(e) => setActiveGroupId(e.target.value)}
            title={t.groups.activeDay}
          >
            {syncGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.result ? "" : ` — ${g.error ? t.groups.failed : t.groups.notSynced}`}
              </option>
            ))}
          </select>
        )}

        {/* Qual CENA da diária. "Diária inteira" está sempre lá: entrar numa cena é
            um recorte da vista, e sair dele tem de ser um clique. Sem cenas, o
            seletor não existe. */}
        {subGroups.length > 0 && (
          <select
            className="text-[11px] bg-surface-2 border border-line rounded px-1.5 py-0.5 text-ink outline-none focus:border-accent"
            value={activeSubGroupId ?? ""}
            onChange={(e) => setActiveSubGroupId(e.target.value || null)}
            title={t.groups.activeSubGroup}
          >
            <option value="">{t.groups.wholeDay}</option>
            {subGroups.map((sg) => (
              <option key={sg.id} value={sg.id}>
                {sg.name}
              </option>
            ))}
          </select>
        )}

        {/* Transporte: o relógio é o som direto (ver lib/transport.ts) */}
        <button
          className="tbtn p-1"
          onClick={() => transport.toggle()}
          disabled={!syncResult}
          title={isPlaying ? t.timeline.pause : t.timeline.play}
        >
          {isPlaying ? (
            <IconPlayerPauseFilled size={12} />
          ) : (
            <IconPlayerPlayFilled size={12} />
          )}
        </button>
        <span
          ref={playheadTcRef}
          className="text-[11px] font-mono tabular-nums text-ink-2 w-[86px] flex-shrink-0"
        />

        {data && (
          <>
            <span className="text-[11px] text-ink-3 flex-shrink-0 whitespace-nowrap">
              {t.timeline.clipCount.replace("{{n}}", String(clipCount))}
            </span>
            {flaggedCount > 0 && (
              <span className="status-pill pill-warning gap-1 flex-shrink-0">
                <IconAlertTriangle size={11} />
                {t.timeline.flaggedCount.replace("{{n}}", String(flaggedCount))}
              </span>
            )}
            {/* As waveforms das câmeras chegam DEPOIS do sync, em segundo plano (o
                sync não lê os arquivos inteiros). Sem este aviso elas apareceriam
                sozinhas nas tracks, sem explicação. */}
            {peaksProgress && (
              <span
                className="status-pill pill-muted gap-1 flex-shrink-0"
                title={t.timeline.peaksHint}
              >
                <IconWaveSquare size={11} className="animate-pulse" />
                {t.timeline.peaksProgress
                  .replace("{{done}}", String(peaksProgress.done))
                  .replace("{{total}}", String(peaksProgress.total))}
                <button
                  className="ml-1 text-ink-3 hover:text-ink"
                  onClick={cancelPeaks}
                  title={t.timeline.peaksCancel}
                >
                  <IconX size={11} />
                </button>
              </span>
            )}
          </>
        )}

        {syncResult && selected.size === 0 && !timelineLocked && (
          <span className="text-[11px] text-ink-3 ml-2 truncate min-w-0">
            {t.timeline.editHint}
          </span>
        )}

        {/* UM clipe: nome e posição. VÁRIOS: a contagem — listar dez nomes seria
            ilegível, e o que importa saber é quantos vão se mexer juntos. */}
        {selectedClip && data && (
          // O único item de largura imprevisível da barra (nomes de arquivo de
          // som chegam a 40+ caracteres): é ELE que encolhe, com reticências.
          <span
            className="text-[11px] text-ink-2 font-mono ml-2 truncate min-w-0"
            title={selectedClip.name}
          >
            {selectedClip.name} · {timelineTc(data, selectedClip.startSec)}
            {selectedClip.manuallyAdjusted && !selectedClip.confirmed && (
              <span className="text-ink-3"> · {t.timeline.adjusted}</span>
            )}
          </span>
        )}

        {/* As AÇÕES sobre a seleção (re-sincronizar, criar cena, confirmar,
            reverter) NÃO ficam aqui: vivem na barra de baixo, ao lado do
            Sincronizar/Exportar (ver `SelectionActions`). Esta barra é de
            INFORMAÇÃO — quando as duas coisas dividiam o espaço, o nome do clipe
            selecionado era empurrado para fora da tela. */}

        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {/* Ação de ARRUMAÇÃO da timeline. O botão executa a escolhida; a setinha
              abre a lista — hoje só "fechar lacunas", e o menu existe para as
              próximas entrarem sem virar mais um botão solto na barra. */}
          {/* Só o ÍCONE: a barra já está cheia, e um rótulo aqui empurrava o
              nome do clipe selecionado para fora. As duas metades usam o mesmo
              `p-1` — é o que garante que tenham a mesma altura. */}
          <div className="relative flex items-center">
            <button
              className="tbtn p-1 rounded-r-none"
              onClick={() => closeGaps()}
              disabled={!canArrange}
              title={`${t.timeline.closeGaps} — ${
                activeSubGroupId ? t.timeline.closeGapsSceneHint : t.timeline.closeGapsHint
              }`}
              aria-label={t.timeline.closeGaps}
            >
              <IconLayoutAlignLeft size={13} />
            </button>
            <button
              className="tbtn p-1 rounded-l-none border-l-0"
              onClick={() => setArrangeMenu((v) => !v)}
              disabled={!canArrange}
              title={t.timeline.arrangeOptions}
              aria-label={t.timeline.arrangeOptions}
            >
              <IconChevronDown size={11} />
            </button>
            {arrangeMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setArrangeMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[200px] bg-surface border border-line rounded-md shadow-lg py-1">
                  <button
                    className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => {
                      setArrangeMenu(false);
                      closeGaps();
                    }}
                  >
                    <IconCheck size={12} className="text-accent mt-0.5 flex-shrink-0" />
                    <span className="flex flex-col">
                      <span className="text-[11px] text-ink">{t.timeline.closeGaps}</span>
                      <span className="text-[10px] text-ink-3">
                        {t.timeline.closeGapsHint}
                      </span>
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="w-px h-4 bg-line mx-1" />
          <button
            className={`tbtn p-1 ${timelineLocked ? "selected" : ""}`}
            title={timelineLocked ? t.timeline.unlock : t.timeline.lock}
            onClick={() => setTimelineLocked(!timelineLocked)}
            disabled={!syncResult}
          >
            {timelineLocked ? <IconLock size={13} /> : <IconLockOpen size={13} />}
          </button>
          <div className="w-px h-4 bg-line mx-1" />
          <button
            className="tbtn p-1"
            title={t.timeline.zoomOut}
            onClick={() => zoomTo(effectivePx / 1.6)}
            disabled={!data}
          >
            <IconZoomOut size={13} />
          </button>
          <button
            className="tbtn p-1"
            title={t.timeline.zoomIn}
            onClick={() => zoomTo(effectivePx * 1.6)}
            disabled={!data}
          >
            <IconZoomIn size={13} />
          </button>
          <button
            className="tbtn p-1"
            title={t.timeline.zoomFit}
            onClick={() => {
              setPxPerSec(0);
              if (scrollRef.current) scrollRef.current.scrollLeft = 0;
            }}
            disabled={!data}
          >
            <IconArrowsHorizontal size={13} />
          </button>
        </div>
      </div>

      {/* Corpo — rola na vertical quando as tracks não cabem na altura do painel */}
      {!data ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          {/* O processamento tem precedência sobre o "vazio": enquanto o app
              trabalha, dizer "sincronize os clipes" seria mentir sobre o estado
              — e é justamente aqui que o usuário olha para saber se travou. */}
          {processing ? (
            <ProcessingPanel state={processing} />
          ) : (
            <>
              <IconWaveSquare size={20} className="text-ink-3" />
              <p className="text-[12px] text-ink-3">{t.timeline.empty}</p>
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto flex" style={{ height: undefined }}>
          {/* Rótulos das tracks — coluna fixa FORA da área de scroll horizontal,
              para que nenhuma transformação de coordenada precise descontá-la. */}
          <div
            className="flex-shrink-0 border-r border-line bg-surface-2"
            style={{ width: LABEL_W, height }}
          >
            <div style={{ height: RULER_H }} />
            {data.tracks.map((track) => (
              <div
                key={track.id}
                className="flex items-center gap-1.5 px-2 border-b border-line"
                style={{ height: TRACK_H + 4 }}
              >
                <span
                  className="text-[11px] truncate"
                  style={{
                    color:
                      track.kind === "sound" ? "var(--tl-reference)" : undefined,
                    // Uma track que não vai soar fica apagada — o estado é visível
                    // sem precisar decifrar dois botões.
                    opacity: audible.has(track.id) ? 1 : 0.4,
                  }}
                  title={track.label}
                >
                  {track.label}
                </span>
                {/* Solo/mute, como numa mesa. É o que permite conferir o sync DE
                    OUVIDO: ouvir a câmera junto com o som direto e perceber o eco
                    quando estão fora. A waveform não pega um erro de poucos
                    frames; o ouvido pega. */}
                <div className="flex flex-col gap-px flex-shrink-0 ml-auto">
                  <button
                    className={`sm-btn ${soloTracks.has(track.id) ? "solo" : ""}`}
                    onClick={() => toggleSolo(track.id)}
                    title={t.timeline.solo}
                  >
                    S
                  </button>
                  <button
                    className={`sm-btn ${
                      mutedTracks.has(track.id) && soloTracks.size === 0 ? "mute" : ""
                    }`}
                    onClick={() => toggleMute(track.id)}
                    title={t.timeline.mute}
                  >
                    M
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Área rolável: o canvas fica grudado (sticky) no viewport e é
              redesenhado no scroll; os divs de clipe vivem no espaço de scroll,
              então o browser os move de graça.

              A ALTURA EXPLÍCITA é obrigatória. Sem ela, este div (um item flex)
              estica só até a altura do CONTAINER, enquanto a coluna de rótulos
              tem a altura do CONTEÚDO e transborda — e com `overflow-y-hidden`
              tudo o que passasse da altura do container era recortado aqui
              dentro. Resultado: os rótulos rolavam e os clipes não, e a última
              track (a do som) simplesmente não existia na tela. Só aparecia com
              4+ tracks, que é quando o conteúdo passa a não caber. */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden relative"
            style={{ height }}
            onWheel={onWheel}
            // Arrastar no vazio = LAÇO de seleção. Clicar no vazio (sem arrastar)
            // desseleciona, como antes. Os clipes param o evento, então um arrasto que
            // começa EM CIMA de um clipe é um arrasto de clipe, nunca um laço.
            onPointerDown={onBgPointerDown}
            onPointerMove={onBgPointerMove}
            onPointerUp={onBgPointerUp}
            onPointerCancel={() => setMarquee(null)}
          >
            <div style={{ width: contentW, height, position: "relative" }}>
              <canvas
                ref={canvasRef}
                className="sticky left-0 top-0 pointer-events-none"
                style={{ zIndex: 0 }}
              />

              {/* O LAÇO. Acima dos clipes (z=4) para ser visível por cima deles, e
                  `pointer-events-none` para não roubar o pointerup de quem o desenha. */}
              {marquee && (
                <div
                  className="absolute pointer-events-none rounded-[2px]"
                  style={{
                    left: Math.min(marquee.x0, marquee.x),
                    top: Math.min(marquee.y0, marquee.y),
                    width: Math.abs(marquee.x - marquee.x0),
                    height: Math.abs(marquee.y - marquee.y0),
                    border: "1px solid var(--tl-accent)",
                    background: "color-mix(in srgb, var(--tl-accent) 14%, transparent)",
                    zIndex: 4,
                  }}
                />
              )}

              {/* Faixa de scrub: cobre a régua e leva a agulha ao ponto clicado.
                  Fica ACIMA dos clipes (z=3) para que arrastar na régua nunca
                  agarre um clipe por engano. */}
              <div
                className="absolute top-0 left-0 cursor-ew-resize"
                style={{ width: contentW, height: RULER_H, zIndex: 3 }}
                onPointerDown={onRulerPointerDown}
                onPointerMove={onRulerPointerMove}
                onPointerUp={onRulerPointerUp}
              />

              {data.tracks.map((track, i) =>
                track.clips.map((clip) => {
                  const x = (clip.startSec - data.originSec) * effectivePx;
                  const w = Math.max(2, clip.durationSec * effectivePx);
                  const isSel = selected.has(clip.path);
                  const draggable = clip.editable && canEdit;
                  const isDragging = drag?.path === clip.path;
                  return (
                    <div
                      key={clip.id}
                      className={`tl-clip absolute rounded-[3px] transition-shadow ${
                        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                      }`}
                      style={{
                        left: x,
                        top: trackTop(i) + CLIP_PAD_Y,
                        width: w,
                        height: TRACK_H - CLIP_PAD_Y * 2,
                        zIndex: isDragging ? 2 : 1,
                        border: clip.confirmed
                          ? "1px solid var(--tl-confirmed-border)"
                          : clip.flagged
                          ? "2px solid var(--tl-flagged-border)"
                          : clip.manuallyAdjusted
                          ? "1px solid var(--tl-adjusted-border)"
                          : clip.syncSource === "timecode"
                          ? "1px solid var(--tl-timecode-border)"
                          : "1px solid rgba(0,0,0,0.18)",
                        boxShadow: isSel
                          ? "0 0 0 2px var(--tl-accent)"
                          : undefined,
                      }}
                      onPointerDown={(e) => onClipPointerDown(e, clip.path)}
                      onPointerMove={onClipPointerMove}
                      onPointerUp={onClipPointerUp}
                      title={
                        `${clip.name}\n` +
                        `${timelineTc(data, clip.startSec)} → ` +
                        `${timelineTc(data, clip.startSec + clip.durationSec)}` +
                        (clip.flagged && clip.flagReason
                          ? `\n⚠ ${flagReasons[clip.flagReason] ?? clip.flagReason}`
                          : "") +
                        (clip.syncSource === "timecode" && !clip.flagged
                          ? `\n⏱ ${t.timeline.tcPlaced}`
                          : "") +
                        (clip.confirmed ? `\n✓ ${t.timeline.confirmed}` : "")
                      }
                    >
                      {w > 56 && (
                        <span className="sticky left-1 top-0 inline-block px-1 py-0.5 text-[10px] text-white/90 truncate max-w-full pointer-events-none">
                          {clip.name}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
