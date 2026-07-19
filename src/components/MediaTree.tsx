import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  IconCalendarEvent,
  IconScissors,
  IconFolders,
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

/** Retorno de `expand_dropped_paths` (Rust): uma pasta = uma fonte, recursivamente. */
interface DroppedGroup {
  group_id: string;
  group_name: string | null;
  files: string[];
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
      className={`flex items-center gap-1.5 pl-7 pr-2 py-1 border-b border-line group cursor-pointer ${
        browsed ? "bg-accent/15" : "hover:bg-surface-2"
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
      className={`flex items-center gap-1.5 pl-12 pr-2 py-1 cursor-pointer group ${
        browsed ? "bg-accent/15" : "hover:bg-surface-2"
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
      <input
        className="flex-1 min-w-0 bg-transparent text-[11px] text-ink outline-none focus:bg-surface rounded px-1"
        value={subGroup.name}
        onChange={(e) => renameSubGroup(group.id, subGroup.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
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
        className={`flex items-center gap-1.5 pl-7 pr-2 py-1 border-b border-line cursor-pointer ${
          browsed ? "bg-accent/15" : "hover:bg-surface-2"
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
        className={`flex items-center gap-1.5 px-2 py-1.5 bg-surface-2 group cursor-pointer ${
          browsed ? "ring-1 ring-inset ring-accent/40" : ""
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

        <IconCalendarEvent size={13} className="text-ink-3 flex-shrink-0" />

        <input
          className="flex-1 min-w-0 bg-transparent text-[12px] font-medium text-ink outline-none focus:bg-surface rounded px-1"
          value={group.name}
          onChange={(e) => renameGroup(group.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />

        <span className="text-[11px] text-ink-3 flex-shrink-0">
          {t.sync.cameraGroup.replace("{{n}}", String(total))}
        </span>

        {group.error && (
          <span className="status-pill pill-error flex-shrink-0" title={group.error}>
            {t.groups.failed}
          </span>
        )}

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
          <SubGroupsCategory group={group} />
        </>
      )}
    </div>
  );
}

// ── O painel ──────────────────────────────────────────────────────────────────

export function MediaTree() {
  const t = useI18n();
  const { clips, addClip, updateClip, appStatus, syncGroups, addSource, groupOwning } =
    useAppStore();
  const [isDragOver, setIsDragOver] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

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
      const sourceId = addSource(groupId, name, dropped.group_id);

      for (let i = 0; i < dropped.files.length; i++) {
        const path = dropped.files[i];
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

  const pickSource = useCallback(
    async (groupId: string) => {
      if (isBusy) return;
      const picked = await open({ directory: true, multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const groups = await invoke<DroppedGroup[]>("expand_dropped_paths", { paths });
      for (const g of groups) await addFolder(groupId, g);
    },
    [addFolder, isBusy]
  );

  const handleDrop = useCallback(
    async (paths: string[], position?: { x: number; y: number }) => {
      if (isBusy) return;
      let target: string | null = null;
      if (position) {
        const dpr = window.devicePixelRatio || 1;
        const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
        target =
          el?.closest("[data-sync-group-id]")?.getAttribute("data-sync-group-id") ?? null;
      }
      if (!target) {
        const gs = useAppStore.getState().syncGroups;
        target = gs.length > 0 ? gs[gs.length - 1].id : newGroup();
      }
      const groups = await invoke<DroppedGroup[]>("expand_dropped_paths", { paths });
      for (const g of groups) await addFolder(target, g);
    },
    [addFolder, newGroup, isBusy]
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <span className="panel-title">
          {t.sync.clips}
          {clips.length > 0 && (
            <span className="text-ink-3 font-normal">({clips.length})</span>
          )}
        </span>
        <button
          className="tbtn"
          onClick={newGroup}
          disabled={isBusy}
        >
          <IconPlus size={12} />
          {t.groups.newGroup}
        </button>
      </div>

      {warning && (
        <div
          className="status-pill pill-warning mb-2 cursor-pointer"
          onClick={() => setWarning(null)}
        >
          {warning}
        </div>
      )}

      <div
        className={`flex-1 min-h-0 border rounded-md overflow-hidden transition-colors ${
          isDragOver ? "border-accent bg-accent/5" : "border-line"
        }`}
        onDragOver={(e) => e.preventDefault()}
      >
        {syncGroups.length === 0 ? (
          <div
            className="h-full flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-surface-2 transition-colors"
            onClick={newGroup}
          >
            <IconAlertCircle size={20} className="text-ink-3" />
            <p className="text-[12px] text-ink-3 text-center px-6">{t.groups.dropHint}</p>
          </div>
        ) : (
          <div className="overflow-y-auto h-full">
            {syncGroups.map((g) => (
              <GroupNode key={g.id} group={g} countOf={countOf} onAddSource={pickSource} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
