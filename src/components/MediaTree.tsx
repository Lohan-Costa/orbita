import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import {
  IconVideo,
  IconMicrophone,
  IconX,
  IconPlus,
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconScissors,
  IconFolders,
  IconVideoPlus,
} from "@tabler/icons-react";
import {
  useAppStore,
  type BrowseSelection,
  type Source,
  type SourceKind,
  type SubGroup,
  type SyncGroup,
} from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { CameraSplitDialog } from "./CameraSplitDialog";

/**
 * A ÁRVORE de mídia — só NAVEGAÇÃO. Os arquivos vivem no painel de Conteúdo (à
 * direita); aqui ficam só os NÓS: diária → ângulos/som direto/"Sub-grupos" → cenas.
 *
 * Clicar num nó o mostra no Conteúdo (`setBrowseSelection`). O ESCOPO da timeline é
 * outra coisa (a diária/cena que se sincroniza) — setado por DUPLO-CLIQUE aqui, ou
 * pelo seletor da própria timeline.
 *
 * O import (arrastar uma pasta, ou o diálogo) e a classificação câmera/som continuam
 * aqui: são estruturais, e é onde a árvore é montada.
 */

/** Retorno de `expand_dropped_paths` (Rust): uma pasta = uma fonte, recursivamente
 *  — exceto quando a heurística acha mais de uma câmera lá dentro, e aí vêm vários
 *  grupos com o mesmo `split_from` (ver `plan_split` no Rust). */
interface DroppedGroup {
  group_id: string;
  group_name: string | null;
  files: string[];
  /** A pasta que foi dividida. Presente = foi PALPITE, tem de ser confirmado. */
  split_from?: string | null;
  /** Palpite do Rust por extensão: `"camera"` ou `"sound"`. */
  kind?: string | null;
}

/** Um split proposto, esperando a confirmação do usuário. */
interface PendingSplit {
  /** A diária que vai receber os arquivos. */
  groupId: string;
  from: string;
  candidates: DroppedGroup[];
}

interface ProbeResult {
  fps?: number;
  tc_start?: string;
  duration_ms?: number;
  width?: number;
  height?: number;
  codec_label?: string;
  has_audio?: boolean;
  sample_rate?: number;
}

/** Este nó é o que está aberto no painel de Conteúdo? */
function isBrowsed(
  sel: BrowseSelection | null,
  kind: BrowseSelection["kind"],
  groupId: string,
  refId?: string
): boolean {
  return (
    sel?.kind === kind && sel.groupId === groupId && (sel.refId ?? undefined) === refId
  );
}

// ── Nome renomeável de um nó ──────────────────────────────────────────────────
/**
 * Clique = SELECIONA (comportamento normal de um item de árvore — propaga pro
 * onClick do nó pai). Duplo-clique = entra em modo de renomear. Antes o campo
 * era sempre um `<input>`, então passar o mouse já mostrava o cursor de texto
 * e um clique já editava — sem estado de "selecionado" nenhum.
 */
function InlineRename({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className: string;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => setEditing(false)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
    );
  }

  return (
    <span
      className={`${className} truncate`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}

// ── Uma fonte (CAM A, Som Direto) — folha, sem arquivos ──────────────────────

function SourceNode({ group, source, count }: { group: SyncGroup; source: Source; count: number }) {
  const t = useI18n();
  const { setSourceKind, removeSource, setActiveGroupId, browseSelection, setBrowseSelection } =
    useAppStore();

  const Icon = source.kind === "camera" ? IconVideo : IconMicrophone;
  const browsed = isBrowsed(browseSelection, "source", group.id, source.id);

  const canBeCamera = useAppStore((s) =>
    s.clips.some((c) => c.sourceId === source.id && c.fps != null)
  );
  const next: SourceKind = source.kind === "camera" ? "sound" : "camera";
  const canFlip = next === "sound" || canBeCamera;

  return (
    <div
      className={`flex items-center gap-1.5 pl-12 pr-2 py-1 border-b border-line border-l-2 group cursor-pointer ${
        browsed
          ? "bg-accent/15 border-l-accent"
          : "border-l-transparent hover:bg-surface-2"
      }`}
      onClick={() => setBrowseSelection({ kind: "source", groupId: group.id, refId: source.id })}
      onDoubleClick={() => setActiveGroupId(group.id)}
      title={source.folderPath}
    >
      <Icon size={13} className="text-ink-3 flex-shrink-0" />
      <span className="text-[12px] text-ink-2 truncate">{source.name}</span>
      <span className="text-[11px] text-ink-3 flex-shrink-0">{count}</span>

      <button
        className="seg-btn ml-auto flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          if (canFlip) setSourceKind(group.id, source.id, next);
        }}
        disabled={!canFlip}
        title={canFlip ? t.groups.flipKind : t.groups.cannotBeCamera}
      >
        {source.kind === "camera" ? t.groups.camera : t.groups.sound}
      </button>

      <button
        className="tbtn p-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0"
        title={t.groups.removeSource}
        onClick={(e) => {
          e.stopPropagation();
          removeSource(group.id, source.id);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}

// ── Uma cena (dentro da categoria "Sub-grupos") ──────────────────────────────

function SubGroupNode({ group, subGroup }: { group: SyncGroup; subGroup: SubGroup }) {
  const t = useI18n();
  const {
    setActiveGroupId,
    setActiveSubGroupId,
    renameSubGroup,
    removeSubGroup,
    browseSelection,
    setBrowseSelection,
  } = useAppStore();

  const browsed = isBrowsed(browseSelection, "subgroup", group.id, subGroup.id);

  return (
    <div
      className={`flex items-center gap-1.5 pl-16 pr-2 py-1 border-l-2 cursor-pointer group ${
        browsed
          ? "bg-accent/15 border-l-accent"
          : "border-l-transparent hover:bg-surface-2"
      }`}
      onClick={() =>
        setBrowseSelection({ kind: "subgroup", groupId: group.id, refId: subGroup.id })
      }
      onDoubleClick={() => {
        // Ordem: `setActiveGroupId` zera a cena, então a diária vem antes.
        setActiveGroupId(group.id);
        setActiveSubGroupId(subGroup.id);
      }}
      title={t.groups.activeSubGroup}
    >
      <IconScissors size={12} className="text-ink-3 flex-shrink-0" />
      <InlineRename
        value={subGroup.name}
        onChange={(v) => renameSubGroup(group.id, subGroup.id, v)}
        className="flex-1 min-w-0 bg-transparent text-[11px] text-ink outline-none focus:bg-surface rounded px-1"
      />
      <span className="text-[10px] text-ink-3 flex-shrink-0">
        {subGroup.paths.length === 0
          ? t.groups.emptySubGroup
          : t.groups.subGroupCount.replace("{{n}}", String(subGroup.paths.length))}
      </span>
      <button
        className="tbtn p-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0"
        title={t.groups.removeSubGroup}
        onClick={(e) => {
          e.stopPropagation();
          removeSubGroup(group.id, subGroup.id);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}

// ── A categoria "Sub-grupos" (nível 2, sempre presente) ──────────────────────

function SubGroupsCategory({ group }: { group: SyncGroup }) {
  const t = useI18n();
  const { collapsed, toggleCollapsed, browseSelection, setBrowseSelection } = useAppStore();
  const key = `cat:${group.id}`;
  const openCat = !collapsed.has(key);
  const browsed = isBrowsed(browseSelection, "category", group.id);

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 pl-7 pr-2 py-1 border-b border-line border-l-2 cursor-pointer ${
          browsed
            ? "bg-accent/15 border-l-accent"
            : "border-l-transparent hover:bg-surface-2"
        }`}
        onClick={() => setBrowseSelection({ kind: "category", groupId: group.id })}
      >
        <button
          className="tbtn p-0 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(key);
          }}
          title={openCat ? t.groups.collapse : t.groups.expand}
        >
          {openCat ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>
        <IconFolders size={13} className="text-ink-3 flex-shrink-0" />
        <span className="text-[12px] text-ink-2">{t.media.subGroupsCategory}</span>
        <span className="text-[11px] text-ink-3 flex-shrink-0 ml-auto">
          {group.subGroups.length}
        </span>
      </div>
      {openCat &&
        group.subGroups.map((sg) => (
          <SubGroupNode key={sg.id} group={group} subGroup={sg} />
        ))}
    </div>
  );
}

// ── Uma diária ────────────────────────────────────────────────────────────────

function GroupNode({
  group,
  countOf,
  onAddSource,
}: {
  group: SyncGroup;
  countOf: (sourceId: string) => number;
  onAddSource: (groupId: string) => void;
}) {
  const t = useI18n();
  const {
    collapsed,
    toggleCollapsed,
    removeGroup,
    renameGroup,
    activeGroupId,
    setActiveGroupId,
    browseSelection,
    setBrowseSelection,
    addSource,
  } = useAppStore();

  const key = `grp:${group.id}`;
  const openGrp = !collapsed.has(key);
  const isActive = activeGroupId === group.id;
  const browsed = isBrowsed(browseSelection, "group", group.id);
  const total = group.sources.reduce((n, s) => n + countOf(s.id), 0);

  return (
    <div
      className={`border-b border-line ${isActive ? "bg-accent/5" : ""}`}
      data-sync-group-id={group.id}
    >
      {/* Clique = mostrar no Conteúdo; duplo-clique = pôr na timeline. */}
      <div
        className={`flex items-center gap-1.5 pl-1.5 pr-2 py-1 border-l-2 group cursor-pointer ${
          browsed
            ? "bg-accent/15 border-l-accent"
            : "border-l-transparent hover:bg-surface-2"
        }`}
        onClick={() => setBrowseSelection({ kind: "group", groupId: group.id })}
        onDoubleClick={() => setActiveGroupId(group.id)}
        title={t.groups.activeDay}
      >
        <button
          className="tbtn p-0 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(key);
          }}
          title={openGrp ? t.groups.collapse : t.groups.expand}
        >
          {openGrp ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>

        <IconFolder size={13} className="text-ink-3 flex-shrink-0" />

        <InlineRename
          value={group.name}
          onChange={(v) => renameGroup(group.id, v)}
          className="flex-1 min-w-0 bg-transparent text-[12px] font-medium text-ink outline-none focus:bg-surface rounded px-1"
        />

        <span className="text-[11px] text-ink-3 flex-shrink-0">
          {t.sync.cameraGroup.replace("{{n}}", String(total))}
        </span>

        {group.error && (
          <span className="status-pill pill-error flex-shrink-0" title={group.error}>
            {t.groups.failed}
          </span>
        )}

        {/* Criar uma câmera VAZIA — o destino para onde mover clipes quando a
            detecção automática juntou duas câmeras numa fonte só. */}
        <button
          className="tbtn p-0.5 flex-shrink-0"
          title={t.groups.addEmptyCamera}
          onClick={(e) => {
            e.stopPropagation();
            const n = group.sources.filter((s) => s.kind === "camera").length + 1;
            addSource(group.id, t.groups.cameraDefault.replace("{{n}}", String(n)));
          }}
        >
          <IconVideoPlus size={12} />
        </button>
        <button
          className="tbtn p-0.5 flex-shrink-0"
          title={t.groups.addSource}
          onClick={(e) => {
            e.stopPropagation();
            onAddSource(group.id);
          }}
        >
          <IconPlus size={12} />
        </button>
        <button
          className="tbtn p-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0"
          title={t.groups.removeGroup}
          onClick={(e) => {
            e.stopPropagation();
            removeGroup(group.id);
          }}
        >
          <IconX size={12} />
        </button>
      </div>

      {openGrp && (
        <>
          {group.sources.map((src) => (
            <SourceNode key={src.id} group={group} source={src} count={countOf(src.id)} />
          ))}
          {group.sources.length === 0 && (
            <button
              className="w-full text-left pl-12 pr-3 py-2 text-[11px] text-ink-3 hover:bg-surface-2"
              onClick={() => onAddSource(group.id)}
            >
              {t.groups.emptyGroup}
            </button>
          )}
          {group.subGroups.length > 0 && <SubGroupsCategory group={group} />}
        </>
      )}
    </div>
  );
}

// ── O painel ──────────────────────────────────────────────────────────────────

export function MediaTree() {
  const t = useI18n();
  const {
    clips, addClip, updateClip, appStatus, syncGroups, addSource, groupOwning,
    setImportProgress,
  } = useAppStore();
  const [isDragOver, setIsDragOver] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  /** Fila de splits propostos — uma pergunta por pasta dividida. */
  const [pendingSplits, setPendingSplits] = useState<PendingSplit[]>([]);

  const newGroup = useCallback(
    () =>
      useAppStore.getState().addGroup(
        t.groups.groupDefault.replace(
          "{{n}}",
          String(useAppStore.getState().syncGroups.length + 1)
        )
      ),
    [t]
  );

  const isBusy = appStatus === "running";

  const countBySource = useMemo(() => {
    const by = new Map<string, number>();
    for (const c of clips) by.set(c.sourceId, (by.get(c.sourceId) ?? 0) + 1);
    return by;
  }, [clips]);
  const countOf = useCallback((sourceId: string) => countBySource.get(sourceId) ?? 0, [
    countBySource,
  ]);

  const addFolder = useCallback(
    async (groupId: string, dropped: DroppedGroup) => {
      const already = dropped.files
        .map((p) => groupOwning(p))
        .find((g): g is string => g !== null);
      if (already) {
        const owner = useAppStore.getState().syncGroups.find((g) => g.id === already);
        setWarning(t.groups.alreadyInGroup.replace("{{group}}", owner?.name ?? ""));
        return;
      }

      const name =
        dropped.group_name ?? dropped.files[0]?.split(/[\\/]/).pop() ?? t.groups.source;
      // O palpite do Rust (por extensão) evita que o gravador apareça como
      // "câmera" na árvore até o primeiro probe voltar.
      const sourceId = addSource(
        groupId,
        name,
        dropped.group_id,
        dropped.kind === "sound" ? "sound" : "camera"
      );

      for (let i = 0; i < dropped.files.length; i++) {
        const path = dropped.files[i];
        // Conta o LOTE, não o projeto: quem sabe o tamanho do lote é quem o
        // iniciou (`importGroups`), então aqui só se incrementa.
        useAppStore.setState((st) =>
          st.importProgress
            ? { importProgress: { ...st.importProgress, done: st.importProgress.done + 1 } }
            : {}
        );
        const id = crypto.randomUUID();
        addClip({
          id,
          path,
          name: path.split(/[\\/]/).pop() ?? path,
          status: "loading",
          syncGroupId: groupId,
          sourceId,
          sourceOrder: i,
        });
        try {
          const meta = await invoke<ProbeResult>("sidecar_call", {
            command: "probe_media",
            params: { path },
          });
          updateClip(id, {
            status: "ready",
            fps: meta.fps,
            tcStart: meta.tc_start,
            durationMs: meta.duration_ms,
            width: meta.width,
            height: meta.height,
            codecLabel: meta.codec_label,
            hasAudio: meta.has_audio,
            sampleRate: meta.sample_rate,
          });
        } catch (err) {
          updateClip(id, { status: "error", error: String(err) });
        }
      }
    },
    [addClip, addSource, groupOwning, t, updateClip]
  );

  /**
   * Importa o que o Rust devolveu, SEGURANDO os splits para confirmação.
   *
   * O que veio inteiro entra na hora (nada mudou). O que a heurística DIVIDIU vai
   * para uma fila de perguntas — uma por pasta dividida —, porque um palpite sobre
   * "quantas câmeras há aqui" não pode virar estrutura sem o usuário ver.
   */
  const importGroups = useCallback(
    async (targetGroupId: string, groups: DroppedGroup[]) => {
      const plain = groups.filter((g) => !g.split_from);
      const split = groups.filter((g) => g.split_from);

      const total = plain.reduce((n, g) => n + g.files.length, 0);
      if (total > 0) setImportProgress({ done: 0, total });
      try {
        for (const g of plain) await addFolder(targetGroupId, g);
      } finally {
        if (total > 0) setImportProgress(null);
      }

      if (split.length > 0) {
        const byFolder = new Map<string, DroppedGroup[]>();
        for (const g of split) {
          const key = g.split_from as string;
          byFolder.set(key, [...(byFolder.get(key) ?? []), g]);
        }
        setPendingSplits((prev) => [
          ...prev,
          ...[...byFolder].map(([from, candidates]) => ({
            groupId: targetGroupId,
            from,
            candidates,
          })),
        ]);
      }
    },
    [addFolder, setImportProgress]
  );

  const pickSource = useCallback(
    async (groupId: string) => {
      if (isBusy) return;
      const picked = await open({ directory: true, multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const groups = await invoke<DroppedGroup[]>("expand_dropped_paths", { paths });
      await importGroups(groupId, groups);
    },
    [importGroups, isBusy]
  );

  const handleDrop = useCallback(
    async (paths: string[], position?: { x: number; y: number }) => {
      if (isBusy) return;
      // Sem grupo nenhum, o drag-and-drop fica desligado — o usuário precisa
      // criar o primeiro grupo pelo botão antes de arrastar qualquer coisa.
      const gs = useAppStore.getState().syncGroups;
      if (gs.length === 0) return;

      let target: string | null = null;
      if (position) {
        const dpr = window.devicePixelRatio || 1;
        const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
        target =
          el?.closest("[data-sync-group-id]")?.getAttribute("data-sync-group-id") ?? null;
      }
      if (!target) target = gs[gs.length - 1].id;

      const groups = await invoke<DroppedGroup[]>("expand_dropped_paths", { paths });
      await importGroups(target, groups);
    },
    [importGroups, isBusy]
  );

  const dropRef = useRef(handleDrop);
  useEffect(() => {
    dropRef.current = handleDrop;
  }, [handleDrop]);

  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    win
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDragOver(true);
        } else if (event.payload.type === "drop") {
          setIsDragOver(false);
          const p = event.payload as {
            paths?: string[];
            position?: { x: number; y: number };
          };
          if (p.paths?.length) dropRef.current(p.paths, p.position);
        } else {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** Resolve o primeiro split da fila e passa para o próximo. */
  const resolveSplit = useCallback(
    async (action: "confirm" | "merge" | "cancel", chosen?: DroppedGroup[]) => {
      const pending = pendingSplits[0];
      if (!pending) return;
      setPendingSplits((prev) => prev.slice(1));
      if (action === "cancel") return;

      if (action === "merge") {
        // Falso positivo: era UMA câmera, e o nome certo é o da pasta arrastada.
        setImportProgress({
          done: 0,
          total: pending.candidates.reduce((n, c) => n + c.files.length, 0),
        });
        try {
        await addFolder(pending.groupId, {
          group_id: pending.from,
          group_name: pending.from.split(/[\\/]/).filter(Boolean).pop() ?? null,
          files: pending.candidates.flatMap((c) => c.files),
        });
        } finally {
          setImportProgress(null);
        }
        return;
      }

      // A ORDEM da lista é a ordem em que as fontes nascem — e é ela que faz a
      // primeira ser a CAM A.
      const escolhidos = chosen ?? [];
      setImportProgress({
        done: 0,
        total: escolhidos.reduce((n, c) => n + c.files.length, 0),
      });
      try {
        for (const c of escolhidos) await addFolder(pending.groupId, c);
      } finally {
        setImportProgress(null);
      }
    },
    [addFolder, pendingSplits, setImportProgress]
  );

  const currentSplit = pendingSplits[0];

  return (
    <div className="flex flex-col h-full min-h-0">
      {currentSplit && (
        <CameraSplitDialog
          key={currentSplit.from}
          folder={currentSplit.from}
          candidates={currentSplit.candidates}
          onConfirm={(chosen) => void resolveSplit("confirm", chosen as DroppedGroup[])}
          onMergeAll={() => void resolveSplit("merge")}
          onCancel={() => void resolveSplit("cancel")}
        />
      )}

      <div className="flex items-center px-3 h-9 border-b border-line flex-shrink-0">
        <span className="text-[12px] font-medium text-ink truncate">{t.media.treeTitle}</span>
      </div>

      {warning && (
        <div
          className="status-pill pill-warning m-2 cursor-pointer flex-shrink-0"
          onClick={() => setWarning(null)}
        >
          {warning}
        </div>
      )}

      <div
        className={`flex-1 min-h-0 transition-colors ${
          isDragOver && syncGroups.length > 0 ? "bg-accent/5" : ""
        }`}
        onDragOver={(e) => e.preventDefault()}
      >
        {syncGroups.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3">
            <IconAlertCircle size={20} className="text-ink-3" />
            <p className="text-[12px] text-ink-3 text-center px-6">{t.groups.dropHint}</p>
            {/* Espaço pra crescer: no futuro divide a linha com "Importar PRPROJ/
                AVB/DRT" — por enquanto só a criação de grupo. */}
            <div className="flex items-center gap-2">
              <button className="tbtn primary gap-1" onClick={newGroup} disabled={isBusy}>
                <IconPlus size={12} />
                {t.groups.createGroup}
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-y-auto h-full">
            {syncGroups.map((g) => (
              <GroupNode key={g.id} group={g} countOf={countOf} onAddSource={pickSource} />
            ))}
          </div>
        )}
      </div>

      {syncGroups.length > 0 && (
        <div className="flex-shrink-0 border-t border-line p-1.5">
          <button
            className="tbtn w-full justify-center gap-1"
            onClick={newGroup}
            disabled={isBusy}
          >
            <IconPlus size={12} />
            {t.groups.newGroup}
          </button>
        </div>
      )}
    </div>
  );
}
