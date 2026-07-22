"""
Orbita — Alinhamento do DESENHO dos arquivos pelo timecode.

É o método que o montador faz à mão, e o diferencial do app: em vez de comparar
o ÁUDIO de cada clipe contra o de todos os sons diretos, alinha-se o PADRÃO de
blocos e buracos que os arquivos formam no eixo do tempo.

Como funciona
─────────────
A câmera tem um relógio de timecode; o gravador de som tem outro. Eles quase
nunca marcam a mesma hora (no material real: câmera em 02:14, som em 11:25), mas
os dois correm em TEMPO REAL — logo a diferença entre eles é uma CONSTANTE Δ.

Os dois gravaram os mesmos momentos, então o ritmo de "grava / para / grava" é o
mesmo nos dois. Deslizar a ocupação do vídeo sobre a do som até elas encaixarem
revela Δ. Sabendo Δ, sabe-se QUEM VAI COM QUEM — sem decodificar um único frame
de áudio.

O que este módulo NÃO faz
─────────────────────────
Não dá o offset de sync. As bordas dos blocos são "gordas": o som direto costuma
começar antes e terminar depois da câmera, e as durações não batem. Medido no
material real, a ocupação erra Δ em ~4 s.

Isso é suficiente e é o ponto: o desenho entrega o PAR e um bracket de poucos
segundos. O sync fino continua sendo da waveform (`sync/waveform.py`) — mas agora
numa janela estreita, contra UM candidato, em vez de uma busca global contra
todos os sons do dia (onde tomadas repetidas competem entre si).

Δ é constante por REGIME, não pelo dia todo
───────────────────────────────────────────
Δ só é constante enquanto ninguém reinicia/rejama um aparelho. No material real
ele mudou uma vez (55,6 s, no intervalo de 2 h entre dois cartões). Por isso
`clock_offsets` devolve os MELHORES candidatos, não o melhor: dois picos quase
empatados não são ambiguidade — são os dois regimes do dia, cada um explicando
metade dos clipes. Quem decide entre eles, clipe a clipe, é a waveform.

Medido no material real (PROJETO X / D02): dentro de um regime, o TC prevê o
offset de sync com ~0,1 s (2–3 frames) de erro.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import fftconvolve

# Resolução do raster de ocupação. Meio segundo é fino o bastante para o encaixe
# (os buracos entre tomadas são de minutos) e deixa um dia inteiro em ~60 k bins.
RES_S = 0.5

# Dois picos mais próximos que isto são a mesma solução vista de esguelha, não
# dois regimes distintos.
_PEAK_SEPARATION_S = 30.0

# Um candidato precisa explicar pelo menos esta fração do que o melhor explica.
# Serve para descartar picos de ruído sem descartar um regime legítimo que cubra
# poucos clipes.
_MIN_RELATIVE_COVERAGE = 0.75

# Largura máxima do platô no topo da correlação. Acima disto, Δ é INDETERMINADO e
# o método não tem o que dizer — ver `_plateau_width`.
_MAX_PLATEAU_S = 300.0
_PLATEAU_LEVEL = 0.99


def _plateau_width(corr: np.ndarray, res: float) -> float:
    """
    Largura (em segundos) do platô contíguo no topo da correlação.

    É a medida de que o método SABE quando não sabe. Se o som direto for um único
    arquivo contínuo cobrindo o dia inteiro — o caso de uma gravação de evento, e
    do dataset de teste antigo — então deslizar o bloco de câmeras para QUALQUER
    lugar dentro dele dá cobertura total. Não há um pico: há um platô de dezenas de
    minutos, e o `argmax` sobre ele devolve um Δ arbitrário, com toda a aparência
    de uma resposta.

    O padrão só informa quando existem BURACOS dos dois lados para encaixar. Sem
    eles, quem tem que responder é a forma de onda.
    """
    peak = corr.max()
    if peak <= 0:
        return float("inf")
    i = int(np.argmax(corr))
    level = peak * _PLATEAU_LEVEL

    lo = i
    while lo > 0 and corr[lo - 1] >= level:
        lo -= 1
    hi = i
    while hi < len(corr) - 1 and corr[hi + 1] >= level:
        hi += 1
    return (hi - lo) * res


@dataclass(frozen=True)
class Interval:
    """Um arquivo no eixo do RELÓGIO DO SEU APARELHO, em segundos reais."""
    key: str
    start: float
    end: float


@dataclass(frozen=True)
class ClockOffset:
    """Δ = quanto somar ao relógio da CÂMERA para chegar ao relógio do SOM."""
    delta: float
    #  Fração da duração total de vídeo que fica coberta por som neste Δ.
    #  1.0 = todo clipe de câmera cai dentro de algum som direto.
    coverage: float


def nominal_fps(fps: float) -> int:
    """Base inteira da contagem de timecode (23,976 → 24; 29,97 → 30)."""
    return max(1, round(fps))


def tc_to_real_seconds(tc: str, fps: float, drop_frame: bool = False) -> float | None:
    """
    Timecode 'HH:MM:SS:FF' → SEGUNDOS REAIS decorridos desde 00:00:00:00.

    A distinção entre "leitura do TC" e "tempo real" é o que estraga tudo se for
    ignorada: o TC conta frames na base NOMINAL (24), mas cada frame dura
    1/23,976 s. Tratar a leitura do TC como se fossem segundos embute 0,1 % de
    erro (= 1/1001) — o que, num dia de 9 h, vira ~30 s de deriva e destrói o
    alinhamento. (Foi exatamente o que aconteceu na primeira medição.)

    Drop-frame: os números de frame pulados NÃO existem, então a contagem é
    descontada — a mesma regra de `src/lib/timecode.ts`, que é onde ela vive no
    frontend.
    """
    if not tc:
        return None
    parts = tc.replace(";", ":").split(":")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return None
    hh, mm, ss, ff = (int(p) for p in parts)

    nominal = nominal_fps(fps)
    if mm > 59 or ss > 59 or ff >= nominal:
        return None

    frames = (hh * 3600 + mm * 60 + ss) * nominal + ff

    if drop_frame:
        # 2 números pulados por minuto a 29,97 (4 a 59,94), exceto nos múltiplos
        # de 10.
        drop = nominal // 15
        total_minutes = hh * 60 + mm
        frames -= drop * (total_minutes - total_minutes // 10)

    return frames / fps


def occupancy(
    intervals: list[Interval], t0: float, n_bins: int, res: float = RES_S
) -> np.ndarray:
    """
    Rasteriza os intervalos numa grade binária: 1 onde há arquivo, 0 nos buracos.

    Clipes contíguos se fundem sozinhos aqui — que é o que resolve, de graça, o
    caso da câmera que quebra uma gravação longa em vários arquivos (onde o
    `start_tc` de um é o frame seguinte ao `end_tc` do anterior): eles viram um
    bloco só, e o padrão não é falseado por uma fronteira que não existiu na
    filmagem.
    """
    grid = np.zeros(n_bins)
    for iv in intervals:
        i = int((iv.start - t0) / res)
        j = int((iv.end - t0) / res)
        grid[max(0, i) : min(n_bins, j)] = 1.0
    return grid


def clock_offsets(
    cameras: list[Interval],
    sounds: list[Interval],
    top_k: int = 4,
    res: float = RES_S,
) -> list[ClockOffset]:
    """
    Os Δ que melhor encaixam o desenho do VÍDEO no desenho do SOM.

    Δ é somado ao relógio da câmera para chegar ao do som:
        posição_no_relógio_do_som = tc_da_camera + Δ

    A cobertura é normalizada pela duração TOTAL DE VÍDEO — não pela sobreposição
    bruta. Isso importa porque o som direto costuma ser mais "gordo" que o vídeo
    (roda antes, para depois): a pergunta certa é "quanto do vídeo caiu dentro de
    algum som?", e não "quanto os dois se tocam", que premiaria simplesmente
    empilhar tudo em cima do trecho mais denso.

    Devolve os melhores candidatos, do maior para o menor. Vários candidatos com
    cobertura parecida NÃO são ambiguidade a resolver aqui: são os regimes de
    relógio do dia (ver o cabeçalho do módulo). Quem decide, clipe a clipe, é a
    waveform.

    Devolve VAZIO quando Δ é indeterminado — o platô no topo da correlação é largo
    demais (ver `_plateau_width`). É o caso de um som direto contínuo: sem buracos
    para encaixar, o desenho não diz nada, e insistir devolveria um Δ arbitrário
    com cara de resposta. Vazio aqui significa "não sei", e o chamador cai na
    forma de onda.
    """
    if not cameras or not sounds:
        return []

    # Eixo comum, com folga suficiente para o vídeo deslizar por todo o som.
    t0 = min(min(c.start for c in cameras), min(s.start for s in sounds))
    t1 = max(max(c.end for c in cameras), max(s.end for s in sounds))
    n = int((t1 - t0) / res) + 1
    if n <= 1:
        return []

    cam = occupancy(cameras, t0, n, res)
    snd = occupancy(sounds, t0, n, res)
    total_video = cam.sum()
    if total_video <= 0 or snd.sum() <= 0:
        return []

    # Correlação plena: quanto do vídeo cai sobre o som, para cada deslocamento.
    corr = fftconvolve(snd, cam[::-1], mode="full") / total_video
    lags = (np.arange(len(corr)) - (len(cam) - 1)) * res

    # Δ é identificável? Ver `_plateau_width`.
    if _plateau_width(corr, res) > _MAX_PLATEAU_S:
        return []

    peaks: list[ClockOffset] = []
    sep = _PEAK_SEPARATION_S
    for i in np.argsort(corr)[::-1]:
        d = float(lags[i])
        if any(abs(d - p.delta) < sep for p in peaks):
            continue
        peaks.append(ClockOffset(delta=d, coverage=float(corr[i])))
        if len(peaks) >= top_k:
            break

    if not peaks:
        return []

    best = peaks[0].coverage
    return [p for p in peaks if p.coverage >= best * _MIN_RELATIVE_COVERAGE]


def candidate_sounds(
    camera: Interval,
    sounds: list[Interval],
    offsets: list[ClockOffset],
) -> list[tuple[str, float]]:
    """
    Os sons diretos que ESTE clipe pode ter, um por Δ candidato.

    Para cada Δ, o clipe é levado ao relógio do som e escolhe-se o som que ele
    mais sobrepõe. Devolve `[(chave_do_som, delta), …]`, sem repetir som — na
    prática, 1 ou 2 candidatos, contra os 24 sons que uma busca cega compararia.

    Quando dois Δ apontam para o MESMO som (o normal: a diferença entre regimes é
    de dezenas de segundos, e os sons duram minutos), guarda-se o Δ de MAIOR
    sobreposição — não o primeiro da lista. O par sairia certo de qualquer jeito,
    mas o Δ errado envenenaria o offset previsto, que é o que serve de referência
    para julgar se o resultado da waveform é plausível.

    Vazio significa "este clipe não cai dentro de som nenhum, em nenhum regime" —
    e isso é uma resposta legítima, não uma falha: a câmera roda antes do
    gravador, entre tomadas, e em planos sem som (no material real, uma diária
    tem 21 vídeos para 5 áudios).
    """
    best_for_sound: dict[str, tuple[float, float]] = {}   # som → (delta, sobreposição)

    for off in offsets:
        start = camera.start + off.delta
        end = camera.end + off.delta

        best_key, best_overlap = None, 0.0
        for s in sounds:
            overlap = min(end, s.end) - max(start, s.start)
            if overlap > best_overlap:
                best_key, best_overlap = s.key, overlap

        if not best_key:
            continue
        prev = best_for_sound.get(best_key)
        if prev is None or best_overlap > prev[1]:
            best_for_sound[best_key] = (off.delta, best_overlap)

    # Mais sobreposto primeiro: é o candidato mais promissor.
    ordered = sorted(best_for_sound.items(), key=lambda kv: -kv[1][1])
    return [(key, delta) for key, (delta, _) in ordered]


def predicted_offset_seconds(
    camera: Interval, sound: Interval, delta: float
) -> float:
    """
    Offset de sync previsto pelo TC: quantos segundos a câmera começa DEPOIS do
    som (a mesma convenção de `CameraAngle.sync_offset_frames`).

    É o centro da janela em que a waveform vai refinar — não o resultado final.
    Erra por alguns segundos, porque Δ vem do encaixe grosso do desenho.
    """
    return (camera.start + delta) - sound.start
