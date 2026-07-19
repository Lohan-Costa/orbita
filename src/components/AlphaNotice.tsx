import { IconAlertTriangle } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { FEEDBACK_FORM_URL } from "../lib/links";

/** Aviso de fase Alpha — toda vez que o app abre (sem persistência: reabrir É o
 *  lembrete). Não fecha ao clicar fora, de propósito: é preciso ler e confirmar. */
export function AlphaNotice() {
  const t = useI18n();
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-line rounded-lg shadow-xl w-[420px] flex flex-col">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <IconAlertTriangle size={16} className="text-ink-warning flex-shrink-0" />
          <span className="text-[13px] font-medium text-ink">{t.alpha.title}</span>
        </div>

        <div className="p-4">
          <p className="text-[12px] text-ink-2 leading-relaxed">{t.alpha.body}</p>
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
