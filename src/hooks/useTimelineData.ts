import { useMemo } from "react";
import { useActiveGroup, useActiveSubGroup, useAppStore } from "../store/appStore";
import { useI18n } from "./useI18n";
import { buildTimeline, buildLiveTimeline, type TimelineData } from "../types/timeline";

/**
 * Os dados que a timeline desenha — e que o monitor também precisa, para saber
 * qual arquivo está no ar sob a agulha.
 *
 * Vive num hook para que timeline e monitor leiam exatamente a MESMA construção:
 * se cada um montasse a sua, a posição de um clipe poderia divergir entre o que
 * se vê e o que se toca.
 *
 * NÃO recebe parâmetro, e é de propósito: ele lê o ESCOPO ATIVO da store. Passar o
 * escopo por prop reabriria a porta para a timeline e o monitor estarem olhando
 * diárias diferentes — que é exatamente o que este hook existe para impedir.
 */
/**
 * Cache de UMA entrada, compartilhado por todos os consumidores do hook.
 *
 * `useMemo` memoiza por INSTÂNCIA de componente — e com três consumidores
 * (timeline, monitor, ações da seleção) a mesma montagem rodava três vezes a
 * cada sync, arrasto ou correção manual, sobre todas as câmeras e tomadas da
 * diária. Como as dependências são idênticas nos três (o hook lê o escopo ativo
 * da store, sem parâmetro), um cache de uma entrada já colapsa tudo para uma
 * montagem só.
 *
 * Uma entrada basta: os três leem o MESMO escopo, por construção — é justamente
 * o que este hook existe para garantir.
 */
let cacheKey: readonly unknown[] | null = null;
let cacheValue: TimelineData | null = null;

function memoized(deps: readonly unknown[], build: () => TimelineData | null) {
  if (cacheKey && cacheKey.length === deps.length && cacheKey.every((d, i) => d === deps[i])) {
    return cacheValue;
  }
  cacheKey = deps;
  cacheValue = build();
  return cacheValue;
}

export function useTimelineData(): TimelineData | null {
  const t = useI18n();
  const group = useActiveGroup();
  const subGroup = useActiveSubGroup();
  const {
    projectStartTcFrames,
    liveClips,
    liveSounds,
    liveGroups,
    liveVersion,
  } = useAppStore();

  const syncResult = group?.result ?? null;
  const groupId = group?.id ?? "";
  const subPaths = subGroup?.paths;

  return useMemo(
    () =>
      memoized(
        [syncResult, groupId, subPaths, projectStartTcFrames, liveVersion,
         t.timeline.soundTrack],
        () => {
          // O recorte da cena entra AQUI, e não nos mutadores: o sub-grupo é uma
          // vista, e uma vista não é destino de escrita. Durante o sync não há
          // recorte — o resultado ainda está se formando, e esconder metade dele
          // não ajudaria ninguém.
          if (syncResult)
            return buildTimeline(
              syncResult, t.timeline.soundTrack, projectStartTcFrames, groupId,
              subPaths ? new Set(subPaths) : undefined
            );
          if (liveClips.size > 0 || liveSounds.size > 0)
            return buildLiveTimeline(
              liveClips, liveSounds, liveGroups, t.timeline.soundTrack,
              projectStartTcFrames, groupId
            );
          return null;
        }
      ),
    // liveVersion é o gatilho: liveClips/liveSounds são Maps mutados no lugar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [syncResult, groupId, subPaths, projectStartTcFrames, liveVersion,
     t.timeline.soundTrack]
  );
}
