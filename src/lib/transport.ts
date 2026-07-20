/**
 * Transporte: a agulha da timeline, o relógio que a move, e o áudio de TODAS as
 * tracks.
 *
 * O transporte toca a timeline inteira, não só o som direto: cada track (as
 * câmeras e o som) soa, e o usuário escolhe o que ouvir com solo/mute. É isso que
 * permite conferir o sync DE OUVIDO — ouvir a câmera e o som direto juntos e
 * perceber o eco quando estão fora. A waveform não pega um erro de poucos frames;
 * o ouvido pega.
 *
 * POR QUE NÃO UM `<audio>` POR TRACK (foi a primeira tentativa, e ela ATRASAVA)
 * ──────────────────────────────────────────────────────────────────────────────
 * Elementos de mídia são independentes: cada um começa a soar quando o buffer DELE
 * fica pronto, com a latência DELE. Nada os trava juntos. A diferença entre essas
 * latências — dezenas de milissegundos — vira um atraso PERMANENTE entre as
 * tracks, e o usuário ouvia um eco entre a câmera e o som direto mesmo com a
 * waveform perfeitamente alinhada na tela e o sync provado correto. Pior: a
 * correção óbvia (mexer no `currentTime` para realinhar) REINICIA o elemento e
 * recria a diferença. É a armadilha que já custou quatro bugs de relógio aqui.
 *
 * A saída não é corrigir melhor: é não ter o que corrigir.
 *
 * COMO É AGORA
 * ────────────
 * Um único `AudioContext`. Para o trecho que vai tocar, cada track vira UM buffer
 * já montado em tempo de TIMELINE (os clipes copiados para as suas posições, e
 * silêncio nos buracos), e todos os buffers partem no MESMO instante do relógio de
 * áudio, via `start(when)`. O alinhamento entre as tracks é exato à amostra POR
 * CONSTRUÇÃO — não existe partida a corrigir, nem deriva a perseguir.
 *
 * O RELÓGIO É `AudioContext.currentTime`
 * ──────────────────────────────────────
 * Ele é o relógio do hardware de áudio: sempre corre, nunca é reiniciado por um
 * seek, e não depende de nenhuma mídia estar soando. Isso apaga de uma vez a
 * complicação que existia aqui — um relógio para quando o som direto tocava,
 * outro (de parede) para os buracos entre tomadas — e apaga junto a classe de bug
 * que ela criava. Há um relógio só, e ele vale em toda parte.
 *
 * A posição é descontada da LATÊNCIA DE SAÍDA: o que está sendo renderizado agora
 * só será ouvido daqui a `outputLatency`. Sem esse desconto o vídeo apareceria
 * adiantado em relação ao som — pouco, mas na mesma ordem de grandeza de um frame,
 * que é justamente a precisão que este monitor precisa ter.
 *
 * A posição NÃO passa pelo state do React: ela muda a cada frame, e um re-render
 * por frame mataria a timeline. Quem desenha lê `positionSec` imperativamente no
 * rAF. O `subscribe` daqui é só para as mudanças GROSSAS (tocou/parou/trocou de
 * fonte).
 */

import { CHANNELS, RATE } from "./pcmCache";
import { type Part, type Segment, fillWindow, partsIn, prepareParts } from "./window";

export type { Segment };

export interface TransportTrack {
  id: string;
  kind: "camera" | "sound";
  segments: Segment[];
}

export interface TransportBounds {
  originSec: number;
  endSec: number;
}

type Listener = () => void;

/** Quanto de áudio se monta de cada vez. */
const WINDOW_SEC = 10;
/** Mantém o agendamento este tanto à frente da agulha. A folga é o orçamento para
 *  o ffmpeg trazer o próximo trecho (medido: ~60 ms por arquivo). */
const SCHEDULE_AHEAD_SEC = 20;
/** O áudio parte este tanto no futuro — o bastante para montar o primeiro buffer
 *  sem correr atrás do relógio. */
const LOOKAHEAD_SEC = 0.08;
/** Rampa de ganho no solo/mute. Cortar em degrau estala. */
const GAIN_RAMP_S = 0.015;

interface TrackState {
  track: TransportTrack;
  gain: GainNode | null;
  audible: boolean;
}

class Transport {
  private tracks = new Map<string, TrackState>();
  private bounds: TransportBounds = { originSec: 0, endSec: 0 };
  private listeners = new Set<Listener>();

  private ctx: AudioContext | null = null;
  private playing = false;

  /** A ÂNCORA: a timeline vale `anchorSec` no instante `anchorCtx` do relógio de
   *  áudio. Toda posição sai desta reta — e é por ela ser a mesma para todas as
   *  tracks que elas não podem divergir. */
  private anchorSec = 0;
  private anchorCtx = 0;

  /** Até onde o áudio já está agendado (na timeline, e no relógio de áudio). Os
   *  trechos se emendam exatamente aqui: sem costura, sem sobreposição. */
  private schedSec = 0;
  private schedCtx = 0;

  private sources: AudioBufferSourceNode[] = [];
  /** Invalida trechos em voo: um `seek` durante a montagem de uma janela não pode
   *  deixá-la chegar depois e tocar o lugar errado. */
  private gen = 0;
  private raf = 0;

  // ── Fonte ──────────────────────────────────────────────────────────────────

  setSource(tracks: TransportTrack[], bounds: TransportBounds): void {
    const sameShape =
      tracks.length === this.tracks.size &&
      tracks.every((t) => {
        const st = this.tracks.get(t.id);
        return (
          st &&
          st.track.segments.length === t.segments.length &&
          st.track.segments.every((s, i) => s.path === t.segments[i].path)
        );
      });

    this.bounds = bounds;

    if (sameShape) {
      // Mesma mídia; só as POSIÇÕES mudaram — uma correção manual. O que se ouve
      // precisa refletir isso, então o trecho agendado é remontado. Custa um
      // memcpy: o cache é indexado pelo tempo do ARQUIVO, e o arquivo não mudou.
      let moved = false;
      for (const t of tracks) {
        const st = this.tracks.get(t.id)!;
        moved ||= st.track.segments.some((s, i) => s.startSec !== t.segments[i].startSec);
        st.track = t;
      }
      if (moved) this.rebuild();
      return;
    }

    this.pause();
    this.stopSources();
    for (const st of this.tracks.values()) st.gain?.disconnect();

    const next = new Map<string, TrackState>();
    for (const t of tracks) {
      const prev = this.tracks.get(t.id);
      next.set(t.id, {
        track: t,
        gain: null,
        // A escolha de ouvir/não ouvir sobrevive a um sync novo.
        audible: prev?.audible ?? t.kind === "sound",
      });
    }
    this.tracks = next;
    this.anchorSec = bounds.originSec;
    this.emit();
  }

  get hasSource(): boolean {
    return this.tracks.size > 0;
  }

  /** Quais tracks estão soando. Chamado pelo store quando muda solo/mute.
   *  Mudo é GANHO, não transporte: nada é reagendado, nada se move. */
  setAudible(audibleIds: Set<string>): void {
    for (const [id, st] of this.tracks) {
      st.audible = audibleIds.has(id);
      if (st.gain && this.ctx) {
        st.gain.gain.setTargetAtTime(
          st.audible ? 1 : 0,
          this.ctx.currentTime,
          GAIN_RAMP_S
        );
      }
    }
  }

  // ── Relógio ────────────────────────────────────────────────────────────────

  /** O que se OUVE agora foi renderizado há `latency`. Sem descontar isto, o vídeo
   *  (que segue esta posição) apareceria adiantado em relação ao som. */
  private get latency(): number {
    const c = this.ctx;
    if (!c) return 0;
    return c.outputLatency || c.baseLatency || 0;
  }

  /** Posição da agulha, em segundos do eixo interno da timeline. */
  get positionSec(): number {
    if (!this.playing || !this.ctx) return this.anchorSec;
    const heard = this.ctx.currentTime - this.latency;
    const sec = this.anchorSec + (heard - this.anchorCtx);
    // Piso na âncora: durante o `LOOKAHEAD` o som ainda não partiu, e a agulha
    // não pode andar para trás.
    return Math.min(this.bounds.endSec, Math.max(this.anchorSec, sec));
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  // ── Transporte ─────────────────────────────────────────────────────────────

  seek(sec: number): void {
    const clamped = Math.min(
      this.bounds.endSec,
      Math.max(this.bounds.originSec, sec)
    );
    if (this.playing && this.ctx) {
      this.stopSources();
      this.anchorSec = clamped;
      this.anchorCtx = this.ctx.currentTime + LOOKAHEAD_SEC;
      this.schedSec = clamped;
      this.schedCtx = this.anchorCtx;
      this.pump();
    } else {
      this.anchorSec = clamped;
    }
    this.emit();
  }

  play(): void {
    if (this.playing || !this.hasSource) return;

    // Tocar a partir do fim rebobina — senão o play não faz nada e parece travado.
    if (this.positionSec >= this.bounds.endSec - 0.05) {
      this.anchorSec = this.bounds.originSec;
    }

    const ctx = this.ensureContext();
    void ctx.resume();          // o `play` é o gesto do usuário que o destrava

    this.playing = true;
    this.anchorCtx = ctx.currentTime + LOOKAHEAD_SEC;
    this.schedSec = this.anchorSec;
    this.schedCtx = this.anchorCtx;
    this.emit();

    this.pump();
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorSec = this.positionSec;   // congela ANTES de derrubar a flag
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stopSources();
    this.emit();
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  // ── O áudio ────────────────────────────────────────────────────────────────

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      // Taxa fixa: os buffers vêm do ffmpeg a 48 kHz, e um contexto na mesma taxa
      // não precisa reamostrar nada. `interactive` pede a menor latência de saída.
      try {
        this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      } catch {
        // Placa que não aceita 48 kHz. Um contexto na taxa dela ainda serve: os
        // buffers são reamostrados na saída, TODOS pelo mesmo caminho — o
        // alinhamento entre as tracks (que é o que este motor existe para garantir)
        // não depende da taxa. Ficar sem áudio nenhum, sim, seria pior que o bug.
        this.ctx = new AudioContext({ latencyHint: "interactive" });
      }
    }
    for (const st of this.tracks.values()) {
      if (!st.gain) {
        st.gain = this.ctx.createGain();
        st.gain.gain.value = st.audible ? 1 : 0;
        st.gain.connect(this.ctx.destination);
      }
    }
    return this.ctx;
  }

  private stopSources(): void {
    this.gen++;                          // o que estiver em voo não chega mais
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* já terminou */
      }
    }
    this.sources = [];
  }

  /** Mantém o áudio agendado à frente da agulha. Os trechos se emendam pelo
   *  relógio, então a costura entre eles é exata. */
  private pump(): void {
    if (!this.playing || !this.ctx) return;
    const horizon = this.positionSec + SCHEDULE_AHEAD_SEC;
    while (this.schedSec < horizon && this.schedSec < this.bounds.endSec) {
      const start = this.schedSec;
      const dur = Math.min(WINDOW_SEC, this.bounds.endSec - start);
      if (dur <= 1e-6) break;
      void this.scheduleWindow(start, dur, this.schedCtx, this.gen);
      this.schedSec += dur;
      this.schedCtx += dur;
    }
  }

  /**
   * Monta o trecho [startSec, startSec+durSec) de cada track e o dispara em
   * `startCtx`. É aqui que o sync entre as tracks acontece: um instante de partida
   * só, e cada clipe já copiado para a sua posição DENTRO do buffer.
   */
  private async scheduleWindow(
    startSec: number,
    durSec: number,
    startCtx: number,
    gen: number
  ): Promise<void> {
    const endSec = startSec + durSec;

    /** O que cada track tem para tocar neste trecho. */
    const work: { st: TrackState; parts: Part[] }[] = [];
    const pending: Promise<void>[] = [];

    for (const st of this.tracks.values()) {
      const parts = partsIn(st.track.segments, startSec, endSec);
      // Track sem nada aqui = buraco entre tomadas. Não se monta buffer nenhum:
      // num dia de filmagem os buracos são a maior parte do tempo.
      if (parts.length === 0) continue;
      work.push({ st, parts });
      const p = prepareParts(parts);
      if (p) pending.push(p);
    }

    if (pending.length > 0) await Promise.all(pending);

    // Um seek (ou um arrasto) durante a montagem: este trecho não vale mais.
    if (gen !== this.gen || !this.playing || !this.ctx) return;

    const ctx = this.ctx;
    const frames = Math.round(durSec * RATE);
    if (frames <= 0) return;

    // Se a montagem demorou mais que a folga, o instante de partida já passou.
    // Não se toca do começo (seria tocar o passado): entra-se ADIANTADO dentro do
    // buffer, exatamente onde o relógio já está. É para isto que `start` tem
    // `offset`.
    let when = startCtx;
    let offset = 0;
    if (when < ctx.currentTime) {
      offset = ctx.currentTime - when + 0.005;
      when = ctx.currentTime + 0.005;
      if (offset >= durSec) return;      // o trecho inteiro já passou
    }

    for (const { st, parts } of work) {
      const buf = ctx.createBuffer(CHANNELS, frames, RATE);
      const planes: Float32Array[] = [];
      for (let c = 0; c < CHANNELS; c++) planes.push(buf.getChannelData(c));
      fillWindow(planes, parts, startSec);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(st.gain!);
      src.start(when, offset);
      src.onended = () => {
        const i = this.sources.indexOf(src);
        if (i >= 0) this.sources.splice(i, 1);
      };
      this.sources.push(src);
    }
  }

  /**
   * Remonta o que está agendado, sem tocar no relógio.
   *
   * Uma correção manual muda onde o clipe cai na timeline, e o que se ouve tem de
   * mudar junto. A âncora fica INTACTA de propósito: reancorar faria a agulha
   * travar por uma fração de segundo a cada arrasto. Em vez disso, corta-se o áudio
   * velho num instante futuro e o novo entra exatamente ali.
   */
  private rebuild(): void {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const cutCtx = ctx.currentTime + LOOKAHEAD_SEC;

    this.gen++;
    for (const s of this.sources) {
      try {
        s.stop(cutCtx);
      } catch {
        /* já terminou */
      }
    }
    this.sources = [];

    this.schedSec = this.anchorSec + (cutCtx - this.anchorCtx);
    this.schedCtx = cutCtx;
    this.pump();
  }

  private tick = (): void => {
    if (!this.playing) return;
    if (this.positionSec >= this.bounds.endSec - 0.01) {
      this.pause();
      return;
    }
    this.pump();
    this.raf = requestAnimationFrame(this.tick);
  };

  // ── Assinatura (só mudanças grossas) ───────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Singleton: só existe um transporte, como só existe uma agulha. */
export const transport = new Transport();
