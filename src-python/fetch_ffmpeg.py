#!/usr/bin/env python3
"""
fetch_ffmpeg.py — baixa ffmpeg + ffprobe estáticos para src-tauri/binaries/.

POR QUE EXISTE: o app EMBARCA o ffmpeg/ffprobe (externalBin do Tauri) — o usuário
NÃO pode precisar instalar nada (o sync morria com `[Errno 2] ... 'ffmpeg'`).
`src-tauri/binaries/` é gitignored, então os binários nunca vêm do repo: o CI
(.github/workflows/release.yml) e os `setup.*` chamam este script. O Tauri exige
os arquivos `binaries/<nome>-<triple>[.exe]` em tempo de BUILD — sem eles o build
falha com "resource path ... doesn't exist" —, então rodar isto é pré-requisito de
QUALQUER build (dev inclusive), o mesmo padrão do `build_sidecar.py`.

Uma implementação só (Python, já é dependência de build) reusada pelos três — em
vez de duplicar download frágil em bash/pwsh/batch.

FONTES — builds GPL LIMPOS (`--enable-gpl` SEM `--enable-nonfree`, portanto
redistribuíveis; com libx264, que o futuro proxy de vídeo vai precisar). Ambos são
serviços de build mantidos, verificados por `ffmpeg -version` (sem nonfree):
  - macOS arm64: martin-riedl.de, em VERSÃO PINADA 8.1.2 (zips separados por
    ferramenta, binário na raiz).
  - Windows x64: BtbN/FFmpeg-Builds (hospedado no GitHub; um zip com ffmpeg.exe +
    ffprobe.exe). ⚠️ aponta pro `latest` (rola no tempo) — pinar é follow-up.

Uso: python fetch_ffmpeg.py <rust-target-triple>
Idempotente: se os dois binários do alvo já existem, não baixa nada.
"""

from __future__ import annotations

import io
import stat
import sys
import urllib.request
import zipfile
from pathlib import Path

BIN_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "binaries"

# Windows: um zip com os dois .exe dentro (pasta interna muda a cada build).
BTBN_WIN_ZIP = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
# macOS arm64: zips SEPARADOS por ferramenta, versão PINADA (8.1.2, GPL-limpo).
MR_MAC_ARM64 = "https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2"


def _download(url: str) -> bytes:
    print(f"      baixando {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "orbita-fetch-ffmpeg"})
    with urllib.request.urlopen(req) as r:
        return r.read()


def _binary_from_zip(zip_bytes: bytes, tool: str) -> bytes:
    """Extrai o binário `tool` (ffmpeg/ffprobe) de um zip, ache ele numa subpasta
    ou não. Se o zip tiver um único arquivo, é ele."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        wanted = {tool, tool + ".exe"}
        for n in z.namelist():
            if Path(n).name in wanted:
                return z.read(n)
        files = [n for n in z.namelist() if not n.endswith("/")]
        if len(files) == 1:
            return z.read(files[0])
        raise RuntimeError(f"não achei '{tool}' no zip (entradas: {z.namelist()})")


def _write(path: Path, data: bytes, executable: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if executable:
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def fetch(triple: str) -> None:
    win = triple.endswith("windows-msvc")
    ext = ".exe" if win else ""
    ff = BIN_DIR / f"ffmpeg-{triple}{ext}"
    fp = BIN_DIR / f"ffprobe-{triple}{ext}"

    if ff.exists() and fp.exists():
        print(f"      ffmpeg/ffprobe para {triple} já presentes. Ok.")
        return

    if win:
        zip_bytes = _download(BTBN_WIN_ZIP)
        _write(ff, _binary_from_zip(zip_bytes, "ffmpeg"), executable=False)
        _write(fp, _binary_from_zip(zip_bytes, "ffprobe"), executable=False)
    elif triple == "aarch64-apple-darwin":
        _write(ff, _binary_from_zip(_download(f"{MR_MAC_ARM64}/ffmpeg.zip"), "ffmpeg"), executable=True)
        _write(fp, _binary_from_zip(_download(f"{MR_MAC_ARM64}/ffprobe.zip"), "ffprobe"), executable=True)
    else:
        print(f"[ERRO] alvo sem fonte de ffmpeg mapeada: {triple}", file=sys.stderr)
        sys.exit(1)

    print(f"      ffmpeg/ffprobe para {triple} prontos.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("uso: python fetch_ffmpeg.py <rust-target-triple>", file=sys.stderr)
        sys.exit(2)
    fetch(sys.argv[1])
