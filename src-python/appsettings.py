"""
Orbita — configurações persistentes do app.

ONDE: no diretório de DADOS do app (junto dos logs), nunca no diretório de cache —
o caminho do cache é justamente uma das coisas configuráveis aqui, e um arquivo
que diz onde fica o cache não pode morar dentro dele.

  macOS   ~/Library/Application Support/Orbita/settings.json
  Windows %APPDATA%\\Orbita\\settings.json
  Linux   ~/.config/Orbita/settings.json

Ler NUNCA levanta: um settings.json corrompido (disco cheio no meio da escrita,
edição à mão) volta aos padrões em vez de derrubar o sidecar no boot. Configuração
é conveniência; perder o app inteiro por causa dela seria desproporcional.

⚠️ O MÓDULO se chama `appsettings`, não `settings`, de propósito: o bundle do
PyInstaller (`--onefile`) põe TODOS os módulos num namespace plano, e `settings` é
genérico o bastante para um dia colidir com o de alguma dependência — silenciosamente,
e só no binário empacotado, que é o pior lugar para descobrir.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

APP_NAME = os.environ.get("ORBITA_APP_NAME", "Orbita")

#: Teto padrão do cache. 5 GB comporta várias diárias de waveform sem que o
#: usuário precise pensar no assunto — e é pequeno o bastante para não assustar
#: quem descobre a pasta um ano depois.
DEFAULT_CACHE_MAX_MB = 5120

_DEFAULTS: dict = {
    # `None` = usar o diretório de cache padrão da plataforma (ver media.cachedir).
    "cache_dir": None,
    "cache_max_mb": DEFAULT_CACHE_MAX_MB,
}


def app_data_dir() -> Path:
    """Dados do app (settings, logs) — persistentes, não descartáveis."""
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home())
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME")
        base = Path(xdg) if xdg else Path.home() / ".config"
    return base / APP_NAME


def logs_dir() -> Path:
    return app_data_dir() / "logs"


def _settings_file() -> Path:
    return app_data_dir() / "settings.json"


def load() -> dict:
    """As configurações, com os padrões preenchidos. Nunca levanta."""
    data = dict(_DEFAULTS)
    try:
        raw = json.loads(_settings_file().read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            # Só chaves conhecidas: um settings.json de uma versão FUTURA não pode
            # injetar campo nenhum aqui dentro.
            for k in _DEFAULTS:
                if k in raw:
                    data[k] = raw[k]
    except (OSError, ValueError):
        pass
    return _sanitize(data)


def _sanitize(data: dict) -> dict:
    """Valores fora do razoável voltam ao padrão — inclusive os que o usuário
    digitou. Um teto de 0 MB apagaria o cache a cada escrita."""
    out = dict(data)

    cache_dir = out.get("cache_dir")
    out["cache_dir"] = str(cache_dir) if cache_dir else None

    try:
        mb = int(out.get("cache_max_mb") or 0)
    except (TypeError, ValueError):
        mb = 0
    out["cache_max_mb"] = mb if mb >= 100 else DEFAULT_CACHE_MAX_MB
    return out


def save(patch: dict) -> dict:
    """Aplica só as chaves conhecidas e devolve as configurações resultantes."""
    data = load()
    for k in _DEFAULTS:
        if k in patch:
            data[k] = patch[k]
    data = _sanitize(data)
    try:
        f = _settings_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".part")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(f)
    except OSError:
        # Não conseguiu gravar (disco cheio, sem permissão): o app segue com o
        # valor em memória. Mentir dizendo que salvou seria pior.
        pass
    return data
