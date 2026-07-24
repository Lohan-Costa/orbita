"""
Orbita — cache em disco das waveforms (os "peaks" que a timeline desenha).

POR QUE EXISTE: desenhar a waveform de um clipe de câmera exige ler o arquivo
INTEIRO — numa diária de Alexa são 202 GB e ~10 minutos. Sem cache, fechar e
reabrir o app (ou re-sincronizar) pagaria esses 10 minutos DE NOVO. É a mesma razão
pela qual o Premiere guarda os `.pek`.

ONDE: no diretório de cache do usuário (ver `media.cachedir` — é configurável),
NÃO junto da mídia. O material bruto pode estar num cartão, num HDD só de leitura
ou num NAS compartilhado — escrever ao lado dele é presunçoso e às vezes
impossível.

A CHAVE inclui tamanho e mtime do arquivo: se a mídia mudou, o cache não vale.
Nunca chavear só pelo caminho — um arquivo re-exportado com o mesmo nome devolveria
a waveform errada, e uma waveform errada é pior que nenhuma (o usuário confere o
sync com os olhos nela).
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np

from . import cachedir


def _cache_root() -> Path:
    return cachedir.sub("peaks")


def _key(path: Path) -> str | None:
    """Identidade do CONTEÚDO, não do nome. `None` se o arquivo sumiu."""
    try:
        st = path.stat()
    except OSError:
        return None
    raw = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _file_for(path: Path) -> Path | None:
    k = _key(path)
    return None if k is None else _cache_root() / f"{k}.peaks"


def load(path: str | Path) -> np.ndarray | None:
    """Peaks já calculados para este arquivo, ou `None`."""
    f = _file_for(Path(path))
    if f is None or not f.is_file():
        return None
    try:
        peaks = np.frombuffer(f.read_bytes(), dtype=np.uint8)
    except OSError:
        return None
    # Usado agora — é o que impede o despejo por tamanho de jogar fora justamente
    # a waveform que o usuário abre todo dia (ver media/cachedir.py).
    cachedir.touch(f)
    return peaks


def store(path: str | Path, peaks: np.ndarray) -> None:
    """Guarda os peaks. Falha em silêncio: cache é otimização, nunca requisito —
    um disco cheio ou sem permissão não pode derrubar o app."""
    f = _file_for(Path(path))
    if f is None:
        return
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        # Escreve e renomeia: um app fechado no meio da escrita não deixa um cache
        # truncado para trás (que seria lido como uma waveform mutilada).
        tmp = f.with_suffix(".part")
        tmp.write_bytes(peaks.tobytes())
        tmp.replace(f)
    except OSError:
        return
    cachedir.maybe_enforce()
