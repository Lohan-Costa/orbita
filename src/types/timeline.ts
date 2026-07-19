import type {
  LiveClip,
  LiveGroup,
  LiveSound,
  SyncedCamera,
  SyncedSound,
  SyncedTake,
  SyncResult,
} from "../store/appStore";
import { secondsToTc } from "../lib/timecode";

export interface TimelineClip {
  /** = path (identidade estável entre eventos, re-syncs e o export). */
  id: string;
  path: string;
  name: string;
  trackId: string;
  startSec: number;
  durationSec: number;
  flagged: boolean;
  flagReason: string | null;
  confidence: number;
  editable: boolean;
  manuallyAdjusted: boolean;
  confirmed: boolean;
  /** Existe um MARCO (um estado confirmado) para onde o *reverter* volta — e que é
   *  diferente do que o sync calculou. É o que decide se o botão "voltar ao original"
   *  aparece: sem marco, os dois reverteres fazem a mesma coisa, e dois botões iguais
   *  só ensinam o usuário a não ler. */
  hasCheckpoint: boolean;
  /** Posição absoluta em frames — a unidade em que o ajuste fino acontece. */
  startFrames: number;
  fps: number;
  /** Som direto = a referência. Move-se por outra regra (ver appStore.moveSound). */
  isSound: boolean;
  /** "timecode" = posicionado só pelo TC, SEM verificação de áudio → cor distinta na
   *  timeline (não pode parecer um sync verificado). "waveform"/undefined = o som
   *  confirmou, ou não se aplica. */
  syncSource?: "waveform" | "timecode" | null;
}

export interface TimelineTrack {
  id: string;
  label: string;
  /** "sound" = a track do som direto (uma só, embaixo, com os sons de todas as
   *  tomadas do dia). */
  kind: "camera" | "sound";
  /** Índice do grupo na ORDEM ORIGINAL (= número da track de vídeo no NLE). A cor
   *  sai daqui, não da posição na tela. */
  hue: number;
  clips: TimelineClip[];
}

export interface TimelineData {
  fps: number;
  /** Onde a VISTA começa: o início do primeiro clipe DELA. Num sub-grupo que só
   *  começa aos 5 min, é 300 — e não 0. */
  originSec: number;
  spanSec: number;
  /** Segundos a somar a um instante da timeline para obter o TC EXIBIDO.
   *
   *  Sai da origem da DIÁRIA, nunca da origem da vista — ver `assemble`. */
  tcOffsetSec: number;
  /** Câmeras primeiro; o som direto é sempre a ÚLTIMA track (embaixo). */
  tracks: TimelineTrack[];
}

/** Instante da timeline → timecode exibido. Único lugar que sabe a conversão. */
export function timelineTc(data: TimelineData, sec: number): string {
  return secondsToTc(sec + data.tcOffsetSec, data.fps);
}

/** O clipe de um ângulo que está no ar num dado instante, e onde dentro dele. */
export interface ProgramFrame {
  clip: TimelineClip;
  /** Segundos DENTRO do arquivo — é o que o player recebe no seek. */
  localSec: number;
}

/**
 * Qual arquivo da track `trackId` cobre o instante `sec`, e em que ponto dele.
 *
 * É a regra do monitor multicam, e a mesma serve para o som: uma câmera grava em
 * pedaços e um dia tem uma tomada de som por vez, então "mostrar a CAM_A" (ou
 * "tocar o som direto") significa mostrar o ARQUIVO que existe sob a agulha — e
 * trocar de arquivo quando ela cruza a fronteira. `null` quando não há nada ali:
 * a tela fica preta e o áudio, mudo. É a verdade, e é informação.
 */
export function programFrameAt(
  data: TimelineData,
  trackId: string | null,
  sec: number
): ProgramFrame | null {
  if (!trackId) return null;
  const track = data.tracks.find((tr) => tr.id === trackId);
  if (!track) return null;

  for (const clip of track.clips) {
    if (sec >= clip.startSec && sec < clip.startSec + clip.durationSec) {
      return { clip, localSec: sec - clip.startSec };
    }
  }
  return null;
}

/** A track do som direto. É uma só por diária, e é sempre a última. */
export function soundTrack(data: TimelineData): TimelineTrack | undefined {
  return data.tracks.find((tr) => tr.kind === "sound");
}

/**
 * O id da track de som — POR DIÁRIA.
 *
 * Era a constante `"__sound__"`, e com duas diárias carregadas isso vira um bug: os
 * ids de track são a chave de `soloTracks`/`mutedTracks`, então dar solo no som da
 * terça daria solo no som da quarta também.
 *
 * Com o id carimbado pela diária, TODO track id fica único no projeto (as câmeras já
 * eram: são uuids de fonte). É o que permite solo/mute e `activeAngleId` continuarem
 * GLOBAIS — o estado de mesa sobrevive à troca de diária, que é o menos surpreendente.
 */
export function soundTrackId(syncGroupId: string): string {
  return `__sound__:${syncGroupId}`;
}

/**
 * Monta a `TimelineData` a partir das tracks já construídas.
 *
 * `tcOriginSec` é o instante que RECEBE o timecode inicial — "onde o tempo zero
 * está" —, e é coisa diferente de `originSec`, que é só "onde a vista começa".
 * Na diária os dois coincidem. Num SUB-GRUPO, não: se o primeiro clipe dele cai
 * aos 5 min, a vista começa em 300 mas o tempo zero continua sendo o da diária, e
 * quem chama passa a origem DELA. Sem essa separação, o mesmo arquivo mostraria
 * `01:00:00:00` no sub-grupo e `01:05:00:00` na diária — o app mentiria, e a
 * mentira só apareceria no Premiere.
 *
 * Default = `originSec`: preserva exatamente o comportamento da diária.
 */
function assemble(
  fps: number,
  cameraTracks: TimelineTrack[],
  sounds: TimelineClip[],
  soundLabel: string,
  startTcFrames: number,
  soundId: string,
  tcOriginSec?: number
): TimelineData | null {
  const soundTrackData: TimelineTrack = {
    id: soundId,
    label: soundLabel,
    kind: "sound",
    hue: 0,
    clips: sounds,
  };

  const all = [...cameraTracks.flatMap((t) => t.clips), ...sounds];
  if (all.length === 0) return null;

  const originSec = Math.min(...all.map((c) => c.startSec));
  const endSec = Math.max(...all.map((c) => c.startSec + c.durationSec));

  return {
    fps,
    originSec,
    tcOffsetSec: startTcFrames / fps - (tcOriginSec ?? originSec),
    spanSec: Math.max(1, endSec - originSec),
    // Convenção de NLE: V1 embaixo, V2 acima. Como o grupo 0 vira a V1 no PRPROJ,
    // ele tem que ser a track de vídeo MAIS BAIXA aqui — senão a timeline
    // contradiz o que o usuário vai ver no Premiere. O som fica abaixo de tudo.
    tracks: [...cameraTracks].reverse().concat(soundTrackData),
  };
}

/** Onde uma câmera começa, em segundos. Escrito UMA vez: a origem da diária e a
 *  posição do clipe têm de sair da mesma conta, ou o timecode diverge. */
const cameraStartSec = (c: SyncedCamera, fps: number) =>
  c.timeline_start_frames / (c.fps || fps);
const soundStartSec = (s: SyncedSound, fps: number) => s.timeline_start_frames / fps;

/** Onde a DIÁRIA começa. É o zero do tempo — inclusive para um sub-grupo dela. */
function groupOriginSec(result: SyncResult, fps: number): number | undefined {
  const starts = [
    ...result.camera_groups.flatMap((g) => g.cameras.map((c) => cameraStartSec(c, fps))),
    ...result.takes.map((t) => soundStartSec(t.sound, fps)),
    ...(result.orphan_sounds ?? []).map((s) => soundStartSec(s, fps)),
  ];
  return starts.length ? Math.min(...starts) : undefined;
}

/**
 * A vista de um sub-grupo: o `SyncResult` da diária restrito a `paths`.
 *
 * **Não copia posições** — devolve os MESMOS objetos, filtrados. É o que faz o
 * sub-grupo ser uma vista viva e não uma cópia: não existe um segundo sync para
 * sair de sincronia com o primeiro, e corrigir um clipe na cena corrige na diária
 * porque é o mesmo dado. O sub-grupo NUNCA é destino de escrita — os mutadores
 * seguem escrevendo em `syncGroups[i].result`.
 *
 * Um sub-grupo montado só com câmeras **puxa o som das tomadas delas junto**: sem
 * o som não dá para conferir o sync de ouvido nem exportar multicam.
 */
export function viewOf(result: SyncResult, paths: ReadonlySet<string>): SyncResult {
  const inView = new Set(paths);
  for (const t of result.takes) {
    if (t.camera_paths.some((p) => inView.has(p))) inView.add(t.sound.path);
  }

  return {
    ...result,
    camera_groups: result.camera_groups
      .map((g) => ({ ...g, cameras: g.cameras.filter((c) => inView.has(c.path)) }))
      // Uma FONTE que ficou sem nenhum clipe não é uma track vazia na tela: ela
      // simplesmente não está nesta cena.
      .filter((g) => g.cameras.length > 0),
    takes: result.takes
      .filter((t) => inView.has(t.sound.path))
      .map((t) => ({
        ...t,
        camera_paths: t.camera_paths.filter((p) => inView.has(p)),
      })),
    orphan_paths: result.orphan_paths.filter((p) => inView.has(p)),
    orphan_sounds: (result.orphan_sounds ?? []).filter((s) => inView.has(s.path)),
  };
}

/**
 * Os arquivos que uma cena REALMENTE contém: os escolhidos, mais o som das tomadas
 * cujas câmeras foram escolhidas.
 *
 * É o que vai para o EXPORT. A regra de "puxar o som junto" tem UM dono — `viewOf` —,
 * e o Python não a reimplementa: ele recebe os paths já resolvidos e filtra. Duas
 * implementações da mesma regra é uma que um dia diverge, e aí o que o usuário vê na
 * timeline da cena deixa de ser o que ele abre no Premiere.
 */
export function viewPaths(
  result: SyncResult,
  paths: ReadonlySet<string>
): string[] {
  const v = viewOf(result, paths);
  return [
    ...v.camera_groups.flatMap((g) => g.cameras.map((c) => c.path)),
    ...v.takes.map((t) => t.sound.path),
    ...v.orphan_paths,
    ...(v.orphan_sounds ?? []).map((s) => s.path),
  ];
}

/**
 * Converte o resultado do sync no que a timeline desenha.
 *
 * Com `subGroupPaths`, desenha só o recorte — mas o TIMECODE continua sendo o da
 * diária (ver `assemble`): o mesmo arquivo não pode ter dois timecodes.
 */
export function buildTimeline(
  result: SyncResult,
  soundLabel: string,
  startTcFrames = 0,
  syncGroupId = "",
  subGroupPaths?: ReadonlySet<string>
): TimelineData | null {
  const fps = result.fps;
  if (!fps) return null;

  // Da diária INTEIRA, antes de recortar: é ela que carrega o tempo zero.
  const tcOriginSec = groupOriginSec(result, fps);
  const view = subGroupPaths ? viewOf(result, subGroupPaths) : result;

  const cameraTracks: TimelineTrack[] = view.camera_groups.map((g) => ({
    id: g.id,
    label: g.name,
    kind: "camera" as const,
    // A cor sai da posição da fonte na DIÁRIA: a CAM B é a mesma cor na cena 01 e
    // na cena 07, mesmo que a CAM A não esteja em nenhuma das duas.
    hue: result.camera_groups.findIndex((src) => src.id === g.id),
    clips: g.cameras.map((c) => ({
      id: c.path,
      path: c.path,
      name: c.name,
      trackId: g.id,
      startSec: cameraStartSec(c, fps),
      durationSec: c.duration_frames / (c.fps || fps),
      flagged: c.flagged,
      flagReason: c.flag_reason,
      confidence: c.confidence,
      editable: true,
      manuallyAdjusted: c.manually_adjusted ?? false,
      confirmed: c.confirmed ?? false,
      hasCheckpoint:
        c.checkpoint_offset !== undefined || c.checkpoint_start !== undefined,
      startFrames: c.timeline_start_frames,
      fps: c.fps || fps,
      isSound: false,
      syncSource: c.sync_source ?? null,
    })),
  }));

  /** A "fonte de sync" de uma tomada é a das câmeras dela — o som foi posicionado
   *  ATRAVÉS da câmera. Se qualquer câmera da tomada é só-TC, o som herda "timecode"
   *  (o par não foi verificado por áudio). */
  const takeSource = (t: SyncedTake): "waveform" | "timecode" | null => {
    const cams = result.camera_groups
      .flatMap((g) => g.cameras)
      .filter((c) => t.camera_paths.includes(c.path));
    if (cams.some((c) => c.sync_source === "timecode")) return "timecode";
    if (cams.some((c) => c.sync_source === "waveform")) return "waveform";
    return null;
  };

  const sounds: TimelineClip[] = view.takes.map((t) => ({
    id: t.sound.path,
    path: t.sound.path,
    name: t.sound.name,
    trackId: soundTrackId(syncGroupId),
    startSec: soundStartSec(t.sound, fps),
    durationSec: t.sound.duration_ms / 1000,
    flagged: false,
    flagReason: null,
    confidence: 0,
    editable: true,
    manuallyAdjusted: t.sound.manually_adjusted ?? false,
    // Era `false` fixo: o som podia ficar roxo, o botão "confirmar" aparecia, e o
    // clipe seguia roxo depois de confirmado. O som é um clipe como os outros.
    confirmed: t.sound.confirmed ?? false,
    // O som não tem marco próprio — o sync dele É o das câmeras da sua tomada, e é
    // nelas que `confirmClip` o carimba.
    hasCheckpoint: view.camera_groups
      .flatMap((g) => g.cameras)
      .some(
        (c) =>
          t.camera_paths.includes(c.path) && c.checkpoint_offset !== undefined
      ),
    startFrames: t.sound.timeline_start_frames,
    fps,
    isSound: true,
    syncSource: takeSource(t),
  }));

  // Sons SEM câmera correspondente: aparecem no seu TC, na mesma track de som.
  // Sinalizados (o usuário precisa saber que não pareou com nada), mas EDITÁVEIS:
  // o usuário pode arrastá-los livremente e, ao soltar sobre uma câmera órfã, o
  // par nasce ali (ver `pairByOverlap` na store). Enquanto solto, arrastar só
  // reposiciona (ver `moveSound`).
  const orphanSounds: TimelineClip[] = (view.orphan_sounds ?? []).map((s) => ({
    id: s.path,
    path: s.path,
    name: s.name,
    trackId: soundTrackId(syncGroupId),
    startSec: soundStartSec(s, fps),
    durationSec: s.duration_ms / 1000,
    flagged: true,
    flagReason: "no_camera",
    confidence: 0,
    editable: true,
    manuallyAdjusted: false,
    confirmed: false,
    hasCheckpoint: false,
    startFrames: s.timeline_start_frames,
    fps,
    isSound: true,
  }));

  return assemble(fps, cameraTracks, [...sounds, ...orphanSounds], soundLabel,
                  startTcFrames, soundTrackId(syncGroupId), tcOriginSec);
}

/**
 * Timeline do estado PARCIAL, durante o sync.
 *
 * As lanes das câmeras existem desde o primeiro instante (vêm do agrupamento que
 * a lista de clipes já conhece) — criá-las conforme os clipes chegam faria as já
 * desenhadas pularem de posição enquanto o usuário olha.
 */
export function buildLiveTimeline(
  liveClips: Map<string, LiveClip>,
  liveSounds: Map<string, LiveSound>,
  knownGroups: LiveGroup[],
  soundLabel: string,
  startTcFrames = 0,
  syncGroupId = ""
): TimelineData | null {
  // SÓ A DIÁRIA NA TELA. Com duas sincronizando, os eventos das duas chegam pelo
  // mesmo canal — sem este filtro, os clipes de uma apareciam na timeline da outra
  // (e as lanes de ambas, empilhadas). Quem carimba o `sync_group_id` é o `main.py`,
  // que roda uma diária por vez.
  const mine = [...liveClips.values()].filter((c) => c.sync_group_id === syncGroupId);
  const mySounds = [...liveSounds.values()].filter(
    (s) => s.sync_group_id === syncGroupId
  );

  const fps = mine[0]?.fps || 24;

  const byGroup = new Map<string, TimelineTrack>(
    knownGroups
      .filter((g) => g.syncGroupId === syncGroupId)
      .map((g, i) => [
        g.id,
        { id: g.id, label: g.name, kind: "camera" as const, hue: i, clips: [] },
      ])
  );

  for (const c of mine) {
    const track = byGroup.get(c.group_id);
    if (!track) continue;
    track.clips.push({
      id: c.path,
      path: c.path,
      name: c.name,
      trackId: c.group_id,
      startSec: c.timeline_start_frames / (c.fps || fps),
      durationSec: c.duration_frames / (c.fps || fps),
      flagged: c.flagged,
      flagReason: c.flag_reason,
      confidence: c.confidence,
      editable: false, // durante o sync não se edita: o resultado ainda muda
      manuallyAdjusted: false,
      confirmed: false,
      hasCheckpoint: false,
      startFrames: c.timeline_start_frames,
      fps: c.fps || fps,
      isSound: false,
      syncSource: c.sync_source ?? null,
    });
  }

  const sounds: TimelineClip[] = mySounds.map((s) => ({
    id: s.path,
    path: s.path,
    name: s.name,
    trackId: soundTrackId(syncGroupId),
    startSec: s.timeline_start_frames / fps,
    durationSec: s.duration_ms / 1000,
    flagged: false,
    flagReason: null,
    confidence: 0,
    editable: false,
    manuallyAdjusted: false,
    confirmed: false,
    hasCheckpoint: false,
    startFrames: s.timeline_start_frames,
    fps,
    isSound: true,
  }));

  return assemble(fps, [...byGroup.values()], sounds, soundLabel, startTcFrames,
                  soundTrackId(syncGroupId));
}
