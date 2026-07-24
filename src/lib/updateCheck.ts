import { REPO_RELEASES_API_URL } from "./links";

/** Os 3 estados que a UI distingue: em dia (nada a mostrar), atrasado (link
 *  de download) e falha de checagem (ex.: sem internet — não sabemos se está
 *  em dia ou não, e isso precisa ficar visualmente diferente de "em dia"). */
export type UpdateStatus =
  | { kind: "up-to-date" }
  | { kind: "outdated"; version: string; url: string }
  | { kind: "error" };

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(remote: string, current: string): boolean {
  const r = parseSemver(remote);
  const c = parseSemver(current);
  if (!r || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > c[i]) return true;
    if (r[i] < c[i]) return false;
  }
  return false;
}

/**
 * Compara a versão instalada contra o release mais recente do GitHub.
 *
 * Usa a LISTA de releases (não `/releases/latest`): todo release do Alpha
 * nasce marcado `prerelease: true` (ver release.yml), e esse endpoint
 * IGNORA prerelease — retornaria 404 pra sempre. O primeiro item da lista já
 * vem ordenado por data de criação, então é o mais recente.
 *
 * `error` cobre tanto falha de rede quanto resposta inesperada da API — a UI
 * trata os dois do mesmo jeito (amarelo: "não sei se está em dia"), então não
 * precisam de estados distintos aqui.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateStatus> {
  try {
    const res = await fetch(REPO_RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { kind: "error" };

    const releases: Array<{ tag_name?: string; html_url?: string; draft?: boolean }> =
      await res.json();
    const latest = releases.find((r) => !r.draft && r.tag_name);
    if (!latest?.tag_name || !latest.html_url) return { kind: "error" };

    if (!isNewer(latest.tag_name, currentVersion)) return { kind: "up-to-date" };
    return { kind: "outdated", version: latest.tag_name.replace(/^v/, ""), url: latest.html_url };
  } catch {
    return { kind: "error" };
  }
}
