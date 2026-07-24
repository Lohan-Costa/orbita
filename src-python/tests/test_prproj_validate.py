"""
O validador estrutural do PRPROJ — e a prova de que ele SABE REPROVAR.

Um validador que só aprova é decoração. Cada teste aqui INJETA um dos bugs que já
custaram uma sessão de debug e exige que o validador o pegue. Se um dia alguém
"simplificar" o validate.py, é aqui que o barulho aparece.

As regras estão em `bancodedadosnles/protocolos/prproj/escrita.md`.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from prproj.validate import validate_root

_SAMPLE = Path(__file__).resolve().parents[2] / "midias-projetos-exemplo" / "TESTE_streamnumber_v5.prproj"


def _root() -> ET.Element:
    import gzip
    return ET.fromstring(gzip.open(_SAMPLE, "rt", encoding="utf-8").read())


def test_um_prproj_bom_passa():
    assert validate_root(_root()) == []


def test_pega_objectuid_duplicado():
    r = _root()
    els = [e for e in r.iter() if e.get("ObjectUID")]
    els[1].set("ObjectUID", els[0].get("ObjectUID"))
    assert any("ObjectUID duplicado" in p for p in validate_root(r))


def test_pega_referencia_pendurada():
    r = _root()
    next(e for e in r.iter() if e.get("ObjectRef")).set("ObjectRef", "999999")
    assert any("inexistente" in p for p in validate_root(r))


def test_pega_start_negativo():
    r = _root()
    next(r.iter("Start")).text = "-1000"
    assert any("Start negativo" in p for p in validate_root(r))


def test_pega_inuse_em_clip_de_track():
    """<InUse> num clip de TRACK: o clipe de vídeo deixa de ser selecionável com
    clique direto no corpo — e o projeto abre normalmente, sem nenhum erro."""
    r = _root()
    by_oid = {e.get("ObjectID"): e for e in r.iter() if e.get("ObjectID")}
    sc = next(iter(r.iter("SubClip")))
    clip = by_oid[sc.find("Clip").get("ObjectRef")]
    ET.SubElement(clip.find("Clip"), "InUse").text = "false"
    assert any("<InUse>" in p for p in validate_root(r))


def test_pega_link_de_video_solo():
    """Um vídeo sozinho num Link também abre — e também não seleciona."""
    r = _root()
    vti = next(iter(r.iter("VideoClipTrackItem"))).get("ObjectID")
    lk = next(iter(r.iter("Link")))
    tis = lk.find(".//TrackItems")
    for child in list(tis):
        tis.remove(child)
    ET.SubElement(tis, "TrackItem", {"Index": "0", "ObjectRef": vti})
    assert any("vídeo SOLO" in p for p in validate_root(r))


def test_pega_multicam_sem_trackindex():
    """`Enabled=true` sem `TrackIndex`: a sequência abre, mas fora do monitor
    multicam — a promessa do app some sem nenhum erro visível."""
    r = _root()
    for mc in r.iter("MasterClip"):
        props = mc.find(".//Node/Properties")
        if props is None:
            continue
        ti = props.find("Source.Monitor.Multicam.TrackIndex")
        if ti is not None:
            props.remove(ti)
            break
    assert any("TrackIndex" in p for p in validate_root(r))
