import { IconBug } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { useProcessingState } from "./ProcessingPanel";
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

/**
 * A barra de status é o ÚNICO lugar sempre visível — então TODO processamento
 * pesado tem de aparecer aqui, e não só no painel onde ele acontece.
 *
 * O passe de waveforms, por exemplo, morava só no cabeçalho da timeline: numa
 * diária recém-carregada a timeline está VAZIA, então o app lia 12 GB em silêncio
 * absoluto e parecia travado. "Sem feedback" e "travado" são indistinguíveis para
 * quem está olhando.
 */
export function StatusBar() {
  const t = useI18n();
  const { appStatus, statusMessage, clips } = useAppStore();
  // A MESMA fase que o painel do meio da timeline mostra — duas leituras do
  // mesmo estado seriam duas que um dia divergem (o rodapé dizendo uma coisa e
  // o centro da tela, outra).
  const processing = useProcessingState();

  let message: string;
  let colorClass = "text-ink-3";

  const counterOf = (p: NonNullable<typeof processing>) =>
    p.total && p.total > 0
      ? t.sync.progress
          .replace("{{current}}", String(p.current ?? 0))
          .replace("{{total}}", String(p.total))
      : "";

  /**
   * O passe de WAVEFORMS roda DEPOIS de o sync já ter respondido, então ele não
   * pode tomar a barra: o resumo ("N tomadas sincronizadas · M para revisar") é
   * o que o usuário precisa ler justamente ao terminar de sincronizar, e ficava
   * escondido por minutos até a última onda ser desenhada. Agora o resumo manda,
   * e o passe entra como segmento secundário.
   */
  const peaksTail =
    processing?.kind === "waveforms"
      ? ` · ${processing.title} ${counterOf(processing)}`
      : "";

  if (processing && processing.kind !== "waveforms") {
    message = [processing.title, counterOf(processing), processing.detail]
      .filter(Boolean)
      .join(" — ");
    colorClass = "text-ink-2";
  } else if (appStatus === "success") {
    message = (statusMessage || t.sync.success) + peaksTail;
    colorClass = "text-ink-success";
  } else if (appStatus === "error") {
    message = (statusMessage || t.sync.error) + peaksTail;
    colorClass = "text-ink-danger";
  } else if (processing) {
    message = [processing.title, counterOf(processing), processing.detail]
      .filter(Boolean)
      .join(" — ");
    colorClass = "text-ink-2";
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
