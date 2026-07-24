"""
Orbita — proxy de vídeo para o monitor: transcodifica um TRECHO curto de uma mídia
que o WebView não decodifica (ProRes, MXF…) para um H.264 leve que o `<video>` toca
frame-exato.

POR QUE EXISTE: o monitor de sync precisa de exatidão AO FRAME (a claquete tem que
bater no ponto do pico do som). O `<video>` do WebView dá isso nativamente, mas não
decodifica ProRes no Windows. Em vez de um player nativo (VLC — que MENTE no seek
pausado, cai no keyframe anterior), geramos um proxy do trecho e o tocamos no
próprio `<video>`. Como o uso real é PULAR pra pontos de sync (não assistir tudo),
um trecho de ~10 s basta; e o custo vira cache, não decode em tempo real.

REGRA CRÍTICA — o proxy é ALL-INTRA (`-g 1`): cada frame é keyframe, então o seek
pausado no `<video>` é exato. Um proxy long-GOP re-introduziria a mentira do VLC.

TETO EM FULL HD: o monitor é pequeno; mídia acima de FHD nunca é transcodificada em
resolução nativa. "full" já é FHD-capped (respeitando o aspect ratio); ½ e ¼ são
relativos a esse teto. Mantém o custo previsível independente da câmera.

O áudio NÃO entra aqui (`-an`): quem toca o som é o `transport.ts`, exato à amostra.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from . import cachedir, fftools

#: Tetos por nível de resolução (largura, altura), respeitando o aspect ratio.
#: "full" é FHD-capped, não a resolução do arquivo; ½ e ¼ são relativos a ele.
RES_CAPS: dict[str, tuple[int, int]] = {
    "full": (1920, 1080),
    "half": (960, 540),
    "quarter": (480, 270),
}
DEFAULT_RES = "half"


def _cap(resolution: str) -> tuple[int, int]:
    return RES_CAPS.get(resolution, RES_CAPS[DEFAULT_RES])


def scale_filter(resolution: str) -> str:
    """Filtro `-vf` que cabe no teto do nível SEM esticar, preserva o aspect ratio,
    e garante dimensões pares (o H.264 exige). A vírgula dentro de `min()` é
    escapada (`\\,`) porque no filtergraph a vírgula separa filtros."""
    w, h = _cap(resolution)
    return (
        f"scale=w='min({w}\\,iw)':h='min({h}\\,ih)'"
        ":force_original_aspect_ratio=decrease:force_divisible_by=2"
    )


def _cache_root() -> Path:
    return cachedir.sub("proxy")


def _file_for(path: Path, start: float, dur: float, resolution: str) -> Path | None:
    """Chave = caminho+tamanho+mtime+janela+resolução (mesmo esquema do probecache):
    se a mídia OU a janela OU a resolução mudam, o proxy não vale."""
    try:
        st = path.stat()
    except OSError:
        return None
    raw = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}|{start:.3f}|{dur:.3f}|{resolution}"
    return _cache_root() / f"{hashlib.sha1(raw.encode('utf-8')).hexdigest()}.mp4"


def window(
    path: str | Path, start: float, dur: float, resolution: str = DEFAULT_RES
) -> Path:
    """Proxy H.264 all-intra do trecho `[start, start+dur)`, cacheado. Devolve o
    caminho do .mp4. O trecho começa em t=0 no proxy (o frontend mapeia a posição
    da timeline para o tempo-local do proxy)."""
    path = Path(path)
    out = _file_for(path, start, dur, resolution)
    if out is None:
        raise RuntimeError(f"arquivo não encontrado: {path}")
    if out.is_file():
        cachedir.touch(out)  # LRU por último USO
        return out

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part.mp4")
    cmd = [
        fftools.ffmpeg(), "-v", "error", "-y",
        "-ss", f"{max(0.0, start):.6f}",  # antes do -i: busca rápida e exata
        "-i", str(path),
        "-t", f"{dur:.6f}",
        "-an",                             # o som vem do transporte, não daqui
        "-vf", scale_filter(resolution),
        "-c:v", "libx264", "-preset", "veryfast",
        "-g", "1",                         # ALL-INTRA — seek pausado exato no <video>
        "-pix_fmt", "yuv420p",             # compatível com o <video> do WebView
        "-movflags", "+faststart",
        str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=300, errors="replace")
    if result.returncode != 0 or not tmp.exists():
        raise RuntimeError(
            f"ffmpeg falhou ao gerar proxy de '{path}': "
            + (result.stderr or "")[-500:]
        )
    tmp.replace(out)          # atômico: nunca um proxy meio-escrito no cache
    cachedir.maybe_enforce()
    return out


def _preview_file_for(path: Path, resolution: str) -> Path | None:
    try:
        st = path.stat()
    except OSError:
        return None
    raw = f"preview|{path.resolve()}|{st.st_size}|{int(st.st_mtime)}|{resolution}"
    return _cache_root() / f"{hashlib.sha1(raw.encode('utf-8')).hexdigest()}.mp4"


def preview(path: str | Path, resolution: str = DEFAULT_RES) -> Path:
    """Proxy do CLIPE INTEIRO, COM áudio, para a prévia do bin (duplo-clique num
    arquivo: "olhar com som", tocado no `<video controls>` nativo).

    Diferente do `window()`: (1) clipe inteiro, não uma janela — a prévia tem barra
    de seek do arquivo todo; (2) COM áudio (aqui o som É do clipe, ao contrário do
    monitor, mudo); (3) GOP NORMAL, não all-intra — a prévia é visualização casual,
    não sync-check ao frame, e all-intra num clipe longo incharia o cache."""
    path = Path(path)
    out = _preview_file_for(path, resolution)
    if out is None:
        raise RuntimeError(f"arquivo não encontrado: {path}")
    if out.is_file():
        cachedir.touch(out)
        return out

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part.mp4")
    cmd = [
        fftools.ffmpeg(), "-v", "error", "-y",
        "-i", str(path),
        "-vf", scale_filter(resolution),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",   # a prévia TEM som (o do próprio clipe)
        "-movflags", "+faststart",
        str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=1800, errors="replace")
    if result.returncode != 0 or not tmp.exists():
        raise RuntimeError(
            f"ffmpeg falhou ao gerar prévia de '{path}': " + (result.stderr or "")[-500:]
        )
    tmp.replace(out)
    cachedir.maybe_enforce()
    return out
