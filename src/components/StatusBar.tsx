import { IconBug } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { FEEDBACK_FORM_URL } from "../lib/links";
import { APP_VERSION } from "../lib/version";

/** Perfil do autor. Um NOME PRÓPRIO não é string traduzível — pela mesma razão que
 *  "Premiere Pro" e "Avid" não são. */
const AUTHOR = "Lohan Costa, edt.";
const AUTHOR_URL = "https://www.linkedin.com/in/lohan-costa/";

/**
 * A assinatura — mora na barra de status, e não numa faixa própria.
 *
 * Uma linha a mais custaria ~28 px de altura PARA SEMPRE, numa ferramenta em que a
 * timeline briga por cada pixel vertical. Aqui o crédito fica permanente e visível
 * sem tirar nada de ninguém.
 *
 * O link abre no NAVEGADOR (`openUrl` do Tauri), não no WebView: um `<a href>` comum
 * navegaria a janela do app para o LinkedIn, e o usuário ficaria preso lá dentro, sem
 * botão de voltar.
 */
function Signature() {
  const t = useI18n();

  return (
    <span className="text-[11px] text-ink-3 flex-shrink-0">
      {t.footer.by}{" "}
      <button
        className="underline underline-offset-2 hover:text-ink-2 transition-colors"
        onClick={() => void openUrl(AUTHOR_URL)}
        title={t.footer.authorLink}
      >
        {AUTHOR}
      </button>
      <span className="mx-1.5 text-line">·</span>
      {t.footer.builtWith}
    </span>
  );
}

export function StatusBar() {
  const t = useI18n();
  const { appStatus, statusMessage, clips, syncProgress } = useAppStore();

  let message: string;
  let colorClass = "text-ink-3";

  if (appStatus === "running") {
    // Progresso ao vivo do sidecar, quando disponível — cai para o texto
    // genérico enquanto nenhum evento chegou ainda.
    if (syncProgress && syncProgress.total > 0) {
      const counter = t.sync.progress
        .replace("{{current}}", String(syncProgress.current))
        .replace("{{total}}", String(syncProgress.total));
      message = syncProgress.message
        ? `${counter} — ${syncProgress.message}`
        : counter;
    } else {
      message = t.sync.running;
    }
    colorClass = "text-ink-2";
  } else if (appStatus === "success") {
    message = statusMessage || t.sync.success;
    colorClass = "text-ink-success";
  } else if (appStatus === "error") {
    message = statusMessage || t.sync.error;
    colorClass = "text-ink-danger";
  } else {
    const ready = clips.filter((c) => c.status === "ready");
    if (ready.length >= 2) {
      message = t.sync.statusReady.replace("{{n}}", String(ready.length));
      colorClass = "text-ink-2";
    } else {
      message = t.sync.statusIdle;
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 h-7 bg-surface-2 border-t border-line flex-shrink-0">
      {/* `truncate` + `min-w-0`: uma mensagem de erro longa encolhe, mas nunca empurra
          a assinatura para fora da tela. */}
      <span className={`text-[11px] truncate min-w-0 ${colorClass}`}>{message}</span>

      <div className="ml-auto flex items-center gap-3 flex-shrink-0">
        <button
          className="tbtn gap-1 py-0.5"
          onClick={() => void openUrl(FEEDBACK_FORM_URL)}
          title={t.footer.reportBugHint}
        >
          <IconBug size={11} />
          {t.footer.reportBug}
        </button>
        <span className="text-[11px] text-ink-3">
          {t.footer.version.replace("{{version}}", APP_VERSION)}
        </span>
        <Signature />
      </div>
    </div>
  );
}
