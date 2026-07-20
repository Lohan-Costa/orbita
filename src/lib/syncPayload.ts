import type { Clip, SyncGroup } from "../store/appStore";

/** Um arquivo no formato que o sidecar espera — o mesmo para o comando "sync" e
 *  para o "resync" (Etapa D). */
export interface SyncFileEntry {
  path: string;
  group_id: string;
  group_order: number;
  source_name?: string;
  kind?: string;
}

/**
 * Os arquivos PRONTOS de uma diária, no formato que o sidecar espera.
 *
 * Um dono só para esta conta: o "sync" cheio (`SyncControls`) e o "resync" parcial
 * da seleção (`Timeline`) precisam do MESMO mapeamento `group_id`/`source_name`/
 * `kind` — duas implementações da mesma regra é uma que um dia diverge, e aí um
 * dos dois caminhos manda um payload que não bate com o que a árvore mostra.
 */
export function syncFilesFor(group: SyncGroup, clips: Clip[]): SyncFileEntry[] {
  const srcOf = new Map(group.sources.map((s) => [s.id, s]));
  return clips
    .filter((c) => c.status === "ready" && c.syncGroupId === group.id)
    .map((c) => ({
      path: c.path,
      group_id: c.sourceId,
      group_order: c.sourceOrder,
      source_name: srcOf.get(c.sourceId)?.name,
      kind: srcOf.get(c.sourceId)?.kind,
    }));
}
