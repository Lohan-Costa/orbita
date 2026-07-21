import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconCheck,
  IconArrowBackUp,
  IconRestore,
  IconScissors,
  IconRefresh,
} from "@tabler/icons-react";
import {
  useAppStore,
  takeOfCamera,
  type SyncResult,
} from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { useTimelineData } from "../hooks/useTimelineData";
import { syncFilesFor } from "../lib/syncPayload";
import type { TimelineClip } from "../types/timeline";

/**
 * O que se pode FAZER com os clipes selecionados na timeline.
 *
 * Mora na barra de baixo, ao lado de Sincronizar/Exportar, e não na barra da
 * timeline: são AÇÕES, e é ali que as ações do app vivem. Na barra de cima elas
 * disputavam espaço com a INFORMAÇÃO (contadores, nome do clipe, avisos) e
 * empurravam o nome do arquivo para fora da tela.
 *
 * A seleção vem da store (`timelineSelection`) — ver o porquê lá.
 */
export function SelectionActions() {
  const t = useI18n();
  const {
    timelineSelection,
    setTimelineSelection,
    timelineLocked,
    confirmClips,
    revertClips,
    revertClipsToOriginal,
    addSubGroup,
    syncGroups,
    activeGroupId,
    clips,
    syncMethod,
    appStatus,
    setAppStatus,
    setSyncProgress,
    applyResyncResult,
  } = useAppStore();

  const data = useTimelineData();
  const group = syncGroups.find((g) => g.id === activeGroupId) ?? null;
  const syncResult = group?.result ?? null;

  const clipByPath = useMemo(() => {
    const m = new Map<string, TimelineClip>();
    for (const tr of data?.tracks ?? []) for (const c of tr.clips) m.set(c.path, c);
    return m;
  }, [data]);

  const selectedClips = useMemo(
    () =>
      [...timelineSelection]
        .map((p) => clipByPath.get(p))
        .filter((c): c is TimelineClip => !!c),
    [timelineSelection, clipByPath]
  );

  const canEdit = !timelineLocked && !!syncResult;
  const resyncing = appStatus === "running";

  /** Só CÂMERAS: o som não tem offset próprio para recalcular (ver
   *  [[manual-correction-model]]). */
  const resyncTargets = useMemo(
    () => selectedClips.filter((c) => !c.isSound && c.editable).map((c) => c.path),
    [selectedClips]
  );

  const editable = selectedClips.filter((c) => c.editable);

  /**
   * RE-SYNC PARCIAL (Etapa D) — recalcula o sync só dos clipes de CÂMERA
   * selecionados. O resto da diária entra FIXADO no que já está na tela —
   * inclusive correções manuais — e serve de ÂNCORA: é o "vizinho confiável" que
   * resolve uma tomada ambígua sem reler um arquivo que ninguém pediu para
   * reconsiderar (ver `pinned`/`selected` em `sync/engine.py`).
   */
  const handleResyncSelection = async () => {
    if (!group?.result || resyncing || resyncTargets.length === 0) return;
    const result = group.result;

    const selectedSet = new Set(resyncTargets);
    const pinned: Record<string, { offset_frames: number; sound_path: string }> = {};
    for (const cg of result.camera_groups) {
      for (const c of cg.cameras) {
        if (selectedSet.has(c.path)) continue;
        const take = takeOfCamera(result, c.path);
        if (!take) continue; // órfão fora da seleção: sem som, não há como ancorá-lo
        pinned[c.path] = {
          offset_frames: c.sync_offset_frames,
          sound_path: take.sound.path,
        };
      }
    }

    setSyncProgress(null);
    setAppStatus("running");
    try {
      const response = await invoke<{
        groups: (Partial<SyncResult> & { id: string; error?: string })[];
      }>("sidecar_call", {
        command: "resync",
        params: {
          groups: [
            {
              id: group.id,
              name: group.name,
              files: syncFilesFor(group, clips),
              selected_paths: resyncTargets,
              pinned,
            },
          ],
          // O MESMO método do sync geral (dropdown): o usuário troca para
          // "Waveform" para consertar por forma de onda os poucos clipes onde o TC
          // falhou, ou mantém "Timecode" para reaplicar o TC de entrada à seleção.
          sync_method: syncMethod,
          // A grade é a do RESULTADO atual, não `projectFps`: os offsets fixados
          // (`pinned`) foram medidos nela, e re-medir o selecionado noutra grade
          // deixaria pin e medição em unidades diferentes.
          fps: result.fps,
          start_tc_frames: result.start_tc_frames,
        },
      });
      const g = response.groups.find((x) => x.id === group.id);
      if (!g || g.error) {
        setAppStatus("error", `${t.timeline.resyncError}: ${g?.error ?? ""}`);
        return;
      }
      applyResyncResult(resyncTargets, g as SyncResult);
      setTimelineSelection(new Set());
      setAppStatus("success", t.timeline.resyncSuccess);
    } catch (err) {
      setAppStatus("error", `${t.timeline.resyncError}: ${err}`);
    } finally {
      setSyncProgress(null);
    }
  };

  if (selectedClips.length === 0) return null;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="status-pill pill-muted flex-shrink-0">
        {t.timeline.selectedCount.replace("{{n}}", String(selectedClips.length))}
      </span>

      {/* Re-sincronizar: só com CÂMERA na seleção. */}
      {canEdit && resyncTargets.length > 0 && (
        <button
          className="tbtn gap-1 flex-shrink-0"
          onClick={() => void handleResyncSelection()}
          disabled={resyncing}
          title={t.timeline.resyncHint}
        >
          <IconRefresh size={12} className={resyncing ? "animate-spin" : undefined} />
          {resyncing ? t.timeline.resyncRunning : t.timeline.resync}
        </button>
      )}

      {/* Criar cena NÃO depende da trava: uma cena é uma vista, e ver não é editar. */}
      {syncResult && (
        <button
          className="tbtn gap-1 flex-shrink-0"
          onClick={() => {
            if (!activeGroupId) return;
            addSubGroup(
              activeGroupId,
              t.groups.subGroupDefault.replace(
                "{{n}}",
                String((group?.subGroups.length ?? 0) + 1)
              ),
              selectedClips.map((c) => c.path)
            );
            setTimelineSelection(new Set());
          }}
          title={t.groups.newSubGroupHint}
        >
          <IconScissors size={12} />
          {t.groups.newSubGroup}
        </button>
      )}

      {/* Confirmar/reverter valem para a seleção INTEIRA — e em LOTE, no store,
          que é quem sabe em quem agir e em que ordem (o som vai primeiro). */}
      {canEdit && editable.length > 0 && (
        <>
          {editable.some((c) => (c.flagged || c.manuallyAdjusted) && !c.confirmed) && (
            <button
              className="tbtn gap-1 flex-shrink-0"
              onClick={() => confirmClips(editable.map((c) => c.path))}
              title={t.timeline.confirmHint}
            >
              <IconCheck size={12} />
              {t.timeline.confirm}
            </button>
          )}
          {editable.some((c) => c.manuallyAdjusted || c.confirmed) && (
            <button
              className="tbtn gap-1 flex-shrink-0"
              onClick={() => revertClips(editable.map((c) => c.path))}
              title={t.timeline.revertHint}
            >
              <IconArrowBackUp size={12} />
              {t.timeline.revert}
            </button>
          )}
          {/* "Ao original" só com um MARCO para pular por baixo — sem ele os dois
              botões fariam a mesma coisa, e dois botões iguais só ensinam o
              usuário a não ler o que está escrito. */}
          {editable.some((c) => c.hasCheckpoint) && (
            <button
              className="tbtn gap-1 flex-shrink-0"
              onClick={() => revertClipsToOriginal(editable.map((c) => c.path))}
              title={t.timeline.revertOriginalHint}
            >
              <IconRestore size={12} />
              {t.timeline.revertOriginal}
            </button>
          )}
        </>
      )}
    </div>
  );
}
