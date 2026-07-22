"""
RELÓGIO CORROBORADO NÃO NAGA (`_corroborate_by_delta`).

Quando a forma de onda não confirma um clipe mas o RELÓGIO do regime o posiciona,
o que decide se ele ainda pede revisão é QUÃO forte é esse relógio:

  - Regime corroborado por VÁRIAS âncoras que concordam apertado → o clipe cai no
    relógio, vira ARDÓSIA (`sync_source="timecode"`) e NÃO é sinalizado. Pintar de
    duvidoso um clipe que várias âncoras colocam a frações de frame do lugar ensina
    o usuário a ignorar o aviso quando ele importa. (No material real: os planos de
    abertura do D03, sem sinal de onda, caem certos no relógio da manhã — 6 âncoras
    a ±0,05 s.)
  - Poucas âncoras, ou âncoras que DISCORDAM entre si → sem aval; segue `tc_only`,
    sinalizado. (O 2º gravador da tarde do D03, sem âncora nenhuma.)

Sem mídia: a re-medição (`sync_camera_to_wav`) é monkeypatchada para SEMPRE devolver
um offset que continua discordando do regime — é o que força o caminho de fallback
onde a decisão acima acontece. Constrói-se `_Clip`/`_Sound` à mão para isolar a
lógica de corroboração da correlação.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sync.engine as engine
from media.audio import PCM_RATE

FPS = 24.0
REGIME_DELTA = 100.0   # Δ de relógio (câmera adiantada 100 s sobre o gravador)


def _snd(path: str, tc_sec: float) -> "engine._Sound":
    s = engine._Sound(Path(path), {
        "duration_ms": 40_000, "sample_rate": PCM_RATE, "channels": 2,
        "tc_start_sec": tc_sec,
    })
    s.pcm = np.zeros(int(40.0 * PCM_RATE), dtype=np.float32)  # evita ler disco
    return s


def _clip(path: str, tc_sec: float, snd, *, confidence: float, implied: float) -> "engine._Clip":
    c = engine._Clip(Path(path), {
        "duration_ms": 10_000, "has_audio": True, "fps": FPS,
        "tc_start": None, "tc_drop_frame": False, "size_bytes": 1000, "channels": 2,
    }, "g", 0, FPS)
    c.tc_sec = tc_sec
    c.tc_frames = round(tc_sec * FPS)
    c.sound = snd
    c.confidence = confidence
    c.implied_delta = implied
    c.sync_source = "waveform"   # foi pareado pela onda; a corroboração pode rebaixar
    return c


@pytest.fixture(autouse=True)
def force_disagreeing_remeasure(monkeypatch):
    # A re-medição SEMPRE volta um offset cujo Δ implícito segue longe do regime —
    # é o que leva `_corroborate_by_delta` ao fallback do relógio (onde a decisão
    # ardósia-vs-flag mora). Ratio baixo: nada aqui vira âncora por acidente.
    def fake_sync(*, wav_path, camera_path, fps, ref_pcm, cam_pcm,
                  min_offset_frames=None, max_offset_frames=None):
        return round((REGIME_DELTA + 60.0) * fps), 1.0   # implied ≈ regime + 60 s

    monkeypatch.setattr(engine, "sync_camera_to_wav", fake_sync)
    monkeypatch.setattr(engine, "extract_pcm", lambda p, channel=0: np.zeros(1, np.float32))
    monkeypatch.setattr(engine, "normalize", lambda x: x)


def _run(anchors_implied: list[float]):
    """Um alvo (onda fraca, Δ fora do regime) cercado de âncoras com os Δ dados.

    Devolve o `_Clip` alvo depois de `_corroborate_by_delta`.
    """
    snd = _snd("/fake/snd.wav", tc_sec=0.0)
    # Âncoras próximas no tempo (todas dentro de ANCHOR_REACH_S do alvo em tc=50 s).
    anchors = [
        _clip(f"/fake/a{i}.mov", tc_sec=40.0 + i, snd=snd,
              confidence=5.0, implied=d)
        for i, d in enumerate(anchors_implied)
    ]
    target = _clip("/fake/target.mov", tc_sec=50.0, snd=snd,
                   confidence=1.0, implied=REGIME_DELTA + 60.0)
    engine._corroborate_by_delta([target, *anchors], FPS, on_clip=None)
    return target


def test_relogio_bem_corroborado_vira_ardosia_sem_flag():
    # 3 âncoras concordando apertado (Δ = 100 s): relógio sólido.
    target = _run([REGIME_DELTA, REGIME_DELTA, REGIME_DELTA])

    assert target.flagged is False
    assert target.sync_source == "timecode"        # ardósia, não âmbar
    # E ficou onde o relógio manda: predicted = (Δ − snd_tc + cam_tc)·fps.
    assert target.offset_frames == round((REGIME_DELTA - 0.0 + 50.0) * FPS)


def test_poucas_ancoras_segue_sinalizado():
    # Só 2 âncoras (< CLOCK_TRUST_MIN_ANCHORS): mediana frágil, sem aval.
    target = _run([REGIME_DELTA, REGIME_DELTA])

    assert target.flagged is True
    assert target.flag_reason == "tc_only"


def test_ancoras_que_discordam_seguem_sinalizadas():
    # 3 âncoras, mas espalhadas por mais que TC_AGREEMENT_S: relógio não é confiável.
    target = _run([REGIME_DELTA, REGIME_DELTA, REGIME_DELTA + engine.TC_AGREEMENT_S + 2.0])

    assert target.flagged is True
    assert target.flag_reason == "tc_only"
