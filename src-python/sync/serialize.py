"""
Orbita — serialização do Daily para/de JSON.

Um único módulo é dono das DUAS direções, de propósito: a fidelidade do
round-trip (sync → frontend → exportar) fica estrutural em vez de depender de
duas implementações combinarem por convenção.

Por que existe: o fluxo é em duas etapas — "Sincronizar" calcula e devolve o
resultado ao frontend (que desenha a timeline), e "Exportar" gera o arquivo a
partir DESSE resultado, sem re-sincronizar. O frontend é a fonte da verdade: o
que está na tela é o que é exportado, inclusive as correções manuais.

A FORMA do JSON espelha a do modelo, com uma diferença: os clipes de câmera
aparecem UMA VEZ, dentro dos `camera_groups`, e as tomadas os referenciam por
`path`. Duplicá-los abriria a porta para as duas cópias divergirem — e o path é
a identidade estável de um clipe em todo o app (a timeline já faz upsert por
path).

Peaks de waveform NÃO passam por aqui: viajam pelos eventos de progresso e não
fazem parte do modelo de domínio.
"""

from __future__ import annotations

from pathlib import Path

from sync.model import (
    CameraAngle, CameraGroup, Daily, Project, SoundClip, SubGroup, Take,
)


def _camera_to_dict(c: CameraAngle) -> dict:
    return {
        "path": str(c.path),
        "name": c.path.name,
        "fps": c.fps,
        "duration_frames": c.duration_frames,
        "timeline_start_frames": c.timeline_start_frames,
        "sync_offset_frames": c.sync_offset_frames,
        "tc_start_frames": c.tc_start_frames,
        "alternate_start_ticks": c.alternate_start_ticks,
        "audio_channels": c.audio_channels,
        "flagged": c.flagged,
        "flag_reason": c.flag_reason,
        "confidence": c.confidence,
        "sync_source": c.sync_source,
    }


def _sound_to_dict(s: SoundClip) -> dict:
    return {
        "path": str(s.path),
        "name": s.path.name,
        "sample_rate": s.sample_rate,
        "duration_ms": s.duration_ms,
        "channels": s.channels,
        "timeline_start_frames": s.timeline_start_frames,
        "tc_start_sec": s.tc_start_sec,
        "scene": s.scene,
        "take": s.take,
    }


def daily_to_dict(daily: Daily) -> dict:
    return {
        "fps": daily.fps,
        "name": daily.name,
        "start_tc_frames": daily.start_tc_frames,
        "camera_groups": [
            {
                "id": g.id,
                "name": g.name,
                "cameras": [_camera_to_dict(c) for c in g.cameras],
            }
            for g in daily.camera_groups
        ],
        "takes": [
            {
                "name": t.name,
                "sound": _sound_to_dict(t.sound),
                # Só as chaves: os clipes já viajaram inteiros nos camera_groups.
                "camera_paths": [str(c.path) for c in t.cameras],
            }
            for t in daily.takes
        ],
        "orphan_paths": [str(c.path) for c in daily.orphan_cameras],
        # Sons sem câmera correspondente — mostrados no seu TC, nunca descartados.
        "orphan_sounds": [_sound_to_dict(s) for s in daily.orphan_sounds],
        "sub_groups": [
            {"id": sg.id, "name": sg.name, "paths": list(sg.paths)}
            for sg in daily.sub_groups
        ],
    }


def daily_from_dict(d: dict) -> Daily:
    """
    Reconstrói o Daily a partir do que o frontend devolve.

    Ignora chaves desconhecidas (o payload da tela carrega extras de exibição) e
    valida o essencial, para que um payload corrompido falhe AQUI, com mensagem
    clara — e não lá dentro do gerador de XML.
    """
    fps = d.get("fps")
    if not isinstance(fps, (int, float)) or fps <= 0:
        raise ValueError(f"fps inválido no resultado do sync: {fps!r}")

    start_tc = d.get("start_tc_frames") or 0
    if not isinstance(start_tc, int) or start_tc < 0:
        raise ValueError(f"start_tc_frames inválido: {start_tc!r}")

    by_path: dict[str, CameraAngle] = {}
    camera_groups: list[CameraGroup] = []

    for g in d.get("camera_groups") or []:
        cams: list[CameraAngle] = []
        for c in g.get("cameras") or []:
            path = Path(c["path"])
            if not path.exists():
                raise ValueError(f"Arquivo de câmera não encontrado: {path}")
            cam = CameraAngle(
                path=path,
                fps=float(c.get("fps") or fps),
                duration_frames=int(c["duration_frames"]),
                timeline_start_frames=int(c.get("timeline_start_frames") or 0),
                sync_offset_frames=int(c.get("sync_offset_frames") or 0),
                tc_start_frames=c.get("tc_start_frames"),
                alternate_start_ticks=c.get("alternate_start_ticks"),
                audio_channels=int(c.get("audio_channels") or 2),
                flagged=bool(c.get("flagged", False)),
                flag_reason=c.get("flag_reason"),
                confidence=float(c.get("confidence") or 0.0),
                sync_source=c.get("sync_source"),
            )
            by_path[str(path)] = cam
            cams.append(cam)
        if cams:
            camera_groups.append(
                CameraGroup(cameras=cams, name=g.get("name") or "", id=g.get("id") or "")
            )

    if not camera_groups:
        raise ValueError("Resultado do sync sem nenhuma câmera.")

    takes: list[Take] = []
    for t in d.get("takes") or []:
        s = t.get("sound") or {}
        spath = Path(s.get("path") or "")
        if not spath.exists():
            raise ValueError(f"Som direto não encontrado: {spath}")
        sound = SoundClip(
            path=spath,
            sample_rate=int(s.get("sample_rate") or 48000),
            duration_ms=float(s.get("duration_ms") or 0.0),
            channels=int(s.get("channels") or 2),
            timeline_start_frames=int(s.get("timeline_start_frames") or 0),
            tc_start_sec=s.get("tc_start_sec"),
            scene=s.get("scene"),
            take=s.get("take"),
        )
        # Os MESMOS objetos dos camera_groups — nunca cópias. É o que garante que
        # uma correção manual chegue ao merged clip e à sequência multicam de uma
        # vez só (ver o cabeçalho de sync/model.py).
        cams = [by_path[p] for p in (t.get("camera_paths") or []) if p in by_path]
        if cams:
            takes.append(Take(sound=sound, cameras=cams))

    orphans = [by_path[p] for p in (d.get("orphan_paths") or []) if p in by_path]

    # Sons órfãos (sem câmera). Reconstruídos como qualquer SoundClip; um arquivo que
    # sumiu é descartado em silêncio (a poda é do frontend, e chegar aqui já podado
    # é o normal).
    orphan_sounds: list[SoundClip] = []
    for s in d.get("orphan_sounds") or []:
        spath = Path(s.get("path") or "")
        if not spath.exists():
            continue
        orphan_sounds.append(SoundClip(
            path=spath,
            sample_rate=int(s.get("sample_rate") or 48000),
            duration_ms=float(s.get("duration_ms") or 0.0),
            channels=int(s.get("channels") or 2),
            timeline_start_frames=int(s.get("timeline_start_frames") or 0),
            tc_start_sec=s.get("tc_start_sec"),
            scene=s.get("scene"),
            take=s.get("take"),
        ))

    # As cenas. Os paths chegam JÁ RESOLVIDOS (o som das tomadas vem junto) — aqui
    # não se decide nada, só se carrega. Um path que não está mais na diária é
    # descartado em silêncio: a poda é do frontend, e chegar aqui já podado é o
    # normal; insistir num arquivo que não existe mais só quebraria o export.
    known = set(by_path) | {str(t.sound.path) for t in takes} \
        | {str(s.path) for s in orphan_sounds}
    sub_groups = [
        SubGroup(
            id=str(sg.get("id") or sg.get("name") or ""),
            name=str(sg.get("name") or ""),
            paths=[p for p in (sg.get("paths") or []) if p in known],
        )
        for sg in (d.get("sub_groups") or [])
    ]

    return Daily(
        camera_groups=camera_groups,
        takes=takes,
        orphan_cameras=orphans,
        orphan_sounds=orphan_sounds,
        sub_groups=sub_groups,
        fps=float(fps),
        name=d.get("name") or "DIARIA",
        start_tc_frames=start_tc,
    )


# ── O envelope: N diárias ────────────────────────────────────────────────────
#
# `daily_to_dict`/`daily_from_dict` NÃO mudam. As duas funções abaixo só embrulham —
# é o que mantém o round-trip de uma diária exatamente como estava (e os testes de
# regressão do sync comparáveis, frame a frame, com o que já foi validado no
# Premiere). O `id` viaja junto porque é a identidade que o FRONTEND deu ao grupo, e
# é por ele que o resultado volta para a diária certa na tela.


def project_to_dict(project: Project, ids: dict[int, str] | None = None) -> dict:
    """`ids` mapeia índice → id do grupo no frontend. Sem ele, cai no nome."""
    ids = ids or {}
    return {
        "name": project.name,
        "groups": [
            {**daily_to_dict(daily), "id": ids.get(i, daily.name)}
            for i, daily in enumerate(project.groups)
        ],
    }


def project_from_dict(d: dict) -> Project:
    """
    Aceita o payload novo (`{groups: [...]}`) e o ANTIGO (uma diária solta).

    O formato antigo continua valendo porque o `export_prproj_from_result` é chamado
    com o que a tela tem, e a tela pode ter sido carregada antes desta mudança — mas
    também porque uma diária só é o caso comum, e forçar um envelope onde não há nada
    a envelopar seria cerimônia.
    """
    groups = d.get("groups")
    if groups is None:
        return Project(name=d.get("name") or "PROJETO", groups=[daily_from_dict(d)])
    return Project(
        name=d.get("name") or "PROJETO",
        groups=[daily_from_dict(g) for g in groups],
    )
