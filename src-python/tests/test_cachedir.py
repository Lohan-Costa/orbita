"""
A POLÍTICA DE CACHE — o teto de tamanho e o despejo.

O que estes testes guardam:

  1. O despejo é LRU DE VERDADE: sai o menos usado RECENTEMENTE, não o mais
     antigo a ser escrito. Um cache que joga fora o que está em uso todo dia é
     pior que não ter cache — o usuário paga a releitura de novo e de novo.
  2. `clear()`/`stats()` só olham para as subpastas que o app gerencia. Se alguém
     apontar o cache para uma pasta com outras coisas dentro, nada mais é tocado.
  3. Abaixo do teto, o despejo NÃO mexe em nada.
  4. Configuração inválida (teto absurdo, JSON corrompido) volta ao padrão em vez
     de derrubar o sidecar.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import appsettings as settings
from media import cachedir


@pytest.fixture
def cache(tmp_path, monkeypatch):
    """Um cache isolado em tmp — nunca o do usuário que está rodando os testes."""
    monkeypatch.setattr(settings, "app_data_dir", lambda: tmp_path / "appdata")
    monkeypatch.setattr(cachedir, "root", lambda: tmp_path / "cache")
    for name in cachedir.SUBDIRS:
        (tmp_path / "cache" / name).mkdir(parents=True, exist_ok=True)
    return tmp_path / "cache"


def _write(cache: Path, sub: str, name: str, size: int, mtime: float) -> Path:
    f = cache / sub / name
    f.write_bytes(b"\0" * size)
    import os
    os.utime(f, (mtime, mtime))
    return f


def test_stats_soma_so_o_que_o_app_gerencia(cache):
    _write(cache, "peaks", "a.peaks", 100, time.time())
    _write(cache, "probe", "b.json", 50, time.time())
    # Um arquivo SOLTO na raiz do cache, que o app não criou.
    (cache / "nao-e-meu.txt").write_bytes(b"\0" * 999)

    st = cachedir.stats()
    assert st["files"] == 2
    assert st["bytes"] == 150


def test_clear_nao_toca_no_que_nao_e_do_app(cache):
    _write(cache, "peaks", "a.peaks", 100, time.time())
    alheio = cache / "nao-e-meu.txt"
    alheio.write_bytes(b"\0" * 999)

    freed = cachedir.clear()

    assert freed["files"] == 1
    assert freed["bytes"] == 100
    assert alheio.exists(), "clear() apagou um arquivo que não é do app"
    assert cachedir.stats()["files"] == 0


def test_abaixo_do_teto_nao_despeja_nada(cache):
    _write(cache, "peaks", "a.peaks", 100, time.time())
    _write(cache, "peaks", "b.peaks", 100, time.time())

    assert cachedir.enforce_limit(max_bytes=1000) == {"bytes": 0, "files": 0}
    assert cachedir.stats()["files"] == 2


def test_despejo_e_lru_sai_o_menos_usado_recentemente(cache):
    agora = time.time()
    # `velho` foi ESCRITO por último, mas usado há muito tempo.
    recente = _write(cache, "peaks", "recente.peaks", 100, agora)
    velho = _write(cache, "peaks", "velho.peaks", 100, agora - 10_000)

    freed = cachedir.enforce_limit(max_bytes=150)

    assert freed["files"] == 1
    assert recente.exists(), "o despejo tirou o arquivo USADO mais recentemente"
    assert not velho.exists()


def test_touch_na_leitura_salva_o_arquivo_do_despejo(cache):
    """O `touch` do `load()` é LOAD-BEARING: sem ele o LRU vira 'o mais antigo a
    ser escrito', e o arquivo que o usuário abre todo dia é o primeiro a sair."""
    agora = time.time()
    a = _write(cache, "peaks", "a.peaks", 100, agora - 10_000)
    b = _write(cache, "peaks", "b.peaks", 100, agora - 5_000)

    cachedir.touch(a)   # é o que `peakcache.load` faz ao acertar o cache

    cachedir.enforce_limit(max_bytes=150)

    assert a.exists(), "o arquivo recém-usado foi despejado"
    assert not b.exists()


def test_despeja_ate_caber_e_nao_alem(cache):
    agora = time.time()
    for i in range(5):
        _write(cache, "peaks", f"{i}.peaks", 100, agora - (5 - i) * 100)

    cachedir.enforce_limit(max_bytes=250)

    st = cachedir.stats()
    assert st["bytes"] <= 250
    assert st["files"] == 2, "despejou mais do que o necessário"


def test_settings_recusa_teto_absurdo(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "app_data_dir", lambda: tmp_path)

    # Um teto de 0 apagaria o cache a cada escrita.
    assert settings.save({"cache_max_mb": 0})["cache_max_mb"] == settings.DEFAULT_CACHE_MAX_MB
    assert settings.save({"cache_max_mb": -5})["cache_max_mb"] == settings.DEFAULT_CACHE_MAX_MB
    assert settings.save({"cache_max_mb": "abc"})["cache_max_mb"] == settings.DEFAULT_CACHE_MAX_MB
    # Um valor razoável passa.
    assert settings.save({"cache_max_mb": 2048})["cache_max_mb"] == 2048


def test_settings_corrompido_volta_ao_padrao(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "app_data_dir", lambda: tmp_path)
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "settings.json").write_text("{ isso não é json", encoding="utf-8")

    data = settings.load()   # não pode levantar: derrubaria o sidecar no boot
    assert data["cache_max_mb"] == settings.DEFAULT_CACHE_MAX_MB
    assert data["cache_dir"] is None


def test_settings_round_trip_do_diretorio(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "app_data_dir", lambda: tmp_path)

    settings.save({"cache_dir": str(tmp_path / "meu-cache")})
    assert settings.load()["cache_dir"] == str(tmp_path / "meu-cache")

    # Voltar ao padrão da plataforma é mandar `None`.
    settings.save({"cache_dir": None})
    assert settings.load()["cache_dir"] is None
