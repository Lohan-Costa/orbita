import { create } from "zustand";

export type Locale = "pt-BR" | "en";
export type SyncMethod = "timecode" | "waveform" | "hybrid";
export type ExportTarget = "premiere" | "avid";
export type AppStatus = "idle" | "running" | "success" | "error";

/**
 * O que está SELECIONADO na árvore de mídia — o que o painel de Conteúdo mostra.
 *
 * É uma seleção de NAVEGAÇÃO, distinta do ESCOPO da timeline (`activeGroupId`/
 * `activeSubGroupId`): clicar na árvore muda só o painel direito; o que vai para a
 * timeline é escolhido à parte (o seletor da timeline, ou um duplo-clique aqui).
 *
 *   group     → todas as mídias da diária (agrupadas por fonte)
 *   source    → só as mídias daquele ângulo/som
 *   category  → o nó "Sub-grupos" (lista as cenas do grupo)
 *   subgroup  → só as mídias que compõem a cena
 *
 * `refId` = o id da fonte (source) ou da cena (subgroup); ausente em group/category.
 */
export type BrowseKind = "group" | "source" | "category" | "subgroup";
export interface BrowseSelection {
  kind: BrowseKind;
  groupId: string;
  refId?: string;
}


export interface Clip {
  id: string;
  path: string;
  name: string;
  fps?: number;
  tcStart?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  codecLabel?: string;
  hasAudio?: boolean;
  sampleRate?: number;
  status: "loading" | "ready" | "error";
  error?: string;
  /** A DIÁRIA a que este arquivo pertence. */
  syncGroupId: string;
  /** A FONTE dentro dela — a câmera física (CAM A) ou o gravador (Som Direto).
   *  Uma câmera grava em pedaços e em vários cartões; todos são a mesma fonte, e
   *  ela vira UMA track de vídeo no NLE. */
  sourceId: string;
  /** Posição do arquivo na sequência de gravação da fonte. */
  sourceOrder: number;
}

export type SourceKind = "camera" | "sound";

/**
 * Uma FONTE dentro de uma diária: a CAM A, a CAM B, o Som Direto.
 *
 * É o que antes se chamava `groupId` e era o caminho da pasta arrastada. Virou uma
 * entidade com id próprio por dois motivos: a mesma pasta pode ser arrastada duas
 * vezes (o caminho não identifica nada), e o usuário precisa poder RENOMEAR e
 * RECLASSIFICAR — o que um caminho não deixa.
 */
export interface Source {
  id: string;
  /** Nome da pasta, editável. */
  name: string;
  /** DETECTADO no probe (tem fps → câmera), e corrigível num clique. */
  kind: SourceKind;
  /** O usuário mandou. O probe não sobrescreve mais. */
  kindLocked?: boolean;
  /** Só exibição/tooltip — a identidade é o `id`. */
  folderPath?: string;
}

/**
 * Um SUB-GRUPO — "cena 01", "a entrevista", "os planos da varanda".
 *
 * É um RECORTE TEMÁTICO de uma diária, e é uma **vista viva, não uma cópia**: só
 * guarda uma lista de paths. O sync é o MESMO dado da diária — não existe um
 * segundo resultado aqui para sair de sincronia com o primeiro, e corrigir um
 * clipe dentro da cena corrige na diária, porque é o mesmo clipe.
 *
 * **Não atravessa diárias.** Duas diárias são duas origens de tempo sem relação
 * entre si; uma cena que pegasse clipes das duas não teria um timecode que fizesse
 * sentido.
 *
 * Sobrevive a um re-sync de propósito: paths sobrevivem, então a cena que o usuário
 * montou continua lá depois de o sync rodar de novo.
 */
export interface SubGroup {
  id: string;
  name: string;
  /** Os arquivos escolhidos. O som das tomadas entra na VISTA (ver `viewOf`), não
   *  aqui: guardar aqui faria a escolha do usuário e a consequência dela virarem a
   *  mesma coisa, e um dia elas divergem. */
  paths: string[];
}

/**
 * Uma DIÁRIA — a unidade que se sincroniza sozinha.
 *
 * As câmeras de um grupo se resolvem contra o SOM DELE, nunca contra o de outro
 * dia. É por isso que o grupo, e não o projeto, é o dono do resultado do sync:
 * dois dias diferentes têm duas origens de tempo sem relação entre si.
 */
export interface SyncGroup {
  id: string;
  name: string;
  /** CAM A, CAM B, Som Direto. O usuário as arrasta para dentro da diária. */
  sources: Source[];
  /** As cenas desta diária. Recortes, não cópias. */
  subGroups: SubGroup[];
  /** O resultado do sync DESTA diária. `null` = ainda não sincronizada. */
  result: SyncResult | null;
  /** O resultado como o sidecar entregou, INTOCADO. É contra ele que o "reverter"
   *  desfaz um ajuste manual — sem isso, a posição original se perderia no primeiro
   *  arrasto. */
  baseline: SyncResult | null;
  /** Hash das entradas que produziram `result`. Diferente do atual = obsoleto, e o
   *  usuário não pode exportar um projeto que não contém o que ele acabou de somar.
   *  O MÉTODO de sync NÃO entra aqui (nem em obsolescência nenhuma) — ver o comentário
   *  de `hashes` em SyncControls: pôr o método na conta já causou dois bugs. */
  inputHash: string | null;
  /** Esta diária falhou no sync. As outras seguem — não se perde o trabalho de cinco
   *  dias por causa do sexto. */
  error?: string;
}

/** Uma diária como o sidecar a devolve: o resultado, ou o erro dela.
 *  O `inputHash` vem POR DIÁRIA — cada uma tem as suas entradas. */
export interface SyncGroupResult {
  id: string;
  name: string;
  result: SyncResult | null;
  inputHash: string;
  error?: string;
}

/** Progresso ao vivo emitido pelo sidecar durante uma operação longa. */
export interface SyncProgress {
  message: string;
  current: number;
  total: number;
}

/** Resultado do comando `sync` — uma DIÁRIA (ver src-python/sync/serialize.py).
 *
 *  É devolvido tal e qual ao sidecar na hora de exportar: o frontend é a fonte
 *  da verdade, então o que está na tela é o que é exportado, correções manuais
 *  incluídas.
 *
 *  Um clipe de câmera aparece UMA VEZ, dentro de `camera_groups`. As tomadas o
 *  referenciam por `path`, e os órfãos também. Duplicá-lo abriria a porta para as
 *  cópias divergirem — e `path` já é a identidade estável de um clipe em todo o
 *  app. */
export interface SyncedCamera {
  path: string;
  name: string;
  fps: number;
  duration_frames: number;
  /** POSIÇÃO na timeline. Vem do timecode (ou do sync, quando não há). */
  timeline_start_frames: number;
  /** RELAÇÃO de sync com o som direto da SUA tomada. Não confundir com a
   *  posição: é a distância entre os dois, e é o que o merged clip precisa.
   *  Invariante mantido aqui: `sync_offset = timeline_start − som.timeline_start`. */
  sync_offset_frames: number;
  tc_start_frames: number | null;
  alternate_start_ticks: number | null;
  audio_channels: number;
  flagged: boolean;
  flag_reason: string | null;
  confidence: number;
  /** COMO foi sincronizado: "waveform" (o som confirmou) ou "timecode" (só
   *  posicionado pelo TC, sem verificar áudio). A timeline pinta os dois diferente —
   *  um TC puro não pode se disfarçar de sync verificado. `null`/ausente = órfão. */
  sync_source?: "waveform" | "timecode" | null;
  /** O SYNC deste clipe foi mudado à mão — e não apenas a posição dele.
   *
   *  Deslocar uma câmera JUNTO com o som dela não é corrigir sync: os dois andam o
   *  mesmo Δ, o `sync_offset` continua o mesmo, e o que mudou foi só onde a tomada
   *  cai no dia. Quem acende o roxo é a mudança de RELAÇÃO, não a de posição — ver
   *  `reconcileAdjusted`.
   *
   *  O sidecar ignora chaves desconhecidas, então trafegar isto é seguro. */
  manually_adjusted?: boolean;
  /** Está NO MARCO e foi revisado — o alerta some. Expira sozinho quando o sync
   *  muda depois da confirmação (ver `reconcileAdjusted`): uma revisão vale para o
   *  estado que foi revisado, e não para sempre. */
  confirmed?: boolean;
  /**
   * O MARCO: o `sync_offset_frames` no instante em que o usuário confirmou.
   *
   * É a "última posição registrada" para onde o *reverter* volta. Sobrevive à
   * expiração do `confirmed` de propósito — é justamente aí que ele serve: você move
   * de novo, o verde apaga, e o *reverter* ainda sabe para onde voltar.
   *
   * É um OFFSET, e não uma posição absoluta. Se a tomada inteira for reposicionada no
   * dia, o marco continua válido: ele guarda a RELAÇÃO com o som, que é o que o sync
   * significa. Guardar a posição absoluta faria o *reverter* arrancar o clipe de perto
   * do som e quebrar o sync — exatamente o que ele existe para não fazer.
   */
  checkpoint_offset?: number;
  /** O marco de um ÓRFÃO (clipe sem som direto). Sem tomada não há offset: o que se
   *  registra é a posição, porque é a única coisa que existe. */
  checkpoint_start?: number;
}

export interface SyncedSound {
  path: string;
  name: string;
  sample_rate: number;
  duration_ms: number;
  channels: number;
  timeline_start_frames: number;
  tc_start_sec: number | null;
  scene: string | null;
  take: string | null;
  manually_adjusted?: boolean;
  /** O som é um clipe como os outros: revisável, confirmável, reversível. Enquanto
   *  ele não tinha este campo, o botão "confirmar" aparecia na track do som, ficava
   *  clicável, e o clipe seguia roxo para sempre.
   *
   *  O MARCO do som não mora aqui: o som não tem offset próprio — o sync dele É o das
   *  câmeras da sua tomada. Confirmar o som carimba o marco NELAS (ver `confirmClip`),
   *  e é contra elas que o *reverter* do som se orienta. */
  confirmed?: boolean;
}

/** Uma tomada: um som direto e as câmeras que a filmaram (por path). */
export interface SyncedTake {
  name: string;
  sound: SyncedSound;
  camera_paths: string[];
}

export interface SyncedGroup {
  id: string;
  name: string;
  cameras: SyncedCamera[];
}

export interface SyncResult {
  fps: number;
  name: string;
  /** TC exibido na origem da timeline (o primeiro clipe). Ver projectStartTcFrames. */
  start_tc_frames: number;
  camera_groups: SyncedGroup[];
  takes: SyncedTake[];
  /** Clipes sem som direto. Normal (a câmera roda antes do gravador, entre
   *  tomadas, em planos sem som) — vão para a bin sinalizados, nunca descartados. */
  orphan_paths: string[];
  /** Sons diretos SEM câmera correspondente — o TC do gravador está longe do da
   *  câmera (D02 do PROJETO X): não pareiam com ninguém, mas o arquivo existe e
   *  aparece no seu TC, como no Premiere. Nunca descartados. */
  orphan_sounds?: SyncedSound[];
}

/**
 * Eventos parciais emitidos durante o sync (ver src-python/sync/engine.py).
 *
 * `sync_group_id` é a DIÁRIA a que o clipe pertence — carimbado pelo `main.py`, que
 * roda uma diária por vez. Sem ele, com duas diárias sincronizando, os clipes de uma
 * apareceriam na timeline da outra: a timeline ao vivo é filtrada por ele.
 */
export interface LiveSound {
  sync_group_id: string;
  path: string;
  name: string;
  fps: number;
  duration_ms: number;
  timeline_start_frames: number;
  channels: number;
}

/** Uma lane de câmera durante o sync, e a DIÁRIA dela. Sem o `syncGroupId`, as
 *  lanes das duas diárias apareciam empilhadas na mesma timeline. */
export interface LiveGroup {
  id: string;
  name: string;
  syncGroupId: string;
}

export interface LiveClip {
  sync_group_id: string;
  /** A FONTE (câmera física) — vira uma track de vídeo. */
  group_id: string;
  group_name: string;
  path: string;
  name: string;
  fps: number;
  duration_frames: number;
  timeline_start_frames: number;
  sync_offset_frames: number;
  sound_path: string | null;
  flagged: boolean;
  flag_reason: string | null;
  confidence: number;
  sync_source?: "waveform" | "timecode" | null;
}

interface AppState {
  locale: Locale;
  setLocale: (locale: Locale) => void;

  /** Toca um som ao terminar um sync/export (sucesso) e ao falhar. Um alerta
   *  sonoro para uma diária que leva minutos: o usuário sai da tela e volta quando
   *  ouve. `true` por padrão; o Titlebar tem o botão de mudo. Não é persistido (como
   *  o resto do estado de UI), então volta ligado a cada abertura. */
  soundsEnabled: boolean;
  setSoundsEnabled: (on: boolean) => void;

  /** Framerate do PROJETO — a grade em que todos os offsets e durações são
   *  medidos. `null` = detectar pelas câmeras (o fps mais comum entre elas).
   *  Fica explícito porque é uma decisão editorial: com câmeras em fps
   *  diferentes, herdar o da primeira da lista escolheria em silêncio. */
  projectFps: number | null;
  setProjectFps: (fps: number | null) => void;

  /** TC exibido na ORIGEM da timeline — que é o primeiro clipe a entrar, não o
   *  som direto. Vai para o ZeroPoint da sequência, então a régua do app e a do
   *  Premiere mostram o mesmo número. 0 = 00:00:00:00. */
  projectStartTcFrames: number;
  setProjectStartTcFrames: (frames: number) => void;

  syncProgress: SyncProgress | null;
  setSyncProgress: (progress: SyncProgress | null) => void;

  /** As waveforms das CÂMERAS, geradas em SEGUNDO PLANO depois do sync — o sync não
   *  lê os arquivos inteiros (ver sync/engine.py), então elas não existem quando a
   *  timeline aparece. Sem este estado o passe rodava MUDO: as waveforms surgiam
   *  sozinhas nas tracks e quem não soubesse do processo não entenderia o que era.
   *  `null` = não há passe em curso. */
  peaksProgress: { done: number; total: number } | null;
  setPeaksProgress: (p: { done: number; total: number } | null) => void;
  /** Cancelar = subir a geração. O passe em curso vê que não é mais o atual e para. */
  peaksGeneration: number;
  cancelPeaks: () => void;

  /** Altura do painel da timeline, ajustável pelo usuário (splitter). */
  timelineHeight: number;
  setTimelineHeight: (px: number) => void;

  /** Largura do painel do monitor (splitter vertical, ao lado da lista). */
  monitorWidth: number;
  setMonitorWidth: (px: number) => void;

  /** Ângulo no ar no monitor = o id de um grupo de câmera (uma track de vídeo).
   *  `null` → o monitor assume o primeiro ângulo assim que houver um sync. */
  activeAngleId: string | null;
  setActiveAngleId: (id: string | null) => void;

  /** O que a ÁRVORE de mídia tem selecionado — o que o painel de Conteúdo mostra.
   *  Navegação, NÃO o escopo da timeline (ver BrowseSelection). `null` = cai no
   *  grupo ativo. Um nó que some (remoção) é reconciliado para o grupo, ou null. */
  browseSelection: BrowseSelection | null;
  setBrowseSelection: (sel: BrowseSelection | null) => void;

  /** Largura da ÁRVORE de mídia (a coluna mais à esquerda), ajustável pelo splitter.
   *  O conteúdo fica no meio (flexível) e o monitor à direita — o monitor NÃO
   *  compete com a mídia, fica sempre visível (ver App). */
  mediaTreeWidth: number;
  setMediaTreeWidth: (px: number) => void;

  /** As DIÁRIAS do projeto. Um trabalho real sincroniza a semana inteira, e cada
   *  diária se resolve INTERNAMENTE (as câmeras dela contra o som dela, nunca
   *  contra o som de outro dia).
   *
   *  Hoje o app cria um grupo implícito no sync — para o usuário nada mudou. O que
   *  mudou é que `syncResult` deixou de ser um campo solto e virou propriedade de
   *  um grupo: é o que permite o segundo grupo existir sem reescrever a timeline,
   *  o monitor e os mutadores. */
  syncGroups: SyncGroup[];
  /** A diária que a timeline e o monitor estão mostrando. */
  activeGroupId: string | null;
  setActiveGroupId: (id: string | null) => void;

  // ── Sub-grupos: o recorte que está na tela ────────────────────────────────

  /** A CENA que a timeline está mostrando, dentro da diária ativa. `null` = a
   *  diária inteira.
   *
   *  Trocar de diária o zera: um sub-grupo não atravessa diárias, então um id de
   *  cena da terça não significa nada na quarta. */
  activeSubGroupId: string | null;
  setActiveSubGroupId: (id: string | null) => void;

  /** Cria uma cena com os arquivos escolhidos e a devolve. O som das tomadas das
   *  câmeras escolhidas entra sozinho na vista — ver `viewOf`. */
  addSubGroup: (groupId: string, name: string, paths: string[]) => string;
  renameSubGroup: (groupId: string, id: string, name: string) => void;
  removeSubGroup: (groupId: string, id: string) => void;

  /** Incrementa só quando um sync NOVO chega — não a cada edição manual. É o que
   *  a timeline observa para resetar zoom/seleção sem fazê-lo a cada tecla.
   *  Fica GLOBAL de propósito: é gatilho de UI, não domínio. */
  syncVersion: number;
  /** O que o sidecar devolveu: uma diária por grupo, cada uma com o seu resultado ou
   *  o seu erro. Uma que falha não apaga as outras. */
  setSyncResults: (groups: SyncGroupResult[]) => void;
  /** Atalho de uma diária só. Delega ao de cima — é o caminho que os testes do
   *  invariante usam, e não pode divergir dele. */
  setSyncResult: (result: SyncResult, inputHash: string) => void;
  /** Zera o resultado das diárias indicadas (ou de todas). A ÁRVORE nunca é tocada:
   *  as diárias e as fontes são do usuário. */
  clearSyncResult: (ids?: string[]) => void;

  /** Correção manual na timeline. Escreve DIRETO no syncResult porque é ele que
   *  vai para o export: o que está na tela é o que é exportado.
   *
   *  Arrastar uma CÂMERA muda o sync dela contra o som da sua tomada — o som fica
   *  parado. Arrastar um SOM move o som contra as câmeras dele — as câmeras ficam
   *  paradas, e o offset delas absorve o movimento. Nos dois casos o invariante
   *  `sync_offset = posição_da_câmera − posição_do_som` é mantido aqui, num lugar
   *  só, para que a posição na tela e o offset exportado nunca divirjam. */
  moveCamera: (path: string, timelineStartFrames: number) => void;
  moveSound: (path: string, timelineStartFrames: number) => void;
  /**
   * SYNC MANUAL POR SOBREPOSIÇÃO — chamado ao SOLTAR um arrasto.
   *
   * No modo TC com relógios diferentes, câmera e som não pareiam sozinhos e ficam
   * cada um no seu TC. Arrastar uma câmera órfã até SOBRE um som (ou um som órfão
   * até sobre uma câmera órfã) e soltar cria o par ali: o offset vira a posição
   * onde o usuário soltou (`câmera − som`), e o clipe entra na tomada. É o "alinhar
   * no olho" virar sync de verdade. Ajuste fino pelas setas depois.
   *
   * Só age em quem foi ARRASTADO e está SOLTO (órfão) — nunca re-pareia um clipe já
   * numa tomada, que seria surpreendente. Não sobrepôs nada? Não faz nada (o clipe
   * só reposicionou).
   */
  pairByOverlap: (draggedPaths: string[]) => void;
  /** Registra o estado atual como MARCO e o marca como revisado. */
  confirmClip: (path: string) => void;
  /** Volta ao último estado REGISTRADO (o marco da última confirmação). Sem marco,
   *  é o próprio sync — e aí "reverter" e "reverter ao original" coincidem. */
  revertClip: (path: string) => void;
  /** Volta ao que o SYNC calculou, apagando o marco e restaurando o alerta original.
   *  É o "desfazer tudo" do clipe, por baixo de quantas confirmações houver. */
  revertClipToOriginal: (path: string) => void;

  /**
   * As versões em LOTE — e elas NÃO são um laço sobre as de cima.
   *
   * Duas regras vivem aqui, e as duas são de domínio (por isso não moram na tela):
   *
   *  1. **Só age em quem tem o que desfazer.** A barra mostra o botão quando ALGUM
   *     clipe da seleção está ajustado; aplicá-lo a TODOS mexeria em clipes que o
   *     usuário nunca tocou — e, como reverter restaura o SYNC (o offset), mexer
   *     neles os FAZ ANDAR na tela.
   *  2. **O SOM vai primeiro.** Reverter uma câmera a posiciona contra o som ONDE ELE
   *     ESTÁ; se o som ainda for reverter, a câmera se alinha a uma posição que está
   *     de saída — e pior: ela deixa de servir de referência para o som (o offset dela
   *     acabou de ser forçado), que então não sai do lugar. A tomada termina partida.
   */
  confirmClips: (paths: string[]) => void;
  revertClips: (paths: string[]) => void;
  revertClipsToOriginal: (paths: string[]) => void;

  /**
   * RE-SYNC PARCIAL (Etapa D) — funde no grupo ATIVO o que o comando `resync`
   * devolveu para `selectedPaths`. Quem faz a chamada ao sidecar é a TELA (mesmo
   * padrão do "Sincronizar" em `SyncControls`); isto aqui só sabe fundir a
   * resposta — ver `applyResync` para a conta (posição, troca de tomada, órfão).
   *
   * Atualiza o BASELINE junto (só para `selectedPaths`): um resync é uma resposta
   * NOVA do algoritmo, não uma correção manual — sem isto o roxo acenderia em todo
   * clipe que o resync tocou.
   */
  applyResyncResult: (selectedPaths: string[], engineResult: SyncResult) => void;

  /** Trava de edição: com ela ligada, arrastar clipe não faz nada. Protege um
   *  sync correto de um arrasto acidental. */
  timelineLocked: boolean;
  setTimelineLocked: (locked: boolean) => void;

  /** Solo/mute por track, como numa mesa de som.
   *
   *  Serve para conferir o sync DE OUVIDO: ouvir a câmera junto com o som direto
   *  e perceber o eco quando estão fora, ou isolar uma câmera contra o som numa
   *  cena com duas. Só ver a waveform não pega um erro de poucos frames — ouvir
   *  pega.
   *
   *  Semântica de mesa: se ALGUMA track está em solo, só as em solo soam (o mute
   *  das outras deixa de importar). Sem nenhum solo, soa tudo o que não está
   *  mudo. */
  soloTracks: Set<string>;
  mutedTracks: Set<string>;
  toggleSolo: (trackId: string) => void;
  toggleMute: (trackId: string) => void;
  /** As tracks que devem SOAR, dado o estado de solo/mute. */
  audibleTracks: (trackIds: string[]) => Set<string>;

  /** Peaks de waveform, por path. Ficam FORA do syncResult de propósito: são
   *  centenas de KB, e o canvas os lê imperativamente (getState) — assim um
   *  peak chegando nunca re-renderiza a árvore React. `peaksVersion` é o que o
   *  canvas observa para saber que precisa redesenhar. */
  peaks: Map<string, Uint8Array>;
  peakRate: number;
  peaksVersion: number;
  setPeaks: (path: string, peaks: Uint8Array, rate: number) => void;
  clearPeaks: () => void;

  /** Estado PARCIAL durante o sync: os clipes vão aparecendo na timeline
   *  conforme o sidecar os resolve, em vez de a tela ficar vazia por 15s.
   *  Quando o sync termina, o `syncResult` (autoritativo) assume. */
  liveSounds: Map<string, LiveSound>;
  liveClips: Map<string, LiveClip>;
  liveVersion: number;
  /** Câmeras conhecidas ANTES do sync (vêm do agrupamento da lista). As lanes
   *  são criadas todas de uma vez, senão elas iriam surgindo uma a uma e
   *  empurrando as anteriores para baixo enquanto o usuário olha. */
  liveGroups: LiveGroup[];
  setLiveGroups: (groups: LiveGroup[]) => void;
  upsertLiveSound: (sound: LiveSound) => void;
  upsertLiveClip: (clip: LiveClip) => void;
  clearLive: () => void;

  clips: Clip[];
  addClip: (clip: Clip) => void;
  updateClip: (id: string, updates: Partial<Clip>) => void;
  removeClip: (id: string) => void;

  // ── A árvore do painel de mídia: diária → fonte → arquivos ────────────────

  /** Cria uma diária VAZIA e a devolve. O usuário arrasta as fontes para dentro. */
  /** O NOME vem de fora, e é obrigatório: a store não sabe em que idioma o app está,
   *  e "Diária 2" nasceria em português para sempre. Quem sabe o idioma é a UI. */
  addGroup: (name: string) => string;
  renameGroup: (id: string, name: string) => void;
  /** Some com a diária e com tudo o que estava nela. */
  removeGroup: (id: string) => void;

  /** Acrescenta uma FONTE (uma pasta de câmera, ou a do gravador) a uma diária.
   *  Devolve o id da fonte — quem chama usa isso para pendurar os clipes nela. */
  addSource: (groupId: string, name: string, folderPath?: string) => string;
  removeSource: (groupId: string, sourceId: string) => void;
  /** Corrige o que o probe classificou. A partir daqui o probe não sobrescreve. */
  setSourceKind: (groupId: string, sourceId: string, kind: SourceKind) => void;

  /** Um arquivo não pode viver em duas diárias: qual delas seria a verdade sobre
   *  onde ele está? Devolve o id da diária que já o tem, ou `null`. */
  groupOwning: (path: string) => string | null;

  /** Nós abertos na árvore. Sobrevive a um sync — reabrir tudo a cada sync seria
   *  desfazer, a cada vez, o que o usuário organizou. */
  collapsed: Set<string>;
  toggleCollapsed: (key: string) => void;

  syncMethod: SyncMethod;
  setSyncMethod: (method: SyncMethod) => void;

  exportTarget: ExportTarget;
  setExportTarget: (target: ExportTarget) => void;

  appStatus: AppStatus;
  statusMessage: string;
  setAppStatus: (status: AppStatus, message?: string) => void;
}

/** Aplica uma transformação a UMA câmera do resultado, sem mutar o original. */
function mapCamera(
  result: SyncResult,
  path: string,
  fn: (c: SyncedCamera) => SyncedCamera
): SyncResult {
  return {
    ...result,
    camera_groups: result.camera_groups.map((g) => ({
      ...g,
      cameras: g.cameras.map((c) => (c.path === path ? fn(c) : c)),
    })),
  };
}

/** A tomada a que um clipe de câmera pertence (ou undefined: é um órfão). */
export function takeOfCamera(
  result: SyncResult,
  cameraPath: string
): SyncedTake | undefined {
  return result.takes.find((t) => t.camera_paths.includes(cameraPath));
}

/** O som direto de um clipe de câmera. */
export function soundOfCamera(
  result: SyncResult,
  cameraPath: string
): SyncedSound | undefined {
  return takeOfCamera(result, cameraPath)?.sound;
}

/**
 * Põe o som de uma tomada numa posição da timeline.
 *
 * As câmeras dela NÃO se mexem na tela: quem absorve o movimento é o
 * `sync_offset_frames` delas — que é exatamente o que "deslocar o som em relação à
 * câmera" significa. O invariante
 *
 *     sync_offset = posição da câmera − posição do som
 *
 * vive AQUI, e só aqui. Arrastar o som e reverter o som são a mesma operação com
 * destinos diferentes; quando cada um fazia a sua conta, um deles esquecia metade
 * dela — foi assim que o "reverter" passou a devolver o som sem devolver o sync.
 */
function placeSound(
  result: SyncResult,
  soundPath: string,
  timelineStartFrames: number,
  manuallyAdjusted: boolean
): SyncResult {
  const take = result.takes.find((t) => t.sound.path === soundPath);
  if (!take) return result;
  const moved = new Set(take.camera_paths);

  return {
    ...result,
    takes: result.takes.map((t) =>
      t.sound.path === soundPath
        ? {
            ...t,
            sound: {
              ...t.sound,
              timeline_start_frames: timelineStartFrames,
              manually_adjusted: manuallyAdjusted,
            },
          }
        : t
    ),
    camera_groups: result.camera_groups.map((g) => ({
      ...g,
      cameras: g.cameras.map((c) =>
        moved.has(c.path)
          ? {
              ...c,
              sync_offset_frames: c.timeline_start_frames - timelineStartFrames,
            }
          : c
      ),
    })),
  };
}

/** Para onde o *reverter* volta: o último estado registrado, ou o que o sync calculou. */
type RevertTarget = "marco" | "original";

/** Este clipe tem alguma coisa para o usuário revisar ou desfazer? */
function hasSomethingToReview(result: SyncResult, path: string): boolean {
  const cam = result.camera_groups
    .flatMap((g) => g.cameras)
    .find((c) => c.path === path);
  if (cam) return !!(cam.flagged || cam.manually_adjusted || cam.confirmed);

  const snd = result.takes.find((t) => t.sound.path === path)?.sound;
  return !!(snd?.manually_adjusted || snd?.confirmed);
}

/**
 * Os clipes de uma seleção, na ORDEM EM QUE O REVERTER PODE ACONTECER: o som antes das
 * câmeras dele. E filtra quem não tem nada a desfazer.
 *
 * **A ordem não é estética — sem ela a tomada termina partida.** Reverter uma câmera a
 * posiciona contra o som ONDE ELE ESTÁ agora. Se o som ainda estiver deslocado (porque
 * o reverter dele vem depois no laço), a câmera se alinha a um lugar que está de saída;
 * e, pior, o offset dela acaba de ser forçado ao valor do sync — o que a torna uma
 * referência FALSA para o reverter do som, que então calcula deslocamento zero e não
 * sai do lugar. Resultado: o som fica onde estava, uma câmera "certa" ao lado dele e as
 * outras fora de sync.
 *
 * Com o som primeiro, tudo se resolve: ele volta usando as câmeras como testemunhas
 * (que ainda carregam o deslocamento dele), e as câmeras se alinham depois contra um
 * som que já está no lugar definitivo.
 */
function soundsFirst(result: SyncResult | null | undefined, paths: string[]): string[] {
  if (!result) return [];
  const isSound = new Set(result.takes.map((t) => t.sound.path));
  return paths
    .filter((p) => hasSomethingToReview(result, p))
    .sort((a, b) => Number(isSound.has(b)) - Number(isSound.has(a)));
}

/**
 * Devolve um clipe a um estado anterior — e devolve o SYNC, não a posição.
 *
 * ⚠️ **A distinção não é acadêmica.** Desde que deslocar a tomada inteira virou uma
 * operação legítima (ela não muda o sync, só o lugar dela no dia), restaurar a POSIÇÃO
 * ABSOLUTA de um clipe passou a ser um bug: o clipe seria arrancado de perto do som e
 * largado onde a tomada estava ANTES de ser reposicionada — quebrando exatamente o
 * sync que o botão promete devolver.
 *
 * Então o que se restaura é o `sync_offset` (a RELAÇÃO com o som), e a posição é
 * DERIVADA dele contra o som onde ele está agora. Um órfão não tem som nem relação: aí,
 * e só aí, o que se restaura é a posição.
 *
 * Para o SOM, o alvo é o offset das câmeras da tomada — e quem se move é o som, porque
 * é o que "deslocar o som contra as câmeras" significa (`placeSound`). A câmera de
 * referência é uma que NÃO tenha um ajuste próprio pendente: um sync-move do som
 * desloca a relação de TODAS as câmeras pelo mesmo tanto, então qualquer uma serve para
 * medir o deslocamento DELE — menos uma que também tenha sido mexida à mão, que
 * carregaria o ajuste dela para dentro da conta.
 */
function restore(
  result: SyncResult,
  baseline: SyncResult | null,
  path: string,
  target: RevertTarget
): SyncResult | null {
  if (!baseline) return null;

  const baseCam = new Map(
    baseline.camera_groups.flatMap((g) => g.cameras.map((c) => [c.path, c] as const))
  );

  /** O offset de destino de uma câmera. */
  const alvoOffset = (c: SyncedCamera): number => {
    const original = baseCam.get(c.path)?.sync_offset_frames ?? c.sync_offset_frames;
    if (target === "original") return original;
    return c.checkpoint_offset ?? original;
  };

  // ── Uma CÂMERA ───────────────────────────────────────────────────────────
  const cam = result.camera_groups
    .flatMap((g) => g.cameras)
    .find((c) => c.path === path);

  if (cam) {
    const base = baseCam.get(path);
    if (!base) return null;
    const take = takeOfCamera(result, path);

    if (target === "original") {
      // O ALERTA do sync volta junto: ele descrevia esta posição, e o usuário precisa
      // de novo da informação que ele carrega.
      const start = take
        ? take.sound.timeline_start_frames + base.sync_offset_frames
        : base.timeline_start_frames;
      return mapCamera(result, path, () => ({
        ...base,
        timeline_start_frames: start,
        manually_adjusted: false,
        confirmed: false,
        checkpoint_offset: undefined,
        checkpoint_start: undefined,
      }));
    }

    // De volta ao MARCO. Sem marco, o registro é o próprio sync — e "reverter" e
    // "reverter ao original" coincidem, que é o certo: não há estado intermediário
    // para onde voltar.
    const cp = take ? cam.checkpoint_offset : cam.checkpoint_start;
    if (cp === undefined) return restore(result, baseline, path, "original");

    const start = take ? take.sound.timeline_start_frames + cp : cp;
    return mapCamera(result, path, (c) => ({
      ...c,
      timeline_start_frames: start,
      sync_offset_frames: take ? cp : c.sync_offset_frames,
      // Voltar ao marco é voltar a um estado REVISADO — o verde acende de novo.
      confirmed: true,
      manually_adjusted: true,   // o reconcile apaga se o marco for o próprio sync
    }));
  }

  // ── O SOM ────────────────────────────────────────────────────────────────
  const take = result.takes.find((t) => t.sound.path === path);
  if (!take) return null;

  const cams = result.camera_groups
    .flatMap((g) => g.cameras)
    .filter((c) => take.camera_paths.includes(c.path));
  if (cams.length === 0) return null;

  const ref =
    cams.find((c) => !(c.manually_adjusted && !c.confirmed)) ?? cams[0];
  const shift = ref.sync_offset_frames - alvoOffset(ref);
  const back = placeSound(
    result, path, take.sound.timeline_start_frames + shift, true
  );

  const tinhaMarco = cams.some((c) => c.checkpoint_offset !== undefined);
  const confirmed = target === "marco" && tinhaMarco;

  return {
    ...back,
    // Ao voltar ao ORIGINAL, o marco vai junto: ele era um estado que o usuário
    // registrou, e ele acabou de dizer que quer o do algoritmo.
    camera_groups:
      target === "original"
        ? back.camera_groups.map((g) => ({
            ...g,
            cameras: g.cameras.map((c) =>
              take.camera_paths.includes(c.path)
                ? { ...c, checkpoint_offset: undefined }
                : c
            ),
          }))
        : back.camera_groups,
    takes: back.takes.map((t) =>
      t.sound.path === path ? { ...t, sound: { ...t.sound, confirmed } } : t
    ),
  };
}

/**
 * Apaga o "ajustado à mão" de quem, no fim das contas, NÃO teve o sync mudado.
 *
 * O roxo responde a uma pergunta: **este clipe está fora de onde o sync o pôs?** Não
 * a "este clipe se mexeu". As duas coisas parecem a mesma e não são: arrastar uma
 * câmera E o som dela juntos (para fechar um buraco na timeline, por exemplo) move os
 * dois pelo MESMO Δ — e `(cam+Δ) − (snd+Δ) = cam − snd`. O `sync_offset` sobrevive
 * intacto: a tomada continua em sync consigo mesma, só mudou de lugar no dia. Marcar
 * isso de roxo é dizer que há uma correção manual para revisar onde não há nenhuma.
 *
 * **Esta função só APAGA a marca, nunca a acende.** É o que preserva a atribuição:
 * quem acende é o mutador, no clipe que o usuário ARRASTOU. Assim, arrastar o som não
 * pinta as câmeras (elas nem se mexeram na tela), e arrastar uma câmera não pinta o
 * som. Aqui só se desfaz o que a aritmética provou desnecessário.
 *
 * E ela roda depois de CADA mutação, o que a torna imune à ordem: num arrasto de
 * vários clipes, os mutadores são chamados um a um, e no meio do caminho o offset de
 * uma câmera realmente fica errado (o som ainda não a alcançou). O estado que importa
 * é o final — e no final esta passada limpa o que ficou aceso à toa.
 */
function reconcileAdjusted(
  result: SyncResult,
  baseline: SyncResult | null
): SyncResult {
  if (!baseline) return result;

  const inTake = new Set(result.takes.flatMap((t) => t.camera_paths));
  const baseCam = new Map(
    baseline.camera_groups.flatMap((g) => g.cameras.map((c) => [c.path, c] as const))
  );

  /** A grandeza que DEFINE o sync de uma câmera. Numa tomada é o offset (a relação
   *  com o som); num órfão, que não tem som, é a posição — a única coisa que existe. */
  const syncOf = (c: SyncedCamera) =>
    inTake.has(c.path) ? c.sync_offset_frames : c.timeline_start_frames;

  /** Onde o ALGORITMO a pôs. */
  const original = (c: SyncedCamera) => {
    const b = baseCam.get(c.path);
    if (!b) return undefined;
    return inTake.has(c.path) ? b.sync_offset_frames : b.timeline_start_frames;
  };

  /** O último estado REGISTRADO: o marco, ou o original se nunca houve marco. */
  const marco = (c: SyncedCamera) => {
    const cp = inTake.has(c.path) ? c.checkpoint_offset : c.checkpoint_start;
    return cp ?? original(c);
  };

  const noOriginal = (c: SyncedCamera) => original(c) === syncOf(c);
  const noMarco = (c: SyncedCamera) => marco(c) === syncOf(c);

  // `mudou` guarda a IDENTIDADE do objeto quando não há nada a apagar. Sem isso, esta
  // passada — que roda a cada mutação — devolveria um `result` novo toda vez, e o
  // `mapActive` gravaria estado novo até quando ninguém mexeu em nada: a timeline
  // inteira re-renderizaria a cada clique.
  let mudou = false;

  const camera_groups = result.camera_groups.map((g) => ({
    ...g,
    cameras: g.cameras.map((c) => {
      let next = c;
      if (next.manually_adjusted && noOriginal(next)) {
        next = { ...next, manually_adjusted: false };
      }
      // A CONFIRMAÇÃO EXPIRA. Ela era a revisão de um estado; mexer no sync depois
      // dela a torna uma revisão de outra coisa. Deixá-la de pé faria um ajuste novo
      // e não revisado se esconder atrás de um "revisado" antigo — o verde ganha do
      // roxo na borda, e o usuário nunca saberia.
      if (next.confirmed && !noMarco(next)) {
        next = { ...next, confirmed: false };
      }
      if (next !== c) mudou = true;
      return next;
    }),
  }));

  const camAt = new Map(
    camera_groups.flatMap((g) => g.cameras.map((c) => [c.path, c] as const))
  );

  const takes = result.takes.map((t) => {
    const s = t.sound;
    if (!s.manually_adjusted && !s.confirmed) return t;

    // O som não tem sync próprio — o dele É o das câmeras da sua tomada. Exigir que
    // TODAS estejam no lugar (e não "alguma") é o que impede o som de apagar o aviso
    // enquanto ainda há câmeras fora de sync: mover o som desloca a relação de TODAS
    // elas de uma vez, e basta uma continuar fora para o som ainda estar segurando
    // uma correção.
    const cams = t.camera_paths
      .map((p) => camAt.get(p))
      .filter((c): c is SyncedCamera => !!c);
    if (cams.length === 0) return t;

    let next = s;
    if (next.manually_adjusted && cams.every(noOriginal)) {
      next = { ...next, manually_adjusted: false };
    }
    if (next.confirmed && !cams.every(noMarco)) {
      next = { ...next, confirmed: false };
    }
    if (next === s) return t;
    mudou = true;
    return { ...t, sound: next };
  });

  return mudou ? { ...result, camera_groups, takes } : result;
}

// ── Sync manual por sobreposição (arrastar-e-parear) ─────────────────────────

/** Duração de um som em frames do projeto. */
function soundDurationFrames(s: { duration_ms: number }, fps: number): number {
  return Math.round((s.duration_ms / 1000) * fps);
}

/** Sobreposição em frames entre [aStart, aStart+aLen] e [bStart, bStart+bLen]. */
function overlapFrames(
  aStart: number, aLen: number, bStart: number, bLen: number
): number {
  return Math.min(aStart + aLen, bStart + bLen) - Math.max(aStart, bStart);
}

/** O item que MAIS se sobrepõe a [start, start+frames], ou null se nada sobrepõe. */
function bestOverlap(
  start: number,
  frames: number,
  items: { path: string; start: number; frames: number }[]
): { path: string } | null {
  let best: { path: string; ov: number } | null = null;
  for (const it of items) {
    const ov = overlapFrames(start, frames, it.start, it.frames);
    if (ov > 0 && (!best || ov > best.ov)) best = { path: it.path, ov };
  }
  return best;
}

/** Todos os sons posicionáveis — os das tomadas E os órfãos. */
function placedSounds(
  result: SyncResult
): { path: string; start: number; frames: number }[] {
  const fps = result.fps;
  return [
    ...result.takes.map((t) => ({
      path: t.sound.path,
      start: t.sound.timeline_start_frames,
      frames: soundDurationFrames(t.sound, fps),
    })),
    ...(result.orphan_sounds ?? []).map((s) => ({
      path: s.path,
      start: s.timeline_start_frames,
      frames: soundDurationFrames(s, fps),
    })),
  ];
}

/** Pareia uma câmera com um som na posição ATUAL dos dois: offset = câmera − som.
 *  A câmera deixa de ser órfã e fica roxa (foi mexida à mão). Se o som era órfão,
 *  ele vira uma tomada. */
function pairCamSound(
  result: SyncResult,
  camPath: string,
  soundPath: string
): SyncResult {
  const cam = result.camera_groups
    .flatMap((g) => g.cameras)
    .find((c) => c.path === camPath);
  if (!cam) return result;

  const take = result.takes.find((t) => t.sound.path === soundPath);
  const orphanSound = (result.orphan_sounds ?? []).find((s) => s.path === soundPath);
  const soundStart = take
    ? take.sound.timeline_start_frames
    : orphanSound?.timeline_start_frames;
  if (soundStart === undefined) return result;

  const offset = cam.timeline_start_frames - soundStart;

  const orphan_paths = result.orphan_paths.filter((p) => p !== camPath);
  const camera_groups = result.camera_groups.map((g) => ({
    ...g,
    cameras: g.cameras.map((c) =>
      c.path === camPath
        ? {
            ...c,
            sync_offset_frames: offset,
            manually_adjusted: true,
            flagged: false,
            flag_reason: null,
          }
        : c
    ),
  }));

  let takes = result.takes;
  let orphan_sounds = result.orphan_sounds ?? [];
  if (take) {
    takes = takes.map((t) =>
      t.sound.path === soundPath
        ? { ...t, camera_paths: [...t.camera_paths, camPath] }
        : t
    );
  } else if (orphanSound) {
    orphan_sounds = orphan_sounds.filter((s) => s.path !== soundPath);
    takes = [
      ...takes,
      {
        name: orphanSound.name.replace(/\.[^.]+$/, ""),
        sound: orphanSound,
        camera_paths: [camPath],
      },
    ];
  }

  return { ...result, camera_groups, takes, orphan_paths, orphan_sounds };
}

/**
 * Tenta parear `path` (recém-solto) com um clipe sobreposto do tipo oposto.
 * Devolve o resultado novo, ou `null` se não houve o que parear.
 *
 * Só um clipe SOLTO (órfão) inicia um par — arrastar um clipe que já está numa
 * tomada só reajusta o offset dele (via `moveCamera`/`moveSound`), nunca re-pareia.
 */
function tryPairByOverlap(result: SyncResult, path: string): SyncResult | null {
  const orphanCams = new Set(result.orphan_paths);
  const cam = result.camera_groups
    .flatMap((g) => g.cameras)
    .find((c) => c.path === path);

  // Câmera órfã arrastada → o som que ela mais sobrepõe.
  if (cam && orphanCams.has(path)) {
    const best = bestOverlap(
      cam.timeline_start_frames,
      cam.duration_frames,
      placedSounds(result)
    );
    return best ? pairCamSound(result, path, best.path) : null;
  }

  // Som órfão arrastado → a câmera órfã que ele mais sobrepõe.
  const orphanSound = (result.orphan_sounds ?? []).find((s) => s.path === path);
  if (orphanSound) {
    const cams = result.camera_groups
      .flatMap((g) => g.cameras)
      .filter((c) => orphanCams.has(c.path))
      .map((c) => ({
        path: c.path,
        start: c.timeline_start_frames,
        frames: c.duration_frames,
      }));
    const best = bestOverlap(
      orphanSound.timeline_start_frames,
      soundDurationFrames(orphanSound, result.fps),
      cams
    );
    return best ? pairCamSound(result, best.path, path) : null;
  }
  return null;
}

/** Escreve uma câmera por path num array de `SyncedGroup[]` — a mesma conta de
 *  `mapCamera`, mas sobre o array em si (não sobre um `SyncResult` inteiro): o
 *  merge do resync encadeia várias trocas antes de ter um `SyncResult` de volta. */
function writeCam(
  groups: SyncedGroup[],
  path: string,
  fn: (c: SyncedCamera) => SyncedCamera
): SyncedGroup[] {
  return groups.map((g) => ({
    ...g,
    cameras: g.cameras.map((c) => (c.path === path ? fn(c) : c)),
  }));
}

/**
 * Funde a resposta do RE-SYNC PARCIAL (Etapa D) no resultado ativo.
 *
 * `engineResult` é um `Daily` INTEIRO recém-calculado — o motor sempre devolve a
 * diária toda (ver `sync/engine.py`), mas só os paths em `selected` foram de fato
 * re-medidos. O resto entrou como o `pinned` que ESTE merge mandou (o offset e o
 * som que já estavam na tela) — e sai idêntico, então usar o valor dele aqui seria
 * redundante e, pior, arriscado: ver a nota de POSIÇÃO abaixo.
 *
 * ⚠️ **A POSIÇÃO de um clipe re-sincronizado não vem do motor.** Ela é recalculada
 * AQUI, com a mesma conta do `moveCamera` — offset novo + posição do SOM na TELA
 * agora. O motor ancora a ilha pelo timecode do ARQUIVO (fixo), que pode não ser
 * onde o usuário reposicionou a tomada inteira à mão (um deslocamento uniforme de
 * câmera+som não muda o sync — ver `reconcileAdjusted` — mas muda a posição, e só
 * a tela sabe qual é ela agora). Usar a posição do motor apagaria esse
 * reposicionamento em clipes que ninguém pediu para tocar.
 *
 * Um clipe selecionado pode trocar de TOMADA (o motor decidiu que ele bate com
 * outro som — é o próprio ponto de usar vizinhos confiáveis como âncora): sai da
 * tomada antiga, entra na nova (ou vira órfão). A tomada de destino perde o
 * "confirmado" quando ganha um clipe novo — ninguém revisou essa composição ainda.
 */
export function applyResync(
  result: SyncResult,
  engineResult: SyncResult,
  selected: ReadonlySet<string>
): SyncResult {
  const engineCamByPath = new Map(
    engineResult.camera_groups.flatMap((g) => g.cameras.map((c) => [c.path, c] as const))
  );
  const engineSoundPathOf = new Map(
    engineResult.takes.flatMap((t) => t.camera_paths.map((p) => [p, t.sound.path] as const))
  );
  const engineTakeBySound = new Map(
    engineResult.takes.map((t) => [t.sound.path, t] as const)
  );

  let camera_groups = result.camera_groups;
  let takes = result.takes;
  let orphan_paths = result.orphan_paths;
  // Sons órfãos (sem câmera) — mostrados no seu TC. Um resync pode ADOTAR um deles
  // (uma câmera passa a bater com ele → vira tomada) ou CRIAR um (a última câmera de
  // uma tomada sai dela → o som fica sem câmera). Os dois casos abaixo.
  let orphan_sounds = result.orphan_sounds ?? [];
  const orphanSoundByPath = new Map(orphan_sounds.map((s) => [s.path, s] as const));

  for (const path of selected) {
    const engineCam = engineCamByPath.get(path);
    if (!engineCam) continue; // não deveria acontecer: mesmo conjunto de arquivos

    // Tira o clipe de onde ele estava — órfão ou tomada antiga — a posição e a
    // filiação novas são recalculadas do zero, sempre.
    orphan_paths = orphan_paths.filter((p) => p !== path);
    takes = takes.map((t) =>
      t.camera_paths.includes(path)
        ? { ...t, camera_paths: t.camera_paths.filter((p) => p !== path) }
        : t
    );

    const fresh = {
      manually_adjusted: false,
      confirmed: false,
      checkpoint_offset: undefined,
      checkpoint_start: undefined,
    };

    const newSoundPath = engineSoundPathOf.get(path);
    if (!newSoundPath) {
      // Ficou (ou virou) órfão: sem som contra que medir a posição AQUI — só o
      // motor sabe onde ancorá-lo (pelo próprio timecode).
      orphan_paths = [...orphan_paths, path];
      camera_groups = writeCam(camera_groups, path, () => ({ ...engineCam, ...fresh }));
      continue;
    }

    // Onde o som de destino está NA TELA agora — não no motor (ver o cabeçalho).
    // Ele pode estar numa tomada, ou ser um som ÓRFÃO que esta câmera vai adotar.
    const currentTake = takes.find((t) => t.sound.path === newSoundPath);
    const orphanSound = orphanSoundByPath.get(newSoundPath);
    const soundPos =
      currentTake?.sound.timeline_start_frames ??
      orphanSound?.timeline_start_frames ??
      engineTakeBySound.get(newSoundPath)!.sound.timeline_start_frames;

    camera_groups = writeCam(camera_groups, path, () => ({
      ...engineCam,
      ...fresh,
      timeline_start_frames: soundPos + engineCam.sync_offset_frames,
    }));

    if (currentTake) {
      takes = takes.map((t) =>
        t.sound.path === newSoundPath
          ? {
              ...t,
              camera_paths: [...t.camera_paths, path],
              // A composição da tomada mudou: entrou um clipe que ninguém revisou.
              // Um "confirmado" que sobrevivesse estaria garantindo por um clipe
              // que nunca foi olhado.
              sound: { ...t.sound, confirmed: false },
            }
          : t
      );
    } else {
      // Vira tomada. O som pode ter sido um ÓRFÃO na tela — se for, ele sai dos
      // órfãos (agora tem câmera) e mantém a posição que já estava exibindo.
      const engineTake = engineTakeBySound.get(newSoundPath)!;
      const soundObj = orphanSound ?? engineTake.sound;
      if (orphanSound) orphan_sounds = orphan_sounds.filter((s) => s.path !== newSoundPath);
      takes = [
        ...takes,
        {
          name: engineTake.name,
          sound: { ...soundObj, manually_adjusted: false, confirmed: false },
          camera_paths: [path],
        },
      ];
    }
  }

  // Tomadas que ficaram sem câmera nenhuma não SOMEM: o som vira um órfão, mostrado
  // no seu lugar. Sumir com ele esconderia um arquivo que existe — a mesma razão de
  // os sons órfãos existirem.
  const emptied = takes.filter((t) => t.camera_paths.length === 0);
  if (emptied.length) {
    const have = new Set(orphan_sounds.map((s) => s.path));
    orphan_sounds = [
      ...orphan_sounds,
      ...emptied
        .filter((t) => !have.has(t.sound.path))
        .map((t) => ({ ...t.sound, manually_adjusted: false, confirmed: false })),
    ];
  }
  takes = takes.filter((t) => t.camera_paths.length > 0);

  return { ...result, camera_groups, takes, orphan_paths, orphan_sounds };
}

/**
 * Atualiza o BASELINE (a referência do "algoritmo disse") para os paths
 * re-sincronizados — e só eles. É o que faz um resync valer como uma nova resposta
 * do algoritmo, e não como uma correção manual: sem isto, `reconcileAdjusted`
 * acenderia o roxo em todo clipe cujo offset novo diferisse do PRIMEIRO sync, que
 * é exatamente a informação que acabou de ficar obsoleta.
 *
 * O baseline só é lido por PATH (`sync_offset_frames` numa tomada,
 * `timeline_start_frames` num órfão — nunca a estrutura de tomadas), então basta
 * substituir a câmera inteira: a posição que o motor devolveu pode não bater com a
 * da TELA (ver `applyResync`), mas ela nunca é lida para quem está numa tomada.
 */
function patchBaselineForResync(
  baseline: SyncResult | null,
  engineResult: SyncResult,
  selected: ReadonlySet<string>
): SyncResult | null {
  if (!baseline) return null;
  const engineCamByPath = new Map(
    engineResult.camera_groups.flatMap((g) => g.cameras.map((c) => [c.path, c] as const))
  );

  let camera_groups = baseline.camera_groups;
  for (const path of selected) {
    const engineCam = engineCamByPath.get(path);
    if (!engineCam) continue;
    camera_groups = writeCam(camera_groups, path, () => engineCam);
  }
  return camera_groups === baseline.camera_groups ? baseline : { ...baseline, camera_groups };
}

/**
 * Reescreve o `result` do grupo ATIVO. Todo mutador de correção manual passa por
 * aqui — é o que faz "editar" significar sempre "editar a diária que está na tela",
 * sem que cada call site precise carregar o id do grupo.
 *
 * `fn` devolve `null` quando não há o que mudar; nesse caso o estado não é tocado
 * (nem o array de grupos), e o React não re-renderiza.
 *
 * TODA mutação sai daqui passando por `reconcileAdjusted` — o "ajustado à mão" é
 * DERIVADO do sync, não uma anotação solta que cada mutador lembra (ou esquece) de
 * manter. Pôr isto aqui, e não em cada um deles, é o que faz a regra valer também
 * para o mutador que alguém escrever amanhã.
 */
function mapActive(
  s: AppState,
  fn: (result: SyncResult, group: SyncGroup) => SyncResult | null
): Partial<AppState> {
  const i = s.syncGroups.findIndex((g) => g.id === s.activeGroupId);
  if (i < 0) return {};
  const group = s.syncGroups[i];
  if (!group.result) return {};

  const changed = fn(group.result, group);
  if (changed === null) return {};

  const next = reconcileAdjusted(changed, group.baseline);
  if (next === group.result) return {};

  const groups = [...s.syncGroups];
  groups[i] = { ...group, result: next };
  return { syncGroups: groups };
}

/** O grupo implícito, enquanto o usuário ainda não cria diárias à mão. */
const DEFAULT_GROUP_ID = "__diaria__";

/**
 * Reclassifica a fonte de `clip` a partir do que o probe achou.
 *
 * A regra é a de sempre — **tem fps → câmera; não tem → som direto** — e ela nunca
 * errou no material real. O que muda é que agora ela é VISÍVEL na tela, e o usuário
 * pode discordar: uma fonte com `kindLocked` não é mais tocada.
 *
 * O drone entra aqui como câmera (tem fps) mesmo sem faixa de áudio, que é o certo:
 * ele é uma câmera que não dá para sincronizar, não um som.
 */
function redetectKind(groups: SyncGroup[], clips: Clip[], clip: Clip): SyncGroup[] {
  const group = groups.find((g) => g.id === clip.syncGroupId);
  const source = group?.sources.find((s) => s.id === clip.sourceId);
  if (!group || !source || source.kindLocked) return groups;

  const mine = clips.filter((c) => c.sourceId === source.id && c.status === "ready");
  const kind: SourceKind = mine.some((c) => c.fps != null) ? "camera" : "sound";
  if (kind === source.kind) return groups;

  return groups.map((g) =>
    g.id !== group.id
      ? g
      : {
          ...g,
          sources: g.sources.map((s) => (s.id === source.id ? { ...s, kind } : s)),
        }
  );
}

/**
 * Tira dos sub-grupos os arquivos que saíram da diária.
 *
 * Um path que não está mais na árvore não pode continuar numa cena: ele viraria um
 * clipe fantasma na timeline e no export. A cena em si NÃO é apagada quando esvazia
 * — o nome é do usuário, e apagar em silêncio o que ele nomeou é pior do que
 * mostrá-la vazia.
 */
function pruneSubGroups(groups: SyncGroup[], gone: ReadonlySet<string>): SyncGroup[] {
  if (gone.size === 0) return groups;

  return groups.map((g) => {
    let changed = false;
    const subGroups = g.subGroups.map((sg) => {
      const paths = sg.paths.filter((p) => !gone.has(p));
      if (paths.length === sg.paths.length) return sg;
      changed = true;
      return { ...sg, paths };
    });
    return changed ? { ...g, subGroups } : g;
  });
}

/**
 * Reconcilia a seleção de navegação depois de uma remoção: se o nó apontado sumiu,
 * cai para o grupo dele (se ele sobreviveu) ou para `null`. Sem isto, o painel de
 * Conteúdo ficaria mostrando uma fonte/cena que não existe mais.
 */
function prunedBrowse(
  sel: BrowseSelection | null,
  groups: SyncGroup[]
): BrowseSelection | null {
  if (!sel) return null;
  const g = groups.find((x) => x.id === sel.groupId);
  if (!g) return null;   // a diária inteira sumiu
  if (sel.kind === "group" || sel.kind === "category") return sel;
  if (sel.kind === "source" && g.sources.some((s) => s.id === sel.refId)) return sel;
  if (sel.kind === "subgroup" && g.subGroups.some((sg) => sg.id === sel.refId)) return sel;
  // O nó específico sumiu, mas a diária ficou: volta para ela.
  return { kind: "group", groupId: sel.groupId };
}

/** A diária que a timeline e o monitor estão mostrando. */
export function activeGroup(s: AppState): SyncGroup | null {
  return s.syncGroups.find((g) => g.id === s.activeGroupId) ?? null;
}

/**
 * Hook: a CENA na tela — e só se ela for da diária na tela.
 *
 * A busca é DENTRO do grupo ativo de propósito: um id de cena da terça não resolve
 * na quarta, então um `activeSubGroupId` que sobrou de outra diária cai para `null`
 * (a diária inteira) em vez de recortar a timeline errada.
 */
export function useActiveSubGroup(): SubGroup | null {
  return useAppStore(
    (s) =>
      s.syncGroups
        .find((g) => g.id === s.activeGroupId)
        ?.subGroups.find((sg) => sg.id === s.activeSubGroupId) ?? null
  );
}

/** Hook: o grupo ativo. A identidade do objeto é estável entre renders enquanto
 *  ele não muda — é o que mantém os `useMemo` da timeline funcionando. */
export function useActiveGroup(): SyncGroup | null {
  return useAppStore((s) => s.syncGroups.find((g) => g.id === s.activeGroupId) ?? null);
}

/** Hook: o resultado do sync da diária na tela. É o que a timeline desenha, o que o
 *  monitor toca e o que vai para o export — os três leem daqui, e por isso não têm
 *  como divergir. */
export function useActiveResult(): SyncResult | null {
  return useAppStore(
    (s) => s.syncGroups.find((g) => g.id === s.activeGroupId)?.result ?? null
  );
}

export const useAppStore = create<AppState>((set, get) => ({
  locale: "pt-BR",
  setLocale: (locale) => set({ locale }),

  soundsEnabled: true,
  setSoundsEnabled: (soundsEnabled) => set({ soundsEnabled }),

  projectFps: null,
  setProjectFps: (projectFps) => set({ projectFps }),

  projectStartTcFrames: 0,
  setProjectStartTcFrames: (projectStartTcFrames) => set({ projectStartTcFrames }),

  syncProgress: null,
  setSyncProgress: (syncProgress) => set({ syncProgress }),

  peaksProgress: null,
  setPeaksProgress: (peaksProgress) => set({ peaksProgress }),
  peaksGeneration: 0,
  cancelPeaks: () =>
    set((s) => ({ peaksGeneration: s.peaksGeneration + 1, peaksProgress: null })),

  timelineHeight: 260,
  setTimelineHeight: (timelineHeight) => set({ timelineHeight }),

  monitorWidth: 420,
  setMonitorWidth: (monitorWidth) => set({ monitorWidth }),

  activeAngleId: null,
  setActiveAngleId: (activeAngleId) => set({ activeAngleId }),

  browseSelection: null,
  setBrowseSelection: (browseSelection) => set({ browseSelection }),

  mediaTreeWidth: 240,
  setMediaTreeWidth: (mediaTreeWidth) => set({ mediaTreeWidth }),

  syncGroups: [],
  activeGroupId: null,
  // Zera a cena: um sub-grupo não atravessa diárias, e um id da terça não
  // significa nada na quarta.
  setActiveGroupId: (activeGroupId) => set({ activeGroupId, activeSubGroupId: null }),

  activeSubGroupId: null,
  setActiveSubGroupId: (activeSubGroupId) => set({ activeSubGroupId }),

  addSubGroup: (groupId, name, paths) => {
    const id = crypto.randomUUID();
    set((s) => ({
      syncGroups: s.syncGroups.map((g) =>
        g.id === groupId
          ? { ...g, subGroups: [...g.subGroups, { id, name, paths: [...paths] }] }
          : g
      ),
      // Entra NELA: o usuário acabou de recortar a cena, e é o que ele quer ver.
      activeGroupId: groupId,
      activeSubGroupId: id,
    }));
    return id;
  },

  renameSubGroup: (groupId, id, name) =>
    set((s) => ({
      syncGroups: s.syncGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              subGroups: g.subGroups.map((sg) => (sg.id === id ? { ...sg, name } : sg)),
            }
          : g
      ),
    })),

  removeSubGroup: (groupId, id) =>
    set((s) => {
      const syncGroups = s.syncGroups.map((g) =>
        g.id === groupId
          ? { ...g, subGroups: g.subGroups.filter((sg) => sg.id !== id) }
          : g
      );
      return {
        syncGroups,
        // Apagar a cena que está na tela devolve a DIÁRIA INTEIRA — nunca uma
        // timeline vazia apontando para uma cena que não existe mais.
        activeSubGroupId: s.activeSubGroupId === id ? null : s.activeSubGroupId,
        browseSelection: prunedBrowse(s.browseSelection, syncGroups),
      };
    }),
  syncVersion: 0,

  /** O sync chegou. Hoje é sempre UMA diária, e ela vira o grupo implícito. */
  /** O sync chegou: uma diária por grupo. Uma que falhou entra com `error` e as
   *  outras seguem — o usuário não perde o trabalho de cinco dias por causa do sexto.
   *
   *  FUNDE por id, não substitui: as FONTES e o nome da diária são do usuário, e um
   *  sync não pode apagar o que ele montou. */
  setSyncResults: (incoming) =>
    set((s) => {
      const byId = new Map(incoming.map((g) => [g.id, g]));

      // FUNDE, e SÓ o que veio. As diárias que não foram sincronizadas desta vez
      // continuam intocadas — acrescentar a segunda diária não pode refazer a
      // primeira, e o resultado dela não pode ser apagado por um sync que não a
      // incluiu.
      const groups: SyncGroup[] = s.syncGroups.map((g) => {
        const got = byId.get(g.id);
        if (!got) return g;
        return {
          ...g,
          result: got.result,
          // O original, para o "reverter". O objeto vem do IPC e nunca é mutado no
          // lugar (as edições criam objetos novos), então guardá-lo por referência basta.
          baseline: got.result,
          inputHash: got.inputHash,
          error: got.error,
        };
      });

      // Uma diária que o sidecar devolveu e que a tela não conhece: só acontece no
      // grupo implícito (enquanto o usuário não monta a árvore à mão).
      for (const g of incoming) {
        if (!groups.some((x) => x.id === g.id)) {
          groups.push({
            id: g.id,
            name: g.name,
            sources: [],
            subGroups: [],
            result: g.result,
            baseline: g.result,
            inputHash: g.inputHash,
            error: g.error,
          });
        }
      }

      // Vai para a diária que ACABOU de sincronizar (a primeira que deu certo): é o
      // que o usuário estava esperando ver. Se nenhuma das novas deu certo, fica onde
      // estava — cair numa timeline vazia sem dizer por quê seria pior.
      const fresh = incoming.find((g) => g.result)?.id;
      return {
        syncGroups: groups,
        activeGroupId: fresh ?? s.activeGroupId ?? groups.find((g) => g.result)?.id ?? null,
        syncVersion: s.syncVersion + 1,
      };
    }),

  setSyncResult: (result, inputHash) =>
    get().setSyncResults([
      {
        id: get().activeGroupId ?? DEFAULT_GROUP_ID,
        name: result.name || DEFAULT_GROUP_ID,
        result,
        inputHash,
      },
    ]),

  /** Zera os RESULTADOS, e só eles. A árvore (as diárias e as fontes) é do usuário —
   *  apagá-la a cada sync seria desfazer, toda vez, o que ele acabou de montar. */
  clearSyncResult: (ids) =>
    set((s) => ({
      syncGroups: s.syncGroups.map((g) =>
        ids && !ids.includes(g.id)
          ? g
          : { ...g, result: null, baseline: null, inputHash: null, error: undefined }
      ),
      syncVersion: s.syncVersion + 1,
    })),

  moveCamera: (path, timelineStartFrames) =>
    set((s) =>
      mapActive(s, (result) => {
        // O som da tomada fica parado; quem se move é a câmera. O offset é a
        // DISTÂNCIA entre os dois — recalculada aqui para que a posição na tela e o
        // número que vai para o export não tenham como divergir.
        const sound = soundOfCamera(result, path);
        return mapCamera(result, path, (c) => ({
          ...c,
          timeline_start_frames: timelineStartFrames,
          sync_offset_frames: sound
            ? timelineStartFrames - sound.timeline_start_frames
            : c.sync_offset_frames,
          manually_adjusted: true,
        }));
      })
    ),

  moveSound: (path, timelineStartFrames) =>
    set((s) =>
      mapActive(s, (result) => {
        // Som de uma TOMADA: mover contra as câmeras dela (os offsets delas
        // absorvem — ver placeSound). Som ÓRFÃO (sem câmera): não há offset a
        // manter, então só reposiciona. O par com uma câmera nasce ao SOLTAR sobre
        // ela (ver pairByOverlap), não aqui.
        if (result.takes.some((t) => t.sound.path === path)) {
          return placeSound(result, path, timelineStartFrames, true);
        }
        const orphans = result.orphan_sounds ?? [];
        if (!orphans.some((so) => so.path === path)) return null;
        return {
          ...result,
          orphan_sounds: orphans.map((so) =>
            so.path === path
              ? { ...so, timeline_start_frames: timelineStartFrames }
              : so
          ),
        };
      })
    ),

  pairByOverlap: (draggedPaths) =>
    set((s) =>
      mapActive(s, (result) => {
        let r = result;
        let changed = false;
        for (const path of draggedPaths) {
          const next = tryPairByOverlap(r, path);
          if (next) {
            r = next;
            changed = true;
          }
        }
        return changed ? r : null;
      })
    ),

  /**
   * Confirmar = REGISTRAR ESTE ESTADO e dizer "revisei, está certo".
   *
   * O estado registrado (o MARCO) é para onde o `revertClip` volta depois. É o que
   * torna a correção manual iterativa: mover, confirmar, mover de novo, e o *reverter*
   * ainda saber para onde voltar — em vez de só existir o "tudo ou nada" contra o sync.
   *
   * Vale para câmera E para som. Enquanto isto só olhava as câmeras, o botão aparecia
   * na track do som, ficava clicável, e o clipe seguia roxo para sempre — a MESMA
   * classe de bug que o `revertClip` já teve.
   */
  confirmClip: (path) =>
    set((s) =>
      mapActive(s, (result) => {
        const take = takeOfCamera(result, path);
        const isCamera = result.camera_groups.some((g) =>
          g.cameras.some((c) => c.path === path)
        );

        if (isCamera) {
          return mapCamera(result, path, (c) => ({
            ...c,
            confirmed: true,
            // Confirmar É a revisão humana que o alerta pedia: ele sai.
            flagged: false,
            flag_reason: null,
            // O marco: o OFFSET, se houver som; a posição, se for órfão.
            ...(take
              ? { checkpoint_offset: c.sync_offset_frames }
              : { checkpoint_start: c.timeline_start_frames }),
          }));
        }

        const snd = result.takes.find((t) => t.sound.path === path);
        if (!snd) return null;

        // Confirmar o SOM é confirmar o sync DA TOMADA — o som não tem offset próprio.
        // Por isso o marco dele é carimbado nas CÂMERAS dela: é contra elas que o
        // *reverter* do som vai se orientar, e é só assim que ele sobrevive a um
        // reposicionamento da tomada no dia.
        const paths = new Set(snd.camera_paths);
        return {
          ...result,
          camera_groups: result.camera_groups.map((g) => ({
            ...g,
            cameras: g.cameras.map((c) =>
              paths.has(c.path)
                ? { ...c, checkpoint_offset: c.sync_offset_frames }
                : c
            ),
          })),
          takes: result.takes.map((t) =>
            t.sound.path === path
              ? { ...t, sound: { ...t.sound, confirmed: true } }
              : t
          ),
        };
      })
    ),

  revertClip: (path) =>
    set((s) => mapActive(s, (result, g) => restore(result, g.baseline, path, "marco"))),

  revertClipToOriginal: (path) =>
    set((s) =>
      mapActive(s, (result, g) => restore(result, g.baseline, path, "original"))
    ),

  confirmClips: (paths) => {
    const r = activeGroup(get())?.result;
    if (!r) return;
    // Confirmar é REVISAR. Um clipe que não tem ajuste nem alerta não tem o que ser
    // revisado — carimbá-lo de "revisado" seria o app inventando um trabalho que
    // ninguém fez.
    for (const p of paths.filter((p) => hasSomethingToReview(r, p))) {
      get().confirmClip(p);
    }
  },

  revertClips: (paths) => {
    const alvo = soundsFirst(activeGroup(get())?.result, paths);
    for (const p of alvo) get().revertClip(p);
  },

  revertClipsToOriginal: (paths) => {
    const alvo = soundsFirst(activeGroup(get())?.result, paths);
    for (const p of alvo) get().revertClipToOriginal(p);
  },

  applyResyncResult: (selectedPaths, engineResult) =>
    set((s) => {
      const i = s.syncGroups.findIndex((g) => g.id === s.activeGroupId);
      if (i < 0) return {};
      const group = s.syncGroups[i];
      if (!group.result) return {};

      const selected = new Set(selectedPaths);
      const merged = applyResync(group.result, engineResult, selected);
      const baseline = patchBaselineForResync(group.baseline, engineResult, selected);
      // A mesma passada de limpeza que TODA mutação leva — pega qualquer
      // consequência do resync que `applyResync` não tenha tratado explicitamente.
      const result = reconcileAdjusted(merged, baseline);

      const groups = [...s.syncGroups];
      groups[i] = { ...group, result, baseline };
      return { syncGroups: groups };
    }),

  timelineLocked: false,
  setTimelineLocked: (timelineLocked) => set({ timelineLocked }),

  soloTracks: new Set(),
  mutedTracks: new Set(),
  toggleSolo: (trackId) =>
    set((s) => {
      const next = new Set(s.soloTracks);
      next.has(trackId) ? next.delete(trackId) : next.add(trackId);
      return { soloTracks: next };
    }),
  toggleMute: (trackId) =>
    set((s) => {
      const next = new Set(s.mutedTracks);
      next.has(trackId) ? next.delete(trackId) : next.add(trackId);
      return { mutedTracks: next };
    }),
  audibleTracks: (trackIds) => {
    // `get()` do zustand, e não `useAppStore.getState()`: referenciar o store
    // dentro da própria definição cria um tipo circular, e o TypeScript desiste —
    // inferindo `any` para a store inteira, em cascata por todo o app.
    const { soloTracks, mutedTracks } = get();
    // Semântica de mesa: havendo solo, ele manda — o mute das outras nem entra
    // na conta.
    if (soloTracks.size > 0) {
      return new Set(trackIds.filter((id) => soloTracks.has(id)));
    }
    return new Set(trackIds.filter((id) => !mutedTracks.has(id)));
  },

  peaks: new Map(),
  peakRate: 50,
  peaksVersion: 0,
  setPeaks: (path, peaks, rate) =>
    set((s) => {
      // Muta o Map em vez de recriá-lo: são centenas de KB por entrada, e nada
      // observa o Map por identidade — quem observa é peaksVersion.
      s.peaks.set(path, peaks);
      return { peakRate: rate, peaksVersion: s.peaksVersion + 1 };
    }),
  clearPeaks: () =>
    set((s) => {
      s.peaks.clear();
      return { peaksVersion: s.peaksVersion + 1 };
    }),

  liveSounds: new Map(),
  liveClips: new Map(),
  liveVersion: 0,
  liveGroups: [],
  setLiveGroups: (liveGroups) =>
    set((s) => ({ liveGroups, liveVersion: s.liveVersion + 1 })),
  upsertLiveSound: (sound) =>
    set((s) => {
      s.liveSounds.set(sound.path, sound);
      return { liveVersion: s.liveVersion + 1 };
    }),
  upsertLiveClip: (clip) =>
    set((s) => {
      // Upsert por path: o engine reemite um clipe quando o move ou o sinaliza
      // numa passada seguinte, e o mais recente é o que vale.
      s.liveClips.set(clip.path, clip);
      return { liveVersion: s.liveVersion + 1 };
    }),
  clearLive: () =>
    set((s) => {
      s.liveClips.clear();
      s.liveSounds.clear();
      return { liveGroups: [], liveVersion: s.liveVersion + 1 };
    }),

  clips: [],
  // Mexer na lista NÃO apaga o syncResult: quem detecta que ele ficou obsoleto
  // é a comparação com o syncInputHash (em SyncControls). Apagar aqui esconderia
  // a obsolescência — o app não teria como avisar "a lista mudou, sincronize de
  // novo", só desabilitaria o Exportar sem explicar por quê.
  addClip: (clip) => set((s) => ({ clips: [...s.clips, clip] })),

  /** O probe voltou. Se a fonte ainda não foi CLASSIFICADA À MÃO, ela se
   *  reclassifica: tem fps → câmera; não tem → som direto. É a mesma detecção de
   *  sempre, só que agora ela é VISÍVEL na tela e o usuário pode discordar. */
  updateClip: (id, updates) =>
    set((s) => {
      const clips = s.clips.map((c) => (c.id === id ? { ...c, ...updates } : c));
      const clip = clips.find((c) => c.id === id);
      if (!clip || clip.status !== "ready") return { clips };
      return { clips, syncGroups: redetectKind(s.syncGroups, clips, clip) };
    }),

  removeClip: (id) =>
    set((s) => {
      const clip = s.clips.find((c) => c.id === id);
      return {
        clips: s.clips.filter((c) => c.id !== id),
        syncGroups: clip
          ? pruneSubGroups(s.syncGroups, new Set([clip.path]))
          : s.syncGroups,
      };
    }),

  // ── A árvore: diária → fonte → arquivos ───────────────────────────────────

  addGroup: (name) => {
    const id = crypto.randomUUID();
    set((s) => ({
      syncGroups: [
        ...s.syncGroups,
        {
          id,
          name,
          sources: [],
          subGroups: [],
          result: null,
          baseline: null,
          inputHash: null,
        },
      ],
      activeGroupId: s.activeGroupId ?? id,
    }));
    return id;
  },

  renameGroup: (id, name) =>
    set((s) => ({
      syncGroups: s.syncGroups.map((g) => (g.id === id ? { ...g, name } : g)),
    })),

  removeGroup: (id) =>
    set((s) => {
      const leaving = s.activeGroupId === id;
      const syncGroups = s.syncGroups.filter((g) => g.id !== id);
      return {
        syncGroups,
        clips: s.clips.filter((c) => c.syncGroupId !== id),
        activeGroupId: leaving
          ? (s.syncGroups.find((g) => g.id !== id)?.id ?? null)
          : s.activeGroupId,
        // Os sub-grupos da diária vão embora com ela; ficar apontando para um
        // deles recortaria a timeline da diária SEGUINTE.
        activeSubGroupId: leaving ? null : s.activeSubGroupId,
        browseSelection: prunedBrowse(s.browseSelection, syncGroups),
      };
    }),

  addSource: (groupId, name, folderPath) => {
    const id = crypto.randomUUID();
    set((s) => ({
      syncGroups: s.syncGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              // "câmera" é só o palpite inicial: o probe decide, e o usuário corrige.
              sources: [...g.sources, { id, name, kind: "camera", folderPath }],
            }
          : g
      ),
    }));
    return id;
  },

  removeSource: (groupId, sourceId) =>
    set((s) => {
      const gone = new Set(
        s.clips.filter((c) => c.sourceId === sourceId).map((c) => c.path)
      );
      const groups = s.syncGroups.map((g) =>
        g.id === groupId
          ? { ...g, sources: g.sources.filter((src) => src.id !== sourceId) }
          : g
      );
      const syncGroups = pruneSubGroups(groups, gone);
      return {
        syncGroups,
        clips: s.clips.filter((c) => c.sourceId !== sourceId),
        browseSelection: prunedBrowse(s.browseSelection, syncGroups),
      };
    }),

  setSourceKind: (groupId, sourceId, kind) =>
    set((s) => ({
      syncGroups: s.syncGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              sources: g.sources.map((src) =>
                // `kindLocked`: a partir daqui o probe não sobrescreve mais. Sem
                // isso, a correção do usuário seria desfeita no próximo arquivo
                // que entrasse na fonte.
                src.id === sourceId ? { ...src, kind, kindLocked: true } : src
              ),
            }
          : g
      ),
    })),

  groupOwning: (path) => {
    const clip = get().clips.find((c) => c.path === path);
    return clip?.syncGroupId ?? null;
  },

  collapsed: new Set(),
  toggleCollapsed: (key) =>
    set((s) => {
      const next = new Set(s.collapsed);
      next.has(key) ? next.delete(key) : next.add(key);
      return { collapsed: next };
    }),

  syncMethod: "hybrid",
  setSyncMethod: (syncMethod) => set({ syncMethod }),

  exportTarget: "premiere",
  setExportTarget: (exportTarget) => set({ exportTarget }),

  appStatus: "idle",
  statusMessage: "",
  setAppStatus: (appStatus, message = "") =>
    set({ appStatus, statusMessage: message }),
}));
