import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import successUrl from "../assets/sounds/notify-success.wav";
import failureUrl from "../assets/sounds/notify-failure.wav";

/**
 * Um alerta sonoro ao FIM de uma operação longa: um som de sucesso quando um
 * sync/re-sync/export termina, e um de falha quando algo dá errado (nada
 * sincroniza, o export quebra, o sidecar recusa). Uma diária leva minutos — o
 * usuário troca de janela e volta quando ouve.
 *
 * POR QUE OLHAR O `appStatus`, e não cada call site: todo caminho longo já
 * transita `running → success` ou `running → error` por um lugar só
 * (`setAppStatus`). Escutar aqui pega TODOS eles — inclusive o que alguém
 * escrever amanhã — sem espalhar `play()` pela base. E o `running` no meio
 * garante que cada término é uma TRANSIÇÃO de verdade (nunca `success → success`),
 * então nenhum toca duas vezes.
 *
 * O `play()` pode ser rejeitado (política de autoplay antes de qualquer clique, ou
 * um som cortado por outro) — não é erro do app; engolimos.
 */
export function useNotificationSounds(): void {
  const appStatus = useAppStore((s) => s.appStatus);
  const soundsEnabled = useAppStore((s) => s.soundsEnabled);

  const prev = useRef(appStatus);
  const success = useRef<HTMLAudioElement | null>(null);
  const failure = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const from = prev.current;
    prev.current = appStatus;
    if (from === appStatus || !soundsEnabled) return;

    let el: HTMLAudioElement | null = null;
    if (appStatus === "success") {
      success.current ??= makeAudio(successUrl);
      el = success.current;
    } else if (appStatus === "error") {
      failure.current ??= makeAudio(failureUrl);
      el = failure.current;
    }
    if (!el) return;

    el.currentTime = 0; // reinicia se dois términos vierem em sequência
    void el.play().catch(() => {});
    // `soundsEnabled` NÃO é dependência de propósito: mutar no meio de uma operação
    // não deve disparar (nem calar) um som retroativo — só vale para o PRÓXIMO
    // término. O `prev` sincroniza mesmo quando mudo, senão religar o som no meio
    // faria o término já passado tocar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus]);
}

const NOTIFY_VOLUME = 0.6;

function makeAudio(url: string): HTMLAudioElement {
  const a = new Audio(url);
  a.volume = NOTIFY_VOLUME;
  a.preload = "auto";
  return a;
}
