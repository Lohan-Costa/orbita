import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { IconArrowRight, IconFolder, IconSettings } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useActiveGroup, useAppStore, type SyncResult } from "../store/appStore";
import { viewPaths } from "../types/timeline";
import { useI18n } from "../hooks/useI18n";
import { syncFilesFor } from "../lib/syncPayload";
import { SettingsDialog } from "./SettingsDialog";
import { SelectionActions } from "./SelectionActions";

/** O que o comando `sync` devolve: uma diária por grupo, com o seu resultado ou o
 *  seu erro. Um grupo que falha não derruba os outros (ver src-python/main.py). */
interface SyncResponse {
  name: string;
  groups: (Partial<SyncResult> & { id: string; name?: string; error?: string })[];
}

export function SyncControls() {
  const t = useI18n();
  const {
    clips,
    syncGroups,
    syncMethod,
    appStatus,
    setAppStatus,
    setSyncProgress,
    setSyncResults,
    clearLive,
    clearSyncResult,
    setLiveGroups,
    projectFps,
    projectStartTcFrames,
    setPeaksProgress,
    cancelPeaks,
  } = useAppStore();

  /** A diária na tela. O EXPORT não sai daqui — ele leva todas as diárias, uma bin
   *  cada (ver `handleExport`). Isto aqui serve para o aviso de "obsoleta", que é
   *  sobre a que o usuário está vendo. */
  const group = useActiveGroup();

  const readyClips = clips.filter((c) => c.status === "ready");

  /** O que vai para o sidecar: uma DIÁRIA por grupo, e dentro dela um arquivo por
   *  clipe, carimbado com a FONTE (`group_id`, que para o engine é a câmera física)
   *  e com a CLASSIFICAÇÃO (`kind`) que a tela mostra. */
  const syncGroupPayload = useMemo(
    () =>
      syncGroups
        .map((g) => ({ id: g.id, name: g.name, files: syncFilesFor(g, readyClips) }))
        .filter((g) => g.files.length > 0),
    [syncGroups, readyClips]
  );

  /**
   * Identidade das entradas de UMA DIÁRIA. Se mudar, o resultado dela descreve outra
   * coisa e precisa ser refeito.
   *
   * POR DIÁRIA, e é o ponto: era um hash só, do projeto inteiro, e por isso acrescentar
   * a segunda diária marcava a PRIMEIRA como obsoleta — e "Sincronizar" re-sincronizava
   * as duas. Uma diária não sabe da outra; o hash dela também não pode saber.
   *
   * O fps entra porque os offsets vêm medidos NELE: trocar a grade depois do sync
   * deixaria os números certos numa unidade errada. A CLASSIFICAÇÃO também: mudar o que
   * é som muda o sync. O início do projeto NÃO entra — ele só renumera a régua, não move
   * clipe nenhum. E as OPÇÕES DE EXPORT também não: mexer num toggle de saída não pode
   * obrigar a re-sincronizar.
   *
   * ⚠️ O MÉTODO de sync NÃO entra aqui — e não marca obsolescência de forma alguma. O
   * hash guarda a identidade dos ARQUIVOS; um resultado já calculado descreve os mesmos
   * arquivos, seja qual for o dropdown. Pôr o método na conta já causou DOIS bugs: no
   * `inputHash` travava o Exportar; num campo à parte (`syncedWith`), trocar o dropdown
   * marcava TODAS as diárias como obsoletas e o "Sincronizar" refazia o projeto inteiro.
   * Para refazer uma diária com OUTRO método, a via é o "Re-sincronizar seleção"
   * (seleciona os clipes → roda o método atual só neles), não o botão global.
   */
  const hashes = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of syncGroupPayload) {
      m.set(
        g.id,
        [
          `fps=${projectFps ?? "auto"}`,
          ...g.files
            .map((f) => `${f.path}|${f.group_id}|${f.group_order}|${f.kind}`)
            .sort(),
        ].join("\n")
      );
    }
    return m;
  }, [syncGroupPayload, projectFps]);

  /** As diárias que precisam ser (re)sincronizadas: as que nunca foram e as que
   *  mudaram de ARQUIVOS. Acrescentar uma diária deixa obsoleta só ELA. */
  const stale = useMemo(
    () =>
      syncGroupPayload.filter((g) => {
        const known = syncGroups.find((x) => x.id === g.id);
        return !known?.result || known.inputHash !== hashes.get(g.id);
      }),
    [syncGroupPayload, syncGroups, hashes]
  );

  const isRunning = appStatus === "running";

  /**
   * ⚠️ Sincronizar com arquivos AINDA SENDO LIDOS sincroniza um conjunto PARCIAL,
   * em silêncio: `syncFilesFor` só manda os `status === "ready"`, então os que
   * ainda não voltaram do `probe_media` simplesmente não entram no payload — e o
   * usuário recebe um sync do que deu tempo de ler, sem nada avisando.
   *
   * Pior: o sidecar atende um comando por vez, então o "sync" ainda fica na FILA
   * atrás das leituras que faltam. Numa pasta nova em HD externo (cache de probe
   * frio) isso é dezenas de segundos com a tela dizendo "Sincronizando…" e nada
   * acontecendo — que foi exatamente o que pareceu travamento.
   */
  const isLoadingClips = clips.some((c) => c.status === "loading");
  const canSync =
    stale.length > 0 && readyClips.length >= 2 && !isRunning && !isLoadingClips;
  const isStale =
    group !== null && group.result !== null && group.inputHash !== hashes.get(group.id);
  /** Só exporta com TUDO em dia: um projeto com uma diária obsoleta descreveria em
   *  parte o que está na tela e em parte o que estava antes. */
  const canExport =
    !isRunning &&
    syncGroups.some((g) => g.result) &&
    syncGroups.every((g) => !g.result || g.inputHash === hashes.get(g.id));

  /** Etapa 1: calcula os offsets. NÃO gera arquivo — o resultado alimenta a
   *  timeline, onde o usuário confere antes de exportar. */
  const handleSync = async () => {
    if (!canSync) return;

    // SÓ AS DIÁRIAS OBSOLETAS. Acrescentar a segunda diária não pode re-sincronizar a
    // primeira: ela não mudou, o resultado dela está certo, e refazê-lo custaria os
    // minutos (ou as horas) que ela levou.
    const todo = stale;

    setSyncProgress(null);
    cancelPeaks();                       // o passe de waveforms anterior não vale mais
    clearLive();
    clearSyncResult(todo.map((g) => g.id));   // só o resultado DELAS
    // As waveforms NÃO são apagadas: elas são por ARQUIVO, não por sync, e regerar as
    // de uma diária de Alexa custa dez minutos de leitura.

    // As lanes das câmeras já existem na ÁRVORE — cria todas de uma vez, para que a
    // timeline tenha estrutura desde o primeiro segundo do sync. A classificação vem
    // da FONTE (que o usuário vê e pode corrigir), não mais de adivinhar pelo fps.
    const syncing = new Set(todo.map((g) => g.id));
    setLiveGroups(
      syncGroups
        .filter((g) => syncing.has(g.id))
        .flatMap((g) =>
          g.sources
            .filter((src) => src.kind === "camera")
            .map((src) => ({ id: src.id, name: src.name, syncGroupId: g.id }))
        )
    );

    setAppStatus("running");
    try {
      // O sidecar sincroniza uma DIÁRIA por vez, cada uma isolada da outra: as
      // câmeras de um dia se resolvem contra o som DAQUELE dia, nunca contra o de
      // outro. Uma que falha volta com `error` e as demais seguem.
      const response = await invoke<SyncResponse>("sidecar_call", {
        command: "sync",
        params: {
          groups: todo,
          sync_method: syncMethod,
          // null = o sidecar detecta o fps pelas câmeras. É a grade em que os
          // offsets voltam medidos, então precisa ir ANTES do sync, não depois.
          fps: projectFps,
          start_tc_frames: projectStartTcFrames,
        },
      });

      const groups = response.groups.map((g) => ({
        id: g.id,
        name: g.name ?? g.id,
        result: g.error ? null : (g as SyncResult),
        inputHash: hashes.get(g.id) ?? "",
        error: g.error,
      }));
      setSyncResults(groups);

      const ok = groups.filter((g) => g.result);
      const failed = groups.filter((g) => g.error);

      if (ok.length === 0) {
        setAppStatus("error", `${t.sync.error}: ${failed[0]?.error ?? ""}`);
        return;
      }

      const takes = ok.reduce((n, g) => n + g.result!.takes.length, 0);
      const orphans = ok.reduce((n, g) => n + g.result!.orphan_paths.length, 0);
      const flagged = ok.reduce(
        (n, g) =>
          n + g.result!.camera_groups.flatMap((cg) => cg.cameras).filter((c) => c.flagged).length,
        0
      );
      const summary = t.sync.takesSummary
        .replace("{{takes}}", String(takes))
        .replace("{{orphans}}", String(orphans));

      setAppStatus(
        "success",
        flagged > 0
          ? `${summary} — ${t.sync.flagsHint.replace("{{n}}", String(flagged))}`
          : summary
      );

      void fillMissingPeaks(ok.map((g) => g.result!));
    } catch (err) {
      setAppStatus("error", `${t.sync.error}: ${err}`);
    } finally {
      setSyncProgress(null);
    }
  };

  /**
   * As waveforms das câmeras que o sync não desenhou — depois, em segundo plano.
   *
   * Para desenhar a waveform de uma câmera é preciso ler o arquivo INTEIRO (o
   * áudio vive interleavado com o vídeo): numa diária de Alexa são 202 GB, e é
   * exatamente isso que o caminho rápido do sync existe para não fazer. Então a
   * timeline aparece na hora — com os clipes caros como blocos — e as waveforms
   * chegam uma a uma, por eventos, enquanto o usuário já trabalha. É o que o
   * próprio Premiere faz (os arquivos `.pek`).
   *
   * UM CLIPE POR CHAMADA, e cedendo a vez. O sidecar atende um comando de cada vez:
   * um passe único de dez minutos deixaria o botão Exportar pendurado. Assim o
   * usuário nunca espera mais que um clipe, e um sync novo abandona o passe antigo.
   *
   * Não é `await`-ado por quem chama: o sync já acabou. Um erro aqui não é erro do
   * sync e não muda o status — waveform é exibição, não sincronismo.
   */
  const fillMissingPeaks = async (results: SyncResult[]) => {
    const store = useAppStore.getState();
    const gen = store.peaksGeneration;
    const have = store.peaks;
    // Câmeras E sons. Os sons pareados normalmente já chegaram com peaks pelos
    // eventos do sync (o filtro `have` os pula) — quem PRECISA disto são os sons
    // ÓRFÃOS, que nenhum evento emite: sem esta linha eles ficavam um bloco vazio
    // na track de som para sempre.
    const missing = [
      ...new Set(
        results.flatMap((r) => [
          ...r.camera_groups.flatMap((g) => g.cameras.map((c) => c.path)),
          ...r.takes.map((t) => t.sound.path),
          ...(r.orphan_sounds ?? []).map((s) => s.path),
        ])
      ),
    ].filter((p) => !have.has(p));

    if (missing.length === 0) return;

    /** Este passe ainda é o atual? (Um sync novo ou o Cancelar sobem a geração.) */
    const alive = () => useAppStore.getState().peaksGeneration === gen;

    setPeaksProgress({ done: 0, total: missing.length });
    try {
      for (let i = 0; i < missing.length; i++) {
        // Enquanto o usuário estiver usando o sidecar (sync novo, export), espera.
        while (useAppStore.getState().appStatus === "running") {
          if (!alive()) return;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!alive()) return;

        try {
          await invoke("sidecar_call", {
            command: "compute_peaks",
            params: { paths: [missing[i]] },
          });
        } catch (err) {
          console.error(`[peaks] ${missing[i]}:`, err);
        }
        if (!alive()) return;
        setPeaksProgress({ done: i + 1, total: missing.length });
      }
    } finally {
      if (alive()) setPeaksProgress(null);
    }
  };

  /** A janela de configurações de export: nome do projeto, local, e os toggles das
   *  opções. Abre ao apertar Exportar. Hoje só tem "áudio da câmera"; no futuro,
   *  "merged clip" e "multicam" (fora do Alpha — ver DECISIONS.md). O default de
   *  incluir o áudio da câmera é DESLIGADO. */
  const [exportDialog, setExportDialog] = useState(false);
  const [settingsDialog, setSettingsDialog] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [saveFolder, setSaveFolder] = useState("");
  const [includeCameraAudio, setIncludeCameraAudio] = useState(false);

  /** As diárias que vão para o arquivo. TODAS as sincronizadas, uma bin cada —
   *  exportar só a que está na tela obrigaria o usuário a exportar quatro vezes e a
   *  juntar os arquivos à mão no Premiere, e o trabalho dele é a semana, não o dia.
   *  As que falharam ficam de fora: não têm resultado para exportar. */
  const exported = useMemo(() => syncGroups.filter((g) => g.result), [syncGroups]);

  /** Etapa 2: gera o arquivo a partir do resultado JÁ calculado — instantâneo,
   *  sem re-sincronizar. O que está na timeline é o que é exportado.
   *
   *  `multicamIds` fica vazio no Alpha (multicam desligado — ver DECISIONS.md): tudo
   *  sai como sequência NORMAL. O parâmetro segue para quando o multicam voltar. */
  const runExport = async (multicamIds: string[]) => {
    if (!canExport || exported.length === 0) return;
    // Nome e local vêm da janela de configurações. Sem os dois, não há para onde
    // gravar. `join` monta o caminho respeitando o separador do SO (Win/mac).
    if (!saveFolder || !projectName.trim()) return;
    const outputPath = await join(saveFolder, `${projectName.trim()}.prproj`);

    setExportDialog(false);
    setAppStatus("running");
    try {
      const result = await invoke<{ path: string; flags?: unknown[] }>("sidecar_call", {
        command: "export_prproj_from_result",
        params: {
          result: {
            groups: exported.map((g) => ({
              ...g.result,
              // O nome da BIN é o que o usuário deu à diária na árvore — não o que o
              // sidecar inventou no sync.
              name: g.name,
              // O início do projeto é lido AGORA, não do resultado do sync: o usuário
              // pode tê-lo mudado depois de sincronizar, e mudar a régua não exige
              // re-sincronizar nada.
              start_tc_frames: projectStartTcFrames,
              sub_groups: g.subGroups.map((sg) => ({
                id: sg.id,
                name: sg.name,
                // Os paths RESOLVIDOS — com o som das tomadas junto. A regra tem um
                // dono só (`viewOf`), e o Python não a reimplementa: o que o usuário
                // vê na timeline da cena é o que vai para a sequência.
                paths: viewPaths(g.result!, new Set(sg.paths)),
              })),
            })),
          },
          // Opções à parte do resultado: o que foi filmado é uma coisa, o que se quer
          // tirar dele é outra.
          options: {
            multicam_sub_groups: multicamIds,
            include_camera_audio: includeCameraAudio,
          },
          output_path: outputPath,
        },
      });

      // O arquivo é gerado mesmo com clipes sinalizados — mas o usuário PRECISA
      // saber que alguns não sincronizaram com confiança, em vez de descobrir
      // no NLE.
      const flags = result?.flags ?? [];
      const msg = t.sync.exportSuccess.replace("{{path}}", result.path);
      if (flags.length > 0) {
        setAppStatus(
          "success",
          `${msg} — ${t.sync.flagsHint.replace("{{n}}", String(flags.length))}`
        );
      } else {
        setAppStatus("success", msg);
      }
    } catch (err) {
      setAppStatus("error", `${t.sync.exportError}: ${err}`);
    }
  };

  /** Exportar abre a JANELA DE CONFIGURAÇÕES: nome do projeto, local, e os toggles das
   *  opções. É lá que o export de fato acontece. Default do nome = a primeira diária. */
  const handleExport = () => {
    if (!projectName) setProjectName(exported[0]?.name || "Órbita");
    setExportDialog(true);
  };

  /** Abre o seletor de PASTA (não de arquivo: o nome vem do campo da janela). */
  const chooseFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setSaveFolder(dir);
  };

  return (
    <div className="flex-shrink-0 border-t border-line bg-surface-2 px-4 py-3">
      <div className="flex items-center gap-2">
        {/* As ações sobre a SELEÇÃO da timeline ocupam o espaço que sobrava à
            esquerda — é onde as ações do app já vivem, e tira da barra da
            timeline (que é de informação) a disputa por largura. */}
        <SelectionActions />

        {isStale && (
          <span className="status-pill pill-warning flex-shrink-0">{t.timeline.stale}</span>
        )}
        <button
          className="tbtn outline-accent gap-1.5 ml-auto flex-shrink-0"
          onClick={handleSync}
          disabled={!canSync}
          title={isLoadingClips && !isRunning ? t.sync.waitLoading : undefined}
        >
          {isRunning ? t.sync.running : t.sync.run}
        </button>
        <button
          className="tbtn primary gap-1.5"
          onClick={handleExport}
          disabled={!canExport}
          title={!canExport && !isRunning ? t.sync.exportHint : undefined}
        >
          {t.sync.export}
          <IconArrowRight size={12} />
        </button>
        <button
          className="tbtn p-1.5"
          onClick={() => setSettingsDialog(true)}
          title={t.settings.open}
          aria-label={t.settings.open}
        >
          <IconSettings size={14} />
        </button>
      </div>

      {settingsDialog && <SettingsDialog onClose={() => setSettingsDialog(false)} />}

      {/* Janela de configurações do export: nome, local, e os toggles das opções.
          É onde o usuário decide o que sai — e o único lugar onde o export dispara. */}
      {exportDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
             onClick={() => setExportDialog(false)}>
          <div className="bg-surface border border-line rounded-lg shadow-xl w-[440px] flex flex-col"
               onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-line">
              <div className="text-[13px] font-medium text-ink">{t.export.dialogTitle}</div>
            </div>

            <div className="p-4 flex flex-col gap-4">
              {/* Nome do projeto */}
              <label className="flex flex-col gap-1">
                <span className="panel-title">{t.export.projectName}</span>
                <input
                  type="text"
                  className="field w-full"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Órbita"
                  autoFocus
                />
              </label>

              {/* Local */}
              <div className="flex flex-col gap-1">
                <span className="panel-title">{t.export.location}</span>
                <div className="flex items-center gap-2">
                  <button className="tbtn gap-1.5 flex-shrink-0" onClick={() => void chooseFolder()}>
                    <IconFolder size={12} />
                    {t.export.chooseFolder}
                  </button>
                  <span className="text-[11px] text-ink-3 truncate" title={saveFolder}>
                    {saveFolder || t.export.noFolder}
                  </span>
                </div>
              </div>

              {/* Opções (toggles) — hoje só áudio da câmera; futuro: merged, multicam */}
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <span className="panel-title">{t.export.optionsTitle}</span>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-accent mt-0.5"
                    checked={includeCameraAudio}
                    onChange={(e) => setIncludeCameraAudio(e.target.checked)}
                  />
                  <span className="flex flex-col">
                    <span className="text-[12px] text-ink">{t.export.includeCameraAudio}</span>
                    <span className="text-[10px] text-ink-3">{t.export.includeCameraAudioHint}</span>
                  </span>
                </label>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-line flex justify-end gap-2">
              <button className="tbtn" onClick={() => setExportDialog(false)}>
                {t.export.cancel}
              </button>
              <button
                className="tbtn primary gap-1.5"
                onClick={() => void runExport([])}
                disabled={!saveFolder || !projectName.trim()}
              >
                {t.sync.export}
                <IconArrowRight size={12} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
