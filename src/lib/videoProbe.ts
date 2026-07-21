/**
 * O `<video>` pode disparar `loadeddata` mesmo quando o CODEC de vídeo não
 * decodifica nada: os metadados e o áudio carregam normalmente, mas o quadro
 * fica preto. Visto no Windows com .mov de câmera em 10-bit/4:2:2 — o
 * WebView2 não tem decoder pra esse profile, mas o container e a faixa de
 * áudio são lidos igual, então `loadeddata` mente.
 *
 * `loadeddata` sozinho não distingue os dois casos; só um quadro de verdade
 * decodificado distingue. Daí este probe: espera por uma confirmação de que
 * ALGUM quadro chegou a ser apresentado antes de considerar o `<video>`
 * utilizável. NÃO precisa (nem deve) tocar o vídeo — o rVFC dispara no primeiro
 * quadro decodificado mesmo com o elemento parado.
 */

/** Quanto esperar pelo primeiro quadro antes de desistir do WebView e cair no
 *  VLC. Conteúdo decodificável apresenta um quadro em dezenas de ms; este teto
 *  só é atingido quando NÃO há decoder (ProRes no Windows). Curto de propósito:
 *  é o tempo de tela preta antes do VLC assumir — na prévia e na troca de
 *  ângulo do monitor. */
const FIRST_FRAME_TIMEOUT_MS = 800;

export async function decodedRealFrame(v: HTMLVideoElement): Promise<boolean> {
  // rVFC (Chromium/WebView2, Safari) só resolve quando um quadro é
  // efetivamente entregue pro compositor — o sinal mais direto que existe.
  if ("requestVideoFrameCallback" in v) {
    const ok = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      (v as unknown as { requestVideoFrameCallback: (cb: () => void) => number })
        .requestVideoFrameCallback(() => finish(true));
      window.setTimeout(() => finish(false), FIRST_FRAME_TIMEOUT_MS);
    });
    if (ok) return true;
  }

  // Sem rVFC, ou ele não disparou a tempo: `getVideoPlaybackQuality` como
  // segunda tentativa — se algum quadro chegou a ser contado, houve decode.
  if (typeof v.getVideoPlaybackQuality === "function") {
    return v.getVideoPlaybackQuality().totalVideoFrames > 0;
  }

  // Nenhum dos dois existe nesta engine: não há como distinguir — confia no
  // `loadeddata`, como antes.
  return true;
}
