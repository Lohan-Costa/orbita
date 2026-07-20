"""
Orbita — Sidecar Python
Ponto de entrada para comunicação com o backend Rust via stdin/stdout.

Protocolo:
  - Recebe comandos JSON via stdin (uma linha por comando)
  - Responde com JSON via stdout (uma linha por resposta)

Formato do comando:
  {"id": "uuid", "command": "nome_do_comando", "params": {...}}

Formato da resposta:
  {"id": "uuid", "ok": true, "data": {...}}
  {"id": "uuid", "ok": false, "error": "mensagem", "detail": "..."}
"""

from __future__ import annotations

import os
import sys
import json
import logging
import time
from pathlib import Path

# O protocolo com o Rust é JSON por stdin/stdout — sempre UTF-8, por contrato.
# Sem isto, no Windows sys.stdout/stdin herdam o codepage do sistema (ex.:
# cp1252 num Windows em português), que não cobre todo o Unicode — um nome de
# cena/arquivo com emoji, CJK ou cirílico (ensure_ascii=False no json.dumps
# preserva o caractere cru) derruba o processo com UnicodeEncodeError na
# escrita. Forçar UTF-8 aqui elimina a dependência do locale da máquina.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
if sys.stdin.encoding and sys.stdin.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdin.reconfigure(encoding="utf-8")

APP_NAME = os.environ.get("ORBITA_APP_NAME", "Orbita")

# Um dono só para os caminhos do app (`settings.logs_dir`) — a janela de
# configurações precisa apontar o usuário para ESTA pasta, e duas contas
# separadas do mesmo caminho um dia divergem.
import appsettings as app_settings

log_dir = app_settings.logs_dir()
log_dir.mkdir(parents=True, exist_ok=True)

from datetime import datetime
log_file = log_dir / f"orbita_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(log_file, encoding="utf-8")],
)
log = logging.getLogger("orbita")


def _write_line(payload: str) -> None:
    """
    Escreve uma linha em stdout, com retry.

    No Windows, o transporte é um pipe anônimo (criado pelo Rust). Sob rajada
    de escritas pequenas e rápidas em sequência — um evento de progresso por
    clipe, no laço de sync — a escrita pode falhar transitoriamente com
    `OSError: [Errno 22] Invalid argument` (visto em produção: sync de 50
    clipes, sem nada de anormal nos dados). Tenta de novo antes de desistir;
    se persistir, deixa a exceção subir para o chamador decidir.
    """
    last_err: OSError | None = None
    for attempt in range(5):
        try:
            sys.stdout.write(payload + "\n")
            sys.stdout.flush()
            return
        except OSError as e:
            last_err = e
            log.warning("Falha ao escrever em stdout (tentativa %d/5): %s", attempt + 1, e)
            time.sleep(0.02 * (attempt + 1))
    raise last_err


def respond(cmd_id: str, data: dict) -> None:
    payload = json.dumps({"id": cmd_id, "ok": True, "data": data}, ensure_ascii=False)
    _write_line(payload)


def respond_progress(cmd_id: str, data: dict) -> None:
    payload = json.dumps(
        {"id": cmd_id, "event": "progress", "data": data}, ensure_ascii=False
    )
    _write_line(payload)


def respond_error(cmd_id: str, message: str, detail: str = "") -> None:
    payload = json.dumps(
        {"id": cmd_id, "ok": False, "error": message, "detail": detail},
        ensure_ascii=False,
    )
    _write_line(payload)
    log.error("Comando %s falhou: %s | %s", cmd_id, message, detail)


def _sync_one_daily(
    cmd_id: str,
    gi: int,
    total_groups: int,
    gid: str,
    gname: str,
    gfiles: list,
    *,
    fps,
    start_tc_frames: int,
    sync_method: str = "hybrid",
    pinned: dict | None = None,
    selected: set | None = None,
) -> dict:
    """
    Sincroniza UMA diária e devolve a entrada de resultado (`{**daily_to_dict(...),
    "id": gid}`) ou de erro (`{"id", "name", "error"}`) — o formato que "sync" e
    "resync" devolvem em `groups`, um por diária.

    `pinned`/`selected` (RE-SYNC PARCIAL, Etapa D) — `None` nos dois é o sync cheio
    de sempre; ver `sync.engine.run` para o que eles fazem.

    Isolado por diária: uma que falha não pode derrubar as outras (ver o
    `try/except` em `handle_command`).
    """
    from sync.engine import run as sync_run
    from sync.serialize import daily_to_dict

    def on_progress(msg: str, cur: int, tot: int) -> None:
        respond_progress(cmd_id, {
            "kind": "status", "message": msg, "current": cur, "total": tot,
            "sync_group_id": gid,
            "group_index": gi, "group_total": total_groups,
        })

    def on_sound(payload: dict) -> None:
        respond_progress(cmd_id, {"kind": "sound", "sync_group_id": gid, **payload})

    def on_clip(payload: dict) -> None:
        respond_progress(cmd_id, {"kind": "clip", "sync_group_id": gid, **payload})

    try:
        daily = sync_run(
            gfiles,
            progress=on_progress,
            project_name=gname,
            on_sound=on_sound,
            on_clip=on_clip,
            fps=fps,
            start_tc_frames=start_tc_frames,
            sync_method=sync_method,
            pinned=pinned,
            selected=selected,
        )
        return {**daily_to_dict(daily), "id": gid}
    except ValueError as e:
        log.warning("Grupo %s falhou: %s", gid, e)
        return {"id": gid, "name": gname, "error": str(e)}
    except Exception as e:
        log.exception("Erro no sync do grupo %s: %s", gid, e)
        return {"id": gid, "name": gname, "error": str(e)}


def handle_command(cmd: dict) -> None:
    cmd_id   = cmd.get("id", "unknown")
    command  = cmd.get("command", "")
    params   = cmd.get("params", {})

    log.info("Comando: %s | id=%s", command, cmd_id)

    if command == "ping":
        respond(cmd_id, {"pong": True, "version": "0.1.0"})

    # ── Configurações e cache ────────────────────────────────────────────────
    elif command == "get_settings":
        from media import cachedir
        respond(cmd_id, {
            **app_settings.load(),
            "logs_dir": str(app_settings.logs_dir()),
            "cache": cachedir.stats(),
        })

    elif command == "set_settings":
        from media import cachedir
        saved = app_settings.save(params or {})
        # O teto novo vale AGORA, não no próximo sync: quem acabou de baixar o
        # limite espera ver o cache encolher, não descobrir depois que não fez nada.
        evicted = cachedir.enforce_limit()
        respond(cmd_id, {
            **saved,
            "logs_dir": str(app_settings.logs_dir()),
            "cache": cachedir.stats(),
            "evicted": evicted,
        })

    elif command == "cache_stats":
        from media import cachedir
        respond(cmd_id, cachedir.stats())

    elif command == "cache_clear":
        from media import cachedir
        freed = cachedir.clear()
        respond(cmd_id, {**freed, "cache": cachedir.stats()})

    elif command == "probe_media":
        from media.inspector import probe
        try:
            result = probe(params["path"])
            respond(cmd_id, result)
        except Exception as e:
            respond_error(cmd_id, "Falha ao ler metadados", str(e))

    # ── Fase 2: Sync Engine ────────────────────────────────────────────────
    elif command == "sync":
        # Payload NOVO: `groups: [{id, name, fps, files: [...]}]` — uma diária cada.
        # Payload ANTIGO: `files: [...]` solto (uma diária). Aceito porque uma diária
        # só é o caso comum, e porque o frontend migra num passo separado.
        raw_groups = params.get("groups")
        if raw_groups is None:
            raw_groups = [{
                "id": params.get("name", "MULTICAM"),
                "name": params.get("name", "MULTICAM"),
                "fps": params.get("fps"),
                "files": params.get("files", []),
            }]

        project_name = params.get("project_name") or params.get("name") or "PROJETO"
        start_tc_frames = int(params.get("start_tc_frames") or 0)
        default_fps = params.get("fps")
        sync_method = params.get("sync_method") or "hybrid"

        if not raw_groups or not any(g.get("files") for g in raw_groups):
            respond_error(cmd_id, "Nenhum arquivo para sincronizar")
            return

        total_groups = len(raw_groups)
        # UM GRUPO QUE FALHA NÃO PODE DERRUBAR OS OUTROS. Antes, um `raise` numa
        # diária matava a resposta inteira — e o usuário perdia o sync das cinco que
        # tinham dado certo. `_sync_one_daily` volta com `error` e as outras seguem.
        results = [
            _sync_one_daily(
                cmd_id, gi, total_groups,
                g.get("id") or g.get("name") or f"grupo-{gi}",
                g.get("name") or g.get("id") or f"grupo-{gi}",
                g.get("files") or [],
                fps=g.get("fps", default_fps),
                start_tc_frames=start_tc_frames,
                sync_method=sync_method,
            )
            for gi, g in enumerate(raw_groups)
            if g.get("files")
        ]

        # Este payload volta tal e qual ao sidecar no export — o frontend é a fonte
        # da verdade, e o que está na tela é o que é exportado.
        respond(cmd_id, {"name": project_name, "groups": results})

    # ── Etapa D: RE-SYNC PARCIAL ─────────────────────────────────────────────
    # Mesma diária, mas só os clipes SELECIONADOS passam pela correlação — o
    # resto entra FIXADO (`pinned`) no offset/som que já estava na tela, e serve
    # de âncora para os que foram selecionados (ver sync.engine.run). Um payload
    # por grupo, igual ao "sync", com dois campos a mais.
    elif command == "resync":
        raw_groups = params.get("groups") or []
        start_tc_frames = int(params.get("start_tc_frames") or 0)
        default_fps = params.get("fps")
        sync_method = params.get("sync_method") or "hybrid"

        if not raw_groups or not any(g.get("files") for g in raw_groups):
            respond_error(cmd_id, "Nenhum arquivo para re-sincronizar")
            return

        total_groups = len(raw_groups)
        results = []
        for gi, g in enumerate(raw_groups):
            gid = g.get("id") or f"grupo-{gi}"
            selected = set(g.get("selected_paths") or [])
            pinned = {
                path: (int(p["offset_frames"]), p["sound_path"])
                for path, p in (g.get("pinned") or {}).items()
            }
            results.append(_sync_one_daily(
                cmd_id, gi, total_groups, gid, g.get("name") or gid,
                g.get("files") or [],
                fps=g.get("fps", default_fps),
                start_tc_frames=start_tc_frames,
                sync_method=sync_method,
                pinned=pinned,
                selected=selected,
            ))

        respond(cmd_id, {"groups": results})

    # ── Waveforms das câmeras (segundo plano, depois do sync) ─────────────
    elif command == "compute_peaks":
        # O sync NÃO gera a waveform de uma câmera cara: para desenhá-la é preciso
        # ler o arquivo INTEIRO (o áudio vive interleavado com o vídeo), e é
        # justamente isso que o caminho rápido existe para evitar — 202 GB numa
        # diária de Alexa. A timeline aparece na hora, com os clipes como blocos, e
        # as waveforms chegam depois, uma a uma, por estes eventos de progresso.
        # É o que o próprio Premiere faz (os arquivos .pek).
        #
        # Cancelar é fechar o processo do lado do frontend: cada peak que já chegou
        # está desenhado, e nada fica pela metade.
        from media import peakcache
        from media.audio import extract_pcm, normalize
        from sync.waveform import PEAK_RATE, peaks_u8
        import base64

        paths = params.get("paths", [])
        if not paths:
            respond(cmd_id, {"count": 0})
            return

        done = 0
        cached = 0
        for path in paths:
            try:
                # O cache em disco é o que impede pagar os 10 minutos de leitura de
                # novo a cada reabertura do app (ver media/peakcache.py).
                peaks = peakcache.load(path)
                if peaks is None:
                    peaks = peaks_u8(normalize(extract_pcm(path)))
                    peakcache.store(path, peaks)
                else:
                    cached += 1
                respond_progress(cmd_id, {
                    "kind": "peaks",
                    "path": path,
                    "peak_rate": PEAK_RATE,
                    "peaks": base64.b64encode(peaks.tobytes()).decode("ascii"),
                })
                done += 1
            except Exception as e:
                # Um arquivo que não abre não pode derrubar os outros: a waveform é
                # exibição, não sync.
                log.warning("peaks falhou em %s: %s", path, e)
                respond_progress(cmd_id, {"kind": "peaks", "path": path, "peaks": None})
        respond(cmd_id, {"count": done, "cached": cached})

    # ── Fase 3: Avid AAF ──────────────────────────────────────────────────
    elif command == "export_aaf":
        respond_error(cmd_id, "Não implementado ainda", "AAF writer — Fase 3")

    # ── Fase 4: Premiere PRPROJ ───────────────────────────────────────────
    # Exporta a partir de um resultado de sync JÁ calculado (o que o frontend
    # tem na timeline). É o caminho normal: não re-sincroniza, então exportar é
    # instantâneo, e o que o usuário vê é exatamente o que é exportado.
    elif command == "export_prproj_from_result":
        from prproj.builder import build_prproj, ExportOptions
        from sync.serialize import project_from_dict

        result = params.get("result")
        output_path_str = params.get("output_path", "")

        if not result:
            respond_error(cmd_id, "Parâmetro 'result' obrigatório")
            return
        if not output_path_str:
            respond_error(cmd_id, "Parâmetro 'output_path' obrigatório")
            return

        try:
            # `project_from_dict` aceita o envelope novo (`{groups: [...]}`) e uma
            # diária solta — o que mantém o caminho antigo funcionando.
            project = project_from_dict(result)
            # As OPÇÕES vêm à parte, e não dentro do resultado do sync: o que foi
            # filmado é uma coisa, o que se quer tirar dele é outra. Trocar uma opção
            # de export não pode obrigar a re-sincronizar.
            opts = params.get("options") or {}
            options = ExportOptions(
                multicam_sub_groups=set(opts.get("multicam_sub_groups") or []),
                include_camera_audio=bool(opts.get("include_camera_audio")),
            )
            out = Path(output_path_str)
            build_prproj(project, out, options)
            # Os avisos são do PROJETO: com quatro diárias, dizer "3 clipes
            # sinalizados" sem dizer de qual dia não ajudaria ninguém.
            flags = [
                {"path": str(c.path), "group_name": cg.name,
                 "daily_name": d.name, "reason": c.flag_reason}
                for d in project.groups
                for cg in d.camera_groups
                for c in cg.cameras
                if c.flagged
            ]
            respond(cmd_id, {"path": str(out), "name": project.name, "flags": flags})
        except ValueError as e:
            respond_error(cmd_id, str(e))
        except Exception as e:
            log.exception("Erro ao gerar PRPROJ: %s", e)
            respond_error(cmd_id, "Erro ao gerar PRPROJ", str(e))

    # LEGADO: sincroniza E exporta numa tacada só. Mantido como fallback e para
    # o caminho do AAF (Fase 3), que ainda não tem fluxo de duas etapas.
    elif command == "export_prproj":
        from sync.engine import run as sync_run
        from prproj.builder import build_prproj

        file_paths = params.get("files", [])
        project_name = params.get("name", "MULTICAM")
        output_path_str = params.get("output_path", "")

        if not file_paths:
            respond_error(cmd_id, "Parâmetro 'files' obrigatório")
            return
        if not output_path_str:
            respond_error(cmd_id, "Parâmetro 'output_path' obrigatório")
            return

        def on_progress_prproj(msg: str, cur: int, tot: int) -> None:
            respond_progress(cmd_id, {"kind": "status", "message": msg, "current": cur, "total": tot})

        try:
            group = sync_run(
                file_paths,
                progress=on_progress_prproj,
                project_name=project_name,
            )
            out = Path(output_path_str)
            build_prproj(group, out)
            flags = [
                {"path": str(c.path), "group_name": cg.name, "reason": c.flag_reason}
                for cg in group.camera_groups
                for c in cg.cameras
                if c.flagged
            ]
            respond(cmd_id, {"path": str(out), "name": project_name, "flags": flags})
        except ValueError as e:
            respond_error(cmd_id, str(e))
        except Exception as e:
            log.exception("Erro ao gerar PRPROJ: %s", e)
            respond_error(cmd_id, "Erro ao gerar PRPROJ", str(e))

    else:
        respond_error(cmd_id, f"Comando desconhecido: {command}")


def main() -> None:
    log.info("Orbita sidecar iniciado. Aguardando comandos via stdin...")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            log.error("JSON inválido: %s | %s", line[:100], e)
            respond_error("parse_error", "JSON inválido", str(e))
            continue
        try:
            handle_command(cmd)
        except Exception as e:
            cmd_id = cmd.get("id", "unknown")
            log.exception("Erro inesperado no comando %s: %s", cmd_id, e)
            try:
                respond_error(cmd_id, "Erro interno inesperado", str(e))
            except OSError:
                # stdout ainda indisponível mesmo após o retry de _write_line —
                # não deixar isso matar o processo inteiro (ver _write_line). O
                # Rust vai estourar o timeout do comando em vez de crashar o
                # sidecar; a próxima linha de stdin ainda tem chance de ir.
                log.critical(
                    "stdout indisponível — não foi possível responder ao comando %s.",
                    cmd_id,
                )

    log.info("Orbita sidecar encerrado.")


if __name__ == "__main__":
    main()
