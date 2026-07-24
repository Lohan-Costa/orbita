import { IconAlertTriangle, IconBrandGithub } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { useUpdateCheck } from "../hooks/useUpdateCheck";
import { FEEDBACK_FORM_URL, REPO_URL } from "../lib/links";

/**
 * Aviso de fase Alpha — toda vez que o app abre (sem persistência: reabrir É o
 * lembrete). Não fecha ao clicar fora, de propósito: é preciso ler e confirmar.
 *
 * A checagem de atualização mora AQUI dentro (em vez de um popup próprio) por
 * isso mesmo: este aviso já aparece toda abertura, então é o lugar natural pra
 * surfacear "tem versão nova" sem introduzir uma segunda interrupção. Só
 * aparece quando há algo a fazer (`outdated`) — em dia/checando/erro de rede
 * ficam em silêncio aqui (o rodapé já cobre esses casos, permanentemente).
 */
export function AlphaNotice() {
  const t = useI18n();
  const update = useUpdateCheck();
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-line rounded-lg shadow-xl w-[420px] flex flex-col">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <IconAlertTriangle size={16} className="text-ink-warning flex-shrink-0" />
          <span className="text-[13px] font-medium text-ink">{t.alpha.title}</span>
        </div>

        <div className="p-4 flex flex-col gap-2">
          <p className="text-[12px] text-ink-2 leading-relaxed">{t.alpha.body}</p>
          <p className="text-[12px] text-ink-2 leading-relaxed">{t.alpha.feedbackHint}</p>
          <p className="text-[12px] text-ink-2 leading-relaxed">
            {t.alpha.roadmapHint}{" "}
            <button
              className="underline underline-offset-2 hover:text-ink transition-colors inline-flex items-center gap-1"
              onClick={() => void openUrl(REPO_URL)}
            >
              <IconBrandGithub size={13} />
              {t.alpha.roadmapLink}
            </button>
          </p>

          {update?.kind === "outdated" && (
            <div className="rounded-md border border-line-danger bg-surface-danger px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-[12px] text-ink-danger">
                {t.alpha.updateAvailable.replace("{{version}}", update.version)}
              </span>
              <button
                className="tbtn gap-1.5 flex-shrink-0"
                onClick={() => void openUrl(update.url)}
              >
                {t.alpha.updateAvailableLink}
              </button>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-line flex justify-end gap-2">
          <button className="tbtn gap-1.5" onClick={() => void openUrl(FEEDBACK_FORM_URL)}>
            {t.alpha.reportButton}
          </button>
          <button className="tbtn primary gap-1.5" onClick={() => setOpen(false)}>
            {t.alpha.dismiss}
          </button>
        </div>
      </div>
    </div>
  );
}
