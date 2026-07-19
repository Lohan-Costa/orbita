import { useEffect, useMemo, useState } from "react";
import {
  IconVideo,
  IconMicrophone,
  IconX,
  IconScissors,
  IconLoader2,
  IconFolders,
} from "@tabler/icons-react";
import {
  useAppStore,
  type Clip,
  type Source,
  type SyncGroup,
} from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { formatFps, formatDuration } from "../lib/clipFormat";

/**
 * O painel de CONTEÚDO — a mídia do nó selecionado na árvore (ver `browseSelection`),
 * numa tabela de colunas informativas (Nome, FPS, Início, Duração, Áudio), no espírito
 * do bin do Media Composer.
 *
 *   grupo    → todas as mídias da diária, agrupadas por fonte
 *   ângulo   → só as mídias daquela fonte
 *   cena     → só os arquivos que compõem a cena
 *   categoria "Sub-grupos" → a lista das cenas do grupo
 *
 * É a metade "detalhe" do mestre-detalhe: a árvore navega, aqui se inspeciona. E é
 * AQUI que uma cena também pode nascer — selecionar arquivos e agrupá-los.
 */

const COL = {
  fps: "w-[56px]",
  start: "w-[92px]",
  dur: "w-[92px]",
  audio: "w-[64px]",
} as const;

// ── Cabeçalho das colunas ─────────────────────────────────────────────────────

function ColumnHeader() {
  const t = useI18n();
  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-surface-2 border-b border-line text-[10px] uppercase tracking-wide text-ink-3 sticky top-0 z-[2]">
      <span className="w-[13px] flex-shrink-0" />
      <span className="flex-1">{t.media.colName}</span>
      <span className={`${COL.fps} text-right flex-shrink-0`}>{t.media.colFps}</span>
      <span className={`${COL.start} text-right flex-shrink-0`}>{t.media.colStart}</span>
      <span className={`${COL.dur} text-right flex-shrink-0`}>{t.media.colDuration}</span>
      <span className={`${COL.audio} text-right flex-shrink-0`}>{t.media.colAudio}</span>
      <span className="w-[16px] flex-shrink-0" />
    </div>
  );
}

// ── Uma linha de arquivo ──────────────────────────────────────────────────────

function FileRow({
  clip,
  selected,
  onToggle,
}: {
  clip: Clip;
  selected: boolean;
  onToggle: () => void;
}) {
  const t = useI18n();
  const removeClip = useAppStore((s) => s.removeClip);

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 border-b border-line last:border-b-0 group cursor-pointer ${
        selected ? "bg-accent/10" : "hover:bg-surface-2"
      }`}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        className="w-[13px] flex-shrink-0 accent-accent"
      />
      <span className="flex-1 text-ink truncate font-mono text-[11px]" title={clip.path}>
        {clip.name}
      </span>

      {clip.status === "loading" ? (
        <IconLoader2 size={12} className="text-ink-3 animate-spin flex-shrink-0" />
      ) : clip.status === "error" ? (
        <span className="status-pill pill-error flex-shrink-0" title={clip.error}>
          {t.sync.loadError}
        </span>
      ) : (
        <>
          <span className={`${COL.fps} text-right text-[11px] text-ink-3 font-mono flex-shrink-0`}>
            {formatFps(clip.fps)}
          </span>
          <span className={`${COL.start} text-right text-[11px] text-ink-3 font-mono flex-shrink-0`}>
            {clip.tcStart ?? "—"}
          </span>
          <span className={`${COL.dur} text-right text-[11px] text-ink-3 font-mono flex-shrink-0`}>
            {formatDuration(clip.durationMs, clip.fps)}
          </span>
          <span className={`${COL.audio} text-right text-[11px] text-ink-3 font-mono flex-shrink-0`}>
            {clip.sampleRate ?? "—"}
          </span>
        </>
      )}

      <button
        className="tbtn p-0.5 w-[16px] opacity-0 group-hover:opacity-100 flex-shrink-0"
        title={t.sync.remove}
        onClick={(e) => {
          e.stopPropagation();
          removeClip(clip.id);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}

// ── Divisor de fonte (só na vista de GRUPO, que tem várias) ───────────────────

function SourceDivider({ source, count }: { source: Source; count: number }) {
  const Icon = source.kind === "camera" ? IconVideo : IconMicrophone;
  return (
    <div className="flex items-center gap-1.5 px-3 py-0.5 bg-surface-2/60 border-b border-line">
      <Icon size={12} className="text-ink-3 flex-shrink-0" />
      <span className="text-[11px] text-ink-2 truncate">{source.name}</span>
      <span className="text-[10px] text-ink-3 flex-shrink-0 ml-auto">{count}</span>
    </div>
  );
}

// ── O painel ──────────────────────────────────────────────────────────────────

export function MediaContent() {
  const t = useI18n();
  const {
    clips,
    syncGroups,
    browseSelection,
    activeGroupId,
    setBrowseSelection,
    addSubGroup,
  } = useAppStore();

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());

  // A seleção EFETIVA: o que a árvore escolheu, ou (sem nada) o grupo ativo.
  const sel =
    browseSelection ??
    (activeGroupId ? { kind: "group" as const, groupId: activeGroupId } : null);

  const group: SyncGroup | null = sel
    ? syncGroups.find((g) => g.id === sel.groupId) ?? null
    : null;

  useEffect(() => {
    setSelectedPaths(new Set());
  }, [sel?.kind, sel?.groupId, sel?.refId]);

  const toggle = (path: string) =>
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  /** As seções (fonte → arquivos) que este nó mostra. Uma seção só quando é um
   *  GRUPO (que tem várias fontes); ângulo/cena têm uma "seção" sem divisor. */
  const sections = useMemo(() => {
    if (!group || !sel || sel.kind === "category") return [];
    const mine = clips.filter((c) => c.syncGroupId === group.id);
    const bySource = new Map<string, Clip[]>();
    for (const c of mine) {
      const list = bySource.get(c.sourceId);
      if (list) list.push(c);
      else bySource.set(c.sourceId, [c]);
    }
    for (const l of bySource.values()) l.sort((a, b) => a.sourceOrder - b.sourceOrder);

    if (sel.kind === "source") {
      const src = group.sources.find((s) => s.id === sel.refId);
      return src ? [{ source: src, clips: bySource.get(src.id) ?? [], divider: false }] : [];
    }
    if (sel.kind === "subgroup") {
      const sg = group.subGroups.find((s) => s.id === sel.refId);
      const paths = new Set(sg?.paths ?? []);
      return group.sources
        .map((src) => ({
          source: src,
          clips: (bySource.get(src.id) ?? []).filter((c) => paths.has(c.path)),
          divider: true,
        }))
        .filter((s) => s.clips.length > 0);
    }
    // grupo: todas as fontes, com divisor (mesmo as vazias — a fonte existe).
    return group.sources.map((src) => ({
      source: src,
      clips: bySource.get(src.id) ?? [],
      divider: true,
    }));
  }, [group, sel, clips]);

  const title = useMemo(() => {
    if (!group || !sel) return "";
    if (sel.kind === "group") return group.name;
    if (sel.kind === "category") return t.media.subGroupsCategory;
    if (sel.kind === "source")
      return group.sources.find((s) => s.id === sel.refId)?.name ?? "";
    return group.subGroups.find((s) => s.id === sel.refId)?.name ?? "";
  }, [group, sel, t]);

  const makeScene = () => {
    if (!group || selectedPaths.size === 0) return;
    addSubGroup(
      group.id,
      t.groups.subGroupDefault.replace("{{n}}", String(group.subGroups.length + 1)),
      [...selectedPaths]
    );
    setSelectedPaths(new Set());
  };

  if (!group || !sel) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-3">
        <IconFolders size={20} />
        <p className="text-[12px] text-center px-6">{t.media.contentEmpty}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Cabeçalho: o nó, e a ação de criar cena quando há arquivos marcados. */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line flex-shrink-0">
        <span className="text-[12px] font-medium text-ink truncate">{title}</span>
        {selectedPaths.size > 0 && (
          <>
            <span className="status-pill pill-muted flex-shrink-0">
              {t.media.selectedCount.replace("{{n}}", String(selectedPaths.size))}
            </span>
            <button className="tbtn gap-1 ml-auto flex-shrink-0" onClick={makeScene}>
              <IconScissors size={12} />
              {t.media.newSceneFromFiles}
            </button>
          </>
        )}
      </div>

      {/* Corpo: a categoria lista as cenas; o resto é a tabela de arquivos. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {sel.kind === "category" ? (
          group.subGroups.length === 0 ? (
            <div className="p-4 text-[12px] text-ink-3 text-center">{t.media.noScenes}</div>
          ) : (
            group.subGroups.map((sg) => (
              <button
                key={sg.id}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 border-b border-line hover:bg-surface-2 text-left"
                onClick={() =>
                  setBrowseSelection({ kind: "subgroup", groupId: group.id, refId: sg.id })
                }
              >
                <IconScissors size={12} className="text-ink-3 flex-shrink-0" />
                <span className="text-[12px] text-ink-2 truncate">{sg.name}</span>
                <span className="text-[11px] text-ink-3 flex-shrink-0 ml-auto">
                  {sg.paths.length}
                </span>
              </button>
            ))
          )
        ) : sections.every((s) => s.clips.length === 0) ? (
          <>
            <ColumnHeader />
            <div className="p-4 text-[12px] text-ink-3 text-center">{t.media.contentNoFiles}</div>
          </>
        ) : (
          <>
            <ColumnHeader />
            {sections.map((s) => (
              <div key={s.source.id}>
                {s.divider && sections.length > 1 && (
                  <SourceDivider source={s.source} count={s.clips.length} />
                )}
                {s.clips.map((c) => (
                  <FileRow
                    key={c.id}
                    clip={c}
                    selected={selectedPaths.has(c.path)}
                    onToggle={() => toggle(c.path)}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
