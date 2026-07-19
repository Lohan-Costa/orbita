"""
Orbita — Media Inspector
Extrai metadados técnicos de arquivos de vídeo e áudio.

Timecode — onde ele REALMENTE mora (custou um bug, 2026-07-12):

  Vídeo (.mp4/.mov): NÃO está no track General. Está num track separado, que o
  MediaInfo reporta como `track_type == "Other"` (é o tmcd do QuickTime).
  Procurar só no General fazia o app achar que material com TC não tinha TC — e,
  sem TC, a timeline não tinha como distribuir os clipes ao longo do dia.

  WAV (BWF): o MediaInfo NÃO expõe o `time_reference` do chunk bext (só admite
  que ele existe, em `delay__origin`). Quem lê é o ffprobe. `time_reference` é a
  contagem de AMOSTRAS desde a meia-noite — a origem do TC do gravador.

Gravadores de som também escrevem CENA e TOMADA nos metadados do BWF
(`SCENE`, `TAKE`), que é como o material se organiza de verdade numa diária.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def _parse_encoded_date(raw: str | None) -> str | None:
    """
    Converte o 'encoded_date' do MediaInfo (data/hora real de gravação, gravada
    pela própria câmera no container QuickTime — não confundir com datas do
    sistema de arquivos, que mudam ao copiar) para ISO 8601 comparável.

    Formatos observados: 'YYYY-MM-DD HH:MM:SS UTC' ou 'YYYY-MM-DD HH:MM:SS'.
    Retorna None se ausente ou não reconhecido.
    """
    if not raw:
        return None
    raw = raw.strip()
    for fmt, tz in (("%Y-%m-%d %H:%M:%S UTC", timezone.utc), ("%Y-%m-%d %H:%M:%S", None)):
        try:
            dt = datetime.strptime(raw, fmt)
            if tz is not None:
                dt = dt.replace(tzinfo=tz)
            return dt.isoformat()
        except ValueError:
            continue
    return None


def _ffprobe_tags_text(path: str) -> str:
    """
    Tags de formato via ffprobe, como TEXTO CRU — de propósito, não como JSON.

    Gravadores de som emitem MAIS DE UMA tag `comment` (o ZOOM F8 manda um blob
    `CHAVE=valor` e depois uma nota livre). Em JSON as chaves repetidas colapsam
    e a última vence, o que apagava justamente o blob com SCENE/TAKE. No texto
    cru as duas sobrevivem.

    Vazio se o ffprobe não estiver instalado — o app segue, só sem o TC do WAV.
    """
    exe = shutil.which("ffprobe")
    if not exe:
        return ""
    try:
        return subprocess.run(
            [exe, "-v", "error", "-show_entries", "format_tags", "-of", "default", path],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
    except Exception:
        return ""


def _bwf_start_seconds(tags_text: str, sample_rate: int | None) -> float | None:
    """
    Início do WAV em segundos desde a meia-noite, do chunk bext do BWF.

    `time_reference` conta AMOSTRAS desde a meia-noite — é a origem do TC do
    gravador de som.
    """
    if not sample_rate:
        return None
    m = re.search(r"^TAG:time_reference=(\d+)\s*$", tags_text, re.MULTILINE)
    if not m:
        return None
    return int(m.group(1)) / float(sample_rate)


def _scene_take(tags_text: str) -> tuple[str | None, str | None]:
    """
    Cena e tomada, dos metadados que o gravador de som escreve no BWF.

    É a organização REAL de uma diária de ficção — o mesmo que está na claquete e
    no relatório de continuidade. Vem dentro do blob `comment` (linhas
    `CHAVE=valor`), não em tags próprias.
    """
    scene = re.search(r"^SCENE=(.*)$", tags_text, re.MULTILINE)
    take = re.search(r"^TAKE=(.*)$", tags_text, re.MULTILINE)
    s = scene.group(1).strip() if scene else None
    t = take.group(1).strip() if take else None
    return (s or None), (t or None)


def _codec_label(vt) -> str | None:
    """Nome amigável do codec (ex.: 'ProRes 422 HQ', 'H.264', 'XDCAM 50')."""
    if vt is None:
        return None
    commercial = getattr(vt, "commercial_name", None) or getattr(vt, "format_commercial", None)
    if commercial:
        c = str(commercial).strip()
        if c.startswith("Apple "):
            c = c[len("Apple "):]
        if c.upper() == "XDCAM HD422":
            return "XDCAM 50"
        return c
    fmt  = getattr(vt, "format", None)
    prof = getattr(vt, "format_profile", None)
    if fmt:
        f = str(fmt).strip()
        fu = f.upper()
        if fu == "AVC":
            return "H.264"
        if fu == "HEVC":
            return "H.265"
        if "PRORES" in fu:
            return f"ProRes {prof}".strip() if prof else "ProRes"
        return f"{f} {prof}".strip() if prof else f
    return None


def probe(path: str) -> dict:
    """
    Extrai metadados de um arquivo de mídia via pymediainfo.

    Retorna dict com:
        path, filename, extension, size_bytes,
        fps, tc_start, duration_ms, width, height,
        codec_label, has_audio, sample_rate, sample_depth

    O resultado é CACHEADO em disco por (caminho, tamanho, mtime): numa diária de
    50 clipes, o primeiro sync lê todos, mas o re-sync parcial (que relê todos só
    para montar o contexto) fica instantâneo. Ver `media/probecache.py`.
    """
    from media import probecache

    cached = probecache.load(path)
    if cached is not None:
        return cached
    meta = _probe_uncached(path)
    probecache.store(path, meta)
    return meta


def _probe_uncached(path: str) -> dict:
    from pymediainfo import MediaInfo

    fp = Path(path)

    media_info = MediaInfo.parse(str(fp))

    video_track = next(
        (t for t in media_info.tracks if t.track_type == "Video"), None
    )
    audio_track = next(
        (t for t in media_info.tracks if t.track_type == "Audio"), None
    )
    general_track = next(
        (t for t in media_info.tracks if t.track_type == "General"), None
    )

    result: dict = {
        "path": str(fp),
        "filename": fp.name,
        "extension": fp.suffix.lower(),
        "has_audio": audio_track is not None,
        "recorded_at": _parse_encoded_date(getattr(general_track, "encoded_date", None)),
    }

    try:
        result["size_bytes"] = fp.stat().st_size
    except OSError:
        result["size_bytes"] = None

    if video_track:
        fps = float(video_track.frame_rate) if video_track.frame_rate else None
        duration_ms = float(video_track.duration) if video_track.duration else None

        # O TC do vídeo mora no track do TIMECODE (o tmcd), que o MediaInfo
        # reporta como "Other" — não no General. Ver o cabeçalho do módulo.
        tc_track = next(
            (t for t in media_info.tracks
             if t.track_type == "Other"
             and getattr(t, "time_code_of_first_frame", None)),
            None,
        )
        tc_start = getattr(tc_track, "time_code_of_first_frame", None)
        drop_frame = str(getattr(tc_track, "timecode_dropframe", "")).lower() == "yes"

        if not tc_start and general_track:
            tc_start = (
                getattr(general_track, "time_code_of_first_frame", None)
                or getattr(general_track, "comapplequicktimetimecode", None)
            )

        result.update(
            {
                "fps": fps,
                "tc_start": tc_start,
                "tc_drop_frame": drop_frame,
                "duration_ms": duration_ms,
                "width": int(video_track.width) if video_track.width else None,
                "height": int(video_track.height) if video_track.height else None,
                "codec_label": _codec_label(video_track),
            }
        )
    else:
        # Arquivo de áudio puro: usa duração do general track
        if general_track and getattr(general_track, "duration", None):
            result["duration_ms"] = float(general_track.duration)

    if audio_track:
        sample_rate = (
            int(audio_track.sampling_rate) if audio_track.sampling_rate else None
        )
        result["sample_rate"] = sample_rate
        result["sample_depth"] = (
            int(audio_track.bit_depth) if getattr(audio_track, "bit_depth", None) else None
        )
        result["channels"] = (
            int(audio_track.channel_s) if getattr(audio_track, "channel_s", None) else None
        )

        # Só arquivos de áudio puro: num vídeo, o TC que vale é o do tmcd.
        if not video_track:
            tags = _ffprobe_tags_text(str(fp))
            result["tc_start_sec"] = _bwf_start_seconds(tags, sample_rate)
            result["scene"], result["take"] = _scene_take(tags)

    return result
