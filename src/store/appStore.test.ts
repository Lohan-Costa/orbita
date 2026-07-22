/**
 * A correção manual e o "reverter".
 *
 * O invariante que estes testes guardam é um só:
 *
 *     sync_offset = posição da câmera − posição do som
 *
 * Ele é o que o export escreve no PRPROJ, e a tela mostra as POSIÇÕES. Se os dois
 * discordarem, o app mente — e é justamente essa discordância que o usuário precisa
 * poder descartar. O bug que gerou este arquivo: o "reverter" só olhava as câmeras,
 * então na track do som o botão existia, ficava clicável, e não fazia nada.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { activeGroup, type SyncResult, useAppStore } from "./appStore";

const SND = "/take01.wav";
const CAM_A = "/camA.mp4";
const CAM_B = "/camB.mp4";

/** Uma tomada: um som em 100, duas câmeras em 130 e 145. */
function fixture(): SyncResult {
  const cam = (path: string, start: number) => ({
    path,
    name: path,
    group_id: "g1",
    fps: 24,
    duration_frames: 240,
    timeline_start_frames: start,
    sync_offset_frames: start - 100,
    tc_start_frames: null,
    alternate_start_ticks: null,
    audio_channels: 2,
    flagged: false,
    flag_reason: null,
    confidence: 3,
  });

  return {
    fps: 24,
    name: "D02",
    start_tc_frames: 0,
    camera_groups: [
      { id: "g1", name: "CAM A", cameras: [cam(CAM_A, 130)] },
      { id: "g2", name: "CAM B", cameras: [{ ...cam(CAM_B, 145), group_id: "g2" }] },
    ],
    takes: [
      {
        name: "T01",
        sound: {
          path: SND,
          name: SND,
          sample_rate: 48000,
          duration_ms: 20000,
          channels: 5,
          timeline_start_frames: 100,
          tc_start_sec: null,
          scene: null,
          take: null,
        },
        camera_paths: [CAM_A, CAM_B],
      },
    ],
    orphan_paths: [],
  };
}

/** Estado atual de um clipe, achatado para facilitar a asserção.
 *
 *  Lê pelo GRUPO ATIVO: o `syncResult` deixou de ser um campo solto e virou
 *  propriedade da diária que está na tela. Os mutadores continuam com a mesma
 *  assinatura — eles editam o grupo ativo —, e é por isso que os testes deste
 *  arquivo, que guardam o invariante de sync, seguem inalterados. */
function look() {
  const r = activeGroup(useAppStore.getState())!.result!;
  const cams = r.camera_groups.flatMap((g) => g.cameras);
  const at = (p: string) => cams.find((c) => c.path === p)!;
  return {
    sound: r.takes[0].sound,
    camA: at(CAM_A),
    camB: at(CAM_B),
  };
}

/**
 * Zera o projeto entre testes.
 *
 * `clearSyncResult()` NÃO serve para isto — e é de propósito: ele limpa os
 * RESULTADOS e preserva a árvore, porque as diárias e as fontes são do usuário e
 * apagá-las a cada sync seria desfazer, toda vez, o que ele acabou de montar. Um
 * teste que precise de estado limpo tem de dizer isso explicitamente.
 */
function reset() {
  useAppStore.setState({
    syncGroups: [], activeGroupId: null, activeSubGroupId: null, clips: [],
    browseSelection: null,
  });
}

describe("correção manual e reverter", () => {
  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(fixture(), "hash");
  });

  it("arrastar o SOM move o som e deixa as câmeras onde estão", () => {
    useAppStore.getState().moveSound(SND, 112);   // 12 frames para a frente

    const { sound, camA, camB } = look();
    expect(sound.timeline_start_frames).toBe(112);
    expect(sound.manually_adjusted).toBe(true);

    // Na tela as câmeras não se mexeram…
    expect(camA.timeline_start_frames).toBe(130);
    expect(camB.timeline_start_frames).toBe(145);
    // …e é o offset delas que absorveu o deslocamento. É isto que significa
    // "dessincronizar o som em relação à câmera".
    expect(camA.sync_offset_frames).toBe(18);     // 130 − 112
    expect(camB.sync_offset_frames).toBe(33);     // 145 − 112
  });

  // O BUG: o botão existia na track do som e não fazia nada.
  it("reverter o SOM devolve a posição DELE e o sync das câmeras", () => {
    useAppStore.getState().moveSound(SND, 112);
    useAppStore.getState().revertClip(SND);

    const { sound, camA, camB } = look();
    expect(sound.timeline_start_frames).toBe(100);
    expect(sound.manually_adjusted).toBe(false);

    // Repor a posição do som SEM repor o offset das câmeras devolveria o som ao
    // lugar certo e deixaria o sync errado — o oposto do que "reverter" promete.
    expect(camA.sync_offset_frames).toBe(30);     // como o sync achou
    expect(camB.sync_offset_frames).toBe(45);
  });

  it("reverter a CÂMERA devolve só ela, sem mexer no som", () => {
    useAppStore.getState().moveCamera(CAM_A, 137);
    expect(look().camA.sync_offset_frames).toBe(37);

    useAppStore.getState().revertClip(CAM_A);

    const { sound, camA, camB } = look();
    expect(camA.timeline_start_frames).toBe(130);
    expect(camA.sync_offset_frames).toBe(30);
    expect(camA.manually_adjusted).toBe(false);
    expect(sound.timeline_start_frames).toBe(100);
    expect(camB.sync_offset_frames).toBe(45);     // a outra câmera não foi tocada
  });

  it("reverter o SOM preserva a correção manual feita na CÂMERA", () => {
    // As duas edições são independentes: desfazer uma não pode desfazer a outra.
    useAppStore.getState().moveCamera(CAM_A, 137);   // a câmera A vai para 137
    useAppStore.getState().moveSound(SND, 112);      // e o som se desloca
    useAppStore.getState().revertClip(SND);          // só o som volta

    const { sound, camA } = look();
    expect(sound.timeline_start_frames).toBe(100);
    expect(camA.timeline_start_frames).toBe(137);    // continua onde o usuário pôs
    expect(camA.sync_offset_frames).toBe(37);        // 137 − 100: o invariante vale
  });

  /**
   * A PROPRIEDADE QUE A MULTI-SELEÇÃO DEPENDE, e ela não é óbvia.
   *
   * Mover uma CÂMERA e o SOM da tomada dela na mesma seleção, pelo mesmo Δ, é seguro
   * em QUALQUER ORDEM:
   *
   *   `moveCamera`  recalcula  offset = pos_cam − pos_som_ATUAL
   *   `placeSound`  recalcula  offset = pos_cam_ATUAL − pos_som
   *
   * Com o mesmo Δ nos dois: (cam+Δ) − (snd+Δ) = cam − snd. O offset original, seja
   * qual for a ordem. O invariante se AUTOCURA porque os dois mutadores derivam de
   * posições ABSOLUTAS, nunca de deltas — consequência direta de `placeSound` ser o
   * dono único da conta.
   *
   * É exatamente o tipo de propriedade que uma refatoração futura quebra em silêncio.
   */
  it.each([
    ["câmera primeiro", ["cam", "snd"]],
    ["som primeiro", ["snd", "cam"]],
  ])("mover câmera E som juntos preserva o sync — %s", (_label, order) => {
    const s = useAppStore.getState();
    const D = 12;   // o mesmo Δ nos dois, como faz um arrasto de vários

    for (const who of order) {
      if (who === "cam") s.moveCamera(CAM_A, 130 + D);
      else s.moveSound(SND, 100 + D);
    }

    const { sound, camA } = look();
    expect(sound.timeline_start_frames).toBe(112);
    expect(camA.timeline_start_frames).toBe(142);
    // O SYNC não mudou: os dois andaram juntos, e é o que o usuário quis dizer ao
    // selecionar os dois e arrastar.
    expect(camA.sync_offset_frames).toBe(30);
  });

  it("o invariante vale depois de qualquer sequência de edições", () => {
    const s = useAppStore.getState();
    s.moveSound(SND, 108);
    s.moveCamera(CAM_B, 151);
    s.moveSound(SND, 95);
    s.revertClip(CAM_B);
    s.moveSound(SND, 103);

    const { sound, camA, camB } = look();
    for (const c of [camA, camB]) {
      expect(c.sync_offset_frames).toBe(
        c.timeline_start_frames - sound.timeline_start_frames
      );
    }
  });
});

/**
 * O ENVELOPE MULTI-DIÁRIA.
 *
 * Um trabalho real sincroniza a semana inteira, e cada diária se resolve INTERNAMENTE
 * (as câmeras dela contra o som dela). O que estes testes guardam é o isolamento:
 * corrigir um clipe na terça não pode mexer na quarta. É a razão de o `syncResult` ter
 * deixado de ser um campo solto e virado propriedade de um GRUPO.
 */
describe("grupos de sync (diárias)", () => {
  beforeEach(reset);

  it("o sync cria a diária e a deixa ativa", () => {
    useAppStore.getState().setSyncResult(fixture(), "hash");

    const s = useAppStore.getState();
    expect(s.syncGroups).toHaveLength(1);
    expect(s.activeGroupId).toBe(s.syncGroups[0].id);
    expect(activeGroup(s)!.result).not.toBeNull();
    // O baseline nasce junto — é contra ele que o "reverter" desfaz.
    expect(activeGroup(s)!.baseline).toBe(activeGroup(s)!.result);
  });


  /** O sync devolve TODAS as diárias de uma vez, e o conjunto substitui o anterior. */
  function twoDays() {
    useAppStore.getState().setSyncResults(
      [
        { id: "TERCA", name: "Terça", result: fixture(), inputHash: "h1" },
        { id: "QUARTA", name: "Quarta", result: fixture(), inputHash: "h2" },
      ]
    );
  }

  it("editar uma diária NÃO toca na outra", () => {
    twoDays();
    expect(useAppStore.getState().syncGroups).toHaveLength(2);

    useAppStore.getState().setActiveGroupId("QUARTA");
    useAppStore.getState().moveSound(SND, 112);

    const groups = useAppStore.getState().syncGroups;
    const terca = groups.find((g) => g.id === "TERCA")!;
    const quarta = groups.find((g) => g.id === "QUARTA")!;

    expect(quarta.result!.takes[0].sound.timeline_start_frames).toBe(112);
    expect(terca.result!.takes[0].sound.timeline_start_frames).toBe(100);   // intacta
    // E o objeto da terça nem foi RECRIADO: a timeline dela não re-renderiza.
    expect(terca.result).toBe(terca.baseline);
  });

  it("reverter numa diária não desfaz a correção da outra", () => {
    twoDays();

    useAppStore.getState().setActiveGroupId("TERCA");
    useAppStore.getState().moveCamera(CAM_A, 137);
    useAppStore.getState().setActiveGroupId("QUARTA");
    useAppStore.getState().moveCamera(CAM_A, 150);

    useAppStore.getState().revertClip(CAM_A);   // reverte só na QUARTA

    const groups = useAppStore.getState().syncGroups;
    const at = (id: string) =>
      groups.find((g) => g.id === id)!.result!.camera_groups[0].cameras[0];

    expect(at("QUARTA").timeline_start_frames).toBe(130);   // voltou
    expect(at("TERCA").timeline_start_frames).toBe(137);    // continua onde o usuário pôs
  });

  it("uma diária que falha não apaga as que deram certo", () => {
    useAppStore.getState().setSyncResults(
      [
        { id: "TERCA", name: "Terça", result: fixture(), inputHash: "h1" },
        { id: "QUARTA", name: "Quarta", result: null, inputHash: "h2",
          error: "sem som direto" },
      ]
    );

    const s = useAppStore.getState();
    expect(s.syncGroups).toHaveLength(2);
    expect(s.syncGroups.find((g) => g.id === "QUARTA")!.error).toBe("sem som direto");
    // E o app abre na que DEU CERTO — cair na que falhou mostraria uma timeline
    // vazia sem dizer por quê.
    expect(s.activeGroupId).toBe("TERCA");
    expect(activeGroup(s)!.result).not.toBeNull();
  });
});

/**
 * A ÁRVORE do painel de mídia: diária → fonte → arquivos.
 *
 * A árvore é do USUÁRIO — ele cria as diárias, arrasta as fontes, corrige a
 * classificação. O app não pode desfazer isso pelas costas dele, e é o que estes
 * testes guardam.
 */
describe("a árvore de mídia", () => {
  beforeEach(reset);

  /** Um arquivo entrando numa fonte, como o painel faz. */
  function addFile(groupId: string, sourceId: string, path: string, fps?: number) {
    const s = useAppStore.getState();
    const id = `clip-${path}`;
    s.addClip({
      id, path, name: path, status: "loading",
      syncGroupId: groupId, sourceId, sourceOrder: 0,
    });
    useAppStore.getState().updateClip(id, { status: "ready", fps });
  }

  it("um sync NÃO apaga a árvore que o usuário montou", () => {
    const s = useAppStore.getState();
    const g = s.addGroup("D02");
    const src = useAppStore.getState().addSource(g, "CAM A", "/cams/A");
    addFile(g, src, "/cams/A/01.mp4", 24);

    useAppStore.getState().clearSyncResult();

    const after = useAppStore.getState();
    expect(after.syncGroups).toHaveLength(1);
    expect(after.syncGroups[0].name).toBe("D02");
    expect(after.syncGroups[0].sources).toHaveLength(1);   // a fonte continua lá
    expect(after.clips).toHaveLength(1);                   // e os arquivos também
    expect(after.syncGroups[0].result).toBeNull();         // só o resultado se foi
  });

  it("o probe classifica a fonte: tem fps → câmera, não tem → som", () => {
    const s = useAppStore.getState();
    const g = s.addGroup("D02");
    const cam = useAppStore.getState().addSource(g, "CAM A");
    const snd = useAppStore.getState().addSource(g, "SD");

    addFile(g, cam, "/a.mp4", 24);      // tem fps
    addFile(g, snd, "/b.wav");          // não tem

    const sources = useAppStore.getState().syncGroups[0].sources;
    expect(sources.find((x) => x.id === cam)!.kind).toBe("camera");
    expect(sources.find((x) => x.id === snd)!.kind).toBe("sound");
  });

  it("a correção do usuário TRAVA — o probe não a desfaz", () => {
    const s = useAppStore.getState();
    const g = s.addGroup("D02");
    const src = useAppStore.getState().addSource(g, "CAM A");
    addFile(g, src, "/a.mp4", 24);
    expect(useAppStore.getState().syncGroups[0].sources[0].kind).toBe("camera");

    // O usuário discorda: aquilo é som direto.
    useAppStore.getState().setSourceKind(g, src, "sound");

    // Chega mais um arquivo COM fps na mesma fonte. Sem o `kindLocked`, a detecção
    // desfaria a correção dele pelas costas — que é o que este teste impede.
    addFile(g, src, "/b.mp4", 24);

    const source = useAppStore.getState().syncGroups[0].sources[0];
    expect(source.kind).toBe("sound");
    expect(source.kindLocked).toBe(true);
  });

  it("um arquivo não pode viver em duas diárias", () => {
    const s = useAppStore.getState();
    const d1 = s.addGroup("D01");
    const src = useAppStore.getState().addSource(d1, "CAM A");
    addFile(d1, src, "/a.mp4", 24);

    // Se ele estivesse nas duas, qual seria a verdade sobre onde ele está?
    expect(useAppStore.getState().groupOwning("/a.mp4")).toBe(d1);
    expect(useAppStore.getState().groupOwning("/nunca-visto.mp4")).toBeNull();
  });

  /**
   * O BUG QUE O USUÁRIO PEGOU: sincronizar a SEGUNDA diária re-sincronizava a primeira.
   *
   * A causa era o hash de entrada ser do PROJETO INTEIRO: acrescentar a segunda diária
   * mudava o hash, e a primeira passava a parecer obsoleta. Uma diária não sabe da
   * outra; o hash dela também não pode saber.
   */
  it("sincronizar a segunda diária NÃO mexe no resultado da primeira", () => {
    const s = useAppStore.getState();

    // A primeira já foi sincronizada.
    s.setSyncResults([
      { id: "D01", name: "D01", result: fixture(), inputHash: "h-d01" },
    ]);
    const antes = useAppStore.getState().syncGroups.find((g) => g.id === "D01")!;

    // Agora chega a segunda — e SÓ ela é sincronizada.
    useAppStore.getState().setSyncResults([
      { id: "D02", name: "D02", result: fixture(), inputHash: "h-d02" },
    ]);

    const depois = useAppStore.getState();
    expect(depois.syncGroups).toHaveLength(2);

    const d01 = depois.syncGroups.find((g) => g.id === "D01")!;
    // O objeto da primeira nem foi RECRIADO: ela não foi tocada de forma nenhuma.
    expect(d01).toBe(antes);
    expect(d01.inputHash).toBe("h-d01");   // e o hash dela continua sendo o dela
    // E o app vai para a que acabou de sincronizar — é o que o usuário esperava ver.
    expect(depois.activeGroupId).toBe("D02");
  });

  it("limpar o resultado de uma diária não limpa o da outra", () => {
    const s = useAppStore.getState();
    s.setSyncResults([
      { id: "D01", name: "D01", result: fixture(), inputHash: "h1" },
      { id: "D02", name: "D02", result: fixture(), inputHash: "h2" },
    ]);

    useAppStore.getState().clearSyncResult(["D02"]);

    const gs = useAppStore.getState().syncGroups;
    expect(gs.find((g) => g.id === "D01")!.result).not.toBeNull();
    expect(gs.find((g) => g.id === "D02")!.result).toBeNull();
  });

  it("apagar a diária leva junto as fontes e os arquivos dela — e só os dela", () => {
    const s = useAppStore.getState();
    const d1 = s.addGroup("D01");
    const d2 = useAppStore.getState().addGroup("D02");
    const s1 = useAppStore.getState().addSource(d1, "CAM A");
    const s2 = useAppStore.getState().addSource(d2, "CAM A");
    addFile(d1, s1, "/d1.mp4", 24);
    addFile(d2, s2, "/d2.mp4", 24);

    useAppStore.getState().removeGroup(d1);

    const after = useAppStore.getState();
    expect(after.syncGroups.map((g) => g.name)).toEqual(["D02"]);
    expect(after.clips.map((c) => c.path)).toEqual(["/d2.mp4"]);
    expect(after.activeGroupId).toBe(d2);   // a ativa não pode ficar apontando para o vazio
  });

  /**
   * MOVER CLIPES ENTRE CÂMERAS — o conserto manual de quando a detecção
   * automática erra (a câmera e o drone importados como uma coisa só).
   */
  describe("mover clipes para outra câmera", () => {
    it("move só os escolhidos, e o resto fica onde estava", () => {
      const s = useAppStore.getState();
      const g = s.addGroup("D04");
      const cam = useAppStore.getState().addSource(g, "01_CAMERAS");
      addFile(g, cam, "/A008_C001.mp4", 24);
      addFile(g, cam, "/A008_C002.mp4", 24);
      addFile(g, cam, "/DJI_0315.mp4", 24);

      const drone = useAppStore.getState().addSource(g, "DRONE");
      useAppStore.getState().moveClipsToSource(g, drone, ["/DJI_0315.mp4"]);

      const clips = useAppStore.getState().clips;
      expect(clips.filter((c) => c.sourceId === drone).map((c) => c.path)).toEqual([
        "/DJI_0315.mp4",
      ]);
      expect(clips.filter((c) => c.sourceId === cam)).toHaveLength(2);
    });

    it("o clipe movido entra DEPOIS do que já estava no destino", () => {
      // `sourceOrder` é a ordem de gravação, e o engine a usa para desempatar
      // quando o timecode não serve. Um clipe que chega não pode colidir com a
      // ordem de quem já está lá.
      const s = useAppStore.getState();
      const g = s.addGroup("D04");
      const a = useAppStore.getState().addSource(g, "A");
      const b = useAppStore.getState().addSource(g, "B");
      addFile(g, b, "/b1.mp4", 24);
      useAppStore.getState().updateClip("clip-/b1.mp4", { sourceOrder: 0 });
      addFile(g, a, "/a1.mp4", 24);

      useAppStore.getState().moveClipsToSource(g, b, ["/a1.mp4"]);

      const inB = useAppStore
        .getState()
        .clips.filter((c) => c.sourceId === b)
        .sort((x, y) => x.sourceOrder - y.sourceOrder);
      expect(inB.map((c) => c.path)).toEqual(["/b1.mp4", "/a1.mp4"]);
      expect(new Set(inB.map((c) => c.sourceOrder)).size).toBe(2); // sem colisão
    });

    it("NÃO move clipe de outra diária, mesmo com o path na lista", () => {
      // Um arquivo vive numa diária só; movê-lo entre diárias mudaria contra qual
      // SOM ele se sincroniza — é outra operação, não um "mover".
      const s = useAppStore.getState();
      const d1 = s.addGroup("D01");
      const d2 = useAppStore.getState().addGroup("D02");
      const s1 = useAppStore.getState().addSource(d1, "CAM");
      const s2 = useAppStore.getState().addSource(d2, "CAM");
      addFile(d1, s1, "/um.mp4", 24);
      addFile(d2, s2, "/dois.mp4", 24);

      useAppStore.getState().moveClipsToSource(d2, s2, ["/um.mp4"]);

      const um = useAppStore.getState().clips.find((c) => c.path === "/um.mp4")!;
      expect(um.sourceId).toBe(s1);      // não se mexeu
      expect(um.syncGroupId).toBe(d1);
    });

    it("uma fonte de destino inexistente não mexe em nada", () => {
      const s = useAppStore.getState();
      const g = s.addGroup("D04");
      const cam = useAppStore.getState().addSource(g, "CAM");
      addFile(g, cam, "/a.mp4", 24);

      useAppStore.getState().moveClipsToSource(g, "fonte-que-nao-existe", ["/a.mp4"]);

      expect(useAppStore.getState().clips[0].sourceId).toBe(cam);
    });
  });
});

/**
 * SUB-GRUPOS — a cena como VISTA, e o que acontece quando o chão se move debaixo dela.
 *
 * Um sub-grupo é só uma lista de paths. Isso é uma escolha, e ela tem duas
 * consequências que estes testes fixam: um RE-SYNC não destrói as cenas (paths
 * sobrevivem — é feature), e um arquivo que SAI da diária tem de sair das cenas
 * junto, ou vira um clipe fantasma que a timeline não sabe desenhar e o export
 * tentaria escrever.
 */
describe("sub-grupos", () => {
  beforeEach(reset);

  function addFile(groupId: string, sourceId: string, path: string, fps?: number) {
    const s = useAppStore.getState();
    const id = `clip-${path}`;
    s.addClip({
      id, path, name: path, status: "loading",
      syncGroupId: groupId, sourceId, sourceOrder: 0,
    });
    useAppStore.getState().updateClip(id, { status: "ready", fps });
  }

  /** Uma diária com uma fonte e dois arquivos. */
  function diaria(name = "D01") {
    const g = useAppStore.getState().addGroup(name);
    const src = useAppStore.getState().addSource(g, "CAM A", "/cams/A");
    addFile(g, src, `/${name}/01.mp4`, 24);
    addFile(g, src, `/${name}/02.mp4`, 24);
    return { g, src };
  }

  it("criar a cena da seleção entra NELA", () => {
    const { g } = diaria();
    const sg = useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4"]);

    const s = useAppStore.getState();
    expect(s.activeGroupId).toBe(g);
    expect(s.activeSubGroupId).toBe(sg);
    expect(s.syncGroups[0].subGroups[0].paths).toEqual(["/D01/01.mp4"]);
  });

  it("trocar de diária ZERA a cena", () => {
    const { g } = diaria("D01");
    const { g: g2 } = diaria("D02");
    useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4"]);

    useAppStore.getState().setActiveGroupId(g2);

    // Um id de cena da terça não significa nada na quarta: sem isto, a timeline da
    // D02 tentaria se recortar por uma cena que não é dela.
    expect(useAppStore.getState().activeSubGroupId).toBeNull();
  });

  it("apagar a FONTE tira os arquivos dela das cenas", () => {
    const { g, src } = diaria();
    useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4", "/D01/02.mp4"]);

    useAppStore.getState().removeSource(g, src);

    // Ficaram paths apontando para arquivos que não existem mais? Então a cena
    // exportaria um clipe fantasma.
    expect(useAppStore.getState().syncGroups[0].subGroups[0].paths).toEqual([]);
  });

  it("remover UM arquivo tira só ele das cenas", () => {
    const { g } = diaria();
    useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4", "/D01/02.mp4"]);

    useAppStore.getState().removeClip("clip-/D01/01.mp4");

    expect(useAppStore.getState().syncGroups[0].subGroups[0].paths).toEqual(["/D01/02.mp4"]);
  });

  it("um RE-SYNC não destrói as cenas", () => {
    const { g } = diaria();
    useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4"]);

    useAppStore.getState().setSyncResults([
      { id: g, name: "D01", result: fixture(), inputHash: "h2" },
    ]);

    // É feature, não acidente: a cena é feita de paths, e paths sobrevivem ao sync.
    const after = useAppStore.getState().syncGroups.find((x) => x.id === g)!;
    expect(after.subGroups.map((sg) => sg.name)).toEqual(["cena 01"]);
    expect(after.result).not.toBeNull();
  });

  it("apagar a cena que está na tela devolve a DIÁRIA INTEIRA", () => {
    const { g } = diaria();
    const sg = useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4"]);

    useAppStore.getState().removeSubGroup(g, sg);

    const s = useAppStore.getState();
    expect(s.syncGroups[0].subGroups).toEqual([]);
    // Nunca uma timeline vazia apontando para uma cena que não existe mais.
    expect(s.activeSubGroupId).toBeNull();
  });

  it("apagar a diária ativa não deixa a cena dela apontando para a seguinte", () => {
    const { g } = diaria("D01");
    diaria("D02");
    useAppStore.getState().addSubGroup(g, "cena 01", ["/D01/01.mp4"]);

    useAppStore.getState().removeGroup(g);

    expect(useAppStore.getState().activeSubGroupId).toBeNull();
  });
});

/**
 * O QUE O ROXO SIGNIFICA — e o que ele NÃO significa.
 *
 * "Ajustado à mão" responde a: **este clipe está fora de onde o sync o pôs?** E não a
 * "este clipe se mexeu". As duas parecem a mesma pergunta e não são.
 *
 * O caso que separa as duas é real e comum: a tomada está sincronizada, mas há um
 * buraco enorme antes dela na timeline. O montador arrasta a câmera E o som juntos
 * para fechar o buraco. Os dois andam o MESMO Δ, e `(cam+Δ) − (snd+Δ) = cam − snd` —
 * o sync sobrevive intacto. Acender o roxo aí é dizer que existe uma correção manual
 * para revisar onde não existe nenhuma, e o usuário passa a desconfiar do aviso
 * justamente quando ele importa.
 */
describe("o roxo marca SYNC mudado, não clipe movido", () => {
  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(fixture(), "hash");
  });

  it("mover a CÂMERA e o SOM juntos NÃO é correção de sync", () => {
    const s = useAppStore.getState();
    const { camA, camB, sound } = look();

    // O arrasto de vários clipes: cada um se move pelo MESMO Δ (ver Timeline.moveBy).
    const D = 40;
    s.moveCamera(CAM_A, camA.timeline_start_frames + D);
    s.moveCamera(CAM_B, camB.timeline_start_frames + D);
    s.moveSound(SND, sound.timeline_start_frames + D);

    const now = look();
    // Andaram todos...
    expect(now.camA.timeline_start_frames).toBe(camA.timeline_start_frames + D);
    expect(now.sound.timeline_start_frames).toBe(sound.timeline_start_frames + D);
    // ...o sync está intacto...
    expect(now.camA.sync_offset_frames).toBe(camA.sync_offset_frames);
    expect(now.camB.sync_offset_frames).toBe(camB.sync_offset_frames);
    // ...e NADA fica roxo.
    expect(now.camA.manually_adjusted).toBeFalsy();
    expect(now.camB.manually_adjusted).toBeFalsy();
    expect(now.sound.manually_adjusted).toBeFalsy();
  });

  it("a ORDEM do arrasto não importa — o som primeiro dá o mesmo resultado", () => {
    // No meio do caminho o offset da câmera fica REALMENTE errado (o som já andou e
    // ela não). É por isso que a reconciliação roda depois de CADA mutação e olha o
    // estado final, em vez de cada mutador tentar adivinhar sozinho.
    const s = useAppStore.getState();
    const { camA, camB, sound } = look();
    const D = -25;

    s.moveSound(SND, sound.timeline_start_frames + D);
    s.moveCamera(CAM_A, camA.timeline_start_frames + D);
    s.moveCamera(CAM_B, camB.timeline_start_frames + D);

    const now = look();
    expect(now.camA.sync_offset_frames).toBe(camA.sync_offset_frames);
    expect(now.camA.manually_adjusted).toBeFalsy();
    expect(now.sound.manually_adjusted).toBeFalsy();
  });

  it("mover a câmera SOZINHA continua sendo correção de sync", () => {
    const s = useAppStore.getState();
    s.moveCamera(CAM_A, look().camA.timeline_start_frames + 7);

    const now = look();
    expect(now.camA.manually_adjusted).toBe(true);
    // E não contamina quem não se mexeu.
    expect(now.camB.manually_adjusted).toBeFalsy();
    expect(now.sound.manually_adjusted).toBeFalsy();
  });

  it("mover o SOM sozinho é correção de sync — e o roxo fica NELE", () => {
    const s = useAppStore.getState();
    s.moveSound(SND, look().sound.timeline_start_frames + 7);

    const now = look();
    expect(now.sound.manually_adjusted).toBe(true);
    // As câmeras não se mexeram na tela; pintá-las seria acusar quem o usuário não
    // tocou. O roxo mora em quem foi ARRASTADO.
    expect(now.camA.manually_adjusted).toBeFalsy();
    expect(now.camB.manually_adjusted).toBeFalsy();
  });

  it("mover a tomada junto e DEPOIS corrigir uma câmera acende só ela", () => {
    const s = useAppStore.getState();
    const { camA, camB, sound } = look();
    const D = 40;

    s.moveCamera(CAM_A, camA.timeline_start_frames + D);
    s.moveCamera(CAM_B, camB.timeline_start_frames + D);
    s.moveSound(SND, sound.timeline_start_frames + D);
    // Agora sim, um ajuste de verdade na CAM A.
    s.moveCamera(CAM_A, look().camA.timeline_start_frames + 3);

    const now = look();
    expect(now.camA.manually_adjusted).toBe(true);
    expect(now.camB.manually_adjusted).toBeFalsy();
    expect(now.sound.manually_adjusted).toBeFalsy();
  });

  it("devolver a câmera À MÃO para o sync original apaga o roxo", () => {
    // Não é o "reverter": é o usuário arrastando de volta até acertar. Se o offset
    // voltou a ser o que o algoritmo calculou, não há correção manual nenhuma ali.
    const s = useAppStore.getState();
    const antes = look().camA.timeline_start_frames;

    s.moveCamera(CAM_A, antes + 5);
    expect(look().camA.manually_adjusted).toBe(true);

    s.moveCamera(CAM_A, antes);
    expect(look().camA.manually_adjusted).toBeFalsy();
  });
});

/**
 * O BUG QUE O USUÁRIO PEGOU: confirmar o SOM não fazia nada.
 *
 * `confirmClip` só olhava as câmeras. Na track do som o botão aparecia, ficava
 * clicável, e o clipe seguia roxo para sempre. É a MESMA classe de bug que o
 * `revertClip` já teve — voltou noutra função, porque "o que existe só para câmera"
 * nunca esteve escrito em lugar nenhum.
 */
describe("confirmar vale para o SOM também", () => {
  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(fixture(), "hash");
  });

  it("confirmar o som tira o roxo dele", () => {
    const s = useAppStore.getState();
    s.moveSound(SND, look().sound.timeline_start_frames + 7);
    expect(look().sound.manually_adjusted).toBe(true);

    s.confirmClip(SND);

    expect(look().sound.confirmed).toBe(true);
  });

  it("reverter AO ORIGINAL desfaz a confirmação do som", () => {
    const s = useAppStore.getState();
    const antes = look().sound.timeline_start_frames;

    s.moveSound(SND, antes + 7);
    s.confirmClip(SND);
    s.revertClipToOriginal(SND);

    const now = look();
    expect(now.sound.timeline_start_frames).toBe(antes);
    expect(now.sound.confirmed).toBeFalsy();
    expect(now.sound.manually_adjusted).toBeFalsy();
  });

  it("confirmar a câmera segue funcionando (e tira o alerta)", () => {
    const s = useAppStore.getState();
    s.moveCamera(CAM_A, look().camA.timeline_start_frames + 7);
    s.confirmClip(CAM_A);

    const now = look();
    expect(now.camA.confirmed).toBe(true);
    expect(now.camA.flagged).toBe(false);
  });
});

/**
 * O MARCO — "reverter" volta um passo; "reverter ao original" volta ao sync.
 *
 * Confirmar não é só apagar o roxo: é REGISTRAR um estado. É o que torna a correção
 * manual iterativa — mover, confirmar, mover de novo, e ainda haver para onde voltar.
 * Sem isso só existe o tudo-ou-nada contra o sync, e o usuário perde o ajuste bom que
 * levou dez minutos para achar.
 *
 * E há uma armadilha que só apareceu quando deslocar a tomada inteira virou uma
 * operação legítima: **reverter tem de restaurar o SYNC (o offset), nunca a posição
 * absoluta.** Restaurar a posição arrancaria o clipe de perto do som e o largaria onde
 * a tomada estava ANTES de ser reposicionada — quebrando o sync que o botão promete
 * devolver. O último teste deste bloco é o que impede isso.
 */
describe("marco: confirmar registra, reverter volta um passo", () => {
  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(fixture(), "hash");
  });

  it("mover a câmera DEPOIS de confirmar a deixa roxa de novo", () => {
    const s = useAppStore.getState();
    const p0 = look().camA.timeline_start_frames;

    s.moveCamera(CAM_A, p0 + 5);
    s.confirmClip(CAM_A);
    expect(look().camA.confirmed).toBe(true);

    s.moveCamera(CAM_A, p0 + 9);

    // A confirmação EXPIRA: ela era a revisão de OUTRO estado. Se ficasse de pé, o
    // verde esconderia o ajuste novo e não revisado (o verde ganha do roxo na borda).
    const now = look();
    expect(now.camA.confirmed).toBeFalsy();
    expect(now.camA.manually_adjusted).toBe(true);
  });

  it("reverter volta ao MARCO (a última posição confirmada), não ao sync", () => {
    const s = useAppStore.getState();
    const p0 = look().camA.timeline_start_frames;

    s.moveCamera(CAM_A, p0 + 5);
    s.confirmClip(CAM_A);      // registra p0+5
    s.moveCamera(CAM_A, p0 + 9);
    s.revertClip(CAM_A);

    const now = look();
    expect(now.camA.timeline_start_frames).toBe(p0 + 5);
    // Voltar ao marco é voltar a um estado REVISADO — o verde acende de novo.
    expect(now.camA.confirmed).toBe(true);
  });

  it("reverter AO ORIGINAL passa por baixo do marco", () => {
    const s = useAppStore.getState();
    const p0 = look().camA.timeline_start_frames;
    const off0 = look().camA.sync_offset_frames;

    s.moveCamera(CAM_A, p0 + 5);
    s.confirmClip(CAM_A);
    s.moveCamera(CAM_A, p0 + 9);
    s.revertClipToOriginal(CAM_A);

    const now = look();
    expect(now.camA.timeline_start_frames).toBe(p0);
    expect(now.camA.sync_offset_frames).toBe(off0);
    expect(now.camA.confirmed).toBeFalsy();
    expect(now.camA.manually_adjusted).toBeFalsy();
    // O marco vai junto: o usuário disse que quer o do algoritmo. Um "reverter"
    // seguinte não pode ressuscitar um estado que ele acabou de descartar.
    expect(now.camA.checkpoint_offset).toBeUndefined();
  });

  it("SEM confirmação, reverter e reverter-ao-original são a mesma coisa", () => {
    // Não há estado intermediário para onde voltar — e inventar um seria mentira.
    const s = useAppStore.getState();
    const p0 = look().camA.timeline_start_frames;

    s.moveCamera(CAM_A, p0 + 5);
    s.revertClip(CAM_A);

    expect(look().camA.timeline_start_frames).toBe(p0);
    expect(look().camA.manually_adjusted).toBeFalsy();
  });

  it("o marco do SOM sobrevive: reverter volta à posição confirmada", () => {
    const s = useAppStore.getState();
    const p0 = look().sound.timeline_start_frames;

    s.moveSound(SND, p0 + 5);
    s.confirmClip(SND);
    s.moveSound(SND, p0 + 12);
    expect(look().sound.confirmed).toBeFalsy();   // expirou

    s.revertClip(SND);

    const now = look();
    expect(now.sound.timeline_start_frames).toBe(p0 + 5);
    expect(now.sound.confirmed).toBe(true);
  });

  // ⚠️ O TESTE. Se ele cair, reverter QUEBRA o sync que promete devolver.
  it("reverter NÃO quebra o sync de uma tomada que foi reposicionada", () => {
    const s = useAppStore.getState();
    const { camA, camB, sound } = look();

    // 1. Corrige a CAM A à mão (um ajuste de sync de verdade).
    s.moveCamera(CAM_A, camA.timeline_start_frames + 6);
    const offAjustado = look().camA.sync_offset_frames;

    // 2. Depois desloca a TOMADA INTEIRA para fechar um buraco no dia. Isto não é
    //    correção de sync: a relação entre os clipes não muda.
    const D = 300;
    s.moveCamera(CAM_A, look().camA.timeline_start_frames + D);
    s.moveCamera(CAM_B, camB.timeline_start_frames + D);
    s.moveSound(SND, sound.timeline_start_frames + D);

    expect(look().camA.sync_offset_frames).toBe(offAjustado);   // sync preservado

    // 3. Agora reverte a CAM A. Ela tem de voltar ao SYNC do algoritmo — e continuar
    //    perto do som, ONDE A TOMADA ESTÁ AGORA. Restaurar a posição ABSOLUTA a
    //    largaria 300 frames atrás, longe do som, com o sync destruído.
    s.revertClipToOriginal(CAM_A);

    const now = look();
    expect(now.camA.sync_offset_frames).toBe(camA.sync_offset_frames);
    // O invariante, que é o que importa de verdade:
    expect(now.camA.timeline_start_frames - now.sound.timeline_start_frames).toBe(
      camA.sync_offset_frames
    );
    // E ela NÃO voltou para a posição velha da tomada.
    expect(now.camA.timeline_start_frames).toBe(camA.timeline_start_frames + D);
  });
});

/** Provas dos dois bugs achados na revisão (ver o commit do conserto). */
describe("REVISÃO: reverter uma SELEÇÃO", () => {
  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(fixture(), "hash");
  });

  it("BUG A: reverter não pode mexer em quem NÃO tinha nada a reverter", () => {
    const s = useAppStore.getState();
    // Só o SOM foi ajustado. A câmera A está intocada.
    s.moveSound(SND, 112);
    const camAntes = look().camA.timeline_start_frames;

    // O usuário seleciona a tomada inteira e clica em "reverter". O botão aparece
    // porque o SOM está ajustado — mas a câmera não tem nada para desfazer.
    s.revertClips([CAM_A, CAM_B, SND]);

    const now = look();
    expect(now.sound.timeline_start_frames).toBe(100);
    expect(now.camA.timeline_start_frames).toBe(camAntes);   // não pode ter pulado
    expect(now.camA.sync_offset_frames).toBe(30);
  });

  it("BUG B: reverter câmera E som juntos não pode quebrar o sync", () => {
    const s = useAppStore.getState();
    s.moveSound(SND, 112);        // som deslocado
    s.moveCamera(CAM_A, 137);     // e a câmera A corrigida à mão

    // Reverter os dois de uma vez. A ORDEM não pode importar.
    s.revertClips([CAM_A, SND]);

    const { sound, camA, camB } = look();
    expect(sound.timeline_start_frames).toBe(100);
    // O invariante, que é o que importa: TODAS as câmeras de volta ao sync.
    expect(camA.timeline_start_frames - sound.timeline_start_frames).toBe(30);
    expect(camB.timeline_start_frames - sound.timeline_start_frames).toBe(45);
    expect(camB.sync_offset_frames).toBe(45);
  });
});

describe("RE-SYNC PARCIAL (Etapa D) — funde só quem foi selecionado", () => {
  const SND2 = "/take02.wav";
  const CAM_C = "/camC.mp4";

  /** A `fixture()` (uma tomada) + uma SEGUNDA tomada — precisa dela para testar
   *  um clipe TROCANDO de tomada, que é o próprio ponto de usar vizinhos
   *  confiáveis como âncora (o motor pode decidir que o clipe bate com OUTRO
   *  som). */
  function fixtureComDuasTomadas(): SyncResult {
    const base = fixture();
    return {
      ...base,
      camera_groups: [
        ...base.camera_groups,
        {
          id: "g3", name: "CAM C",
          cameras: [{
            path: CAM_C, name: CAM_C, fps: 24,
            duration_frames: 240, timeline_start_frames: 520,
            sync_offset_frames: 20, tc_start_frames: null,
            alternate_start_ticks: null, audio_channels: 2,
            flagged: false, flag_reason: null, confidence: 3,
          }],
        },
      ],
      takes: [
        ...base.takes,
        {
          name: "T02",
          sound: {
            path: SND2, name: SND2, sample_rate: 48000, duration_ms: 20000,
            channels: 2, timeline_start_frames: 500, tc_start_sec: null,
            scene: null, take: null,
          },
          camera_paths: [CAM_C],
        },
      ],
    };
  }

  /**
   * A resposta do motor é sempre a diária INTEIRA (ver sync/engine.py). Este
   * helper monta uma a partir da fixture, movendo `paths` para o SOM indicado (ou
   * para os órfãos, com `soundPath: null`) — do jeito mais LITERAL possível, sem
   * reaproveitar a lógica do merge (`applyResync`): senão um bug ali passaria
   * despercebido também aqui.
   *
   * `timeline_start_frames` das câmeras tocadas vem ERRADO de propósito (999999):
   * é o que prova que o merge NUNCA lê posição do motor — só offset/som/flag.
   */
  function engineDaily(
    moves: { path: string; offset: number; soundPath: string | null }[]
  ): SyncResult {
    const all = fixtureComDuasTomadas();
    const byPath = new Map(moves.map((m) => [m.path, m] as const));

    const camera_groups = all.camera_groups.map((g) => ({
      ...g,
      cameras: g.cameras.map((c) => {
        const m = byPath.get(c.path);
        if (!m) return c;
        return { ...c, sync_offset_frames: m.offset, timeline_start_frames: 999999 };
      }),
    }));

    // Tira cada movido de ONDE ele estava...
    let takes = all.takes.map((t) => ({
      ...t,
      camera_paths: t.camera_paths.filter((p) => !byPath.has(p)),
    }));
    // ...e põe no destino.
    for (const m of moves) {
      if (m.soundPath === null) continue; // órfão: não entra em tomada nenhuma
      takes = takes.map((t) =>
        t.sound.path === m.soundPath
          ? { ...t, camera_paths: [...t.camera_paths, m.path] }
          : t
      );
    }
    takes = takes.filter((t) => t.camera_paths.length > 0);

    const orphan_paths = [
      ...all.orphan_paths,
      ...moves.filter((m) => m.soundPath === null).map((m) => m.path),
    ];

    return { ...all, camera_groups, takes, orphan_paths };
  }

  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(fixtureComDuasTomadas(), "hash");
  });

  it("atualiza o offset do selecionado, e a POSIÇÃO vem da tela — não do motor", () => {
    const s = useAppStore.getState();
    const engine = engineDaily([{ path: CAM_A, offset: 40, soundPath: SND }]);

    s.applyResyncResult([CAM_A], engine);

    const now = look();
    expect(now.camA.sync_offset_frames).toBe(40);
    // soundPos (100, o da TELA) + offset novo (40) — nunca o 999999 do motor.
    expect(now.camA.timeline_start_frames).toBe(140);
  });

  it("um resync NÃO acende o roxo — é uma resposta nova do algoritmo, não uma correção manual", () => {
    const s = useAppStore.getState();
    s.applyResyncResult([CAM_A], engineDaily([{ path: CAM_A, offset: 40, soundPath: SND }]));

    expect(look().camA.manually_adjusted).toBeFalsy();
  });

  it("o baseline acompanha: mover a câmera DEPOIS do resync compara contra o offset NOVO", () => {
    const s = useAppStore.getState();
    s.applyResyncResult([CAM_A], engineDaily([{ path: CAM_A, offset: 40, soundPath: SND }]));

    // Volta para a posição que o SYNC ORIGINAL (pré-resync) tinha — 130, offset 30.
    // Se o baseline não tivesse acompanhado o resync, isto bateria com o offset
    // ANTIGO (30) e o roxo apagaria sozinho — o que esconderia que o usuário
    // acabou de descartar a resposta do resync.
    s.moveCamera(CAM_A, 130);

    const now = look();
    expect(now.camA.sync_offset_frames).toBe(30);
    expect(now.camA.manually_adjusted).toBe(true);
  });

  it("não toca em quem não foi selecionado — mesmo que o motor tenha recalculado ele também", () => {
    const s = useAppStore.getState();
    const antes = look().camB;

    s.applyResyncResult(
      [CAM_A],
      engineDaily([
        { path: CAM_A, offset: 40, soundPath: SND },
        { path: CAM_B, offset: 999, soundPath: SND }, // o motor "recalculou" — deve ser ignorado
      ])
    );

    const now = look();
    expect(now.camB.sync_offset_frames).toBe(antes.sync_offset_frames);
    expect(now.camB.timeline_start_frames).toBe(antes.timeline_start_frames);
  });

  it("troca de tomada: o motor decide que o clipe bate com OUTRO som", () => {
    const s = useAppStore.getState();
    // CAM_B estava em T01 (com SND); o motor manda ela para T02 (SND2), offset 12.
    s.applyResyncResult([CAM_B], engineDaily([{ path: CAM_B, offset: 12, soundPath: SND2 }]));

    const r = activeGroup(useAppStore.getState())!.result!;
    const t01 = r.takes.find((t) => t.sound.path === SND)!;
    const t02 = r.takes.find((t) => t.sound.path === SND2)!;
    expect(t01.camera_paths).not.toContain(CAM_B);
    expect(t02.camera_paths).toContain(CAM_B);

    const camB = r.camera_groups.flatMap((g) => g.cameras).find((c) => c.path === CAM_B)!;
    expect(camB.sync_offset_frames).toBe(12);
    // soundPos da T02 na TELA (500) + offset novo (12).
    expect(camB.timeline_start_frames).toBe(512);
  });

  it("a tomada de destino perde o 'confirmado' quando ganha um clipe que ninguém revisou", () => {
    const s = useAppStore.getState();
    s.confirmClip(SND2); // confirma a T02 inteira (o marco vai para a CAM_C, mas o "confirmado" mora no som)

    const r0 = activeGroup(useAppStore.getState())!.result!;
    expect(r0.takes.find((t) => t.sound.path === SND2)!.sound.confirmed).toBe(true);

    s.applyResyncResult([CAM_B], engineDaily([{ path: CAM_B, offset: 12, soundPath: SND2 }]));

    const r1 = activeGroup(useAppStore.getState())!.result!;
    expect(r1.takes.find((t) => t.sound.path === SND2)!.sound.confirmed).toBe(false);
  });

  it("um clipe selecionado pode virar ÓRFÃO", () => {
    const s = useAppStore.getState();
    s.applyResyncResult(
      [CAM_B],
      engineDaily([{ path: CAM_B, offset: 0, soundPath: null }])
    );

    const r = activeGroup(useAppStore.getState())!.result!;
    expect(r.orphan_paths).toContain(CAM_B);
    expect(r.takes.find((t) => t.sound.path === SND)!.camera_paths).not.toContain(CAM_B);
  });

  it("um resync ADOTA um som órfão: ele sai dos órfãos e vira tomada", () => {
    const SND3 = "/take03.wav";
    const snd3 = {
      path: SND3, name: SND3, sample_rate: 48000, duration_ms: 20000,
      channels: 2, timeline_start_frames: 700, tc_start_sec: null,
      scene: null, take: null,
    };
    const base = { ...fixtureComDuasTomadas(), orphan_sounds: [snd3] };
    useAppStore.getState().setSyncResult(base, "hash");

    // O motor pareia CAM_A (que estava em T01) com o som que era ÓRFÃO (SND3).
    const all = fixtureComDuasTomadas();
    const engine: SyncResult = {
      ...all,
      camera_groups: all.camera_groups.map((g) => ({
        ...g,
        cameras: g.cameras.map((c) =>
          c.path === CAM_A
            ? { ...c, sync_offset_frames: 15, timeline_start_frames: 999999 }
            : c
        ),
      })),
      takes: [
        { name: "T01", sound: all.takes[0].sound, camera_paths: [CAM_B] },
        all.takes[1],
        { name: "T03", sound: snd3, camera_paths: [CAM_A] },
      ],
      orphan_sounds: [],
    };

    useAppStore.getState().applyResyncResult([CAM_A], engine);

    const r = activeGroup(useAppStore.getState())!.result!;
    // SND3 saiu dos órfãos e virou tomada com CAM_A.
    expect((r.orphan_sounds ?? []).map((s) => s.path)).not.toContain(SND3);
    const t3 = r.takes.find((t) => t.sound.path === SND3)!;
    expect(t3.camera_paths).toContain(CAM_A);
    // Posição de CAM_A = posição do SND3 NA TELA (700) + offset novo (15).
    const camA = r.camera_groups.flatMap((g) => g.cameras).find((c) => c.path === CAM_A)!;
    expect(camA.timeline_start_frames).toBe(715);
  });

  it("a última câmera sai de uma tomada: o som NÃO some, vira órfão", () => {
    const s = useAppStore.getState();
    // CAM_C é a única câmera de T02 (SND2). Se ela vira órfã, o som SND2 fica sem
    // câmera — mas deve aparecer no seu lugar, não sumir.
    s.applyResyncResult([CAM_C], engineDaily([{ path: CAM_C, offset: 0, soundPath: null }]));

    const r = activeGroup(useAppStore.getState())!.result!;
    expect(r.takes.find((t) => t.sound.path === SND2)).toBeUndefined();
    expect((r.orphan_sounds ?? []).map((so) => so.path)).toContain(SND2);
  });
});

describe("sync manual por sobreposição (arrastar-e-parear)", () => {
  const ORFA_CAM = "/orfa_cam.mp4";
  const ORFA_SND = "/orfa_snd.wav";

  /** Uma diária com UMA câmera órfã e UM som órfão, posicionados SOBREPOSTOS: a
   *  câmera em [100, 340] e o som em [130, 370] (240 frames cada). É o caso do modo
   *  TC com relógios diferentes — nada pareou sozinho. */
  function orfaos(): SyncResult {
    return {
      fps: 24,
      name: "D",
      start_tc_frames: 0,
      camera_groups: [
        {
          id: "g1",
          name: "CAM A",
          cameras: [
            {
              path: ORFA_CAM,
              name: ORFA_CAM,
              fps: 24,
              duration_frames: 240,
              timeline_start_frames: 100,
              sync_offset_frames: 0,
              tc_start_frames: null,
              alternate_start_ticks: null,
              audio_channels: 2,
              flagged: true,
              flag_reason: "no_sound",
              confidence: 0,
            },
          ],
        },
      ],
      takes: [],
      orphan_paths: [ORFA_CAM],
      orphan_sounds: [
        {
          path: ORFA_SND,
          name: "orfa_snd.wav",
          sample_rate: 48000,
          duration_ms: 10000, // 240 frames a 24 fps
          channels: 2,
          timeline_start_frames: 130,
          tc_start_sec: null,
          scene: null,
          take: null,
        },
      ],
    };
  }

  beforeEach(() => {
    reset();
    useAppStore.getState().setSyncResult(orfaos(), "hash");
  });

  it("arrastar a câmera sobre o som CRIA a tomada, offset = câmera − som", () => {
    useAppStore.getState().pairByOverlap([ORFA_CAM]);

    const r = activeGroup(useAppStore.getState())!.result!;
    // O som órfão virou tomada, com a câmera dentro.
    expect(r.orphan_sounds ?? []).toHaveLength(0);
    const take = r.takes.find((t) => t.sound.path === ORFA_SND)!;
    expect(take.camera_paths).toEqual([ORFA_CAM]);

    const cam = r.camera_groups.flatMap((g) => g.cameras).find((c) => c.path === ORFA_CAM)!;
    // offset = posição da câmera (100) − posição do som (130).
    expect(cam.sync_offset_frames).toBe(-30);
    // Deixou de ser órfã, deixou o alerta, e ficou roxa (mexida à mão).
    expect(r.orphan_paths).not.toContain(ORFA_CAM);
    expect(cam.flagged).toBe(false);
    expect(cam.manually_adjusted).toBe(true);
  });

  it("é simétrico: arrastar o SOM sobre a câmera pareia igual", () => {
    useAppStore.getState().pairByOverlap([ORFA_SND]);

    const r = activeGroup(useAppStore.getState())!.result!;
    expect(r.orphan_sounds ?? []).toHaveLength(0);
    expect(r.takes.find((t) => t.sound.path === ORFA_SND)!.camera_paths).toEqual([ORFA_CAM]);
  });

  it("sem sobreposição, não pareia nada", () => {
    // Afasta o som para longe da câmera (sem overlap).
    useAppStore.getState().moveSound(ORFA_SND, 5000);
    useAppStore.getState().pairByOverlap([ORFA_SND]);

    const r = activeGroup(useAppStore.getState())!.result!;
    expect(r.takes).toHaveLength(0);
    expect(r.orphan_sounds ?? []).toHaveLength(1);
    // E o moveSound reposicionou o som órfão (sem par).
    expect((r.orphan_sounds ?? [])[0].timeline_start_frames).toBe(5000);
  });

  it("não re-pareia um clipe que já está numa tomada", () => {
    // Pareia uma vez.
    useAppStore.getState().pairByOverlap([ORFA_CAM]);
    const antes = activeGroup(useAppStore.getState())!.result!;
    const takesAntes = antes.takes.length;

    // Arrastar de novo a câmera (agora numa tomada) não deve criar OUTRA tomada.
    useAppStore.getState().pairByOverlap([ORFA_CAM]);
    const depois = activeGroup(useAppStore.getState())!.result!;
    expect(depois.takes.length).toBe(takesAntes);
  });
});

describe("browseSelection — a árvore de mídia navega o painel de Conteúdo", () => {
  beforeEach(reset);

  function setup() {
    const s = useAppStore.getState();
    const gid = s.addGroup("D01");
    const srcId = s.addSource(gid, "CAM A", "/camA");
    s.addClip({
      id: "c1", path: "/camA/a.mp4", name: "a.mp4", status: "ready",
      syncGroupId: gid, sourceId: srcId, sourceOrder: 0,
    });
    const sgId = s.addSubGroup(gid, "Cena 1", ["/camA/a.mp4"]);
    return { gid, srcId, sgId };
  }

  it("selecionar um nó guarda a seleção de navegação", () => {
    const { gid, srcId } = setup();
    useAppStore.getState().setBrowseSelection({ kind: "source", groupId: gid, refId: srcId });

    expect(useAppStore.getState().browseSelection).toEqual({
      kind: "source", groupId: gid, refId: srcId,
    });
  });

  it("remover a FONTE selecionada devolve a seleção à diária (não some)", () => {
    const { gid, srcId } = setup();
    useAppStore.getState().setBrowseSelection({ kind: "source", groupId: gid, refId: srcId });
    useAppStore.getState().removeSource(gid, srcId);

    expect(useAppStore.getState().browseSelection).toEqual({ kind: "group", groupId: gid });
  });

  it("remover a CENA selecionada devolve a seleção à diária", () => {
    const { gid, sgId } = setup();
    useAppStore.getState().setBrowseSelection({ kind: "subgroup", groupId: gid, refId: sgId });
    useAppStore.getState().removeSubGroup(gid, sgId);

    expect(useAppStore.getState().browseSelection).toEqual({ kind: "group", groupId: gid });
  });

  it("remover a DIÁRIA selecionada zera a seleção", () => {
    const { gid } = setup();
    useAppStore.getState().setBrowseSelection({ kind: "group", groupId: gid });
    useAppStore.getState().removeGroup(gid);

    expect(useAppStore.getState().browseSelection).toBeNull();
  });

  it("remover OUTRA diária não mexe na seleção", () => {
    const { gid } = setup();
    const other = useAppStore.getState().addGroup("D02");
    useAppStore.getState().setBrowseSelection({ kind: "group", groupId: gid });
    useAppStore.getState().removeGroup(other);

    expect(useAppStore.getState().browseSelection).toEqual({ kind: "group", groupId: gid });
  });
});

/**
 * FECHAR LACUNAS — encostar as tomadas umas nas outras.
 *
 * A regra que estes testes existem para guardar é UMA: a unidade que se move é a
 * TOMADA INTEIRA. Câmera e som andam o mesmo Δ, então `sync_offset` sobrevive e
 * nada fica roxo — deslocar a tomada não é correção de sync (ver a memória
 * `manual-correction-model`). Se algum dia alguém "otimizar" isto movendo clipe
 * por clipe, é aqui que estoura.
 */
describe("fechar lacunas", () => {
  beforeEach(reset);

  const CAM = "/cam/a.mov";
  const CAM2 = "/cam/b.mov";
  const S1 = "/snd/1.wav";
  const S2 = "/snd/2.wav";

  /** Duas tomadas de 240 frames (10 s a 24 fps), com um buraco entre elas. */
  function twoTakes(secondStart: number): SyncResult {
    const cam = (path: string, start: number, sound: number) => ({
      path,
      name: path,
      fps: 24,
      duration_frames: 240,
      timeline_start_frames: start,
      sync_offset_frames: start - sound,
      tc_start_frames: null,
      alternate_start_ticks: null,
      audio_channels: 2,
      flagged: false,
      flag_reason: null,
      confidence: 3,
    });
    const snd = (path: string, start: number) => ({
      path,
      name: path,
      sample_rate: 48000,
      duration_ms: 10000,          // 240 frames a 24 fps
      channels: 2,
      timeline_start_frames: start,
      tc_start_sec: null,
      scene: null,
      take: null,
    });

    return {
      fps: 24,
      name: "D",
      start_tc_frames: 0,
      camera_groups: [
        {
          id: "g1",
          name: "CAM A",
          cameras: [cam(CAM, 0, 0), cam(CAM2, secondStart + 5, secondStart)],
        },
      ],
      takes: [
        { name: "T1", sound: snd(S1, 0), camera_paths: [CAM] },
        { name: "T2", sound: snd(S2, secondStart), camera_paths: [CAM2] },
      ],
      orphan_paths: [],
    };
  }

  function state() {
    const r = activeGroup(useAppStore.getState())!.result!;
    const cams = r.camera_groups.flatMap((g) => g.cameras);
    return {
      cam: (p: string) => cams.find((c) => c.path === p)!,
      snd: (p: string) => r.takes.find((t) => t.sound.path === p)!.sound,
    };
  }

  it("encosta a segunda tomada no fim da primeira", () => {
    // T1 ocupa [0, 240): som e câmera começam em 0 e duram 240 frames.
    useAppStore.getState().setSyncResult(twoTakes(1000), "h");
    useAppStore.getState().closeGaps();

    const s = state();
    expect(s.snd(S2).timeline_start_frames).toBe(240);
    expect(s.cam(CAM2).timeline_start_frames).toBe(245);   // manteve os +5
  });

  it("⚠️ o SYNC sobrevive: câmera e som andam o MESMO Δ", () => {
    useAppStore.getState().setSyncResult(twoTakes(1000), "h");
    const antes = state().cam(CAM2).sync_offset_frames;

    useAppStore.getState().closeGaps();

    expect(state().cam(CAM2).sync_offset_frames).toBe(antes);
    // e o invariante continua de pé, medido na tela
    const s = state();
    expect(s.cam(CAM2).timeline_start_frames - s.snd(S2).timeline_start_frames).toBe(
      s.cam(CAM2).sync_offset_frames
    );
  });

  it("⚠️ NÃO acende o roxo — deslocar a tomada não é correção de sync", () => {
    useAppStore.getState().setSyncResult(twoTakes(1000), "h");
    useAppStore.getState().closeGaps();

    const s = state();
    expect(s.cam(CAM2).manually_adjusted).toBeFalsy();
    expect(s.snd(S2).manually_adjusted).toBeFalsy();
  });

  it("a PRIMEIRA tomada não se mexe — o buraco do começo não é lacuna entre clipes", () => {
    const r = twoTakes(1000);
    // empurra tudo 500 frames para a frente
    r.takes[0].sound.timeline_start_frames = 500;
    r.camera_groups[0].cameras[0].timeline_start_frames = 500;
    useAppStore.getState().setSyncResult(r, "h");

    useAppStore.getState().closeGaps();

    expect(state().snd(S1).timeline_start_frames).toBe(500);
  });

  it("tomadas que se SOBREPÕEM são separadas, nunca sobrescritas", () => {
    useAppStore.getState().setSyncResult(twoTakes(100), "h");   // T2 começa dentro de T1
    useAppStore.getState().closeGaps();

    const s = state();
    expect(s.snd(S2).timeline_start_frames).toBe(240);   // empurrada para depois de T1
  });

  it("sem lacuna nenhuma, nada muda", () => {
    useAppStore.getState().setSyncResult(twoTakes(240), "h");
    const antes = JSON.stringify(activeGroup(useAppStore.getState())!.result);

    useAppStore.getState().closeGaps();

    expect(JSON.stringify(activeGroup(useAppStore.getState())!.result)).toBe(antes);
  });

  it("o clipe SOLTO também entra na fila — senão colidiria com quem se moveu", () => {
    const r = twoTakes(1000);
    // Uma câmera órfã (fora de qualquer tomada), lá na frente.
    r.camera_groups[0].cameras.push({
      ...r.camera_groups[0].cameras[0],
      path: "/cam/orfa.mov",
      timeline_start_frames: 2000,
      sync_offset_frames: 0,
    });
    useAppStore.getState().setSyncResult(r, "h");

    useAppStore.getState().closeGaps();

    // T1 [0,240) → T2 [240,485), porque a câmera dela começa 5 depois do som
    // e dura 240 → órfã encosta em 485.
    expect(state().cam("/cam/orfa.mov").timeline_start_frames).toBe(485);
  });

  /**
   * ⚠️ REGRESSÃO (achada na revisão de 2026-07-20): fechar lacunas APAGAVA a
   * confirmação de um clipe ÓRFÃO.
   *
   * Para um órfão não há som contra o que medir, então `reconcileAdjusted` usa a
   * POSIÇÃO como a grandeza de sync dele. Como o fechar-lacunas move órfãos, a
   * posição mudava, o marco não batia mais e o verde era apagado em silêncio — o
   * usuário perdia a revisão que acabara de fazer.
   *
   * O deslocamento EM LOTE não é correção de sync (a mesma regra que protege as
   * tomadas), então o baseline e o marco andam junto com o clipe.
   */
  it("⚠️ um ÓRFÃO confirmado continua confirmado depois de fechar lacunas", () => {
    const r = twoTakes(1000);
    r.camera_groups[0].cameras.push({
      ...r.camera_groups[0].cameras[0],
      path: "/cam/orfa.mov",
      timeline_start_frames: 5000,
      sync_offset_frames: 0,
      flagged: true,
      flag_reason: "no_sound",
    });
    r.orphan_paths = ["/cam/orfa.mov"];
    useAppStore.getState().setSyncResult(r, "h");

    // O usuário revisa o órfão e confirma.
    useAppStore.getState().confirmClips(["/cam/orfa.mov"]);
    expect(state().cam("/cam/orfa.mov").confirmed).toBe(true);

    useAppStore.getState().closeGaps();

    const depois = state().cam("/cam/orfa.mov");
    expect(depois.timeline_start_frames).not.toBe(5000);   // moveu mesmo
    expect(depois.confirmed).toBe(true);                   // e continua revisado
    expect(depois.manually_adjusted).toBeFalsy();
  });

  /**
   * ⚠️ O BASELINE anda junto no deslocamento em lote — e é o `reverter` que
   * cobra isso.
   *
   * Reverter um ÓRFÃO restaura a POSIÇÃO do baseline (ele não tem som contra o
   * que medir um offset — ver `restore`). Se o baseline ficasse parado enquanto
   * o fechar-lacunas compacta a timeline, reverter jogaria o clipe de volta ao
   * lugar de ANTES da compactação, arrancando-o do layout e reabrindo o buraco
   * que o usuário acabou de fechar.
   */
  it("⚠️ reverter um ÓRFÃO depois de fechar lacunas o devolve ao lugar COMPACTADO", () => {
    const r = twoTakes(1000);
    r.camera_groups[0].cameras.push({
      ...r.camera_groups[0].cameras[0],
      path: "/cam/orfa.mov",
      timeline_start_frames: 5000,
      sync_offset_frames: 0,
      flagged: true,
      flag_reason: "no_sound",
    });
    r.orphan_paths = ["/cam/orfa.mov"];
    useAppStore.getState().setSyncResult(r, "h");

    useAppStore.getState().closeGaps();
    const compactado = state().cam("/cam/orfa.mov").timeline_start_frames;
    expect(compactado).not.toBe(5000);

    // O usuário arrasta o órfão para longe e se arrepende.
    useAppStore.getState().moveCamera("/cam/orfa.mov", compactado + 900);
    useAppStore.getState().revertClipsToOriginal(["/cam/orfa.mov"]);

    expect(state().cam("/cam/orfa.mov").timeline_start_frames).toBe(compactado);
  });

  it("uma câmera com fps DIFERENTE do projeto não erra a conta da duração", () => {
    // A câmera precisa ser MAIS LONGA que o som, senão é o som que define o fim
    // da tomada e o erro de grade passa despercebido (foi o que aconteceu na
    // primeira versão deste teste — ele não mordia).
    //
    // 180 frames a 12 fps = 15 s = 360 frames na grade do projeto (24 fps),
    // contra os 240 do som. Sem converter, a conta daria 180 e a T2 encostaria
    // cedo demais, sobrepondo o fim da câmera da T1.
    const r = twoTakes(1000);
    r.camera_groups[0].cameras[0] = {
      ...r.camera_groups[0].cameras[0],
      fps: 12,
      duration_frames: 180,
    };
    useAppStore.getState().setSyncResult(r, "h");

    useAppStore.getState().closeGaps();

    expect(state().snd(S2).timeline_start_frames).toBe(360);
  });
});
