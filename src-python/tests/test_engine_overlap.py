"""
A REGRA: dois clipes da MESMA câmera (nem dois sons) não se sobrepõem na timeline.

Uma câmera não grava dois arquivos ao mesmo tempo; o gravador não grava dois sons
ao mesmo tempo. Na timeline isso é uma track só, e uma track não tem dois clipes no
mesmo instante. Quando o TC (ou o sync) os põe sobrepostos, o passe
`_resolve_track_overlaps` empurra a tomada de trás para a frente — a UNIDADE inteira
(clipe + som), então o sync se preserva.

⚠️ Slow-motion é a exceção e está PENDENTE (ver a memória): um clipe lento dura mais
que o seu intervalo de TC e PODE invadir o próximo. Por ora ele é empurrado como
qualquer outro.

Sem mídia real: `probe` sintético, `extract_pcm` só para o som (modo TC não lê
câmera).
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
# Mesma câmera física (mesmo group_id), dois arquivos com TC que se sobrepõe:
# A [00:05, 00:15]s, B [00:10, 00:20]s → invasão de [10, 15]s.
# str(Path(...)) (não a literal crua): o engine guarda `c.path` como Path e
# compara via str(c.path) — no Windows isso normaliza "/" para "\", então a
# constante do teste precisa passar pela mesma normalização pra continuar
# batendo com o que o engine devolve.
CAM_A = str(Path("/fake/camA/a1.mov"))
CAM_B = str(Path("/fake/camA/a2.mov"))
SND_A = str(Path("/fake/snd_a.wav"))   # TC 5 s — cobre A
SND_B = str(Path("/fake/snd_b.wav"))   # TC 10 s — cobre B
DUR_S = 10.0

_TC = {CAM_A: "00:00:05:00", CAM_B: "00:00:10:00"}
_SND_TC = {SND_A: 5.0, SND_B: 10.0}


def _probe(path: str) -> dict:
    if path in _TC:
        return {
            "fps": FPS, "has_audio": True, "duration_ms": DUR_S * 1000,
            "tc_start": _TC[path], "tc_drop_frame": False,
            "size_bytes": 1000, "channels": 2,
        }
    return {
        "fps": None, "has_audio": True, "duration_ms": DUR_S * 1000,
        "tc_start_sec": _SND_TC[path], "size_bytes": 1000,
        "channels": 2, "sample_rate": PCM_RATE,
    }


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    monkeypatch.setattr(engine, "probe", _probe)
    monkeypatch.setattr(
        engine, "extract_pcm",
        lambda p, channel=0: np.zeros(int(DUR_S * PCM_RATE), dtype=np.float32),
    )
    monkeypatch.setattr(engine, "normalize", normalize)


def _entries():
    # Os dois clipes de câmera na MESMA fonte ("camA"); dois sons soltos.
    return [
        {"path": CAM_A, "group_id": "camA", "group_order": 0},
        {"path": CAM_B, "group_id": "camA", "group_order": 1},
        {"path": SND_A, "group_id": None, "group_order": None},
        {"path": SND_B, "group_id": None, "group_order": None},
    ]


def _cam(daily, path):
    return next(c for g in daily.camera_groups for c in g.cameras if str(c.path) == path)


def test_clipes_da_mesma_camera_nao_se_sobrepoem():
    daily = engine.run(_entries(), fps=FPS, sync_method="timecode")

    a = _cam(daily, CAM_A)
    b = _cam(daily, CAM_B)

    # B começa em (ou depois de) onde A termina — sem invasão.
    assert b.timeline_start_frames >= a.timeline_start_frames + a.duration_frames

    # E o sync de B foi PRESERVADO: a tomada dele andou inteira (clipe + som),
    # então o offset não mudou.
    assert b.sync_offset_frames == 0


def test_os_sons_das_duas_tomadas_tambem_nao_se_sobrepoem():
    daily = engine.run(_entries(), fps=FPS, sync_method="timecode")

    sounds = sorted(
        (t.sound for t in daily.takes), key=lambda s: s.timeline_start_frames
    )
    assert len(sounds) == 2
    first, second = sounds
    first_end = first.timeline_start_frames + round(first.duration_ms / 1000 * FPS)
    assert second.timeline_start_frames >= first_end
