/**
 * A PROVA de que as tracks saem alinhadas.
 *
 * O bug que este motor existe para matar era este: cada track num `<audio>`
 * independente, cada um partindo quando o seu buffer ficava pronto, e a diferença
 * entre essas latências virando um atraso permanente — audível como eco entre a
 * câmera e o som direto, com a waveform perfeitamente alinhada na tela.
 *
 * O desenho novo promete que o deslocamento entre duas tracks é EXATO À AMOSTRA,
 * por construção. Uma promessa dessas não se confere lendo o código: mede-se. O
 * teste põe o MESMO arquivo em duas tracks, separadas por um atraso conhecido, e
 * correlaciona os dois buffers montados. O pico tem de cair exatamente no atraso
 * pedido — nem uma amostra a mais.
 *
 * Contra mídia REAL da diária (mp4/AAC e WAV de 5 canais), porque é o material que
 * já mentiu antes: é ele que tem GOP de 23 frames, e é o WAV multicanal que o
 * downmix pode maltratar.
 *
 * O `invoke` do Tauri não existe fora do app, então o mock chama o MESMO ffmpeg
 * com os MESMOS argumentos que o `pcm.rs` — o que se testa é a montagem, e ela é a
 * mesma dos dois lados.
 *
 * PRECISA de mídia real fora do repo (`ORBITA_TEST_CAM_PATH` e
 * `ORBITA_TEST_SND_PATH`, apontando pra um clipe de câmera e um WAV de som
 * direto de uma diária qualquer). Sem as duas variáveis — o caso comum, inclusive
 * em CI —, a suíte inteira é pulada: não há como provar isto contra mídia
 * sintética.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const RATE = 48000;
const CHANNELS = 2;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "pcm_window") throw new Error(`comando inesperado: ${cmd}`);
    const { path, startSec, durSec } = args as {
      path: string;
      startSec: number;
      durSec: number;
    };
    // Os MESMOS argumentos de src-tauri/src/pcm.rs.
    const out = execFileSync(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", startSec.toFixed(6),
        "-t", durSec.toFixed(6),
        "-i", path,
        "-vn",
        "-ac", String(CHANNELS),
        "-ar", String(RATE),
        "-f", "f32le",
        "pipe:1",
      ],
      { maxBuffer: 1 << 30 }
    );
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  },
}));

const { fillWindow, partsIn, prepareParts } = await import("./window");

const CAM = process.env.ORBITA_TEST_CAM_PATH ?? "";
const SND = process.env.ORBITA_TEST_SND_PATH ?? "";
const mediaReady = !!CAM && !!SND && existsSync(CAM) && existsSync(SND);

/** Monta um trecho da timeline para uma track, como o transporte faz. */
async function window(
  segments: { path: string; startSec: number; durationSec: number }[],
  startSec: number,
  durSec: number
): Promise<Float32Array> {
  const parts = partsIn(segments, startSec, startSec + durSec);
  await prepareParts(parts);
  const planes = [
    new Float32Array(Math.round(durSec * RATE)),
    new Float32Array(Math.round(durSec * RATE)),
  ];
  fillWindow(planes, parts, startSec);
  return planes[0];      // o canal esquerdo basta para medir deslocamento
}

/**
 * Deslocamento de `b` em relação a `a`, em amostras, por correlação.
 *
 * Quando o deslocamento é o esperado os buffers são IDÊNTICOS (vêm do mesmo
 * arquivo), então a correlação vale exatamente 1 ali e o pico é inequívoco — não
 * há como um vizinho ganhar por acaso. O passo de 7 só barateia a soma; não mexe
 * na resolução do eixo, que continua sendo de UMA amostra.
 */
function lag(a: Float32Array, b: Float32Array, search: number, from = search): number {
  const n = 2 * RATE;              // 2 s de sinal bastam, e sobra
  let best = -Infinity;
  let bestLag = 0;
  for (let d = -search; d <= search; d++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = from; i < from + n; i += 7) {
      const x = a[i];
      const y = b[i + d];
      num += x * y;
      da += x * x;
      db += y * y;
    }
    const c = num / (Math.sqrt(da * db) + 1e-12);
    if (c > best) {
      best = c;
      bestLag = d;
    }
  }
  return bestLag;
}

describe.skipIf(!mediaReady)("montagem do trecho da timeline", () => {
  /**
   * O CASO QUE REPRODUZ O BUG: duas tracks separadas por um atraso conhecido.
   *
   * 21 ms é a ordem de grandeza do atraso que o usuário ouvia como eco entre a
   * câmera e o som direto. Se a montagem errar UMA amostra (20 µs), isto pega.
   */
  it.each([
    ["som direto (WAV, 5 canais)", SND],
    ["câmera (mp4/AAC)", CAM],
  ])("desloca %s exatamente como a timeline manda", async (_label, path) => {
    const DELAY = 0.0213372;                       // s — de propósito, fora da grade
    const expected = Math.round(DELAY * RATE);     // 1024 amostras

    // O trecho [40,50) cai no MEIO do arquivo e ATRAVESSA a fronteira dos blocos
    // de cache (15 s), que é onde uma emenda errada apareceria.
    const a = await window([{ path, startSec: 0, durationSec: 300 }], 40, 10);
    const b = await window([{ path, startSec: DELAY, durationSec: 300 }], 40, 10);

    expect(lag(a, b, 3000)).toBe(expected);
  });

  /**
   * O MESMO, mas com o clipe COMEÇANDO DENTRO da janela — o começo de uma tomada.
   *
   * É o único caso em que o deslocamento DE DESTINO (onde o clipe cai dentro do
   * buffer) é diferente de zero, e diferente entre as duas tracks. Sem este caso o
   * teste acima passa mesmo com a conta de destino errada: os dois clipes entram em
   * zero e o erro se cancela. Descoberto injetando o erro de propósito e vendo o
   * teste passar — um teste que não sabe falhar não prova nada.
   */
  it.each([
    ["som direto (WAV, 5 canais)", SND],
    ["câmera (mp4/AAC)", CAM],
  ])("desloca %s quando a TOMADA COMEÇA dentro do trecho", async (_label, path) => {
    const DELAY = 0.0213372;
    const expected = Math.round(DELAY * RATE);

    // A tomada entra 2 s depois do começo da janela: destino = 96 000 numa track,
    // 96 000 + 1 024 na outra.
    const a = await window([{ path, startSec: 42, durationSec: 300 }], 40, 10);
    const b = await window([{ path, startSec: 42 + DELAY, durationSec: 300 }], 40, 10);

    expect(a.slice(0, 96000).every((v) => v === 0)).toBe(true);   // silêncio antes
    // A correlação tem de olhar DEPOIS da entrada da tomada — antes dela só há
    // silêncio, e silêncio não correlaciona com nada.
    expect(lag(a, b, 3000, 96000 + 3000)).toBe(expected);
  });

  /**
   * Mover o clipe NA TIMELINE e mover a janela junto tem de dar exatamente o mesmo
   * áudio: é a conta de posição (onde no buffer) cancelando a conta de arquivo
   * (onde na mídia). Se as duas não cancelarem à amostra, duas tracks em posições
   * diferentes não podem estar alinhadas — e aqui a comparação é bit a bit.
   */
  it.each([
    ["som direto (WAV, 5 canais)", SND],
    ["câmera (mp4/AAC)", CAM],
  ])("a posição na timeline e a posição no arquivo se cancelam — %s", async (_l, path) => {
    const a = await window([{ path, startSec: 0, durationSec: 300 }], 40, 10);
    const b = await window([{ path, startSec: 2, durationSec: 300 }], 42, 10);

    expect(a.length).toBe(b.length);
    expect(a.every((v, i) => v === b[i])).toBe(true);
    expect(a.some((v) => v !== 0)).toBe(true);      // e não passou por ser tudo zero
  });

  it("põe silêncio onde a track não tem clipe (o buraco entre tomadas)", async () => {
    const buf = await window([{ path: CAM, startSec: 100, durationSec: 30 }], 40, 10);
    expect(buf.every((v) => v === 0)).toBe(true);
  });
});
