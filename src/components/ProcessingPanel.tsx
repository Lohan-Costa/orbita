import { IconLoader2 } from "@tabler/icons-react";
import { useAppStore } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";

/**
 * O que o app está fazendo AGORA — no meio da timeline, não escondido no rodapé.
 *
 * A barra de status é uma linha de 11px na borda de baixo da janela: para um
 * processo que leva minutos e lê dezenas de GB, ela é pequena demais para
 * responder a pergunta que o usuário de fato faz, que é "isto travou?". Um
 * painel no CENTRO, no lugar onde a timeline vai nascer, responde sozinho —
 * inclusive porque tem um spinner que se move (uma barra parada em 0% ainda
 * parece travamento; um spinner girando, não).
 *
 * As três fases têm pesos MUITO diferentes e o texto tem de dizer qual é:
 *   - leitura de metadados  → rápida, mas serial e no HD do usuário
 *   - sync                  → o trabalho de verdade, um clipe por vez
 *   - formas de onda        → segundo plano, DEPOIS do sync já ter respondido
 */

export interface ProcessingState {
  /**
   * Qual fase é. A barra de status precisa distinguir: `waveforms` roda DEPOIS
   * do sync já ter respondido, então ela não pode engolir o resumo ("N tomadas
   * sincronizadas · M para revisar") — o resumo aparece, e o passe entra como
   * segmento secundário. As outras fases, sim, são o estado corrente.
   */
  kind: "reading" | "starting" | "syncing" | "waveforms";
  /** Título da fase — o que está acontecendo, em palavras. */
  title: string;
  /** Detalhe: normalmente o arquivo da vez. */
  detail?: string;
  current?: number;
  total?: number;
}

/**
 * A fase em curso, ou `null` quando não há processamento nenhum.
 *
 * Um dono só para esta conta: a barra de status e o painel da timeline mostram
 * a MESMA coisa em tamanhos diferentes, e duas leituras do mesmo estado é uma
 * que um dia diverge — o rodapé dizendo uma fase e o meio da tela, outra.
 */
export function useProcessingState(): ProcessingState | null {
  const t = useI18n();
  const { appStatus, clips, syncProgress, peaksProgress, importProgress } =
    useAppStore();

  const loading = clips.filter((c) => c.status === "loading").length;

  /** O LOTE em curso — não o projeto. Ver `importProgress` na store. */
  const reading = (): ProcessingState => ({
    kind: "reading",
    title: t.processing.reading,
    detail: t.processing.readingHint,
    current: importProgress?.done,
    total: importProgress?.total,
  });

  if (appStatus === "running") {
    if (syncProgress && syncProgress.total > 0) {
      return {
        kind: "syncing",
        title: t.processing.syncing,
        detail: syncProgress.message || undefined,
        current: syncProgress.current,
        total: syncProgress.total,
      };
    }
    // Ainda sem evento nenhum do sidecar. Ou ele está subindo o motor, ou o
    // comando está na FILA atrás da leitura de metadados — e dizer qual dos dois
    // é a diferença entre "está trabalhando" e "travou".
    if (loading > 0) {
      return reading();
    }
    return {
      kind: "starting",
      title: t.processing.starting,
      detail: t.processing.startingHint,
    };
  }

  if (loading > 0) {
    return reading();
  }

  if (peaksProgress) {
    return {
      kind: "waveforms",
      title: t.processing.waveforms,
      detail: t.processing.waveformsHint,
      current: peaksProgress.done,
      total: peaksProgress.total,
    };
  }

  return null;
}

export function ProcessingPanel({ state }: { state: ProcessingState }) {
  const { title, detail, current, total } = state;
  // Sem total conhecido não há barra — uma barra parada em 0% mente sobre o
  // progresso; o spinner sozinho já diz "estou trabalhando".
  const pct =
    total && total > 0 ? Math.min(100, Math.round(((current ?? 0) / total) * 100)) : null;

  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-[380px] px-6">
      <div className="flex items-center gap-2">
        <IconLoader2 size={16} className="text-accent animate-spin" />
        <span className="text-[13px] font-medium text-ink">{title}</span>
      </div>

      {pct !== null && (
        <div className="w-full flex flex-col gap-1">
          <div className="h-[4px] w-full rounded-full bg-surface-3 overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-ink-3 tabular-nums">
            <span>
              {current} / {total}
            </span>
            <span>{pct}%</span>
          </div>
        </div>
      )}

      {detail && (
        <p className="text-[11px] text-ink-3 text-center truncate w-full" title={detail}>
          {detail}
        </p>
      )}
    </div>
  );
}
