"""
O SUB-GRUPO no NLE — e A ARMADILHA DO TIMECODE, do lado do export.

A cena começa no PRIMEIRO CLIPE DELA: uma cena que só acontece aos 5 min não pode
gerar cinco minutos de vazio no começo da sequência. Mas deslocar as posições mexe
no TIMECODE — e aí o mesmo arquivo mostraria `01:00:00:00` na cena e `01:05:00:00`
na diária. O mesmo arquivo, dois timecodes.

É a única mentira que este app pode contar, e ela só apareceria no Premiere, tarde,
com o material já montado em cima. O primeiro teste desta suíte é o que a impede —
é o irmão gêmeo do que guarda a timeline (`src/types/timeline.test.ts`), porque a
correção é a mesma dos dois lados:

    posição   = timeline_start − origin
    ZeroPoint = start_tc       + origin
    TC exibido = ZeroPoint + posição = start_tc + timeline_start   ← invariante
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from prproj.builder import ExportOptions, _B
from prproj.validate import validate_root
from sync.model import (
    CameraAngle, CameraGroup, Daily, Project, SoundClip, SubGroup, Take,
)

FPS = 24.0
TPF = round(254016000000 / FPS)
HORA = 24 * 3600          # 01:00:00:00 em frames, a 24 fps
CINCO_MIN = 24 * 300      # onde a 2ª tomada começa


def _cam(path: Path, start: int) -> CameraAngle:
    return CameraAngle(path=path, fps=FPS, duration_frames=240,
                       timeline_start_frames=start, sync_offset_frames=30,
                       audio_channels=2)


def _snd(path: Path, start: int) -> SoundClip:
    return SoundClip(path=path, sample_rate=48000, duration_ms=10000, channels=2,
                     timeline_start_frames=start)


def _diaria(tmp: Path) -> Daily:
    """Duas tomadas: a 1ª no zero, a 2ª aos 5 min. Duas câmeras. Uma cena = a 2ª."""
    paths = {}
    for n in ("a1.mov", "a2.mov", "b1.mov", "b2.mov", "s1.wav", "s2.wav"):
        p = tmp / n
        p.write_bytes(b"x")
        paths[n] = p

    a1, a2 = _cam(paths["a1.mov"], 0), _cam(paths["a2.mov"], CINCO_MIN)
    b1, b2 = _cam(paths["b1.mov"], 30), _cam(paths["b2.mov"], CINCO_MIN + 30)
    s1, s2 = _snd(paths["s1.wav"], 0), _snd(paths["s2.wav"], CINCO_MIN)

    return Daily(
        camera_groups=[
            CameraGroup(cameras=[a1, a2], name="CAM A", id="camA"),
            CameraGroup(cameras=[b1, b2], name="CAM B", id="camB"),
        ],
        takes=[Take(sound=s1, cameras=[a1, b1]), Take(sound=s2, cameras=[a2, b2])],
        # A cena 02: as câmeras da 2ª tomada MAIS o som dela — os paths chegam
        # RESOLVIDOS do frontend (é ele o dono da regra de puxar o som junto).
        sub_groups=[SubGroup(id="cena2", name="cena 02", paths=[
            str(paths["a2.mov"]), str(paths["b2.mov"]), str(paths["s2.wav"]),
        ])],
        fps=FPS, name="D01", start_tc_frames=HORA,
    )


def _build(d: Daily, options: ExportOptions | None = None) -> ET.Element:
    return ET.fromstring(_B(Project(groups=[d]), options).build())


# ── Ler o XML ────────────────────────────────────────────────────────────────
#
# O PRPROJ é um grafo achatado: quase nada é filho de quem o usa — a Sequence
# APONTA para os TrackGroups, que apontam para as Tracks, que apontam para os
# TrackItems. Ler "os clipes desta sequência" é seguir essa corrente, e é o que
# `_clipes_de` faz. Vale o trabalho: um teste que lesse os TrackItems soltos não
# saberia dizer de QUAL das duas sequências eles são — que é a pergunta inteira
# deste arquivo.


def _seqs(root: ET.Element) -> dict[str, ET.Element]:
    """nome da sequência → o elemento <Sequence>."""
    return {s.findtext("Name") or "": s
            for s in root.iter("Sequence") if s.get("ObjectUID")}


def _index(root: ET.Element) -> tuple[dict, dict]:
    """(por ObjectID, por ObjectUID) — os dois espaços de nome do PRPROJ."""
    return (
        {e.get("ObjectID"): e for e in root.iter() if e.get("ObjectID")},
        {e.get("ObjectUID"): e for e in root.iter() if e.get("ObjectUID")},
    )


def _clipes_de(root: ET.Element, seq_name: str) -> list[tuple[str, int]]:
    """Os clipes de VÍDEO de uma sequência: (nome do arquivo, Start em ticks)."""
    by_oid, by_uid = _index(root)
    seq = _seqs(root)[seq_name]

    mc_de_subclip = {sc.get("ObjectID"): sc.find("MasterClip").get("ObjectURef")
                     for sc in root.iter("SubClip") if sc.find("MasterClip") is not None}
    nome_de_mc = {mc.get("ObjectUID"): mc.findtext("Name")
                  for mc in root.iter("MasterClip") if mc.get("ObjectUID")}

    out: list[tuple[str, int]] = []
    for tg_ref in seq.iterfind("./TrackGroups/TrackGroup/Second"):
        tg = by_oid.get(tg_ref.get("ObjectRef"))
        if tg is None or tg.tag != "VideoTrackGroup":
            continue
        for tr_ref in tg.iterfind("./TrackGroup/Tracks/Track"):
            track = by_uid.get(tr_ref.get("ObjectURef"))
            if track is None:
                continue
            for ti_ref in track.iter("TrackItem"):
                ti = by_oid.get(ti_ref.get("ObjectRef"))
                if ti is None or ti.tag != "VideoClipTrackItem":
                    continue
                sub = ti.find(".//SubClip")
                if sub is None:
                    continue
                nome = nome_de_mc.get(mc_de_subclip.get(sub.get("ObjectRef")))
                out.append((nome or "?", int(ti.findtext(".//Start"))))
    return out


def _tc_frames_de(root: ET.Element, seq_name: str, arquivo: str) -> int:
    """
    O TIMECODE EXIBIDO de um clipe, em frames — o número que o montador lê na régua.

    É `ZeroPoint + Start`: a origem da sequência mais a posição do clipe dentro dela.
    Ler os dois JUNTOS é o ponto — é a soma que tem de bater entre as sequências, e
    olhar só para a posição esconderia exatamente o bug que este arquivo persegue.
    """
    zero = int(_seqs(root)[seq_name].findtext(".//MZ.ZeroPoint"))
    for nome, start in _clipes_de(root, seq_name):
        if nome == arquivo:
            return (zero + start) // TPF
    raise AssertionError(f"{arquivo!r} não está na sequência {seq_name!r}")


# ⚠️ O TESTE. Se ele cair, o app está mentindo sobre o timecode.
class TestOTimecodeNaoMente:
    def test_o_TC_de_um_clipe_e_o_MESMO_na_diaria_e_no_subgrupo(self, tmp_path: Path):
        root = _build(_diaria(tmp_path))

        for arquivo in ("a2.mov", "b2.mov"):
            na_diaria = _tc_frames_de(root, "D01", arquivo)
            na_cena = _tc_frames_de(root, "D01 · cena 02", arquivo)
            assert na_cena == na_diaria, (
                f"{arquivo}: a diária mostra {na_diaria} e a cena {na_cena} — "
                "o mesmo arquivo com dois timecodes"
            )

        # E o número é o certo: 01:00:00:00 + 5 min = 01:05:00:00.
        assert _tc_frames_de(root, "D01 · cena 02", "a2.mov") == HORA + CINCO_MIN

    def test_a_cena_comeca_no_primeiro_clipe_DELA(self, tmp_path: Path):
        """Sem isto, a sequência da cena abriria com 5 minutos de vazio."""
        root = _build(_diaria(tmp_path))

        starts = [start for _, start in _clipes_de(root, "D01 · cena 02")]
        assert min(starts) == 0

    def test_a_sequencia_da_DIARIA_nao_se_mexeu(self, tmp_path: Path):
        """O sub-grupo é uma vista: existir não pode deslocar a diária."""
        root = _build(_diaria(tmp_path))

        assert _tc_frames_de(root, "D01", "a1.mov") == HORA
        assert _tc_frames_de(root, "D01", "a2.mov") == HORA + CINCO_MIN


class TestOQueEntraNaCena:
    def test_a_cena_leva_SO_os_clipes_dela(self, tmp_path: Path):
        root = _build(_diaria(tmp_path))

        nomes = sorted(n for n, _ in _clipes_de(root, "D01 · cena 02"))
        assert nomes == ["a2.mov", "b2.mov"]   # nunca a1/b1

    def test_a_cena_NAO_duplica_a_midia_da_diaria(self, tmp_path: Path):
        """
        O motivo do cache de mídia (E7). Sem ele, o mesmo arquivo entraria duas vezes
        na bin — uma pela diária, outra pela cena — e o Premiere não teria como dizer
        qual dos dois é "o de verdade".
        """
        d = _diaria(tmp_path)
        root = _build(d)

        a2 = str((tmp_path / "a2.mov"))
        assert sum(1 for m in root.iter("Media")
                   if m.findtext("FilePath") == a2) == 1

    def test_uma_cena_esvaziada_nao_vira_sequencia(self, tmp_path: Path):
        d = _diaria(tmp_path)
        d.sub_groups = [SubGroup(id="vazia", name="cena vazia", paths=[])]
        root = _build(d)

        assert "D01 · cena vazia" not in _seqs(root)


class TestAsCenasMoramNumaSubBin:
    def test_a_cena_fica_numa_sub_bin_dentro_da_diaria(self, tmp_path: Path):
        root = _build(_diaria(tmp_path))

        bins = {b.findtext("./ProjectItem/Name"): b for b in root.iter("BinProjectItem")}
        assert set(bins) == {"D01", "SUB-GRUPOS"}

        filhos_da_diaria = {i.get("ObjectURef") for i in bins["D01"].iter("Item")}
        assert bins["SUB-GRUPOS"].get("ObjectUID") in filhos_da_diaria

    def test_uma_diaria_sem_cenas_nao_ganha_sub_bin_vazia(self, tmp_path: Path):
        d = _diaria(tmp_path)
        d.sub_groups = []
        root = _build(d)

        nomes = {b.findtext("./ProjectItem/Name") for b in root.iter("BinProjectItem")}
        assert nomes == {"D01"}


class TestOModoEUmaOpcaoDeEXPORT:
    """O modo NÃO vive no domínio (ver ExportOptions e o DECISIONS.md)."""

    def _multicam_de(self, root: ET.Element, seq_name: str) -> str | None:
        for mc in root.iter("MasterClip"):
            if mc.findtext("Name") == seq_name:
                return mc.findtext(".//Source.Monitor.Multicam.Enabled")
        return None

    def test_por_default_a_cena_sai_como_sequencia_NORMAL(self, tmp_path: Path):
        # Multicam é uma ESCOLHA. Escolher pelo usuário em silêncio é como se perde a
        # confiança nele.
        root = _build(_diaria(tmp_path))
        assert self._multicam_de(root, "D01 · cena 02") == "false"

    def test_o_usuario_pede_multicam_e_a_cena_sai_multicam(self, tmp_path: Path):
        root = _build(_diaria(tmp_path),
                      ExportOptions(multicam_sub_groups={"cena2"}))
        assert self._multicam_de(root, "D01 · cena 02") == "true"

    def test_a_diaria_sai_como_sequencia_NORMAL_no_alpha(self, tmp_path: Path):
        # ALPHA: o multicam está DESLIGADO (bug aberto do áudio adaptativo — a multicam
        # é lida como "0 Channel" e fica muda como fonte). A diária sai como sequência
        # NORMAL sincronizada. O código de multicam segue gated, para voltar depois.
        root = _build(_diaria(tmp_path))
        assert self._multicam_de(root, "D01") == "false"


class TestOValidadorAprova:
    def test_uma_diaria_com_cena_passa_no_validador(self, tmp_path: Path):
        root = _build(_diaria(tmp_path),
                      ExportOptions(multicam_sub_groups={"cena2"}))
        assert validate_root(root) == []
