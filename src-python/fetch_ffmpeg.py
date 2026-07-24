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

FONTES — VENDORIZADAS: os binários vêm de um release nosso no PRÓPRIO repo público
(`Lohan-Costa/orbita`, tag `vendor-ffmpeg-8.1.2`), re-hospedados UMA vez a partir do
upstream. Assim o build não depende da disponibilidade de terceiros nem de tags que
rolam/são podadas (o BtbN, por exemplo, apaga autobuilds antigos). São builds GPL
LIMPOS (`--enable-gpl` SEM `--enable-nonfree`, redistribuíveis; com libx264, que o
proxy de vídeo futuro vai precisar), verificados por `ffmpeg -version`. Origem:
  - macOS arm64: martin-riedl.de 8.1.2 (zips separados por ferramenta).
  - Windows x64: BtbN autobuild-2026-07-21-13-38, n8.1.2 win64-gpl (um zip com os
    dois .exe). Ambos os SOs em ffmpeg 8.1.2.
Para ATUALIZAR: baixar do upstream, conferir `ffmpeg -version | grep nonfree`,
subir num release vendor NOVO e bumpar `VENDOR` abaixo.

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

# Release de VENDOR no nosso repo público (imutável, sob nosso controle).
VENDOR = "https://github.com/Lohan-Costa/orbita/releases/download/vendor-ffmpeg-8.1.2"
WIN_ZIP = f"{VENDOR}/ffmpeg-win64-gpl.zip"          # um zip com ffmpeg.exe + ffprobe.exe
MAC_FFMPEG_ZIP = f"{VENDOR}/ffmpeg-macos-arm64.zip"  # zips separados por ferramenta
MAC_FFPROBE_ZIP = f"{VENDOR}/ffprobe-macos-arm64.zip"


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
        zip_bytes = _download(WIN_ZIP)
        _write(ff, _binary_from_zip(zip_bytes, "ffmpeg"), executable=False)
        _write(fp, _binary_from_zip(zip_bytes, "ffprobe"), executable=False)
    elif triple == "aarch64-apple-darwin":
        _write(ff, _binary_from_zip(_download(MAC_FFMPEG_ZIP), "ffmpeg"), executable=True)
        _write(fp, _binary_from_zip(_download(MAC_FFPROBE_ZIP), "ffprobe"), executable=True)
    else:
        print(f"[ERRO] alvo sem fonte de ffmpeg mapeada: {triple}", file=sys.stderr)
        sys.exit(1)

    print(f"      ffmpeg/ffprobe para {triple} prontos.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("uso: python fetch_ffmpeg.py <rust-target-triple>", file=sys.stderr)
        sys.exit(2)
    fetch(sys.argv[1])
