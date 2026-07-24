"""
Orbita — o diretório de cache, e a política de tamanho dele.

Um dono só para "onde fica o cache": `peakcache` e `probecache` perguntam aqui.
Antes cada um calculava o caminho por conta própria, e o caminho não podia ser
configurado sem editar os dois (que um dia divergiriam).

A POLÍTICA DE TAMANHO é LRU por mtime, e o mtime é atualizado na LEITURA
(`touch`): sem isso o "mais antigo" seria o mais antigo a ser ESCRITO, e a
waveform que o usuário abre todo dia seria despejada antes daquela que ele gerou
uma vez e nunca mais viu. Cache que despeja o que está em uso não é cache.

O despejo NUNCA levanta: um arquivo que não pode ser apagado (em uso, sem
permissão) é pulado. Cache é otimização, nunca requisito.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import appsettings as settings

#: As subpastas que o app gerencia. `clear()` e `stats()` só olham para ELAS —
#: nunca para a raiz inteira. Se o usuário apontar o cache para uma pasta que já
#: tem coisas dele (o Desktop, no limite), nada fora daqui é tocado.
SUBDIRS = ("peaks", "probe", "proxy")

#: Um scan completo é barato, mas não a ponto de valer a cada escrita de cache.
_EVICT_THROTTLE_S = 10.0
_last_evict = 0.0


def default_root() -> Path:
    """Onde o cache mora quando o usuário não escolheu nada."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches" / settings.APP_NAME
    elif os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        base = (Path(local) if local else Path.home()) / settings.APP_NAME / "Cache"
    else:
        xdg = os.environ.get("XDG_CACHE_HOME")
        base = (Path(xdg) if xdg else Path.home() / ".cache") / settings.APP_NAME
    return base


def root() -> Path:
    """A raiz efetiva do cache: a configurada, ou a padrão da plataforma."""
    configured = settings.load().get("cache_dir")
    if configured:
        try:
            return Path(configured).expanduser()
        except (OSError, ValueError):
            pass
    return default_root()


def sub(name: str) -> Path:
    return root() / name


def _entries() -> list[tuple[Path, int, float]]:
    """(caminho, bytes, mtime) de tudo que o app gerencia. Nunca levanta."""
    out: list[tuple[Path, int, float]] = []
    base = root()
    for name in SUBDIRS:
        d = base / name
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_file():
                            st = e.stat()
                            out.append((Path(e.path), st.st_size, st.st_mtime))
                    except OSError:
                        continue
        except OSError:
            continue
    return out


def stats() -> dict:
    """Quanto o cache ocupa, em quantos arquivos, e onde."""
    entries = _entries()
    return {
        "dir": str(root()),
        "default_dir": str(default_root()),
        "bytes": sum(size for _, size, _ in entries),
        "files": len(entries),
    }


def touch(path: Path) -> None:
    """Marca como usado agora — é o que torna o despejo um LRU de verdade."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def clear() -> dict:
    """Apaga tudo que o app gerencia. Devolve o que foi liberado."""
    freed = 0
    removed = 0
    for f, size, _ in _entries():
        try:
            f.unlink()
            freed += size
            removed += 1
        except OSError:
            continue
    return {"bytes": freed, "files": removed}


def enforce_limit(max_bytes: int | None = None) -> dict:
    """
    Despeja os menos usados recentemente até o cache caber no teto.

    `max_bytes=None` lê o teto das configurações. Um teto <= 0 desliga o despejo
    (não é o padrão, e `settings` já barra valores absurdos).
    """
    if max_bytes is None:
        max_bytes = int(settings.load()["cache_max_mb"]) * 1024 * 1024
    if max_bytes <= 0:
        return {"bytes": 0, "files": 0}

    entries = _entries()
    total = sum(size for _, size, _ in entries)
    if total <= max_bytes:
        return {"bytes": 0, "files": 0}

    # Mais antigo primeiro (mtime = último uso, graças ao `touch` na leitura).
    entries.sort(key=lambda e: e[2])

    freed = 0
    removed = 0
    for f, size, _ in entries:
        if total - freed <= max_bytes:
            break
        try:
            f.unlink()
            freed += size
            removed += 1
        except OSError:
            continue
    return {"bytes": freed, "files": removed}


def maybe_enforce() -> None:
    """Chamado depois de cada escrita de cache, com rédea curta: varrer o
    diretório a cada waveform gravada seria pagar I/O para evitar I/O."""
    global _last_evict
    now = time.monotonic()
    if now - _last_evict < _EVICT_THROTTLE_S:
        return
    _last_evict = now
    try:
        enforce_limit()
    except Exception:
        pass
