"""
O RE-SYNC PARCIAL (Etapa D) — o contrato de `pinned`/`selected` em `sync.engine.run`.

O que este teste guarda: um clipe FIXADO (fora de `selected`) não é lido de novo —
nem `probe`, nem PCM — e sai do re-sync com o offset e o som EXATOS que entraram.
É a alavanca de custo (re-sincronizar 1 clipe custa 1 clipe, não a diária) e
também a alavanca de correção (o clipe fixado é quem ancora a desambiguação dos
selecionados — ver `_corroborate_by_delta` e a passada 2 de `_pair_by_waveform`).

Sem mídia real: PCM sintético (ruído com semente fixa), com `probe`/`extract_pcm`
monkeypatchados — o que roda de verdade é a correlação (`sync.waveform`), não o
ffmpeg. `probe`/`extract_pcm`/`extract_pcm_window` são monkeypatchados NO MÓDULO
`sync.engine` (onde foram importados por nome) — patchar `media.audio` não
bastaria, porque o nome já está vinculado em `engine` desde o `import`.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sync.engine as engine
from media.audio import PCM_RATE, normalize

FPS = 24.0

# ── Fixture: duas tomadas independentes, cada câmera é um RECORTE EXATO do som
# dela — a correlação acerta o pico sem ambiguidade nenhuma, o que isola o teste
# no que interessa aqui: o contrato de pinned/selected, não a qualidade do match.
# str(Path(...)) (não a literal crua): o engine guarda `c.path` como Path e
# compara via str(c.path) — no Windows isso normaliza "/" para "\", então as
# constantes do teste precisam passar pela mesma normalização pra continuar
# batendo com o que o engine devolve.
_SND1 = str(Path("/fake/snd1.wav"))
_SND2 = str(Path("/fake/snd2.wav"))
_CAM1 = str(Path("/fake/camA/cam1.mov"))
_CAM2 = str(Path("/fake/camB/cam2.mov"))

_SND_DUR_S = 40.0
_CAM_DUR_S = 10.0
_CAM1_OFFSET_S = 5.0   # cam1 começa aos 5s DENTRO do snd1
_CAM2_OFFSET_S = 8.0   # cam2 começa aos 8s DENTRO do snd2


def _noise(seed: int, dur_s: float) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.standard_normal(int(dur_s * PCM_RATE)).astype(np.float32)


@pytest.fixture
def pcm_by_path():
    snd1 = _noise(1, _SND_DUR_S)
    snd2 = _noise(2, _SND_DUR_S)
    lo1, hi1 = int(_CAM1_OFFSET_S * PCM_RATE), int((_CAM1_OFFSET_S + _CAM_DUR_S) * PCM_RATE)
    lo2, hi2 = int(_CAM2_OFFSET_S * PCM_RATE), int((_CAM2_OFFSET_S + _CAM_DUR_S) * PCM_RATE)
    return {
        _SND1: snd1,
        _SND2: snd2,
        _CAM1: snd1[lo1:hi1].copy(),
        _CAM2: snd2[lo2:hi2].copy(),
    }


def _entries() -> list[dict]:
    return [
        {"path": _CAM1, "group_id": "camA", "group_order": 0},
        {"path": _CAM2, "group_id": "camB", "group_order": 0},
        {"path": _SND1, "group_id": None, "group_order": None},
        {"path": _SND2, "group_id": None, "group_order": None},
    ]


def _fake_probe(path: str) -> dict:
    if path in (_CAM1, _CAM2):
        return {
            "fps": FPS, "has_audio": True, "duration_ms": _CAM_DUR_S * 1000,
            "tc_start": None, "tc_drop_frame": False, "size_bytes": 1000, "channels": 2,
        }
    return {
        "fps": None, "has_audio": True, "duration_ms": _SND_DUR_S * 1000,
        "tc_start_sec": None, "size_bytes": 1000, "channels": 2, "sample_rate": PCM_RATE,
    }


def _install_fakes(monkeypatch, pcm_by_path: dict, forbidden: set[str]):
    monkeypatch.setattr(engine, "probe", _fake_probe)

    def fake_extract_pcm(path, channel=0):
        path = str(path)
        assert path not in forbidden, f"{path} foi relido — deveria estar fixado (pinned)"
        return pcm_by_path[path]

    monkeypatch.setattr(engine, "extract_pcm", fake_extract_pcm)
    monkeypatch.setattr(engine, "normalize", normalize)


def test_clipe_fixado_nao_e_relido_e_sai_com_o_mesmo_offset(monkeypatch, pcm_by_path):
    # ── Passo 1: sync CHEIO, de referência (pinned=None é o caminho de sempre) ──
    _install_fakes(monkeypatch, pcm_by_path, forbidden=set())
    baseline = engine.run(_entries(), fps=FPS)

    cam1_full = next(
        c for g in baseline.camera_groups for c in g.cameras if str(c.path) == _CAM1
    )
    assert cam1_full.confidence >= engine.TRUST_RATIO  # é um match limpo — pré-condição do teste
    # Um sync por forma de onda se marca "waveform" — o som confirmou de verdade.
    assert cam1_full.sync_source == "waveform"

    # ── Passo 2: RE-SYNC PARCIAL — só a CAM2 selecionada; CAM1 entra FIXADA no
    # que o passo 1 mediu, e não pode ser lida de novo. ──
    _install_fakes(monkeypatch, pcm_by_path, forbidden={_CAM1})
    pinned = {_CAM1: (cam1_full.sync_offset_frames, _SND1)}
    partial = engine.run(_entries(), fps=FPS, pinned=pinned, selected={_CAM2})

    cam1_partial = next(
        c for g in partial.camera_groups for c in g.cameras if str(c.path) == _CAM1
    )
    cam2_partial = next(
        c for g in partial.camera_groups for c in g.cameras if str(c.path) == _CAM2
    )

    # CAM1: exatamente o que foi fixado — nem o offset, nem a confiança mudam.
    assert cam1_partial.sync_offset_frames == cam1_full.sync_offset_frames
    assert cam1_partial.confidence == engine.PINNED_CONFIDENCE

    # CAM2: FOI de fato re-sincronizada — achou o SND2 certo, no offset certo (± 1
    # frame: a correlação é sub-frame, mas o corte em frame inteiro arredonda).
    cam2_take = next(
        t for t in partial.takes if _CAM2 in [str(c.path) for c in t.cameras]
    )
    assert str(cam2_take.sound.path) == _SND2
    expected_offset = round(_CAM2_OFFSET_S * FPS)
    assert abs(cam2_partial.sync_offset_frames - expected_offset) <= 1


def test_sem_pinned_nem_selected_e_bit_a_bit_o_sync_cheio_de_antes(monkeypatch, pcm_by_path):
    """Contrato de retrocompatibilidade: `pinned`/`selected` default None não pode
    mudar UMA VÍRGULA do caminho normal — é o que os dois parâmetros novos não
    tocam em nada quando ninguém os usa."""
    _install_fakes(monkeypatch, pcm_by_path, forbidden=set())
    a = engine.run(_entries(), fps=FPS)
    b = engine.run(_entries(), fps=FPS, pinned=None, selected=None)

    offsets_a = sorted((str(c.path), c.sync_offset_frames, c.confidence)
                        for g in a.camera_groups for c in g.cameras)
    offsets_b = sorted((str(c.path), c.sync_offset_frames, c.confidence)
                        for g in b.camera_groups for c in g.cameras)
    assert offsets_a == offsets_b
