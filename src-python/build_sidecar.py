#!/usr/bin/env python3
"""
build_sidecar.py — empacota o sidecar Python num binário standalone
(PyInstaller), para o Tauri embutir no app via `externalBin`.

Uso: python build_sidecar.py <target-triple-do-rust>
  (ex.: aarch64-apple-darwin, x86_64-pc-windows-msvc)

Roda em CI (ver .github/workflows/release.yml), antes do `tauri build`. Pode
rodar localmente também — é só isso que o script faz, nada mágico:
  1. PyInstaller --onefile em main.py
  2. copia o binário pra src-tauri/binaries/orbita-python-<target>[.exe]

`--hidden-import=importlib.resources`: sem isso, `scipy.stats._sobol` (import
dinâmico) quebra em runtime com "No module named 'importlib.resources'" — o
PyInstaller não detecta esse import por análise estática. Descoberto rodando
o binário de verdade (não só o build "sem erro"), ver docs/adr se existir uma
entrada sobre isso.
"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
BINARIES_DIR = HERE.parent / "src-tauri" / "binaries"


def main() -> None:
    if len(sys.argv) != 2:
        print("uso: python build_sidecar.py <target-triple>", file=sys.stderr)
        sys.exit(1)
    target = sys.argv[1]
    is_windows = "windows" in target

    subprocess.run(
        [
            sys.executable, "-m", "PyInstaller",
            "--name", "orbita-python",
            "--onefile", "--clean", "--noconfirm",
            "--hidden-import=importlib.resources",
            str(HERE / "main.py"),
        ],
        cwd=HERE,
        check=True,
    )

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    src_name = "orbita-python.exe" if is_windows else "orbita-python"
    dest_name = f"orbita-python-{target}.exe" if is_windows else f"orbita-python-{target}"
    shutil.copy2(HERE / "dist" / src_name, BINARIES_DIR / dest_name)
    print(f"Sidecar empacotado em {BINARIES_DIR / dest_name}")


if __name__ == "__main__":
    main()
