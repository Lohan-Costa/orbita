"""
Orbita — cache em disco dos METADADOS (o que `inspector.probe` devolve).

POR QUE EXISTE: ler os metadados de um arquivo (pymediainfo + ffprobe) é rápido
por arquivo, mas numa diária de 50 clipes soma segundos — e um RE-SYNC parcial os
relê TODOS só para montar o contexto, mesmo mexendo em um clipe só. O usuário via
"Metadados: 17 de 50" antes de o processamento começar. Com o cache, a segunda
leitura (e todo re-sync depois do primeiro sync) é instantânea.

A CHAVE inclui tamanho e mtime do arquivo — se a mídia mudou, o cache não vale.
Mesma regra do `peakcache`: nunca chavear só pelo caminho.

O VALOR é o dict de `probe` serializado em JSON. Os valores são primitivos
(str/int/float/bool/None), então o round-trip é fiel.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


def _cache_root() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches" / "Orbita"
    elif os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        base = (Path(local) if local else Path.home()) / "Orbita" / "Cache"
    else:
        xdg = os.environ.get("XDG_CACHE_HOME")
        base = (Path(xdg) if xdg else Path.home() / ".cache") / "Orbita"
    return base / "probe"


def _file_for(path: Path) -> Path | None:
    try:
        st = path.stat()
    except OSError:
        return None
    raw = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    return _cache_root() / f"{hashlib.sha1(raw.encode('utf-8')).hexdigest()}.json"


def load(path: str | Path) -> dict | None:
    """Metadados já lidos para este arquivo, ou `None`."""
    f = _file_for(Path(path))
    if f is None or not f.is_file():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def store(path: str | Path, meta: dict) -> None:
    """Guarda os metadados. Falha em silêncio: cache é otimização, nunca requisito."""
    f = _file_for(Path(path))
    if f is None:
        return
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".part")
        tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        tmp.replace(f)
    except OSError:
        pass
