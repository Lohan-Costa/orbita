"""
Orbita — extração de PCM mono para cross-correlação de waveform.

Usa ffmpeg para converter qualquer mídia (MOV, WAV, MP4 …) para PCM 32-bit float
mono a 8 kHz. A taxa baixa reduz a memória e a CPU sem perder precisão de sync
(resolução de 1/8000 s ≈ 0,125 ms, muito abaixo de um frame a 24fps ≈ 41 ms).

LER O ARQUIVO INTEIRO É CARO, E QUASE SEMPRE DESNECESSÁRIO
──────────────────────────────────────────────────────────
O áudio de uma câmera vive INTERLEAVADO com o vídeo. Para pegar 47 s de áudio de
um MXF ProRes, o ffmpeg atravessa os 2,4 GB do arquivo — 9 s num disco rápido. Uma
diária de Alexa (42 clipes, 202 GB) levava 18 MINUTOS só nisto.

`extract_pcm_window` lê só o trecho pedido. O custo é proporcional à JANELA, não ao
arquivo (medido, a frio: 5 s → 1,0 s; 10 s → 2,0 s; 20 s → 4,1 s; inteiro → 11,7 s).
Quando o timecode já diz onde o clipe cai, uma janela basta para CONFERIR — e é o
que o engine faz. Ver `sync/waveform.confirm_offset`.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np

PCM_RATE = 8000   # Hz — resolução suficiente para sync; muda só aqui se precisar


def _run(cmd: list[str], path: str) -> np.ndarray:
    result = subprocess.run(cmd, capture_output=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg falhou ao extrair PCM de '{path}': "
            + result.stderr.decode(errors="replace")[-500:]
        )
    return np.frombuffer(result.stdout, dtype=np.float32).copy()


def extract_pcm(path: str | Path, channel: int = 0) -> np.ndarray:
    """
    Extrai o canal `channel` (0-based) de `path` como array float32 mono a PCM_RATE Hz.

    Lê o arquivo INTEIRO — caro em mídia de câmera (ver o cabeçalho do módulo).
    Preferir `extract_pcm_window` sempre que se souber onde olhar.
    """
    path = str(Path(path))
    return _run([
        "ffmpeg", "-v", "error",
        "-i", path,
        "-af", f"pan=mono|c0=c{channel}",
        "-ar", str(PCM_RATE), "-ac", "1",
        "-f", "f32le", "-vn",
        "pipe:1",
    ], path)


def extract_pcm_window(
    path: str | Path, start_s: float, dur_s: float, channel: int = 0
) -> np.ndarray:
    """
    O mesmo, mas só de `[start_s, start_s + dur_s)`.

    `-ss` ANTES do `-i` é busca rápida — e, no ffmpeg moderno, **exata à amostra**
    (medido contra a extração integral: deslocamento zero, correlação 1,0000, em
    MXF/ProRes, mp4/AAC e WAV). Isso é load-bearing: se a janela não começasse na
    amostra pedida, o offset medido nela estaria errado pelo mesmo tanto.

    Perto do fim do arquivo o ffmpeg simplesmente devolve menos amostras — quem
    chama confere o tamanho.
    """
    path = str(Path(path))
    if dur_s <= 0:
        return np.zeros(0, dtype=np.float32)
    return _run([
        "ffmpeg", "-v", "error",
        "-ss", f"{max(0.0, start_s):.6f}",
        "-t", f"{dur_s:.6f}",
        "-i", path,
        "-af", f"pan=mono|c0=c{channel}",
        "-ar", str(PCM_RATE), "-ac", "1",
        "-f", "f32le", "-vn",
        "pipe:1",
    ], path)


def normalize(pcm: np.ndarray) -> np.ndarray:
    """Normaliza para pico 1.0; retorna array de zeros se silêncio."""
    peak = np.max(np.abs(pcm))
    if peak < 1e-9:
        return np.zeros_like(pcm)
    return pcm / peak
