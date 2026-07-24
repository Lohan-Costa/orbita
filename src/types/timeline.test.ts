/**
 * A construção da timeline — e a colisão que só aparece com DUAS diárias.
 *
 * Os ids de track são a chave de `soloTracks`/`mutedTracks` e de `activeAngleId`. Se
 * duas diárias tiverem uma track com o mesmo id, dar solo no som da terça dá solo no
 * som da quarta — e o usuário não tem como entender por quê. Este arquivo existe para
 * que isso não volte.
 */

import { describe, expect, it } from "vitest";
import type {
  LiveClip,
  LiveSound,
  SyncedCamera,
  SyncedSound,
  SyncResult,
} from "../store/appStore";
import {
  buildLiveTimeline,
  buildTimeline,
  soundTrack,
  soundTrackId,
  timelineTc,
  viewOf,
  type TimelineData,
} from "./timeline";
import { clipColor, type DrawTheme } from "../components/Timeline/draw";

/** Uma diária: uma câmera (fonte `srcId`) e um som. */
function fixture(srcId: string): SyncResult {
  return {
    fps: 24,
    name: "D",
    start_tc_frames: 0,
    camera_groups: [
      {
        id: srcId,
        name: "CAM A",
        cameras: [
          {
            path: `/${srcId}/a.mp4`,
            name: "a.mp4",
            fps: 24,
            duration_frames: 240,
            timeline_start_frames: 30,
            sync_offset_frames: 30,
            tc_start_frames: null,
            alternate_start_ticks: null,
            audio_channels: 2,
            flagged: false,
            flag_reason: null,
            confidence: 3,
          },
        ],
      },
    ],
    takes: [
      {
        name: "T01",
        sound: {
          path: `/${srcId}/s.wav`,
          name: "s.wav",
          sample_rate: 48000,
          duration_ms: 20000,
          channels: 5,
          timeline_start_frames: 0,
          tc_start_sec: null,
          scene: null,
          take: null,
        },
        camera_paths: [`/${srcId}/a.mp4`],
      },
    ],
    orphan_paths: [],
  };
}

describe("ids de track", () => {
  it("a track de som é ÚNICA por diária", () => {
    const terca = buildTimeline(fixture("cam-1"), "Som", 0, "TERCA")!;
    const quarta = buildTimeline(fixture("cam-2"), "Som", 0, "QUARTA")!;

    const a = soundTrack(terca)!.id;
    const b = soundTrack(quarta)!.id;

    // Era a constante "__sound__" nas duas: solo no som de uma dava solo no da outra.
    expect(a).not.toBe(b);
    expect(a).toBe(soundTrackId("TERCA"));
    expect(b).toBe(soundTrackId("QUARTA"));
  });

  it("NENHUM id de track se repete entre duas diárias", () => {
    const terca = buildTimeline(fixture("cam-1"), "Som", 0, "TERCA")!;
    const quarta = buildTimeline(fixture("cam-2"), "Som", 0, "QUARTA")!;

    const ids = [...terca.tracks, ...quarta.tracks].map((tr) => tr.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("os clipes de som apontam para a track de som DA SUA diária", () => {
    const d = buildTimeline(fixture("cam-1"), "Som", 0, "TERCA")!;
    const track = soundTrack(d)!;
    for (const clip of track.clips) {
      expect(clip.trackId).toBe(track.id);
    }
  });

  it("o som fica ABAIXO das câmeras (convenção de NLE: V1 embaixo)", () => {
    const d = buildTimeline(fixture("cam-1"), "Som", 0, "TERCA")!;
    expect(d.tracks[d.tracks.length - 1].kind).toBe("sound");
  });
});

/**
 * A TIMELINE AO VIVO, com duas diárias sincronizando.
 *
 * O BUG QUE O USUÁRIO PEGOU: os eventos das duas diárias chegam pelo MESMO canal. Sem
 * filtro, a timeline da segunda mostrava também as lanes e os clipes da primeira — o
 * seletor dizia "Diária 2" e a tela mostrava as duas.
 */
describe("timeline ao vivo", () => {
  const clip = (syncGroupId: string, sourceId: string, path: string): LiveClip => ({
    sync_group_id: syncGroupId,
    group_id: sourceId,
    group_name: "CAM A",
    path,
    name: path,
    fps: 24,
    duration_frames: 240,
    timeline_start_frames: 0,
    sync_offset_frames: 0,
    sound_path: null,
    flagged: false,
    flag_reason: null,
    confidence: 3,
  });

  const sound = (syncGroupId: string, path: string): LiveSound => ({
    sync_group_id: syncGroupId,
    path,
    name: path,
    fps: 24,
    duration_ms: 20000,
    timeline_start_frames: 0,
    channels: 2,
  });

  it("mostra SÓ a diária na tela — lanes e clipes", () => {
    const clips = new Map([
      ["/d1.mp4", clip("D01", "src-d1", "/d1.mp4")],
      ["/d2.mp4", clip("D02", "src-d2", "/d2.mp4")],
    ]);
    const sounds = new Map([
      ["/d1.wav", sound("D01", "/d1.wav")],
      ["/d2.wav", sound("D02", "/d2.wav")],
    ]);
    const lanes = [
      { id: "src-d1", name: "CAM A (D01)", syncGroupId: "D01" },
      { id: "src-d2", name: "CAM A (D02)", syncGroupId: "D02" },
    ];

    const d = buildLiveTimeline(clips, sounds, lanes, "Som", 0, "D02")!;

    // Uma lane de câmera (a da D02) + a track de som. A lane da D01 não entra.
    expect(d.tracks.map((tr) => tr.id)).toEqual(["src-d2", soundTrackId("D02")]);

    const paths = d.tracks.flatMap((tr) => tr.clips.map((c) => c.path));
    expect(paths).toEqual(["/d2.mp4", "/d2.wav"]);
  });
});

/**
 * SUB-GRUPOS — e A ARMADILHA DO TIMECODE.
 *
 * Um sub-grupo é uma VISTA da diária, não uma cópia. A tentação é montá-lo como uma
 * timeline própria — e aí o primeiro clipe dele vira a origem, e o timecode que a
 * régua mostra passa a ser OUTRO. O mesmo arquivo, dois timecodes: um na diária,
 * outro na cena. É a única mentira que este app pode contar, e ela só apareceria
 * lá no Premiere, com o material montado em cima.
 *
 * O teste do meio deste bloco é o que impede isso de voltar.
 */
describe("sub-grupos", () => {
  const HORA = 24 * 60 * 60; // 01:00:00:00 a 24 fps, em frames
  const CENA2 = 24 * 300; // a 2ª tomada começa aos 5 min

  const cam = (path: string, start: number): SyncedCamera => ({
    path,
    name: path,
    fps: 24,
    duration_frames: 240,
    timeline_start_frames: start,
    sync_offset_frames: 0,
    tc_start_frames: null,
    alternate_start_ticks: null,
    audio_channels: 2,
    flagged: false,
    flag_reason: null,
    confidence: 3,
  });

  const som = (path: string, start: number): SyncedSound => ({
    path,
    name: path,
    sample_rate: 48000,
    duration_ms: 20000,
    channels: 2,
    timeline_start_frames: start,
    tc_start_sec: null,
    scene: null,
    take: null,
  });

  /** Uma diária de DUAS tomadas: a 1ª no zero, a 2ª aos 5 min. Duas câmeras. */
  function diaria(): SyncResult {
    return {
      fps: 24,
      name: "TERCA",
      start_tc_frames: 0,
      camera_groups: [
        { id: "camA", name: "CAM A", cameras: [cam("/a1.mp4", 0), cam("/a2.mp4", CENA2)] },
        { id: "camB", name: "CAM B", cameras: [cam("/b1.mp4", 30), cam("/b2.mp4", CENA2 + 30)] },
      ],
      takes: [
        { name: "T01", sound: som("/s1.wav", 0), camera_paths: ["/a1.mp4", "/b1.mp4"] },
        { name: "T02", sound: som("/s2.wav", CENA2), camera_paths: ["/a2.mp4", "/b2.mp4"] },
      ],
      orphan_paths: [],
    };
  }

  const tcDe = (d: TimelineData, path: string) => {
    const clip = d.tracks.flatMap((tr) => tr.clips).find((c) => c.path === path)!;
    return timelineTc(d, clip.startSec);
  };

  // ⚠️ O TESTE. Se ele cair, o app está mentindo sobre o timecode.
  it("o TC de um clipe é o MESMO na diária e no sub-grupo", () => {
    const r = diaria();
    const cena2 = new Set(["/a2.mp4", "/b2.mp4"]);

    const inteira = buildTimeline(r, "Som", HORA, "TERCA")!;
    const cena = buildTimeline(r, "Som", HORA, "TERCA", cena2)!;

    // A cena COMEÇA aos 5 min — a vista não mente sobre isso...
    expect(cena.originSec).toBe(300);
    expect(inteira.originSec).toBe(0);

    // ...mas o TEMPO ZERO continua sendo o da diária.
    for (const path of ["/a2.mp4", "/b2.mp4", "/s2.wav"]) {
      expect(tcDe(cena, path)).toBe(tcDe(inteira, path));
    }
    expect(tcDe(cena, "/a2.mp4")).toBe("01:05:00:00");
  });

  it("um sub-grupo só de câmeras PUXA o som das tomadas delas", () => {
    const cena = buildTimeline(diaria(), "Som", 0, "TERCA", new Set(["/a2.mp4"]))!;

    // Sem o som não dá para conferir o sync de ouvido nem exportar multicam.
    expect(soundTrack(cena)!.clips.map((c) => c.path)).toEqual(["/s2.wav"]);
    // E o som da OUTRA tomada não vem junto.
    expect(soundTrack(cena)!.clips).toHaveLength(1);
  });

  it("as posições são as MESMAS — a vista não recalcula nada", () => {
    const r = diaria();
    const inteira = buildTimeline(r, "Som", 0, "TERCA")!;
    const cena = buildTimeline(r, "Som", 0, "TERCA", new Set(["/a2.mp4", "/b2.mp4"]))!;

    const na = (d: TimelineData, p: string) =>
      d.tracks.flatMap((tr) => tr.clips).find((c) => c.path === p)!;

    for (const path of ["/a2.mp4", "/b2.mp4", "/s2.wav"]) {
      expect(na(cena, path).startFrames).toBe(na(inteira, path).startFrames);
      expect(na(cena, path).startSec).toBe(na(inteira, path).startSec);
    }
  });

  it("a cor de uma fonte não muda quando a outra fica de fora", () => {
    // A CAM B é a mesma cor na cena em que a CAM A não entrou. Se o hue saísse da
    // posição na VISTA, a CAM B roubaria a cor da CAM A e o usuário veria a lane
    // trocar de cor ao entrar na cena.
    const cena = buildTimeline(diaria(), "Som", 0, "TERCA", new Set(["/b2.mp4"]))!;
    const inteira = buildTimeline(diaria(), "Som", 0, "TERCA")!;

    const hueB = (d: TimelineData) => d.tracks.find((tr) => tr.id === "camB")!.hue;
    expect(hueB(cena)).toBe(hueB(inteira));
  });

  it("uma FONTE que ficou sem clipes some da cena (não vira lane vazia)", () => {
    const cena = buildTimeline(diaria(), "Som", 0, "TERCA", new Set(["/b2.mp4"]))!;
    expect(cena.tracks.map((tr) => tr.id)).toEqual(["camB", soundTrackId("TERCA")]);
  });

  it("viewOf devolve os MESMOS objetos, não cópias", () => {
    // É o que faz "corrigir na cena corrige na diária" ser verdade POR CONSTRUÇÃO:
    // não há um segundo dado para sair de sincronia com o primeiro.
    const r = diaria();
    const v = viewOf(r, new Set(["/a2.mp4"]));

    expect(v.camera_groups[0].cameras[0]).toBe(r.camera_groups[0].cameras[1]);
    expect(v.takes[0].sound).toBe(r.takes[1].sound);
  });

  it("o take da vista só lista as câmeras QUE ESTÃO nela", () => {
    const v = viewOf(diaria(), new Set(["/a2.mp4"]));
    expect(v.takes).toHaveLength(1);
    expect(v.takes[0].camera_paths).toEqual(["/a2.mp4"]);
  });
});

/**
 * SONS ÓRFÃOS — o som que não pareou com câmera nenhuma (D02 do PROJETO X: o TC do
 * gravador está horas distante do da câmera). O arquivo EXISTE e tem de aparecer no
 * seu TC, na track de som, como o Premiere mostra. Antes ele sumia.
 */
describe("sons órfãos na timeline", () => {
  function comOrfao(): SyncResult {
    const r = fixture("cam-1");
    r.orphan_sounds = [
      {
        path: "/far.wav",
        name: "far.wav",
        sample_rate: 48000,
        duration_ms: 30000,
        channels: 2,
        timeline_start_frames: 86400, // 1 h a 24 fps
        tc_start_sec: 3600,
        scene: null,
        take: null,
      },
    ];
    return r;
  }

  it("aparece na MESMA track de som, no seu lugar", () => {
    const d = buildTimeline(comOrfao(), "Som", 0, "TERCA")!;
    const track = soundTrack(d)!;
    const paths = track.clips.map((c) => c.path);
    expect(paths).toContain("/far.wav");
    // A tomada normal (o som pareado) continua lá também.
    expect(paths).toContain("/cam-1/s.wav");
  });

  it("é sinalizado, mas EDITÁVEL (arrastável — pode ser solto sobre uma câmera)", () => {
    const d = buildTimeline(comOrfao(), "Som", 0, "TERCA")!;
    const orfao = soundTrack(d)!.clips.find((c) => c.path === "/far.wav")!;
    expect(orfao.flagged).toBe(true);
    expect(orfao.flagReason).toBe("no_camera");
    // Editável para o usuário poder arrastá-lo até uma câmera e criar o par ali
    // (ver appStore.pairByOverlap).
    expect(orfao.editable).toBe(true);
  });

  it("entra na conta da origem — não deixa a régua num referencial diferente", () => {
    // O som pareado está em 0; o órfão em 86400. A origem é 0, então o TC do órfão
    // é 01:00:00:00. Se ele NÃO entrasse em groupOriginSec, uma origem negativa (ou
    // outra) faria o mesmo arquivo mostrar um TC na diária e outro na cena.
    const d = buildTimeline(comOrfao(), "Som", 0, "TERCA")!;
    const orfao = soundTrack(d)!.clips.find((c) => c.path === "/far.wav")!;
    expect(timelineTc(d, orfao.startSec)).toBe("01:00:00:00");
  });
});

/**
 * SYNC POR TIMECODE tem COR PRÓPRIA. Um clipe posicionado só pelo TC não foi
 * verificado contra o áudio e não pode se pintar de azul/verde (a cor de um sync
 * confirmado pela forma de onda) — daria a falsa impressão de "conferido".
 */
describe("cor de sync por timecode", () => {
  function comTc(): SyncResult {
    const r = fixture("cam-1");
    r.camera_groups[0].cameras[0].sync_source = "timecode";
    return r;
  }

  it("a câmera só-TC carrega syncSource='timecode' até a timeline", () => {
    const d = buildTimeline(comTc(), "Som", 0, "TERCA")!;
    const cam = d.tracks
      .flatMap((tr) => tr.clips)
      .find((c) => c.path === "/cam-1/a.mp4")!;
    expect(cam.syncSource).toBe("timecode");
  });

  it("o SOM da tomada herda 'timecode' da câmera — o par não foi verificado", () => {
    const d = buildTimeline(comTc(), "Som", 0, "TERCA")!;
    const som = soundTrack(d)!.clips.find((c) => c.path === "/cam-1/s.wav")!;
    expect(som.syncSource).toBe("timecode");
  });

  it("clipColor: TC ganha do normal, mas perde para flagged/confirmado/roxo", () => {
    const theme = {
      timecode: "TC",
      flagged: "AMBER",
      confirmed: "TEAL",
      adjusted: "PURPLE",
      reference: "GREEN",
      trackHues: ["BLUE"],
    } as unknown as DrawTheme;
    const base = { flagged: false, confirmed: false, manuallyAdjusted: false };

    // TC ganha da cor normal (câmera azul / som verde de referência).
    expect(clipColor({ ...base, syncSource: "timecode" }, false, theme, 0)).toBe("TC");
    expect(clipColor({ ...base, syncSource: "timecode" }, true, theme, 0)).toBe("TC");
    // waveform/undefined caem no normal.
    expect(clipColor({ ...base, syncSource: "waveform" }, false, theme, 0)).toBe("BLUE");
    // Mas os estados que o usuário/sistema impuseram vencem o TC.
    expect(clipColor({ ...base, flagged: true, syncSource: "timecode" }, false, theme, 0)).toBe("AMBER");
    expect(clipColor({ ...base, confirmed: true, syncSource: "timecode" }, false, theme, 0)).toBe("TEAL");
    expect(clipColor({ ...base, manuallyAdjusted: true, syncSource: "timecode" }, false, theme, 0)).toBe("PURPLE");
  });
});
