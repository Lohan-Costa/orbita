"""
SINCRONIZAÇÃO POR TIMECODE PURO (`sync_method="timecode"`).

O que este teste guarda:

  1. NENHUM áudio de câmera é lido — o modo TC posiciona pela diferença de TC, e
     essa é a promessa (ver a timeline inteira na hora, sem processar). O som é
     lido só para a waveform de exibição.
  2. O offset é EXATAMENTE `cam_TC − snd_TC` em frames — o sync que vale quando os
     aparelhos compartilham o relógio.
  3. Um clipe sem TC não é posicionado às cegas: fica sinalizado `no_tc`.

Sem mídia real: `probe` monkeypatchado devolve TCs sintéticos; `extract_pcm` é
monkeypatchado e PROÍBE ler qualquer câmera (se o modo TC ler uma, o teste falha).
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
SND = "/fake/snd.wav"          # TC 0 s — cobre as câmeras
SND_FAR = "/fake/snd_far.wav"  # TC 3600 s (1 h) — não cobre câmera nenhuma
CAM1 = "/fake/camA/cam1.mov"   # TC 00:00:05:00 → 5 s
CAM2 = "/fake/camB/cam2.mov"   # TC 00:00:08:00 → 8 s
CAM_NO_TC = "/fake/camC/cam3.mov"  # sem TC
SND_DUR_S = 40.0
CAM_DUR_S = 10.0

# TC (em segundos) de cada som direto do teste.
_SND_TC = {SND: 0.0, SND_FAR: 3600.0}


def _probe(path: str) -> dict:
    tc = {CAM1: "00:00:05:00", CAM2: "00:00:08:00", CAM_NO_TC: None}
    if path in tc:
        return {
            "fps": FPS, "has_audio": True, "duration_ms": CAM_DUR_S * 1000,
            "tc_start": tc[path], "tc_drop_frame": False,
            "size_bytes": 1000, "channels": 2,
        }
    return {
        "fps": None, "has_audio": True, "duration_ms": SND_DUR_S * 1000,
        "tc_start_sec": _SND_TC.get(path, 0.0),
        "size_bytes": 1000, "channels": 2, "sample_rate": PCM_RATE,
    }


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    monkeypatch.setattr(engine, "probe", _probe)

    def fake_extract_pcm(path, channel=0):
        path = str(path)
        # O modo TC não pode ler áudio de CÂMERA (é a promessa). Ler um SOM é ok
        # (a waveform de exibição), mas só o som PAREADO — o órfão nem isso.
        assert path in _SND_TC, f"modo TC leu áudio de câmera ({path}) — não deveria"
        return np.zeros(int(SND_DUR_S * PCM_RATE), dtype=np.float32)

    monkeypatch.setattr(engine, "extract_pcm", fake_extract_pcm)
    monkeypatch.setattr(engine, "normalize", normalize)


def _entries(*cams: str, sounds=(SND,)) -> list[dict]:
    e = [{"path": c, "group_id": f"g{i}", "group_order": 0} for i, c in enumerate(cams)]
    for s in sounds:
        e.append({"path": s, "group_id": None, "group_order": None})
    return e


def _cam(daily, path):
    return next(c for g in daily.camera_groups for c in g.cameras if str(c.path) == path)


def test_offset_e_a_diferenca_de_TC_sem_ler_camera():
    daily = engine.run(_entries(CAM1, CAM2), fps=FPS, sync_method="timecode")

    # cam_TC − snd_TC, em frames: (5−0)*24 = 120 ; (8−0)*24 = 192.
    assert _cam(daily, CAM1).sync_offset_frames == 120
    assert _cam(daily, CAM2).sync_offset_frames == 192
    # E os dois pareados com o único som (o TC deles cai dentro dele).
    take_cams = {str(c.path) for t in daily.takes for c in t.cameras}
    assert take_cams == {CAM1, CAM2}
    # Marcados como "timecode" — a timeline os pinta diferente de um sync verificado.
    assert _cam(daily, CAM1).sync_source == "timecode"
    assert _cam(daily, CAM2).sync_source == "timecode"


def test_clipe_sem_TC_fica_sinalizado():
    daily = engine.run(_entries(CAM1, CAM_NO_TC), fps=FPS, sync_method="timecode")

    c = _cam(daily, CAM_NO_TC)
    assert c.flagged is True
    assert c.flag_reason == "no_tc"
    # O órfão não entra em tomada.
    assert CAM_NO_TC not in {str(x.path) for t in daily.takes for x in t.cameras}


def test_resync_por_TC_so_toca_a_selecao():
    """Um resync em modo TC re-posiciona só o selecionado; o resto entra fixado."""
    # Primeiro um sync TC cheio, para ter os offsets.
    full = engine.run(_entries(CAM1, CAM2), fps=FPS, sync_method="timecode")
    off1 = _cam(full, CAM1).sync_offset_frames

    # Resync só de CAM2, com CAM1 fixado.
    partial = engine.run(
        _entries(CAM1, CAM2), fps=FPS, sync_method="timecode",
        pinned={CAM1: (off1, SND)}, selected={CAM2},
    )
    assert _cam(partial, CAM1).sync_offset_frames == off1   # intacto
    assert _cam(partial, CAM2).sync_offset_frames == 192     # reaplicado pelo TC


def test_som_sem_camera_aparece_no_seu_TC():
    """O CASO D02 do PROJETO X: o gravador tem TC horas distante do da câmera, o som
    não pareia com ninguém — mas NÃO some. Vira órfão, no seu TC, como no Premiere."""
    daily = engine.run(
        _entries(CAM1, CAM2, sounds=(SND, SND_FAR)),
        fps=FPS, sync_method="timecode",
    )

    # SND (TC 0) pareou com as câmeras; SND_FAR (TC 1 h) não pareou com ninguém.
    take_sounds = {str(t.sound.path) for t in daily.takes}
    orphan_sounds = {str(s.path) for s in daily.orphan_sounds}
    assert take_sounds == {SND}
    assert orphan_sounds == {SND_FAR}

    # E ele está no seu TC. A origem é 0 (o som pareado SND cai em TC 0), então não
    # há deslocamento e o órfão fica no seu TC cru: 3600 s × 24 fps.
    far = next(s for s in daily.orphan_sounds if str(s.path) == SND_FAR)
    assert far.timeline_start_frames == round(3600.0 * FPS)
