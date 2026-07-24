import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  IconVideoFilled,
  IconMicrophoneFilled,
  IconX,
  IconScissors,
  IconLoader2,
  IconFolders,
  IconArrowRight,
  IconVideoPlus,
} from "@tabler/icons-react";
import {
  useAppStore,
  type Clip,
  type Source,
  type SyncGroup,
} from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { formatFps, formatDuration, sourceColor } from "../lib/clipFormat";

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
  fps: "w-[46px]",
  start: "w-[92px]",
  dur: "w-[92px]",
  audio: "w-[64px]",
} as const;

/** Piso de largura da tabela (soma das colunas + nome mínimo + espaçamentos) —
 *  abaixo disto o painel ganha scroll horizontal em vez de espremer o texto. */
const TABLE_MIN_WIDTH = 560;

// ── Cabeçalho das colunas ─────────────────────────────────────────────────────

function ColumnHeader() {
  const t = useI18n();
  return (
    <div
      className="flex items-center gap-2 pl-2.5 pr-3 py-1 border-l-2 border-l-transparent bg-surface-2 border-b border-line text-[10px] uppercase tracking-wide text-ink-3 sticky top-0 z-[2]"
      style={{ minWidth: TABLE_MIN_WIDTH }}
    >
      <span className="w-[13px] flex-shrink-0" />
      <span className="flex-1 min-w-[160px]">{t.media.colName}</span>
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
  source,
  hue,
  selected,
  onSelect,
}: {
  clip: Clip;
  source: Source;
  hue?: number;
  selected: boolean;
  onSelect: (e: ReactMouseEvent) => void;
}) {
  const t = useI18n();
  const removeClip = useAppStore((s) => s.removeClip);
  const setPreviewClip = useAppStore((s) => s.setPreviewClip);

  const Icon = source.kind === "camera" ? IconVideoFilled : IconMicrophoneFilled;
  const color = sourceColor(source.kind, hue);

  return (
    <div
      className={`flex items-center gap-2 pl-2.5 pr-3 py-1 border-b border-line last:border-b-0 group cursor-pointer border-l-2 ${
        selected ? "border-l-accent" : "border-l-transparent hover:bg-surface-2"
      }`}
      style={{
        minWidth: TABLE_MIN_WIDTH,
        // Fundo tingido pela cor da fonte (mesma da Timeline) — só pra pontuar
        // a seleção, no mesmo peso visual do cinza do hover.
        backgroundColor: selected ? `color-mix(in srgb, ${color} 14%, white)` : undefined,
      }}
      onClick={onSelect}
      onDoubleClick={() => {
        if (clip.status === "error") return;
        setPreviewClip({ path: clip.path, name: clip.name });
      }}
      title={t.media.previewHint}
    >
      <Icon size={13} style={{ color }} className="flex-shrink-0" />
      <span className="flex-1 min-w-[160px] text-ink truncate font-mono text-[11px]" title={clip.path}>
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
    addSource,
    moveClipsToSource,
  } = useAppStore();

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [moveMenu, setMoveMenu] = useState(false);
  /** Âncora do último clique simples/shift, pra range-select — como um Finder. */
  const lastClickedPathRef = useRef<string | null>(null);

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

  /** Posição de cada fonte-câmera na diária — a MESMA conta da Timeline
   *  (`hue: result.camera_groups.findIndex(...)`), pra CAM B ter a mesma cor
   *  no bin e na track. Som não entra: fica sempre no verde de referência. */
  const cameraHueOf = useMemo(() => {
    const by = new Map<string, number>();
    if (!group) return by;
    let i = 0;
    for (const s of group.sources) {
      if (s.kind === "camera") by.set(s.id, i++);
    }
    return by;
  }, [group]);

  /** As seções (fonte → arquivos) que este nó mostra. Uma seção só quando é um
   *  GRUPO (que tem várias fontes); ângulo/cena têm uma "seção" só. Sem divisor
   *  visual entre fontes — a cor do ícone (ver `sourceColor`) já comunica de
   *  qual fonte é cada arquivo. */
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

    const hueOf = (src: Source) => cameraHueOf.get(src.id);

    if (sel.kind === "source") {
      const src = group.sources.find((s) => s.id === sel.refId);
      return src ? [{ source: src, hue: hueOf(src), clips: bySource.get(src.id) ?? [] }] : [];
    }
    if (sel.kind === "subgroup") {
      const sg = group.subGroups.find((s) => s.id === sel.refId);
      const paths = new Set(sg?.paths ?? []);
      return group.sources
        .map((src) => ({
          source: src,
          hue: hueOf(src),
          clips: (bySource.get(src.id) ?? []).filter((c) => paths.has(c.path)),
        }))
        .filter((s) => s.clips.length > 0);
    }
    // grupo: todas as fontes (mesmo as vazias — a fonte existe).
    return group.sources.map((src) => ({
      source: src,
      hue: hueOf(src),
      clips: bySource.get(src.id) ?? [],
    }));
  }, [group, sel, clips, cameraHueOf]);

  /** Ordem visível das linhas, pra resolver o intervalo de um shift-clique. */
  const flatPaths = useMemo(
    () => sections.flatMap((s) => s.clips.map((c) => c.path)),
    [sections]
  );

  /**
   * Clique simples SUBSTITUI a seleção por só este item (como um arquivo no
   * Finder) — não acumula. Cmd/Ctrl+clique alterna este item na seleção sem
   * mexer no resto. Shift+clique seleciona o intervalo a partir do último
   * clique simples/shift (sem mover a âncora, pra poder repetir o shift a
   * partir do mesmo ponto).
   */
  const selectClip = (path: string, e: ReactMouseEvent) => {
    if (e.shiftKey && lastClickedPathRef.current) {
      const from = flatPaths.indexOf(lastClickedPathRef.current);
      const to = flatPaths.indexOf(path);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelectedPaths(new Set(flatPaths.slice(lo, hi + 1)));
        return;
      }
    }

    if (e.metaKey || e.ctrlKey) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.has(path) ? next.delete(path) : next.add(path);
        return next;
      });
    } else {
      setSelectedPaths(new Set([path]));
    }
    lastClickedPathRef.current = path;
  };

  const title = useMemo(() => {
    if (!group || !sel) return "";
    if (sel.kind === "group") return group.name;
    if (sel.kind === "category") return t.media.subGroupsCategory;
    if (sel.kind === "source")
      return group.sources.find((s) => s.id === sel.refId)?.name ?? "";
    return group.subGroups.find((s) => s.id === sel.refId)?.name ?? "";
  }, [group, sel, t]);

  /**
   * Passa a seleção para outra câmera da MESMA diária — o conserto de quando a
   * detecção automática junta duas câmeras (a principal e o drone) numa fonte só.
   *
   * ⚠️ É um MENU, e não arrastar-e-soltar, de propósito: o `dragDropEnabled` do
   * Tauri (ligado, porque o app depende do drop nativo de PASTAS do Finder/
   * Explorer) impede o drag-and-drop HTML5 dentro da janela no Windows. Um gesto
   * que só funciona num dos dois SOs seria pior que um menu que funciona nos dois
   * (ver CLAUDE.md: o app não pode assumir um SO).
   */
  const moveSelectionTo = (sourceId: string) => {
    if (!group) return;
    moveClipsToSource(group.id, sourceId, [...selectedPaths]);
    setSelectedPaths(new Set());
    setMoveMenu(false);
  };

  /**
   * ⚠️ Os destinos são filtrados PELO TIPO do que está selecionado.
   *
   * `syncFilesFor` manda para o engine o `kind` da FONTE, não o do arquivo — então
   * arrastar clipes de vídeo para o "Som Direto" fazia `_is_camera()` devolver
   * False e os clipes sumirem das tracks de vídeo, virando som, sem aviso nenhum.
   * Um menu que oferece o destino errado é um convite a esse erro.
   *
   * O tipo do clipe é o mesmo critério do resto do app: tem fps → é câmera.
   */
  const selectionIsSound = useMemo(() => {
    const sel = clips.filter((c) => selectedPaths.has(c.path));
    return sel.length > 0 && sel.every((c) => c.fps == null);
  }, [clips, selectedPaths]);

  const moveTargets = useMemo(
    () =>
      (group?.sources ?? []).filter((src) =>
        selectionIsSound ? src.kind === "sound" : src.kind === "camera"
      ),
    [group, selectionIsSound]
  );

  const moveSelectionToNewCamera = () => {
    if (!group) return;
    const n = group.sources.filter((s) => s.kind === "camera").length + 1;
    const id = addSource(group.id, t.groups.cameraDefault.replace("{{n}}", String(n)));
    moveSelectionTo(id);
  };

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

            {/* Mover para outra câmera desta diária */}
            <div className="relative ml-auto flex-shrink-0">
              <button
                className="tbtn gap-1"
                onClick={() => setMoveMenu((v) => !v)}
                title={t.media.moveToHint}
              >
                <IconArrowRight size={12} />
                {t.media.moveTo}
              </button>
              {moveMenu && (
                <>
                  {/* Clicar fora fecha — sem isto o menu fica preso aberto. */}
                  <div className="fixed inset-0 z-10" onClick={() => setMoveMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-surface border border-line rounded-md shadow-lg py-1">
                    {moveTargets.map((src) => (
                      <button
                        key={src.id}
                        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-ink-2 hover:bg-surface-2"
                        onClick={() => moveSelectionTo(src.id)}
                      >
                        {src.kind === "camera" ? (
                          <IconVideoFilled size={12} className="flex-shrink-0" />
                        ) : (
                          <IconMicrophoneFilled size={12} className="flex-shrink-0" />
                        )}
                        <span className="truncate">{src.name}</span>
                      </button>
                    ))}
                    {!selectionIsSound && (
                      <>
                        {moveTargets.length > 0 && (
                          <div className="my-1 border-t border-line" />
                        )}
                        <button
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-ink hover:bg-surface-2"
                          onClick={moveSelectionToNewCamera}
                        >
                          <IconVideoPlus size={12} className="flex-shrink-0" />
                          {t.media.newCamera}
                        </button>
                      </>
                    )}
                    {selectionIsSound && moveTargets.length === 0 && (
                      <div className="px-2.5 py-1.5 text-[10px] text-ink-3">
                        {t.media.noMoveTarget}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <button className="tbtn gap-1 flex-shrink-0" onClick={makeScene}>
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
                {s.clips.map((c) => (
                  <FileRow
                    key={c.id}
                    clip={c}
                    source={s.source}
                    hue={s.hue}
                    selected={selectedPaths.has(c.path)}
                    onSelect={(e) => selectClip(c.path, e)}
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
