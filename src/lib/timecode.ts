/**
 * Timecode SMPTE e escala da régua.
 *
 * Nota sobre Intl (o CLAUDE.md manda usá-lo para durações): `HH:MM:SS:FF` é um
 * formato técnico fixo do SMPTE, não uma duração localizável — `Intl` não
 * consegue expressá-lo (nenhum locale escreve timecode "por extenso"). O que dá
 * para localizar é só o preenchimento de dígitos, e é o que fazemos.
 *
 * Drop-frame: nos fps NTSC (29,97 = 30000/1001; 59,94 = 60000/1001) o timecode
 * contaria mais devagar que o relógio de parede. O SMPTE compensa PULANDO
 * números de frame — 2 por minuto a 29,97, 4 a 59,94 — exceto nos minutos
 * múltiplos de 10. Nenhum frame é descartado: só a NUMERAÇÃO salta, para que o
 * timecode volte a bater com o relógio. Por isso se escreve com ponto-e-vírgula
 * (`HH:MM:SS;FF`), e é o que o Premiere exibe por padrão em material NTSC.
 */

const pad2 = new Intl.NumberFormat(undefined, {
  minimumIntegerDigits: 2,
  useGrouping: false,
});

/** fps "nominal": a base inteira da contagem (23,976 → 24; 29,97 → 30). */
export function nominalFps(fps: number): number {
  return Math.max(1, Math.round(fps));
}

/**
 * Drop-frame existe só nos fps NTSC (29,97 e 59,94), onde a base é 30/60 e o fps
 * real é 1000/1001 dela. A 23,976 o timecode também deriva do relógio, mas o
 * SMPTE não define drop-frame ali — material a 24 é sempre non-drop.
 */
export function isDropFrame(fps: number): boolean {
  const nominal = nominalFps(fps);
  if (nominal !== 30 && nominal !== 60) return false;
  return Math.abs(fps - nominal) > 0.001; // 29,97 sim; 30 exato não
}

/** Números de frame pulados a cada minuto: 2 a 29,97; 4 a 59,94. */
function dropCount(nominal: number): number {
  return nominal / 15;
}

/** Contagem de frames → partes do timecode, já com o salto do drop-frame. */
function framesToParts(
  frames: number,
  nominal: number,
  drop: boolean
): { hh: number; mm: number; ss: number; ff: number } {
  let n = frames;

  if (drop) {
    // Reinsere na NUMERAÇÃO os números que o drop-frame pula, para que as
    // divisões abaixo caiam no valor certo. Um bloco de 10 minutos pula
    // 9 × dropCount: o minuto múltiplo de 10 é o único que não pula.
    const d = dropCount(nominal);
    const perMinute = nominal * 60 - d;
    const per10Minutes = nominal * 60 * 10 - d * 9;
    const blocks = Math.floor(n / per10Minutes);
    const rest = n % per10Minutes;
    n += d * 9 * blocks;
    if (rest >= d) n += d * Math.floor((rest - d) / perMinute);
  }

  return {
    ff: n % nominal,
    ss: Math.floor(n / nominal) % 60,
    mm: Math.floor(n / (nominal * 60)) % 60,
    hh: Math.floor(n / (nominal * 3600)),
  };
}

/** Segundos → "HH:MM:SS:FF" (ou "HH:MM:SS;FF" em drop-frame). */
export function secondsToTc(sec: number, fps: number): string {
  const sign = sec < 0 ? "-" : "";
  const nominal = nominalFps(fps);
  const drop = isDropFrame(fps);
  const { hh, mm, ss, ff } = framesToParts(
    Math.round(Math.abs(sec) * fps),
    nominal,
    drop
  );

  return (
    `${sign}${pad2.format(hh)}:${pad2.format(mm)}:${pad2.format(ss)}` +
    `${drop ? ";" : ":"}${pad2.format(ff)}`
  );
}

/** Contagem de frames → timecode. Mesma regra, para quem já pensa em frames. */
export function framesToTc(frames: number, fps: number): string {
  return secondsToTc(frames / fps, fps);
}

/**
 * "HH:MM:SS:FF" → contagem de frames, ou `null` se não for um timecode válido —
 * é assim que o campo de início do projeto rejeita entrada quebrada.
 *
 * Aceita `:` ou `;` nos frames e formas curtas ("10:00" = 10 s e 0 frames), para
 * que digitar no campo não exija os 8 dígitos.
 */
export function tcToFrames(tc: string, fps: number): number | null {
  const parts = tc.trim().replace(/;/g, ":").split(":");
  if (parts.length < 2 || parts.length > 4) return null;
  if (parts.some((p) => !/^\d+$/.test(p))) return null;

  // Alinha à direita: "10:00" vira 00:00:10:00.
  const padded = [0, 0, 0, 0].map((_, i) => {
    const idx = i - (4 - parts.length);
    return idx < 0 ? 0 : Number(parts[idx]);
  });
  const [hh, mm, ss, ff] = padded;

  const nominal = nominalFps(fps);
  const drop = isDropFrame(fps);
  if (mm > 59 || ss > 59 || ff >= nominal) return null;

  let frames = (hh * 3600 + mm * 60 + ss) * nominal + ff;

  if (drop) {
    // Timecodes que o drop-frame PULA não existem (00:01:00;00 e ;01 a 29,97).
    if (ss === 0 && mm % 10 !== 0 && ff < dropCount(nominal)) return null;
    // Desconta os números pulados até aqui — o inverso exato de framesToParts.
    const totalMinutes = hh * 60 + mm;
    frames -= dropCount(nominal) * (totalMinutes - Math.floor(totalMinutes / 10));
  }

  return frames;
}

/** Segundos → "MM:SS" ou "H:MM:SS" — para rótulos curtos, fora da régua. */
export function secondsToShort(sec: number): string {
  const sign = sec < 0 ? "-" : "";
  const abs = Math.floor(Math.abs(sec));
  const ss = abs % 60;
  const mm = Math.floor(abs / 60) % 60;
  const hh = Math.floor(abs / 3600);
  return hh > 0
    ? `${sign}${hh}:${pad2.format(mm)}:${pad2.format(ss)}`
    : `${sign}${mm}:${pad2.format(ss)}`;
}

/**
 * Passo dos ticks da régua: o valor "redondo" mais próximo que dá pelo menos
 * `minSpacingPx` entre marcas. Sem isso a régua vira um borrão ao afastar o
 * zoom, ou fica com marcas em intervalos quebrados (a cada 3,7s).
 */
const NICE_STEPS_SEC = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
];

export function chooseTickStepSec(pxPerSec: number, minSpacingPx = 110): number {
  for (const step of NICE_STEPS_SEC) {
    if (step * pxPerSec >= minSpacingPx) return step;
  }
  return NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1];
}

/** Os fps que o seletor do projeto oferece. */
export const PROJECT_FPS_OPTIONS: { value: number; label: string }[] = [
  { value: 24000 / 1001, label: "23,976" },
  { value: 24, label: "24" },
  { value: 25, label: "25" },
  { value: 30000 / 1001, label: "29,97" },
  { value: 30, label: "30" },
  { value: 50, label: "50" },
  { value: 60000 / 1001, label: "59,94" },
  { value: 60, label: "60" },
];

/** Rótulo de um fps qualquer, casando com a opção mais próxima do seletor. */
export function fpsLabel(fps: number): string {
  const match = PROJECT_FPS_OPTIONS.find((o) => Math.abs(o.value - fps) < 0.01);
  return match ? match.label : fps.toFixed(3).replace(".", ",");
}
