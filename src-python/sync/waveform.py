"""
Orbita — cross-correlação de waveform para determinar o offset de sync.

Algoritmo em 2 etapas, ambas sobre ENVELOPE DE ENERGIA RMS (nunca PCM bruto):
  1. Coarse: ZNCC do envelope contra o WAV inteiro. Resolução ADAPTATIVA pela
     duração do clipe (ver _coarse_block). Localiza a região.
  2. Fine: ZNCC de envelope de alta resolução numa janela estreita ao redor do
     coarse, com interpolação parabólica → precisão sub-frame.

O áudio é usado por COMPLETO nas duas etapas: o envelope calcula o RMS de todas
as amostras, agrupadas em blocos. O que muda entre as etapas é a RESOLUÇÃO
temporal dos blocos, não a cobertura do áudio.

Por que envelope de energia RMS (e não PCM bruto):
  - O mic interno da câmera e o gravador de som direto têm respostas de
    frequência e posições muito diferentes → a FORMA DE ONDA bruta correlaciona
    mal entre eles. Já o CONTORNO de energia da cena (quem fala quando, pausas,
    picos) é praticamente o mesmo nos dois.
  - Medido: correlacionar PCM bruto não melhora a precisão do pico (o pico fica
    exatamente no mesmo lugar do envelope a 500 Hz), só piora a robustez.

Por que ZNCC e não NCC simples (CRÍTICO — foi a causa de um bug real):
  - Envelope de energia é sempre positivo → tem um componente DC grande.
  - NCC que normaliza só pela ENERGIA da janela (sem remover a média local) é
    dominada por esse DC: a correlação vira "onde o áudio é mais alto", não
    "onde o padrão casa". Era isso que fazia o sync escolher picos errados.
  - ZNCC remove a média LOCAL de cada janela da referência (Pearson de verdade),
    medindo só a forma do contorno, invariante ao nível absoluto.

Por que resolução ADAPTATIVA no coarse:
  - A estabilidade da correlação depende de quantos PONTOS o clipe vira, não de
    quantos segundos ele dura. Um clipe de 19 s a 10 Hz vira só 195 pontos e a
    correlação fica instável (medido: o pico certo perdia para um vizinho
    errado). O mesmo clipe a 25 Hz+ casa correto.
  - Então a taxa é escolhida para garantir um mínimo de pontos por clipe.

Confiança:
  - NÃO é o valor absoluto do pico ZNCC (varia muito com o conteúdo: cena com
    fala contínua correlaciona mais que cena esparsa, mesmo estando certa).
  - É a RAZÃO entre o pico e o melhor concorrente distante (peak / second_peak):
    mede o quão INEQUÍVOCO é o match. Em dados reais, matches corretos ficaram
    em razão ≥ 1.8; ambíguos (tomadas repetidas com áudio parecido), em ~1.05.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import fftconvolve

from media.audio import PCM_RATE, extract_pcm, normalize

# ── Coarse (busca global) ────────────────────────────────────────────────────
# Alvo de pontos de envelope por clipe: abaixo disso a correlação fica instável.
_COARSE_MIN_POINTS = 1000
_COARSE_RATE_MIN = 50      # Hz — piso (clipes longos)
_COARSE_RATE_MAX = 200     # Hz — teto (clipes muito curtos)

# ── Fine (refinamento sub-frame) ─────────────────────────────────────────────
# Medido: acima de ~500 Hz o pico não se move mais (nem usando PCM bruto a
# 8 kHz). Subir além disso é só custo, sem ganho de precisão.
_FINE_RATE = 500
_FINE_MARGIN_S = 0.6       # janela do refinamento ao redor do coarse

# Separação mínima entre o pico e o "concorrente" usado na razão de confiança —
# evita que a vizinhança imediata do pico (alta por continuidade) conte como
# concorrente independente.
_PEAK_SEPARATION_S = 9.0

# ── Peaks para a timeline (exibição, não sync) ───────────────────────────────
# 50 Hz: PEAK_BLOCK=160 divide PCM_RATE (8000) EXATAMENTE. Taxas que não dividem
# causam o bug de deriva de escala documentado em _coarse_block — restrição
# inegociável. 50 Hz também está fixado ao zoom máximo da timeline (100 px/s):
# 1 peak = 2 px, ou seja, resolução de sobra mesmo no zoom mais fechado.
PEAK_RATE = 50
PEAK_BLOCK = PCM_RATE // PEAK_RATE


def peaks_u8(pcm: np.ndarray) -> np.ndarray:
    """
    Envelope RMS a PEAK_RATE Hz, normalizado ao PRÓPRIO pico → uint8 (0..255).

    Normalização por clipe (e não global) porque o mic da câmera e o gravador de
    som direto têm níveis absolutos muito diferentes: o que interessa é a FORMA
    do contorno, não o nível — mesma razão que fez ZNCC ganhar de NCC no sync.
    Também faz cada waveform preencher seu retângulo na timeline.
    """
    env = _envelope(pcm, PEAK_BLOCK)
    if len(env) == 0:
        return np.zeros(0, dtype=np.uint8)
    peak = float(env.max())
    if peak < 1e-9:
        return np.zeros(len(env), dtype=np.uint8)
    return np.clip(env / peak * 255.0, 0, 255).astype(np.uint8)


# ── Correlação de uma JANELA do clipe contra o som inteiro ───────────────────
# Separação mínima entre pico e concorrente na razão de confiança. Menor que
# _PEAK_SEPARATION_S porque aqui o sinal é curto: exigir 9 s de separação deixaria
# quase nenhum concorrente, e a razão saturaria.
_CONFIRM_SEPARATION_S = 1.0


def confirm_offset(
    cam_pcm: np.ndarray,
    snd_pcm: np.ndarray,
) -> tuple[float, float] | None:
    """
    ONDE, dentro de `snd_pcm`, a janela `cam_pcm` cai — e o quão inequívoco é.

    Devolve `(posição_s, razão)`, ou `None` se não houver sinal para decidir.

    Serve ao caminho rápido do engine: o clipe entra como uma JANELA de ~20 s (ler
    o arquivo inteiro de uma câmera custa caro — ver `media.audio`), e o som entra
    INTEIRO. A busca não é restringida: só o sinal usado para buscar é menor.

    CORRELAÇÃO DE PCM CRU, NÃO DE ENVELOPE. O envelope (que `sync_camera_to_wav`
    usa) é o certo para uma busca cega com o clipe todo, mas numa janela curta ele
    não tem resolução: a primeira versão disto usava envelope e errava por até 8
    segundos — com "confiança" 99, porque a razão saturava. O PCM cru é barato aqui
    e não mente.
    """
    n = len(cam_pcm)
    if n < PCM_RATE or len(snd_pcm) < n:
        return None
    if float(np.abs(cam_pcm).max()) < 1e-6 or float(np.abs(snd_pcm).max()) < 1e-6:
        return None      # silêncio: não há o que confirmar

    ncc = _ncc_valid(snd_pcm, cam_pcm)
    if len(ncc) == 0:
        return None

    k = int(np.argmax(ncc))
    peak = float(ncc[k])

    # Razão pico/concorrente — a mesma ideia do sync (ver o cabeçalho do módulo):
    # o valor ABSOLUTO da correlação não diz se está certo (aqui ele fica em
    # 0,02–0,09, porque um mic de câmera não se parece com um boom); o que diz é o
    # quanto o pico se destaca.
    sep = int(_CONFIRM_SEPARATION_S * PCM_RATE)
    mask = np.ones(len(ncc), dtype=bool)
    mask[max(0, k - sep): k + sep + 1] = False
    rival = float(ncc[mask].max()) if mask.any() else 0.0
    ratio = peak / rival if rival > 1e-9 else float("inf")

    # Interpolação parabólica: o pico verdadeiro raramente cai numa amostra exata.
    delta = 0.0
    if 0 < k < len(ncc) - 1:
        y0, y1, y2 = ncc[k - 1], ncc[k], ncc[k + 1]
        den = y0 - 2 * y1 + y2
        if abs(den) > 1e-12:
            delta = float(np.clip(0.5 * (y0 - y2) / den, -1.0, 1.0))

    return (k + delta) / PCM_RATE, ratio


def _ncc_valid(ref: np.ndarray, sig: np.ndarray) -> np.ndarray:
    """
    Correlação normalizada de `sig` deslizando DENTRO de `ref`, em todos os lags em
    que ela cabe inteira. Normaliza pela energia do TRECHO de `ref` sob a janela —
    sem isso a correlação mediria "onde o som é mais alto", não "onde o padrão casa"
    (o mesmo erro que o ZNCC do coarse corrige com a média local).
    """
    n = len(sig)
    ref64 = ref.astype(np.float64)
    sig64 = sig.astype(np.float64)

    # correlate(ref, sig, "valid") == fftconvolve(ref, sig[::-1], "valid")
    num = fftconvolve(ref64, sig64[::-1], mode="valid")

    cs = np.concatenate(([0.0], np.cumsum(ref64 ** 2)))
    energy = cs[n:] - cs[:-n]                       # energia de cada trecho
    den = np.sqrt(np.maximum(energy, 0.0)) * np.linalg.norm(sig64)
    out = np.zeros_like(num)
    ok = den > 1e-12
    out[ok] = num[ok] / den[ok]
    return out


def _coarse_block(duration_s: float) -> int:
    """
    Tamanho do bloco (em amostras) do envelope coarse, adaptado à duração do
    clipe para garantir pontos suficientes.

    Trabalhamos em BLOCOS, não em "taxa pedida": o bloco é a grandeza real
    (inteiro, em amostras), e a taxa efetiva é PCM_RATE/bloco. Pedir uma taxa
    que não divide PCM_RATE exatamente e depois converter índice→tempo usando a
    taxa PEDIDA (e não a efetiva) introduz um erro de ESCALA que cresce com o
    tempo — bug real já cometido aqui: 52 Hz pedidos viravam bloco 153 → taxa
    efetiva 52.288 Hz → 0.55% de deriva → ~8 s de erro em 24 min de áudio.
    """
    if duration_s <= 0:
        return PCM_RATE // _COARSE_RATE_MIN
    rate = float(np.clip(_COARSE_MIN_POINTS / duration_s,
                         _COARSE_RATE_MIN, _COARSE_RATE_MAX))
    return max(1, int(PCM_RATE // rate))


def _envelope(pcm: np.ndarray, block: int) -> np.ndarray:
    """PCM (8 kHz) → envelope de energia RMS com blocos de `block` amostras.
    Usa TODAS as amostras (RMS por bloco); só a resolução temporal muda.
    A taxa efetiva do resultado é PCM_RATE/block."""
    block = max(1, block)
    n = (len(pcm) // block) * block
    if n == 0:
        return np.zeros(0)
    return np.sqrt(np.mean(pcm[:n].reshape(-1, block) ** 2, axis=1))


# Sobreposição mínima exigida entre os dois sinais para um lag ser considerado.
# Sem um piso, o lag em que só uma pontinha se sobrepõe correlaciona alto POR
# ACIDENTE (poucos pontos, Pearson instável) e ganha do lag verdadeiro.
_MIN_OVERLAP_S = 15.0
_MIN_OVERLAP_FRAC = 0.5     # do mais curto dos dois


def _zncc(reference: np.ndarray, signal: np.ndarray, rate: float) -> np.ndarray:
    """
    ZNCC (Pearson) de `signal` deslizando sobre `reference`, via FFT, calculado
    sobre a REGIÃO QUE SE SOBREPÕE em cada lag — não só onde há contenção total.

    Índice i ↔ lag = i - (len(signal) - 1). Lags cuja sobreposição é curta demais
    (ver _MIN_OVERLAP_*) ficam -inf.

    Por que sobreposição PARCIAL (foi a causa de um bug real, 2026-07-12):
      Só buscar lags de contenção total assume que o sinal cabe inteiro dentro da
      referência. Isso vale quando as câmeras rodam dentro de um som direto
      contínuo e longo — mas NÃO numa diária, onde cada tomada tem o seu som e as
      durações são parecidas: o som entra antes e a câmera sai depois, então
      nenhum contém o outro. O offset correto simplesmente NÃO ESTAVA no espaço
      de busca, e a correlação elegia um arquivo qualquer com pico ~0.07.

    Por que a média LOCAL é removida (ZNCC e não NCC):
      Envelope de energia é sempre positivo → tem DC grande. Normalizar só pela
      energia da janela mede "onde o áudio é mais alto", não "onde o padrão casa".

    Aqui as duas médias variam com o lag (a janela muda dos DOIS lados), então
    ambas são calculadas por lag, em vez de a do sinal ser fixa.
    """
    m, n = len(reference), len(signal)
    out = np.full(m + n - 1, -np.inf)
    if n == 0 or m == 0:
        return out

    ones_m, ones_n = np.ones(m), np.ones(n)

    # Correlação plena (todos os lags, inclusive os de sobreposição parcial).
    # `correlate(a, v)` = `fftconvolve(a, v[::-1])`.
    sum_rs = fftconvolve(reference, signal[::-1], mode="full")
    sum_r = fftconvolve(reference, ones_n[::-1], mode="full")
    sum_r2 = fftconvolve(reference ** 2, ones_n[::-1], mode="full")
    sum_s = fftconvolve(ones_m, signal[::-1], mode="full")
    sum_s2 = fftconvolve(ones_m, (signal ** 2)[::-1], mode="full")
    count = fftconvolve(ones_m, ones_n[::-1], mode="full")

    # O piso não pode exigir mais sobreposição do que o mais curto dos dois TEM a
    # oferecer: um clipe de 5 s nunca produziria 15 s de sobreposição, e a busca
    # inteira devolveria -inf. (Bug real: clipes entre 5 s e 15 s eram
    # matematicamente impossíveis de sincronizar.) Daí o teto em `min(m, n)`.
    min_overlap = min(
        max(_MIN_OVERLAP_S * rate, _MIN_OVERLAP_FRAC * min(m, n)),
        min(m, n),
    )
    valid = count >= min_overlap
    if not valid.any():
        return out

    c = count[valid]
    # Pearson sobre a sobreposição: cov / (σ_ref · σ_sig), tudo por lag.
    cov = sum_rs[valid] - sum_r[valid] * sum_s[valid] / c
    var_r = np.maximum(sum_r2[valid] - sum_r[valid] ** 2 / c, 0.0)
    var_s = np.maximum(sum_s2[valid] - sum_s[valid] ** 2 / c, 0.0)
    den = np.sqrt(var_r * var_s)

    scores = np.full(len(c), -np.inf)
    ok = den > 1e-12
    scores[ok] = cov[ok] / den[ok]
    out[valid] = scores
    return out


def _confidence(zncc: np.ndarray, peak_idx: int, rate: float) -> float:
    """Razão pico / melhor concorrente distante. Alto = match inequívoco."""
    sep = int(_PEAK_SEPARATION_S * rate)
    rest = zncc.copy()
    rest[max(0, peak_idx - sep) : peak_idx + sep + 1] = -np.inf
    if not np.isfinite(rest).any():
        return 99.0
    second = float(np.max(rest[np.isfinite(rest)]))
    peak = float(zncc[peak_idx])
    return (peak / second) if second > 1e-6 else 99.0


def _refine(ref_pcm: np.ndarray, cam_pcm: np.ndarray,
            coarse_offset_s: float, fps: float) -> float:
    """
    Refina o offset (em frames, fracionário) por ZNCC de envelope de alta
    resolução numa janela estreita, com interpolação parabólica do pico.
    """
    block = max(1, PCM_RATE // _FINE_RATE)
    rate = PCM_RATE / block                      # taxa EFETIVA (ver _coarse_block)

    ref_env = _envelope(ref_pcm, block)
    cam_env = _envelope(cam_pcm, block)
    n = len(cam_env)
    if n == 0 or n >= len(ref_env):
        return coarse_offset_s * fps

    center = int(round(coarse_offset_s * rate))
    margin = int(_FINE_MARGIN_S * rate)
    lo = max(0, center - margin)
    hi = min(len(ref_env) - n, center + margin)
    if hi <= lo:
        return coarse_offset_s * fps

    sig0 = cam_env - cam_env.mean()
    std_sig = np.sqrt(np.dot(sig0, sig0) / n)
    if std_sig < 1e-12:
        return coarse_offset_s * fps

    scores = np.full(hi - lo + 1, -np.inf)
    for k, start in enumerate(range(lo, hi + 1)):
        w = ref_env[start : start + n]
        w0 = w - w.mean()
        denom = np.sqrt(np.dot(w0, w0) / n) * std_sig
        if denom > 1e-12:
            scores[k] = float(np.dot(w0, sig0) / (n * denom))

    if not np.isfinite(scores).any():
        return coarse_offset_s * fps

    k = int(np.argmax(scores))
    # Interpolação parabólica → precisão abaixo de um bloco do envelope.
    delta = 0.0
    if 0 < k < len(scores) - 1 and all(np.isfinite(scores[k - 1 : k + 2])):
        y0, y1, y2 = scores[k - 1], scores[k], scores[k + 1]
        den = y0 - 2 * y1 + y2
        if abs(den) > 1e-12:
            delta = float(np.clip(0.5 * (y0 - y2) / den, -1.0, 1.0))

    refined_s = (lo + k + delta) / rate
    return refined_s * fps


def sync_camera_to_wav(
    wav_path: str,
    camera_path: str,
    fps: float,
    wav_channel: int = 0,
    camera_channel: int = 0,
    min_offset_frames: int | None = None,
    max_offset_frames: int | None = None,
    ref_pcm: np.ndarray | None = None,
    cam_pcm: np.ndarray | None = None,
) -> tuple[int, float]:
    """
    Retorna (sync_offset_frames, confidence).

    Positivo → câmera começa depois do início do WAV.

    confidence = razão pico/melhor-concorrente (ver docstring do módulo). NÃO é
    o valor bruto da correlação — é o quão inequívoco é o match. Matches
    corretos em dados reais ficam ≥ ~1.8; ambíguos, ~1.05.

    min_offset_frames / max_offset_frames: restringem a busca coarse — usados
    para encaixar um clipe ambíguo entre dois vizinhos já confiáveis do mesmo
    grupo de câmera (ver sync/engine.py).

    ref_pcm / cam_pcm: PCM já extraído (evita reextrair). Passar `cam_pcm`
    importa em dois lugares: o engine reusa o mesmo PCM para gerar os peaks da
    timeline, e a segunda passada (desambiguação) reusa o da primeira — antes
    disso, um clipe ambíguo era extraído do disco DUAS vezes.
    """
    if ref_pcm is None:
        ref_pcm = normalize(extract_pcm(wav_path, channel=wav_channel))
    if cam_pcm is None:
        cam_pcm = normalize(extract_pcm(camera_path, channel=camera_channel))

    # ── 1. Coarse: resolução adaptada à duração do clipe ──────────────────────
    duration_s = len(cam_pcm) / PCM_RATE
    block = _coarse_block(duration_s)
    rate = PCM_RATE / block          # taxa EFETIVA — nunca a "pedida" (ver _coarse_block)
    ref_env = _envelope(ref_pcm, block)
    cam_env = _envelope(cam_pcm, block)

    zncc = _zncc(ref_env, cam_env, rate)
    n = len(cam_env)

    z = zncc
    if min_offset_frames is not None or max_offset_frames is not None:
        z = zncc.copy()
        if min_offset_frames is not None:
            i_lo = int(round(min_offset_frames / fps * rate)) + (n - 1)
            z[: max(0, i_lo)] = -np.inf
        if max_offset_frames is not None:
            i_hi = int(round(max_offset_frames / fps * rate)) + (n - 1)
            if i_hi + 1 < len(z):
                z[i_hi + 1 :] = -np.inf

    if not np.isfinite(z).any():
        return (min_offset_frames or 0), -1.0

    peak_idx = int(np.argmax(z))
    confidence = _confidence(z, peak_idx, rate)
    coarse_offset_s = (peak_idx - (n - 1)) / rate

    # ── 2. Fine: envelope de alta resolução + interpolação sub-frame ──────────
    offset_frames_exact = _refine(ref_pcm, cam_pcm, coarse_offset_s, fps)
    return round(offset_frames_exact), confidence
