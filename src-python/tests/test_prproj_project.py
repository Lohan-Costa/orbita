"""
O PRPROJ de um PROJETO: uma bin por diária, num arquivo só.

O trabalho do usuário é a SEMANA, não o dia. Exportar uma diária por arquivo o
obrigaria a abrir quatro projetos e a juntá-los à mão no Premiere — que é
exatamente o trabalho que este app existe para não fazer.

O que estes testes guardam:

  1. Cada diária vira UMA bin, com a sua mídia e a sua sequência dentro.
  2. Um arquivo tem UM MasterClip no projeto INTEIRO. Duplicar a mídia faz o
     Premiere mostrar o mesmo arquivo duas vezes na bin — e o usuário não tem como
     saber qual dos dois é "o de verdade". (É também o que permite, em E8, a
     sequência de um sub-grupo referenciar a mesma mídia da diária.)
  3. Cada diária mantém a SUA grade de tempo: fps e timecode inicial são dela, e
     a aritmética de uma não pode contaminar a outra.
  4. O resultado passa no validador estrutural — o mesmo que guarda as regras que
     já custaram sessões de debug.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from prproj.builder import _B
from prproj.validate import validate_root
from sync.model import CameraAngle, CameraGroup, Daily, Project, SoundClip, Take


def _daily(name: str, tmp: Path, fps: float = 24.0, start_tc: int = 0) -> Daily:
    campath = tmp / f"{name}_cam.mp4"
    sndpath = tmp / f"{name}_snd.wav"
    campath.write_bytes(b"x")
    sndpath.write_bytes(b"x")

    cam = CameraAngle(
        path=campath, fps=fps, duration_frames=240,
        timeline_start_frames=130, sync_offset_frames=30, audio_channels=2,
    )
    snd = SoundClip(
        path=sndpath, sample_rate=48000, duration_ms=20000, channels=5,
        timeline_start_frames=100,
    )
    return Daily(
        camera_groups=[CameraGroup(cameras=[cam], name="CAM A", id=f"{name}-g1")],
        takes=[Take(sound=snd, cameras=[cam])],
        fps=fps, name=name, start_tc_frames=start_tc,
    )


def _build(project: Project) -> ET.Element:
    return ET.fromstring(_B(project).build())


def _bins(root: ET.Element) -> list[ET.Element]:
    return list(root.iter("BinProjectItem"))


def _defs(root: ET.Element, tag: str) -> list[ET.Element]:
    """Os elementos DEFINIDOS, não as referências.

    O PRPROJ usa a mesma tag para o objeto e para o ponteiro até ele: a `<Sequence
    ObjectID=...>` de verdade e a `<Sequence ObjectRef=.../>` que alguém escreve para
    apontá-la. Contar `iter(tag)` conta as duas — e um teste que conta ponteiros não
    está contando sequências.
    """
    return [e for e in root.iter(tag)
            if e.get("ObjectID") or e.get("ObjectUID")]


def _name_of(el: ET.Element) -> str:
    return el.findtext("./ProjectItem/Name") or ""


def _children_of(el: ET.Element) -> list[str]:
    return [i.get("ObjectURef") for i in el.iter("Item")]


class TestUmaBinPorDiaria:
    def test_cada_diaria_vira_uma_bin(self, tmp_path: Path):
        proj = Project(name="SEMANA", groups=[
            _daily("D01", tmp_path), _daily("D02", tmp_path)])
        root = _build(proj)

        assert [_name_of(b) for b in _bins(root)] == ["D01", "D02"]

    def test_a_raiz_contem_as_bins_e_nada_mais(self, tmp_path: Path):
        proj = Project(groups=[_daily("D01", tmp_path), _daily("D02", tmp_path)])
        root = _build(proj)

        rpi = _defs(root, "RootProjectItem")[0]
        bin_uids = {b.get("ObjectUID") for b in _bins(root)}
        # A mídia mora DENTRO da bin da sua diária — solta na raiz, ela apareceria
        # misturada com a dos outros dias, que é o que esta etapa existe para evitar.
        assert set(_children_of(rpi)) == bin_uids

    def test_a_bin_da_diaria_tem_a_midia_dela_e_a_sua_sequencia(self, tmp_path: Path):
        proj = Project(groups=[_daily("D01", tmp_path), _daily("D02", tmp_path)])
        root = _build(proj)

        cpis = {c.get("ObjectUID"): c for c in root.iter("ClipProjectItem")}
        for b in _bins(root):
            dia = _name_of(b)
            nomes = [_name_of(cpis[uid]) for uid in _children_of(b)]
            # 1 câmera + 1 som + a sequência (que se chama como a diária).
            assert nomes == [f"{dia}_cam.mp4", f"{dia}_snd.wav", dia]

    def test_uma_sequencia_por_diaria(self, tmp_path: Path):
        proj = Project(groups=[_daily("D01", tmp_path), _daily("D02", tmp_path)])
        root = _build(proj)

        assert len(_defs(root, "Sequence")) == 2


class TestAMidiaNaoDUPLICA:
    """
    As asserções aqui olham o XML GERADO, e não o cache do builder.

    A primeira versão destes testes checava `len(b.cam_media)` — e passava mesmo com
    o cache desligado, porque o dicionário tem uma entrada por path de qualquer jeito.
    Ele media a chave, não a consequência. O que importa é quantos `<Media>` o
    Premiere vai encontrar apontando para o mesmo arquivo.
    """

    def _midias_de(self, root: ET.Element, path: Path) -> int:
        return sum(1 for m in root.iter("Media")
                   if m.findtext("FilePath") == str(path))

    def test_um_arquivo_referenciado_duas_vezes_tem_UMA_midia(self, tmp_path: Path):
        """
        A regra de que E8 depende: a sequência do sub-grupo vai referenciar a MESMA
        mídia da diária. Sem o cache, o mesmo arquivo entra duas vezes no projeto — e
        o usuário não tem como saber qual das duas cópias é "a de verdade".
        """
        d = _daily("D01", tmp_path)
        # A MESMA diária, montada duas vezes: é o caminho em que dois pedidos de mídia
        # caem no mesmo arquivo.
        root = _build(Project(groups=[d, d]))

        assert self._midias_de(root, d.cameras[0].path) == 1
        # O WAV tem UM Media POR CANAL (é assim que o Premiere endereça um canal de um
        # multipista) — 5 canais, 5 Media. O que não pode é virarem 10.
        assert self._midias_de(root, d.sounds[0].path) == 5

    def test_arquivos_diferentes_nao_colapsam_num_so(self, tmp_path: Path):
        d1, d2 = _daily("D01", tmp_path), _daily("D02", tmp_path)
        root = _build(Project(groups=[d1, d2]))

        # O cache é por PATH: dois arquivos diferentes são duas mídias, e um cache
        # chaveado errado (pelo nome da diária, digamos) as fundiria.
        assert self._midias_de(root, d1.cameras[0].path) == 1
        assert self._midias_de(root, d2.cameras[0].path) == 1

        arquivos = {m.findtext("FilePath") for m in root.iter("Media")}
        arquivos.discard(None)   # há Media que não é de arquivo (a da sequência)
        assert arquivos == {
            str(d1.cameras[0].path), str(d1.sounds[0].path),
            str(d2.cameras[0].path), str(d2.sounds[0].path),
        }


class TestCadaDiariaTemASuaGradeDeTempo:
    def test_o_fps_de_uma_nao_contamina_a_outra(self, tmp_path: Path):
        """
        Duas diárias podem ter sido filmadas em fps diferentes. A aritmética de ticks
        é medida na grade DE CADA UMA — e como o builder guarda a diária corrente num
        campo (`self.daily`), esquecer de trocá-la mediria a segunda com a régua da
        primeira, em silêncio.
        """
        from prproj.builder import TICKS_PER_SEC

        proj = Project(groups=[
            _daily("D25", tmp_path, fps=25.0),
            _daily("D24", tmp_path, fps=24.0),
        ])
        root = _build(proj)

        # O tpf da SEQUÊNCIA viaja no <FrameRate> do TrackGroup de vídeo, em ticks por
        # frame. (Há outros <FrameRate> no arquivo — os da MÍDIA —, e olhar para eles
        # seria medir o fps do arquivo, não o da grade da sequência.)
        tpfs = {int(e.findtext("./TrackGroup/FrameRate"))
                for e in _defs(root, "VideoTrackGroup")}
        assert tpfs == {round(TICKS_PER_SEC / 25.0), round(TICKS_PER_SEC / 24.0)}

    def test_o_timecode_inicial_e_de_cada_diaria(self, tmp_path: Path):
        proj = Project(groups=[
            _daily("D01", tmp_path, start_tc=0),
            _daily("D02", tmp_path, start_tc=24 * 3600),   # 01:00:00:00 a 24 fps
        ])
        root = _build(proj)

        zeros = {int(e.text) for e in root.iter("MZ.ZeroPoint")}
        tpf = round(254016000000 / 24.0)
        assert zeros == {0, 24 * 3600 * tpf}


class TestSomOrfaoNoExport:
    """Um som SEM câmera correspondente (relógios diferentes) aparece na tela E no
    arquivo — a timeline tem TODOS os arquivos, em sync ou não. Ele vai para a track
    de áudio no seu lugar, mas NÃO entra em Link nenhum (não tem câmera)."""

    def _daily_com_orfao(self, name: str, tmp: Path) -> Daily:
        d = _daily(name, tmp)
        orfa = tmp / f"{name}_orfa.wav"
        orfa.write_bytes(b"x")
        d.orphan_sounds = [SoundClip(
            path=orfa, sample_rate=48000, duration_ms=10000, channels=2,
            timeline_start_frames=500,
        )]
        return d

    def test_o_som_orfao_esta_na_bin_e_tem_midia(self, tmp_path: Path):
        d = self._daily_com_orfao("D01", tmp_path)
        root = _build(Project(groups=[d]))

        # Na bin: câmera, som da tomada, som ÓRFÃO, e a sequência.
        cpis = {c.get("ObjectUID"): c for c in root.iter("ClipProjectItem")}
        b = _bins(root)[0]
        nomes = [_name_of(cpis[uid]) for uid in _children_of(b)]
        assert nomes == ["D01_cam.mp4", "D01_snd.wav", "D01_orfa.wav", "D01"]

        # E tem Media própria — 2 canais, 2 Media (sem entrada na bin, o Premiere o
        # jogaria em "Recovered Clips").
        orfa_path = str(d.orphan_sounds[0].path)
        assert sum(1 for m in root.iter("Media")
                   if m.findtext("FilePath") == orfa_path) == 2

    def test_o_som_orfao_nao_entra_em_Link(self, tmp_path: Path):
        # Sem órfão: 1 tomada = 1 Link. COM órfão: continua 1 Link (o órfão não tem
        # câmera com que andar junto).
        sem = _build(Project(groups=[_daily("D01", tmp_path)]))
        com = _build(Project(groups=[self._daily_com_orfao("D02", tmp_path)]))
        assert len(list(com.iter("Link"))) == len(list(sem.iter("Link")))

    def test_com_som_orfao_ainda_passa_no_validador(self, tmp_path: Path):
        assert validate_root(_build(
            Project(groups=[self._daily_com_orfao("D01", tmp_path)]))) == []


class TestOValidadorAprova:
    def test_um_projeto_de_duas_diarias_passa_no_validador(self, tmp_path: Path):
        proj = Project(groups=[_daily("D01", tmp_path), _daily("D02", tmp_path)])
        assert validate_root(_build(proj)) == []

    def test_um_projeto_VAZIO_ainda_e_um_prproj_valido(self, tmp_path: Path):
        # "Exportar" sem ter sincronizado nada abre um projeto vazio, em vez de
        # estourar.
        assert validate_root(_build(Project())) == []
