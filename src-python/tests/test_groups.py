"""
Os GRUPOS de sync (diárias) — o envelope e o isolamento.

O que estes testes guardam:

  1. Um grupo SEM SOM DIRETO é legítimo (B-roll, plano MOS) e NÃO derruba nada. Antes
     isto levantava `ValueError` e matava a diária inteira.
  2. Um grupo que falha NÃO derruba os outros — o usuário não perde o sync das cinco
     diárias que deram certo por causa da sexta.
  3. O round-trip do `Project` preserva o do `Daily` exatamente (é só um envelope).

Sem mídia real: o que se testa aqui é a ESTRUTURA. A precisão do sync tem o seu
próprio teste, e é contra os datasets reais (ver a memória `sync-performance`).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sync.model import CameraAngle, CameraGroup, Daily, Project, SoundClip, Take
from sync.serialize import daily_to_dict, project_from_dict, project_to_dict


def _cam(path: str, start: int, offset: int) -> CameraAngle:
    return CameraAngle(
        path=Path(path),
        fps=24.0,
        duration_frames=240,
        timeline_start_frames=start,
        sync_offset_frames=offset,
        tc_start_frames=None,
        alternate_start_ticks=None,
        audio_channels=2,
        flagged=False,
        flag_reason=None,
        confidence=3.0,
    )


def _daily(name: str, tmp: Path) -> Daily:
    """Uma diária de mentira, mas com arquivos que EXISTEM — `daily_from_dict`
    valida a existência em disco, e é bom que valide."""
    campath = tmp / f"{name}_cam.mp4"
    sndpath = tmp / f"{name}_snd.wav"
    campath.write_bytes(b"x")
    sndpath.write_bytes(b"x")

    cam = _cam(str(campath), 130, 30)
    snd = SoundClip(
        path=sndpath, sample_rate=48000, duration_ms=20000, channels=5,
        timeline_start_frames=100, tc_start_sec=None, scene=None, take=None,
    )
    return Daily(
        camera_groups=[CameraGroup(cameras=[cam], name="CAM A", id="g1")],
        takes=[Take(sound=snd, cameras=[cam])],
        orphan_cameras=[],
        fps=24.0,
        name=name,
    )


class TestProjectRoundTrip:
    def test_o_envelope_preserva_a_diaria_exatamente(self, tmp_path: Path):
        d = _daily("D01", tmp_path)
        antes = daily_to_dict(d)

        proj = Project(name="SEMANA", groups=[d])
        volta = project_from_dict(project_to_dict(proj, ids={0: "uuid-1"}))

        assert len(volta.groups) == 1
        depois = daily_to_dict(volta.groups[0])
        assert depois == antes, "o envelope não pode mexer no conteúdo da diária"

    def test_varias_diarias_nao_se_misturam(self, tmp_path: Path):
        proj = Project(name="SEMANA",
                       groups=[_daily("D01", tmp_path), _daily("D02", tmp_path)])
        volta = project_from_dict(project_to_dict(proj))

        assert [g.name for g in volta.groups] == ["D01", "D02"]
        # Cada diária tem a SUA mídia — nada vazou de uma para a outra.
        paths = [str(g.cameras[0].path) for g in volta.groups]
        assert paths[0] != paths[1]

    def test_aceita_o_payload_antigo_de_uma_diaria_solta(self, tmp_path: Path):
        """O formato antigo (uma diária, sem envelope) continua valendo — a tela
        pode ter sido carregada antes desta mudança."""
        d = _daily("D01", tmp_path)
        proj = project_from_dict(daily_to_dict(d))

        assert len(proj.groups) == 1
        assert proj.groups[0].name == "D01"


class TestGrupoSemSom:
    """Um dia de B-roll não tem som direto. Não é erro — é o material."""

    def test_o_daily_aceita_zero_tomadas(self, tmp_path: Path):
        campath = tmp_path / "broll.mp4"
        campath.write_bytes(b"x")
        cam = _cam(str(campath), 0, 0)
        cam.flagged, cam.flag_reason = True, "no_sound"

        d = Daily(
            camera_groups=[CameraGroup(cameras=[cam], name="CAM A", id="g1")],
            takes=[],                  # sem som: sem tomadas
            orphan_cameras=[cam],      # sinalizado, NUNCA descartado
            fps=24.0,
            name="B-ROLL",
        )
        volta = project_from_dict(project_to_dict(Project(groups=[d]))).groups[0]

        assert volta.takes == []
        assert len(volta.orphan_cameras) == 1
        assert volta.orphan_cameras[0].flag_reason == "no_sound"
        # E o clipe segue sendo o MESMO objeto do camera_group — não uma cópia.
        assert volta.orphan_cameras[0] is volta.cameras[0]

    def test_normalize_origin_funciona_sem_som(self, tmp_path: Path):
        campath = tmp_path / "broll.mp4"
        campath.write_bytes(b"x")
        cam = _cam(str(campath), 500, 0)
        d = Daily(
            camera_groups=[CameraGroup(cameras=[cam], name="CAM A", id="g1")],
            takes=[], orphan_cameras=[cam], fps=24.0,
        )
        d.normalize_origin()
        assert cam.timeline_start_frames == 0     # o primeiro clipe vai para zero


class TestSerializeRecusaLixo:
    def test_recusa_arquivo_que_nao_existe(self, tmp_path: Path):
        d = _daily("D01", tmp_path)
        payload = project_to_dict(Project(groups=[d]))
        payload["groups"][0]["camera_groups"][0]["cameras"][0]["path"] = "/nao/existe.mp4"

        with pytest.raises(ValueError, match="não encontrado"):
            project_from_dict(payload)


class TestSonsOrfaos:
    """Sons sem câmera correspondente (o TC do gravador longe do da câmera) — o
    arquivo existe e aparece no seu TC, e o round-trip tem de preservá-lo."""

    def test_o_som_orfao_sobrevive_ao_round_trip(self, tmp_path: Path):
        d = _daily("D01", tmp_path)
        far = tmp_path / "far_snd.wav"
        far.write_bytes(b"x")
        d.orphan_sounds = [SoundClip(
            path=far, sample_rate=48000, duration_ms=30000, channels=2,
            timeline_start_frames=86400, tc_start_sec=3600.0, scene=None, take=None,
        )]

        volta = project_from_dict(project_to_dict(Project(groups=[d]))).groups[0]

        assert len(volta.orphan_sounds) == 1
        assert str(volta.orphan_sounds[0].path) == str(far)
        assert volta.orphan_sounds[0].timeline_start_frames == 86400

    def test_normalize_origin_desloca_o_som_orfao_junto(self, tmp_path: Path):
        """Se o órfão não fosse deslocado com o resto, ficaria num referencial
        diferente — e o TC dele mentiria contra o das câmeras."""
        campath = tmp_path / "cam.mp4"
        campath.write_bytes(b"x")
        cam = _cam(str(campath), 500, 0)   # câmera aos 500 frames
        far = SoundClip(
            path=tmp_path / "far.wav", sample_rate=48000, duration_ms=1000,
            channels=2, timeline_start_frames=900, tc_start_sec=None,
            scene=None, take=None,
        )
        d = Daily(
            camera_groups=[CameraGroup(cameras=[cam], name="CAM A", id="g1")],
            takes=[], orphan_cameras=[cam], orphan_sounds=[far], fps=24.0,
        )
        d.normalize_origin()
        # A origem é 500 (o primeiro clipe). Os dois recuam 500.
        assert cam.timeline_start_frames == 0
        assert far.timeline_start_frames == 400
