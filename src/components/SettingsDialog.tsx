import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconFolder, IconTrash, IconExternalLink } from "@tabler/icons-react";
import { useI18n } from "../hooks/useI18n";
import { formatBytes } from "../lib/clipFormat";

/**
 * A janela de CONFIGURAÇÕES. Hoje só cache e logs; é o lugar onde as próximas
 * opções entram sem cada uma virar um botão solto na barra.
 *
 * A resolução de reprodução NÃO mora aqui — é um controle de VISUALIZAÇÃO
 * (à la Premiere), de efeito imediato, então vive no próprio Monitor (ver
 * `Monitor.tsx`), não atrás de um "Salvar" que o usuário pode nunca apertar.
 *
 * O estado NÃO vive na store do app: nada aqui participa do sync, e uma cópia
 * na store seria uma segunda fonte de verdade sobre o que já está gravado em
 * disco pelo sidecar. A janela lê ao abrir e escreve ao salvar — Cancelar
 * simplesmente descarta.
 *
 * ⚠️ LIMPAR O CACHE é IMEDIATO e não espera o Salvar. Não é uma preferência, é
 * uma AÇÃO: pôr uma ação destrutiva atrás de um "Salvar" (que o usuário pode
 * nunca apertar) esconde se ela aconteceu ou não.
 */

interface CacheStats {
  dir: string;
  default_dir: string;
  bytes: number;
  files: number;
}

interface Settings {
  cache_dir: string | null;
  cache_max_mb: number;
  logs_dir: string;
  cache: CacheStats;
}

/** Opções de teto. Números redondos em vez de um campo livre: o valor exato não
 *  importa, e um campo livre convida a digitar "0" (que apagaria tudo sempre). */
const MAX_OPTIONS_MB = [1024, 2048, 5120, 10240, 20480, 51200];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n();

  const [loaded, setLoaded] = useState<Settings | null>(null);
  const [cacheDir, setCacheDir] = useState<string | null>(null);
  const [maxMb, setMaxMb] = useState(5120);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await invoke<Settings>("sidecar_call", {
      command: "get_settings",
      params: {},
    });
    setLoaded(s);
    setCacheDir(s.cache_dir);
    setMaxMb(s.cache_max_mb);
    setStats(s.cache);
  }, []);

  useEffect(() => {
    // Um erro aqui NÃO pode ser silencioso: engolindo-o, a janela abria com o
    // caminho em branco e "Cache vazio", o que parece um cache vazio de verdade
    // em vez de "não consegui perguntar ao sidecar".
    void refresh().catch((e) => {
      setLoaded(null);
      setError(String(e));
    });
  }, [refresh]);

  // Esc fecha, como em qualquer diálogo do sistema.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chooseFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setCacheDir(dir);
  };

  const clearCache = async () => {
    setBusy(true);
    setFreed(null);
    try {
      const r = await invoke<{ bytes: number; files: number; cache: CacheStats }>(
        "sidecar_call",
        { command: "cache_clear", params: {} }
      );
      setStats(r.cache);
      setFreed(r.bytes);
    } catch {
      /* limpar cache nunca é crítico — o pior caso é o cache continuar lá */
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await invoke("sidecar_call", {
        command: "set_settings",
        params: { cache_dir: cacheDir, cache_max_mb: maxMb },
      });
      onClose();
    } catch {
      setBusy(false);
    }
  };

  /** O local mudou em relação ao que está gravado? O cache antigo NÃO vem junto,
   *  e o usuário precisa saber disso antes de salvar, não depois. */
  const dirChanged = loaded !== null && (cacheDir ?? null) !== (loaded.cache_dir ?? null);
  const effectiveDir = cacheDir ?? stats?.default_dir ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-line rounded-lg shadow-xl w-[520px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-line">
          <div className="text-[13px] font-medium text-ink">{t.settings.title}</div>
        </div>

        <div className="p-4 flex flex-col gap-5">
          {error && (
            <div className="status-pill pill-error !text-[11px] !py-1.5 !px-2">
              {t.settings.loadError}
              <span className="block text-[10px] opacity-80 mt-0.5 font-mono">{error}</span>
            </div>
          )}

          {/* ── Cache ────────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <span className="panel-title">{t.settings.cacheSection}</span>
            <p className="text-[10px] text-ink-3 leading-snug">{t.settings.cacheHint}</p>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-2">{t.settings.cacheLocation}</span>
              <div className="flex items-center gap-2">
                <button className="tbtn gap-1.5 flex-shrink-0" onClick={() => void chooseFolder()}>
                  <IconFolder size={12} />
                  {t.settings.chooseFolder}
                </button>
                {cacheDir && (
                  <button className="tbtn flex-shrink-0" onClick={() => setCacheDir(null)}>
                    {t.settings.useDefault}
                  </button>
                )}
                {/* `min-w-0` é load-bearing: `truncate` zera a largura mínima
                    automática do item flex, e sem ele o caminho encolhia até
                    sumir por completo em vez de truncar. */}
                <span
                  className="flex-1 min-w-0 text-[10px] text-ink-2 truncate font-mono select-text"
                  title={effectiveDir}
                >
                  {effectiveDir}
                </span>
              </div>
              {dirChanged && (
                <span className="text-[10px] text-ink-warning">{t.settings.movedHint}</span>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11px] text-ink-2 flex-1">
                {stats && stats.files > 0
                  ? t.settings.cacheUsage
                      .replace("{{size}}", formatBytes(stats.bytes))
                      .replace("{{files}}", String(stats.files))
                  : t.settings.cacheEmpty}
                {freed !== null && (
                  <span className="text-ink-success ml-2">
                    {t.settings.cleared.replace("{{size}}", formatBytes(freed))}
                  </span>
                )}
              </span>
              {/* ⚠️ Limpar age no diretório SALVO — o `cache_clear` do sidecar lê
                  a configuração em disco, não o que está pendente na tela. Com um
                  local novo escolhido e não salvo, o botão apagaria um diretório
                  DIFERENTE do que o painel está exibindo. */}
              <button
                className="tbtn danger gap-1.5 flex-shrink-0"
                onClick={() => void clearCache()}
                disabled={busy || !stats || stats.files === 0 || dirChanged}
                title={dirChanged ? t.settings.clearBlockedByMove : undefined}
              >
                <IconTrash size={12} />
                {busy ? t.settings.clearing : t.settings.clearCache}
              </button>
            </div>

            <label className="flex flex-col gap-1 pt-1">
              <span className="text-[11px] text-ink-2">{t.settings.cacheMax}</span>
              <select
                className="field w-[160px]"
                value={maxMb}
                onChange={(e) => setMaxMb(Number(e.target.value))}
              >
                {MAX_OPTIONS_MB.map((mb) => (
                  <option key={mb} value={mb}>
                    {formatBytes(mb * 1024 * 1024)}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-ink-3 leading-snug">
                {t.settings.cacheMaxHint}
              </span>
            </label>
          </div>

          {/* ── Logs ─────────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <span className="panel-title">{t.settings.logsSection}</span>
            <p className="text-[10px] text-ink-3 leading-snug">{t.settings.logsHint}</p>
            <button
              className="tbtn gap-1.5 self-start"
              onClick={() => loaded && void openPath(loaded.logs_dir)}
              disabled={!loaded}
            >
              <IconExternalLink size={12} />
              {t.settings.openLogs}
            </button>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-line flex justify-end gap-2">
          <button className="tbtn" onClick={onClose}>
            {t.settings.cancel}
          </button>
          <button
            className="tbtn primary"
            onClick={() => void save()}
            disabled={busy || !loaded}
          >
            {t.settings.save}
          </button>
        </div>
      </div>
    </div>
  );
}
