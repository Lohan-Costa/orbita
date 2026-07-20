"""
Orbita — SyncEngine: recebe os arquivos de uma diária e devolve um `Daily`.

O material real é uma DIÁRIA: N tomadas, cada uma com o seu som direto e um ou
mais clipes de câmera. Não há um som contínuo do dia. O trabalho do engine é
descobrir QUEM VAI COM QUEM e por QUANTOS FRAMES.

Dois caminhos, e o primeiro é o diferencial do app
──────────────────────────────────────────────────

1. COM TIMECODE — alinhamento do desenho (`sync/tcmatch.py`).
   Câmera e gravador têm relógios diferentes, mas ambos correm em tempo real: a
   diferença entre eles é uma constante. Como gravaram os mesmos momentos, o
   padrão de blocos e buracos é o mesmo nos dois, e deslizar um sobre o outro
   revela essa constante — sem decodificar um frame de áudio. Daí sai, para cada
   clipe, UM candidato a som (1,1 em média no material real, contra 24 de uma
   busca cega). A waveform então só confirma e refina.

   Isso não é otimização: é o que torna o resultado CORRETO. Numa busca cega, as
   tomadas repetidas da mesma cena competem entre si e a correlação escolhe a
   errada (medido: 2 erros em 25). Com o candidato dado pelo TC, não há
   concorrente.

2. SEM TIMECODE — busca cega, como antes.
   Cada clipe é correlacionado contra todos os sons; vence o de maior pico. A
   ambiguidade acústica (tomadas repetidas) é resolvida por CRONOLOGIA: clipes e
   sons avançam na mesma ordem, então um clipe duvidoso é restringido ao intervalo
   entre os seus vizinhos confiáveis. Restrição física, não acústica — nenhuma
   métrica de áudio resolve isso sozinha.

Confiança
─────────
Nunca o valor absoluto da correlação (varia com o conteúdo da cena: fala contínua
correlaciona mais que cena esparsa, mesmo estando certa). Sempre a RAZÃO entre o
pico e o melhor concorrente — o quão inequívoco foi o match. Ver `sync/waveform.py`.

Um clipe sem som direto NÃO é um erro: a câmera roda antes do gravador, entre
tomadas, e em planos sem som (uma diária real do dataset tem 21 vídeos para 5
áudios). Ele vai para os órfãos, sinalizado, e nunca é descartado.
"""

from __future__ import annotations

import base64
import math
import re
from pathlib import Path
from typing import Callable

import numpy as np

from media import peakcache
from media.inspector import probe
from media.audio import PCM_RATE, extract_pcm, extract_pcm_window, normalize
from sync.model import CameraAngle, CameraGroup, Daily, SoundClip, Take
from sync.tcmatch import (
    Interval,
    candidate_sounds,
    clock_offsets,
    nominal_fps,
    predicted_offset_seconds,
    tc_to_real_seconds,
)
from sync.waveform import PEAK_RATE, confirm_offset, peaks_u8, sync_camera_to_wav

ProgressCallback = Callable[[str, int, int], None]

TICKS_PER_SEC = 254_016_000_000

# Razão pico/melhor-concorrente a partir da qual um match é inequívoco. Calibrado
# em 2026-07-11 contra o dataset real: matches corretos ficaram entre 1,86 e 4,86;
# os ambíguos (tomadas repetidas), em ~1,06. Ver DECISIONS.md.
TRUST_RATIO = 1.5

# Abaixo disto, mesmo após a desambiguação, o resultado é sinalizado em vez de
# aceito em silêncio.
FLAG_RATIO = 1.15

# Clipes curtos demais não têm sinal de sync — e quebram a normalização do ZNCC
# (um clipe de 0,4 s devolveu pico 3,79, impossível: o ZNCC não passa de 1).
# Entram no projeto, mas sinalizados, sem passar pela correlação.
MIN_SYNC_DURATION_S = 5.0

# Quando o offset da waveform bate com o que o relógio do REGIME prevê dentro
# desta margem, o match está CORROBORADO — duas medições independentes, uma do
# relógio e outra do som, chegando ao mesmo lugar.
#
# É apertado de propósito: dentro de um regime o Δ é constante a ~0,1 s (medido
# em 24 tomadas seguidas). Uma folga grande aqui aceitaria como "corroborado" um
# offset dezenas de segundos errado.
TC_AGREEMENT_S = 5.0

# ── A JANELA: o que o timecode já sabe, não se paga para descobrir ───────────
#
# O áudio de uma câmera vive INTERLEAVADO com o vídeo: para ler 20 s de som de um
# MXF ProRes, o ffmpeg atravessa 20 s de imagem junto. Ler o arquivo INTEIRO de
# cada clipe custava 18 MINUTOS numa diária de Alexa (42 clipes, 202 GB) — e era
# desperdício, porque o timecode JÁ DIZ onde o clipe cai. Basta olhar ali.
#
# WAVEFORM_WINDOW_S — quanto do clipe se lê. MEDIDO contra a correlação do arquivo
# inteiro, na diária real: 10 s erra até 5,4 frames (pouco sinal: o mic da câmera
# correlaciona a só 0,02–0,09 com o boom); 20 s erra no máximo 1 frame; 30 s não
# melhora nada e custa 30% a mais. 20 s é o ponto onde a curva vira.
WAVEFORM_WINDOW_S = 20.0

# Onde a janela começa DENTRO do clipe. Os primeiros instantes costumam ser
# ajuste/silêncio (a câmera parte antes da ação), e silêncio não correlaciona.
WAVEFORM_WINDOW_LEAD_S = 2.0

# A JANELA SÓ ENTRA ONDE HÁ O QUE ECONOMIZAR.
#
# Ela troca sinal por tempo: com 20 s em vez do clipe inteiro, a estimativa fica
# ~0,5 frame mais ruidosa. Isso se paga quando o arquivo é caro — e só então.
# Medido nos três datasets reais:
#
#   MIDIA MULTCAM  .mov   464 MB   4,7 MB/s de mídia   ler inteiro: 1,5 s
#   PROJETO X      .mp4   509 MB   1,4 MB/s            ler inteiro: 1,7 s
#   PROJETO Y      .mxf  2991 MB  56,6 MB/s            ler inteiro:  10 s   ← Alexa 35
#
# Nos dois primeiros a janela economizaria segundos e custaria 1 frame em alguns
# clipes (medido: 2 de 26 na D02, que o usuário já validou no Premiere). Não vale.
# No terceiro ela economiza 15 MINUTOS numa diária. Vale muito.
#
# Num disco lento (um NAS) o ponto de virada desce; se isso aparecer, medir e
# baixar o teto — não chutar.
WHOLE_FILE_BUDGET_BYTES = 1_000_000_000

# Meia-largura da janela em que a correlação é refeita ao redor do offset previsto
# pelo regime. Generosa, porque o palpite inicial da correlação pode estar longe —
# mas estreita o bastante para que a tomada vizinha (que competia e vencia) fique
# de fora do páreo.
TC_SEARCH_WINDOW_S = 30.0

# A confiança de um clipe FIXADO (`pinned`) — o RE-SYNC PARCIAL (Etapa D). Sempre
# acima de TRUST_RATIO, para que ele conte como âncora nas duas desambiguações
# (`_corroborate_by_delta` e a passada 2 de `_pair_by_waveform`) exatamente como um
# clipe medido com alta confiança contaria. O valor em si não é lido em nenhuma
# outra conta — só comparado contra TRUST_RATIO.
PINNED_CONFIDENCE = 999.0


def _natural_sort_key(path: Path):
    """Ordena nomes tratando runs de dígitos numericamente ('PANA2' < 'PANA10')."""
    parts = re.split(r"(\d+)", path.name)
    return [int(p) if p.isdigit() else p for p in parts]


def _tc_usable(clips: list["_Clip"]) -> bool:
    """
    O timecode desta câmera serve como RELÓGIO DO DIA?

    Ter um campo de TC não basta: ele precisa ANDAR. O drone do material real
    grava `00:00:00:00` em todos os 8 arquivos — um "relógio" parado, que
    empilharia todos os clipes no frame 0 e, pior, envenenaria o alinhamento do
    desenho com um bloco fantasma na origem.

    O teste é o mínimo indispensável: todo clipe tem TC, e os TCs são distintos.
    Uma câmera assim ainda pode ser sincronizada pela waveform — o que ela não
    pode é fingir que sabe as horas.
    """
    if not clips or any(c.tc_sec is None for c in clips):
        return False
    return len({c.tc_frames for c in clips}) == len(clips)


def _peaks_b64(pcm, path=None) -> str:
    """Peaks prontos para o IPC: uint8 → base64 (JSON com floats seria 4x maior).

    Com `path`, também vão para o cache em disco — o PCM inteiro acabou de ser
    pago; guardar a onda é de graça e poupa o `compute_peaks` de reler o arquivo."""
    pk = peaks_u8(pcm)
    if path is not None:
        peakcache.store(path, pk)
    return base64.b64encode(pk.tobytes()).decode("ascii")


def _duration_frames(duration_ms: float, fps: float) -> int:
    return math.ceil(duration_ms / 1000 * fps)


def _ticks_per_frame(fps: float) -> int:
    return round(TICKS_PER_SEC / fps)


# Duas câmeras a 23,976 podem reportar 23.976 e 23.98 — é o mesmo fps, e
# tratá-las como divergentes encheria a tela de avisos falsos.
_FPS_EPSILON = 0.01


def _detect_project_fps(cam_fps: list[float]) -> float:
    """fps do projeto = o mais comum entre as câmeras (não o da primeira: com uma
    câmera fora do padrão no topo da lista, o projeto herdaria o fps errado em
    silêncio)."""
    counts: dict[float, int] = {}
    for f in cam_fps:
        key = next((k for k in counts if abs(k - f) < _FPS_EPSILON), f)
        counts[key] = counts.get(key, 0) + 1
    # Empate resolve pelo maior fps: entre dois igualmente comuns, o mais alto
    # preserva mais frames.
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


# ── Estrutura interna do trabalho ────────────────────────────────────────────


class _Clip:
    """Um clipe de câmera durante o processamento (vira um CameraAngle no fim)."""

    def __init__(self, path: Path, meta: dict, group_id: str,
                 group_order: int | None, fps: float):
        self.path = path
        self.meta = meta
        self.group_id = group_id
        self.group_order = group_order
        self.group_name = ""
        self.duration_s = (meta.get("duration_ms") or 0.0) / 1000
        self.duration_frames = _duration_frames(meta.get("duration_ms") or 0, fps)
        self.has_audio = bool(meta.get("has_audio"))
        self.size_bytes = int(meta.get("size_bytes") or 0)

        self.tc_sec = tc_to_real_seconds(
            meta.get("tc_start") or "", meta.get("fps") or fps,
            bool(meta.get("tc_drop_frame")),
        )
        self.tc_frames: int | None = (
            None if self.tc_sec is None else round(self.tc_sec * fps)
        )

        self.sound: _Sound | None = None
        self.offset_frames = 0
        self.confidence = 0.0
        self.flagged = False
        self.flag_reason: str | None = None
        self.sync_source: str | None = None   # "waveform" | "timecode" (ver model.py)
        self.pcm: np.ndarray | None = None
        self.peaks: str | None = None
        self.timeline_start = 0
        self.implied_delta: float | None = None

    @property
    def syncable(self) -> tuple[bool, str | None]:
        """Este clipe tem como ser sincronizado? Se não, por quê."""
        if not self.has_audio:
            # Uma câmera sem faixa de áudio (um drone, no material real) não tem
            # com o que correlacionar. Não é erro — é uma limitação física.
            return False, "no_audio"
        if self.duration_s < MIN_SYNC_DURATION_S:
            # Curto demais para ter sinal — e quebra a normalização do ZNCC (um
            # clipe de 0,4 s devolveu pico 3,79, impossível: ZNCC não passa de 1).
            return False, "too_short"
        return True, None


class _Sound:
    """Um som direto durante o processamento (vira um SoundClip no fim)."""

    def __init__(self, path: Path, meta: dict):
        self.path = path
        self.meta = meta
        self.duration_s = (meta.get("duration_ms") or 0.0) / 1000
        self.tc_sec: float | None = meta.get("tc_start_sec")
        self.pcm: np.ndarray | None = None
        self.peaks: str | None = None
        self.clips: list[_Clip] = []
        self.timeline_start = 0
        self.implied_delta: float | None = None
        self.placed = False

    def load_pcm(self) -> np.ndarray:
        """PCM do som, extraindo se preciso. Os peaks (que a timeline usa) são
        calculados na primeira extração e SOBREVIVEM ao `release` — assim liberar
        a memória não obriga a reler o arquivo do disco depois. Eles também vão
        para o CACHE EM DISCO (o mesmo dos `.pek`): é o que deixa o PRÓXIMO sync
        desta diária — e o `compute_peaks` de segundo plano — sem ter de reler o
        arquivo só para desenhar a onda."""
        if self.pcm is None:
            self.pcm = normalize(extract_pcm(str(self.path)))
            self.peaks = _peaks_b64(self.pcm, self.path)
        return self.pcm

    def release(self) -> None:
        """Devolve o PCM à memória. Uma diária tem dezenas de sons de ~9 min:
        segurar todos custaria centenas de MB, e no caminho do timecode cada som
        é usado por ~1 clipe — cachear não compraria nada."""
        self.pcm = None


# ── O engine ─────────────────────────────────────────────────────────────────


def run(
    file_entries: list[str | dict],
    progress: ProgressCallback | None = None,
    project_name: str = "DIARIA",
    on_sound: Callable[[dict], None] | None = None,
    on_clip: Callable[[dict], None] | None = None,
    fps: float | None = None,
    start_tc_frames: int = 0,
    pinned: dict[str, tuple[int, str]] | None = None,
    selected: set[str] | None = None,
    sync_method: str = "hybrid",
) -> Daily:
    """
    Recebe os arquivos de uma diária e devolve um `Daily` sincronizado.

    Cada item de `file_entries` é `{"path", "group_id", "group_order"}` (o grupo é
    a câmera física — uma pasta arrastada) ou uma string solta.

    `fps` — framerate do PROJETO. Se None, detecta (o mais comum entre as câmeras).
    Todos os offsets e durações são medidos nessa grade.

    `on_sound` / `on_clip` — alimentam a timeline ao vivo, com os peaks de
    waveform. Carregam dados de EXIBIÇÃO; o modelo de domínio continua puro.

    `sync_method` — como parear e posicionar:
      - "timecode": SÓ o timecode. Cada clipe vai para o seu TC de entrada e o
        offset é a diferença de TC contra o som (cam_TC − snd_TC), que é o sync
        EXATO quando os aparelhos compartilham o relógio (jam sync). Não lê um
        frame de áudio para sincronizar — é a opção para quando o TC está certo, e
        a waveform vira o conserto pontual pela seleção. Ver `_pair_by_tc_only`.
      - "waveform": SÓ a forma de onda, ignorando o TC no pareamento (`_pair_by_waveform`).
      - "hybrid" (padrão): o TC propõe o par e a waveform confirma/refina quando o
        relógio serve; senão, busca cega. É o comportamento histórico.

    RE-SYNC PARCIAL (Etapa D) — `pinned` e `selected` andam juntos e são `None` os
    dois no caminho normal (sync cheio), que fica bit a bit como sempre foi.

    `pinned` — `{path: (offset_frames, sound_path)}` para os clipes que o usuário
    NÃO selecionou. Eles não são medidos de novo: entram já resolvidos, com
    confiança `PINNED_CONFIDENCE` — e é exatamente isso que os torna ÂNCORA
    confiável para a desambiguação por cronologia (`_pair_by_waveform`) e para a
    corroboração por regime de relógio (`_corroborate_by_delta`) dos clipes que
    FORAM selecionados. Sem ler o arquivo deles de novo: é o que faz um re-sync de
    1 clipe custar 1 clipe, não a diária inteira.

    `selected` — os paths que de fato passam pela correlação. `None` (o padrão)
    processa todo mundo, igual a antes; um conjunto processa só ele, e trata quem
    ficou de fora como já resolvido (por `pinned`, ou por já não ter sido tocado).
    """
    entries = [
        {"path": e, "group_id": e, "group_order": None} if isinstance(e, str) else e
        for e in file_entries
    ]

    def emit(msg: str, cur: int, tot: int) -> None:
        if progress:
            progress(msg, cur, tot)

    # ── 1. Probe ─────────────────────────────────────────────────────────────
    total = len(entries)
    emit("Lendo metadados...", 0, total)

    probed = []
    for i, e in enumerate(entries):
        meta = probe(e["path"])
        probed.append(
            (Path(e["path"]), meta, e.get("group_id"), e.get("group_order"), e.get("kind"))
        )
        emit(f"Metadados: {Path(e['path']).name}", i + 1, total)

    # ── 2. Separar câmeras de sons ───────────────────────────────────────────
    #
    # A regra continua a mesma — TEM FPS → CÂMERA — e ela nunca errou no material
    # real. O que mudou é que agora ela é VISÍVEL na tela: a fonte mostra como foi
    # classificada, e o usuário pode discordar. Quando ele discorda, `kind` chega
    # aqui e MANDA.
    #
    # Um arquivo sem fps não pode ser câmera por decreto (não há vídeo nele para
    # pôr numa track), então essa direção é ignorada — e a UI nem oferece o botão.
    def _is_camera(meta: dict, kind: str | None) -> bool:
        if not meta.get("fps"):
            return False                      # sem vídeo, não há câmera possível
        return kind != "sound"                # o usuário pode rebaixar uma câmera a som

    cam_entries = [(p, m, gid, gord) for p, m, gid, gord, k in probed if _is_camera(m, k)]
    snd_entries = [(p, m) for p, m, _, _, k in probed
                   if not _is_camera(m, k) and m.get("has_audio")]

    if not cam_entries:
        raise ValueError("Nenhum clipe de câmera encontrado.")

    # O NOME da fonte vem do frontend (é o que o usuário vê e pode renomear). Antes
    # ele era derivado do `group_id`, que era o caminho da pasta — e agora é um uuid,
    # do qual não se deriva nome nenhum.
    source_names: dict[str, str] = {
        str(e["group_id"]): e["source_name"]
        for e in entries
        if e.get("group_id") and e.get("source_name")
    }

    # UM GRUPO SEM SOM DIRETO É LEGÍTIMO — não é erro.
    #
    # É o dia de B-roll, o plano MOS, a câmera que rodou sozinha. Antes isto
    # levantava `ValueError` e derrubava a diária inteira. Todo o caminho para
    # tratá-lo JÁ EXISTIA e estava inalcançável: `_place_on_timeline` sabe lidar com
    # `c.sound is None` (ancora o clipe pelo próprio TC, ou o emenda no cursor) e
    # `_build_daily` já os recolhe em `orphan_cameras`. Os clipes saem sinalizados
    # como `no_sound`, que é a resposta honesta.
    has_sound = bool(snd_entries)

    project_fps = float(fps) if fps else _detect_project_fps(
        [m["fps"] for _, m, _, _ in cam_entries]
    )
    diverging = sorted({
        m["fps"] for _, m, _, _ in cam_entries
        if abs(m["fps"] - project_fps) >= _FPS_EPSILON
    })
    if diverging:
        listed = ", ".join(f"{f:g}" for f in diverging)
        emit(f"Atenção: câmeras a {listed} fps num projeto a {project_fps:g} fps.",
             0, total)

    sounds = [_Sound(p, m) for p, m in snd_entries]

    # ── 3. Agrupar câmeras por câmera física ─────────────────────────────────
    groups: dict[str, list[_Clip]] = {}
    group_order_seen: list[str] = []
    group_names: dict[str, str] = {}

    for cam_path, cam_meta, gid, gord in cam_entries:
        gid = gid or str(cam_path)
        if gid not in groups:
            groups[gid] = []
            group_order_seen.append(gid)
        groups[gid].append(_Clip(cam_path, cam_meta, gid, gord, project_fps))

    for gid, clips in groups.items():
        # Ordem de gravação. O timecode, quando serve, é a verdade; senão a ordem
        # que o frontend passou, senão o nome (sort natural). NÃO usar
        # `recorded_at`: o relógio interno da câmera do dataset é não-monotônico, e
        # nos arquivos convertidos ele traz a data da CONVERSÃO, não a da filmagem.
        if _tc_usable(clips):
            clips.sort(key=lambda c: c.tc_sec)
        elif all(c.group_order is not None for c in clips):
            clips.sort(key=lambda c: c.group_order)
        else:
            clips.sort(key=lambda c: _natural_sort_key(c.path))

        # O nome que o usuário deu à fonte. Sem ele (payload antigo, ou um arquivo
        # solto), cai no que sempre se fez: o nome da pasta, ou o do próprio arquivo
        # quando a fonte tem um clipe só.
        name = source_names.get(gid) or (
            Path(gid).name if len(clips) > 1 else clips[0].path.name
        )
        group_names[gid] = name
        for c in clips:
            c.group_name = name

    all_clips = [c for gid in group_order_seen for c in groups[gid]]

    # ── 3.5 Fixar os clipes que o RE-SYNC PARCIAL não selecionou ─────────────
    #
    # Eles não passam pela correlação: entram já resolvidos, com a confiança no
    # teto — é isso que os torna ÂNCORA para os que FORAM selecionados, sem gastar
    # um segundo relendo um arquivo que ninguém pediu para reconsiderar.
    if pinned:
        sound_by_path = {str(s.path): s for s in sounds}
        for c in all_clips:
            fixado = pinned.get(str(c.path))
            if fixado is None:
                continue
            offset_frames, sound_path = fixado
            snd = sound_by_path.get(sound_path)
            if snd is None:
                # O som apontado não está (mais) nesta diária — não há como
                # ancorar nele. Cai para a correlação normal, se selecionado; senão
                # fica sem som, como um órfão.
                continue
            c.sound = snd
            c.offset_frames = offset_frames
            c.confidence = PINNED_CONFIDENCE
            snd.clips.append(c)
            if c.tc_sec is not None and snd.tc_sec is not None:
                c.implied_delta = (snd.tc_sec + offset_frames / project_fps) - c.tc_sec

    # ── 4. Parear cada clipe com o seu som ───────────────────────────────────
    # Só entram no alinhamento por TC as câmeras cujo relógio SERVE (ver
    # _tc_usable) e os sons que têm TC. Uma câmera com relógio inútil ainda é
    # sincronizada pela waveform — o que ela não pode é envenenar o desenho.
    tc_gids = [gid for gid in group_order_seen if _tc_usable(groups[gid])]
    tc_clips = [c for gid in tc_gids for c in groups[gid]]
    tc_sounds = [s for s in sounds if s.tc_sec is not None]

    offsets = []
    if tc_clips and tc_sounds:
        emit("Alinhando o desenho dos arquivos pelo timecode...", 0, len(all_clips))
        offsets = clock_offsets(
            [Interval(str(c.path), c.tc_sec, c.tc_sec + c.duration_s) for c in tc_clips],
            [Interval(str(s.path), s.tc_sec, s.tc_sec + s.duration_s) for s in tc_sounds],
        )

    if not has_sound:
        # Nada com que parear. Cada clipe fica sinalizado `no_sound` e vai para a
        # bin — sinalizado, nunca descartado. `_place_on_timeline` os posiciona pelo
        # TC (ou os emenda em sequência, se não houver relógio).
        emit("Sem som direto: os clipes vão sinalizados.", 0, len(all_clips))
        for c in all_clips:
            c.flagged, c.flag_reason = True, "no_sound"
            _emit_clip(on_clip, c, project_fps)
    elif sync_method == "timecode":
        # TIMECODE PURO — sem ler áudio. Coloca cada clipe no seu TC e o pareia com
        # o som cujo TC se sobrepõe. Ver `_pair_by_tc_only`.
        emit("Posicionando pelo timecode...", 0, len(all_clips))
        _pair_by_tc_only(
            all_clips, sounds, project_fps, emit, on_clip, on_sound, selected=selected,
        )
    elif sync_method == "waveform":
        # FORMA DE ONDA PURA — ignora o TC no pareamento, mesmo quando ele serviria.
        # É a escolha do usuário: "não confie no relógio, ouça".
        emit("Pareando por forma de onda...", 0, len(all_clips))
        _pair_by_waveform(
            groups, group_order_seen, sounds, project_fps, emit, on_clip, on_sound,
            selected=selected,
        )
    elif offsets:
        listed = ", ".join(f"{o.coverage:.0%}" for o in offsets)
        emit(f"{len(offsets)} alinhamento(s) de relógio ({listed})", 0, len(all_clips))
        _pair_by_timecode(
            tc_clips, tc_sounds, offsets, project_fps, emit, on_clip, on_sound,
            selected=selected,
        )

        # As câmeras sem relógio utilizável caem na busca cega.
        rest = {gid: groups[gid] for gid in group_order_seen if gid not in tc_gids}
        if rest:
            emit("Câmeras sem relógio — pareando por forma de onda...",
                 0, len(all_clips))
            _pair_by_waveform(
                rest, list(rest), sounds, project_fps, emit, on_clip, on_sound,
                selected=selected,
            )
    else:
        # Ou não há timecode, ou o desenho não identifica Δ (som contínuo, sem
        # buracos para encaixar — ver tcmatch._plateau_width). Nos dois casos quem
        # responde é a forma de onda.
        emit("Pareando por forma de onda...", 0, len(all_clips))
        _pair_by_waveform(
            groups, group_order_seen, sounds, project_fps, emit, on_clip, on_sound,
            selected=selected,
        )

    for s in sounds:
        s.release()

    # ── 5. Posições absolutas na timeline ────────────────────────────────────
    _place_on_timeline(groups, group_order_seen, sounds, project_fps)

    # ── 6. Materializar o Daily ──────────────────────────────────────────────
    return _build_daily(
        groups, group_order_seen, group_names, sounds, all_clips,
        project_fps, project_name, start_tc_frames,
    )


# ── Pareamento por TIMECODE PURO (sem áudio) ─────────────────────────────────


def _pair_by_tc_only(
    clips: list[_Clip],
    sounds: list[_Sound],
    fps: float,
    emit: ProgressCallback,
    on_clip,
    on_sound=None,
    selected: set[str] | None = None,
) -> None:
    """
    SINCRONIZAÇÃO POR TIMECODE PURO — sem correlação, sem ler áudio de câmera.

    Coloca cada clipe no seu TC de entrada e o pareia com o som cujo TC se
    sobrepõe. O offset é a diferença de TC (`cam_TC − snd_TC`) — que é o sync
    EXATO quando câmera e gravador compartilham o relógio (jam sync). É a opção
    para quando o usuário SABE que o TC está certo: vê a timeline inteira na hora,
    e conserta pontualmente, pela seleção, os poucos clipes onde o TC falhou
    (re-sync por forma de onda daquela seleção).

    O que NÃO tem TC não tem como ser posicionado por aqui: fica sinalizado
    (`no_tc`). O que tem TC mas não cai em som nenhum vai para os órfãos,
    ancorado pelo próprio TC em `_place_on_timeline`.

    `selected` (RE-SYNC PARCIAL) — processa só quem está nele; o resto já chegou
    fixado por `pinned` e não é tocado.
    """
    snd_with_tc = [s for s in sounds if s.tc_sec is not None]
    to_process = [c for c in clips if selected is None or str(c.path) in selected]
    total = len(to_process)
    done = 0

    for c in to_process:
        if c.tc_sec is None:
            # Sem relógio, o TC puro não tem o que fazer — é a resposta honesta.
            c.flagged, c.flag_reason = True, "no_tc"
            done += 1
            emit(f"{c.path.name}: sem timecode", done, total)
            _emit_clip(on_clip, c, fps)
            continue

        # O som cujo TC mais se sobrepõe ao do clipe. Sobreposição, e não só
        # "contém o início", porque um clipe pode começar antes do gravador e
        # ainda pertencer àquele som.
        best = None
        for s in snd_with_tc:
            overlap = (min(c.tc_sec + c.duration_s, s.tc_sec + s.duration_s)
                       - max(c.tc_sec, s.tc_sec))
            if overlap > 0 and (best is None or overlap > best[1]):
                best = (s, overlap)

        if best is None:
            c.flagged, c.flag_reason = True, "no_sound"
            done += 1
            emit(f"{c.path.name}: TC fora de qualquer som", done, total)
            _emit_clip(on_clip, c, fps)
            continue

        snd = best[0]
        c.sound = snd
        c.offset_frames = round((c.tc_sec - snd.tc_sec) * fps)
        # O TC é a fonte da verdade aqui — confiança no teto, como um clipe fixado.
        # Isso também o credencia como âncora se um resync por waveform vier depois.
        c.confidence = PINNED_CONFIDENCE
        # Posicionado pelo TC, SEM verificar o áudio — a timeline pinta diferente.
        c.sync_source = "timecode"
        snd.clips.append(c)
        done += 1
        emit(f"TC {c.path.name}: {c.offset_frames:+d} frames", done, total)
        _emit_clip(on_clip, c, fps)
        _ensure_sound_peaks(snd)
        _emit_sound(on_sound, snd, c, fps)


# ── Pareamento COM timecode ──────────────────────────────────────────────────


def _pair_by_timecode(
    clips: list[_Clip],
    sounds: list[_Sound],
    offsets: list,
    fps: float,
    emit: ProgressCallback,
    on_clip,
    on_sound=None,
    selected: set[str] | None = None,
) -> None:
    """
    O diferencial: o timecode diz QUEM VAI COM QUEM; a waveform diz por QUANTOS
    FRAMES.

    O alinhamento do desenho reduz os candidatos de "todos os sons do dia" para
    um ou dois. A correlação então roda contra esses — e sem tomadas repetidas
    concorrendo, ela deixa de ter como escolher a errada.

    `selected` (RE-SYNC PARCIAL) — `None` processa `clips` inteiro, como sempre.
    Um conjunto pula quem está fora dele: já foi resolvido por `pinned` em `run()`,
    e mexer nele de novo seria o re-sync parcial custar a diária inteira.
    """
    cam_ivs = [
        Interval(str(c.path), c.tc_sec, c.tc_sec + c.duration_s)
        for c in clips if c.tc_sec is not None
    ]
    snd_ivs = [
        Interval(str(s.path), s.tc_sec, s.tc_sec + s.duration_s)
        for s in sounds if s.tc_sec is not None
    ]
    by_path = {str(s.path): s for s in sounds}

    # O progresso conta só o que VAI SER PROCESSADO — num re-sync parcial, o pulado
    # nem entra na conta, para a barra não andar pela diária inteira e mentir que
    # tudo foi reprocessado.
    total = sum(1 for c in clips if selected is None or str(c.path) in selected)
    done = 0
    for c in clips:
        if selected is not None and str(c.path) not in selected:
            # Fixado pelo `pinned` de `run()` (ou nem tocado) — o re-sync parcial
            # não lê o arquivo dele de novo.
            continue

        ok, reason = c.syncable
        if not ok:
            c.flagged, c.flag_reason = True, reason
            done += 1
            emit(f"{c.path.name}: não sincronizável ({reason})", done, total)
            _emit_clip(on_clip, c, fps)
            continue

        iv = next((i for i in cam_ivs if i.key == str(c.path)), None)
        cands = candidate_sounds(iv, snd_ivs, offsets) if iv else []

        if not cands:
            # Não caiu dentro de som nenhum, em nenhum regime. Normal: a câmera
            # roda antes do gravador, entre tomadas, e em planos sem som.
            c.flagged, c.flag_reason = True, "no_sound"
            done += 1
            emit(f"{c.path.name}: sem som direto correspondente", done, total)
            _emit_clip(on_clip, c, fps)
            continue

        emit(f"Sincronizando {c.path.name}...", done, total)

        # O TIMECODE JÁ DISSE QUAL É O SOM. O que falta é ONDE, dentro dele — e para
        # isso não é preciso ler o clipe inteiro: uma JANELA dele basta, e a busca
        # continua varrendo o som TODO, exatamente como antes.
        #
        # Não caia na tentação de estreitar também a busca DENTRO do som usando o Δ
        # do `clock_offsets`: esse Δ é GROSSO (candidatos a 30 s de distância um do
        # outro — ele foi feito para escolher o som, não para apontar dentro dele).
        # Uma janela de busca de ±2 s em cima dele prendeu a correlação no lugar
        # errado e moveu 3 clipes da D02 em ~3 s. O som é barato de ler; a câmera é
        # que não é. Economize no lado caro, e só nele.
        best = None
        if c.size_bytes > WHOLE_FILE_BUDGET_BYTES:
            for snd_key in dict.fromkeys(k for k, _ in cands):
                snd = by_path[snd_key]
                r = _measure_window(c, snd, fps)
                if r is None:
                    continue
                if best is None or r[1] > best[1]:
                    best = (*r, snd)

        # NÃO filtrar aqui por `TRUST_RATIO`. Esse limiar foi calibrado para a razão
        # do ENVELOPE (`sync_camera_to_wav`); a correlação de PCM cru da janela tem
        # outra escala e fica em ~1,1–3,9 mesmo quando acerta. Barrar por ele mandava
        # metade dos clipes para a leitura integral sem motivo — e devolvia os 18
        # minutos. Quem julga se o resultado presta é `_corroborate_by_delta`, que
        # compara o Δ deste clipe com o do REGIME do relógio: é uma medida absoluta,
        # e não depende da escala de nenhuma razão.
        if best is None:
            whole = _measure_whole_file(c, cands, by_path, fps)
            if whole is not None:
                best = whole

        if best is None:
            c.flagged, c.flag_reason = True, "no_sound"
            done += 1
            emit(f"{c.path.name}: não foi possível medir", done, total)
            _emit_clip(on_clip, c, fps)
            continue

        offset, ratio, snd = best
        c.sound, c.offset_frames, c.confidence = snd, offset, ratio
        c.sync_source = "waveform"   # o som confirmou de verdade
        snd.clips.append(c)

        # Δ IMPLÍCITO deste par: agora que o offset é conhecido, dá para dizer
        # exatamente quanto o relógio da câmera está adiantado em relação ao do
        # gravador. É o número que a checagem de coerência abaixo usa — muito mais
        # preciso que o Δ grosso do encaixe do desenho, que só serviu para propor
        # o candidato.
        c.implied_delta = (snd.tc_sec + offset / fps) - c.tc_sec

        c.pcm = None
        done += 1
        emit(f"Sync {c.path.name}: {offset:+d} frames", done, total)
        _emit_clip(on_clip, c, fps)
        _ensure_sound_peaks(snd)
        _emit_sound(on_sound, snd, c, fps)

    _corroborate_by_delta(clips, fps, on_clip, selected=selected)


def _ensure_sound_peaks(snd: _Sound) -> None:
    """A waveform do SOM, que a timeline desenha.

    Primeiro o CACHE EM DISCO (os nossos `.pek`): num segundo sync da mesma diária
    — e no modo TC, que promete "sem processamento" — reler 2,5 GB de som só para
    redesenhar uma onda que não mudou seria pagar duas vezes pela mesma imagem.

    Sem cache, vale a leitura integral: o som é a REFERÊNCIA — é contra ele que o
    usuário confere o sync com os olhos. As waveforms das CÂMERAS não são feitas
    aqui: elas custariam o arquivo inteiro de cada clipe, que é justamente o que
    este caminho existe para evitar. Vêm depois, em segundo plano
    (comando `compute_peaks`).
    """
    if snd.peaks is not None:
        return
    cached = peakcache.load(snd.path)
    if cached is not None:
        snd.peaks = base64.b64encode(cached.tobytes()).decode("ascii")
        return
    snd.load_pcm()
    snd.release()


def _measure_window(
    c: _Clip,
    snd: _Sound,
    fps: float,
    near_frames: int | None = None,
    half_frames: int = 0,
) -> tuple[int, float] | None:
    """
    Onde `c` cai dentro de `snd` — lendo só uma JANELA do clipe.

    Devolve `(offset_frames, razão)`, ou `None` se não houver janela utilizável.

    A ECONOMIA É SÓ DO LADO DA CÂMERA, e é onde ela toda está: o áudio de câmera
    vive interleavado com o vídeo, então ler 20 s de som de um MXF ProRes custa ler
    20 s de imagem junto (~4 s de disco). O SOM é lido inteiro — um dia de som
    direto são ~2,5 GB contra os 202 GB das câmeras.

    Por padrão a busca varre o som TODO: nada restringe ONDE o pico pode cair, só
    QUANTO do clipe se usa para achá-lo. `near_frames` restringe a busca a
    ±`half_frames` de um offset previsto — e **só deve ser usado quando a previsão
    for PRECISA** (o Δ medido de um regime de relógio). O Δ grosso do
    `clock_offsets` NÃO serve: os candidatos dele ficam a 30 s um do outro, e
    prender a busca neles moveu clipes da D02 em 3 s.
    """
    cam_dur = c.duration_s

    cw0 = min(WAVEFORM_WINDOW_LEAD_S, max(0.0, cam_dur - WAVEFORM_WINDOW_S))
    cw = min(WAVEFORM_WINDOW_S, cam_dur - cw0)
    if cw < MIN_SYNC_DURATION_S:
        return None

    cam_pcm = normalize(extract_pcm_window(c.path, cw0, cw))
    snd_pcm = snd.load_pcm()
    snd.release()
    if len(snd_pcm) < len(cam_pcm):
        return None

    # A janela do clipe começa em `cw0` DENTRO dele, então ela cai em
    # `offset + cw0` dentro do som.
    lo = 0
    if near_frames is not None:
        lo = max(0, round((near_frames - half_frames) / fps * PCM_RATE)
                 + round(cw0 * PCM_RATE))
        hi = min(len(snd_pcm),
                 round((near_frames + half_frames) / fps * PCM_RATE)
                 + round(cw0 * PCM_RATE) + len(cam_pcm))
        snd_pcm = snd_pcm[lo:hi]
        if len(snd_pcm) < len(cam_pcm):
            return None

    found = confirm_offset(cam_pcm, snd_pcm)
    if found is None:
        return None

    pos_s, ratio = found
    return round((lo / PCM_RATE + pos_s - cw0) * fps), ratio


def _measure_whole_file(
    c: _Clip, cands, by_path: dict[str, _Sound], fps: float
) -> tuple[int, float, _Sound] | None:
    """O caminho CARO: lê o clipe inteiro. Só para quem a janela não resolveu."""
    if c.pcm is None:
        c.pcm = normalize(extract_pcm(str(c.path)))

    best = None
    for snd_key in dict.fromkeys(k for k, _ in cands):
        snd = by_path[snd_key]
        offset, ratio = sync_camera_to_wav(
            wav_path=str(snd.path), camera_path=str(c.path), fps=fps,
            ref_pcm=snd.load_pcm(), cam_pcm=c.pcm,
        )
        snd.release()
        if best is None or ratio > best[1]:
            best = (offset, ratio, snd)
    return best


def _corroborate_by_delta(
    clips: list[_Clip], fps: float, on_clip, selected: set[str] | None = None,
) -> None:
    """
    Usa o Δ IMPLÍCITO para consertar o que a correlação errou — e sinalizar o que
    ela não tem como acertar.

    Δ implícito = o quanto o relógio da câmera está adiantado em relação ao do
    gravador, calculado EXATAMENTE a partir do offset que a waveform achou. Ele só
    muda quando alguém reinicia um aparelho: dentro de um regime é praticamente
    uma constante (medido no material real: variação de 0,0 s ao longo de 24
    tomadas).

    Daí a alavanca: um clipe cujo Δ destoa do regime está errado, e o Δ do regime
    DIZ ONDE ELE DEVERIA ESTAR. Então em vez de só sinalizá-lo, refazemos a
    correlação numa janela estreita ao redor desse offset previsto — e aí não há
    concorrente para ela escolher errado.

    Os regimes são descobertos agrupando os Δ (não há como saber de antemão
    quantos são: uma diária real tem dois, e outra tem um segundo GRAVADOR, com um
    relógio a 6 horas de distância do primeiro).

    Um regime SEM nenhum clipe confiável não tem como se autocorrigir — nada nele
    corrobora nada. Esses clipes ficam sinalizados, e é a resposta honesta:
    "sincronizei, mas não confio; olhe".
    """
    paired = [c for c in clips
              if c.sound is not None and c.implied_delta is not None and c.tc_sec is not None]
    anchors = [c for c in paired if c.confidence >= TRUST_RATIO]
    if len(anchors) < 2:
        return

    for c in paired:
        if selected is not None and str(c.path) not in selected:
            # Fixado pelo `pinned` — ele É a âncora (entrou em `anchors` acima), e
            # não o alvo de mais uma corroboração.
            continue

        # O regime de um clipe se descobre pelo TEMPO dele, não pelo Δ dele. Um
        # clipe mal sincronizado tem o Δ errado — agrupar por Δ o jogaria no regime
        # errado, justamente o clipe que se quer consertar. Já o tempo não mente: um
        # regime é um trecho contíguo do dia, e as âncoras confiáveis ao redor dizem
        # qual relógio valia ali.
        near = [a for a in anchors
                if a is not c and abs(a.tc_sec - c.tc_sec) <= ANCHOR_REACH_S]

        if len(near) < 2:
            # Nenhuma âncora por perto. Não há relógio corroborado com que julgar
            # nem corrigir este clipe. Se a correlação também não se garante, o
            # honesto é dizer que não sabemos. (É o caso, no material real, de um
            # SEGUNDO gravador usado à tarde, cujos clipes não têm uma única
            # correlação confiante entre si.)
            if c.confidence < TRUST_RATIO:
                c.flagged, c.flag_reason = True, "unverified"
                _emit_clip(on_clip, c, fps)
            continue

        regime_delta = float(np.median([a.implied_delta for a in near]))
        if abs(c.implied_delta - regime_delta) <= TC_AGREEMENT_S:
            continue   # corroborado: o relógio e o som dizem a mesma coisa

        # O regime diz onde este clipe DEVERIA cair. Refaz a correlação só ali — e
        # assim a tomada vizinha, que competia e vencia, sai do páreo.
        predicted_frames = round((regime_delta - c.sound.tc_sec + c.tc_sec) * fps)
        half = round(TC_SEARCH_WINDOW_S * fps)

        # AQUI a previsão é PRECISA (vem do Δ medido de várias âncoras, não do Δ
        # grosso do `clock_offsets`), então uma janela estreita é segura — e num
        # arquivo de câmera original ela é a diferença entre 10 s e 4 s por clipe.
        found = None
        if c.size_bytes > WHOLE_FILE_BUDGET_BYTES:
            found = _measure_window(
                c, c.sound, fps,
                near_frames=predicted_frames, half_frames=half,
            )
        if found is None:
            offset, ratio = sync_camera_to_wav(
                wav_path=str(c.sound.path), camera_path=str(c.path), fps=fps,
                ref_pcm=c.sound.load_pcm(),
                cam_pcm=normalize(extract_pcm(str(c.path))),
                min_offset_frames=predicted_frames - half,
                max_offset_frames=predicted_frames + half,
            )
            c.sound.release()
        else:
            offset, ratio = found
        c.offset_frames, c.confidence = offset, ratio
        c.implied_delta = (c.sound.tc_sec + offset / fps) - c.tc_sec

        if abs(c.implied_delta - regime_delta) <= TC_AGREEMENT_S:
            _emit_clip(on_clip, c, fps)
            continue   # a janela resolveu: agora concorda com o regime

        # A forma de onda não confirma nem levada pela mão — mas o relógio deste
        # trecho do dia é a MELHOR estimativa que existe, e é dele que sai a posição.
        # Deixar aqui o resultado ruim da correlação seria trocar a medida boa por
        # uma que sabemos ser ruim.
        c.offset_frames = predicted_frames
        c.implied_delta = regime_delta

        # QUÃO confiável é esse relógio decide se o clipe ainda NAGA. Um regime
        # corroborado por VÁRIAS âncoras que concordam apertado (dentro de um regime o
        # Δ é constante a ~0,1 s) posiciona a ~2–3 frames — não é um "não sei", é um
        # sync por timecode legítimo. Vira ardósia (`sync_source="timecode"`) e SAI da
        # lista de "revisar no NLE", em vez de âmbar-hachurado: pintar de duvidoso um
        # clipe que 6 âncoras colocam a 0,02 s do lugar ensina o usuário a ignorar o
        # aviso quando ele importa. Poucas âncoras, ou âncoras que discordam entre si,
        # NÃO dão esse aval — aí segue sinalizado (`tc_only`), como o 2º gravador da
        # tarde (0 âncoras) do material real. Ver DECISIONS.md.
        near_deltas = [a.implied_delta for a in near]
        clock_trustworthy = (
            len(near) >= CLOCK_TRUST_MIN_ANCHORS
            and max(near_deltas) - min(near_deltas) <= TC_AGREEMENT_S
        )
        if clock_trustworthy:
            c.sync_source = "timecode"
        else:
            c.flagged, c.flag_reason = True, "tc_only"
        _emit_clip(on_clip, c, fps)


# Até que distância no tempo uma âncora ainda diz respeito a este clipe. Um regime
# de relógio é um trecho contíguo do dia; depois de um intervalo longo (o almoço,
# no material real) o aparelho pode ter sido reiniciado, e o relógio de antes já
# não vale.
ANCHOR_REACH_S = 3600.0

# Quantas âncoras próximas (e concordando dentro de TC_AGREEMENT_S) bastam para o
# relógio de um regime posicionar um clipe SEM alarme. Abaixo disso o clipe ainda
# cai no relógio, mas sinalizado (`tc_only`): uma ou duas âncoras dão uma mediana
# frágil. Medido no D03: a manhã tem 6 âncoras concordando a ±0,05 s (relógio
# sólido — os planos de abertura, sem sinal de onda, caem certos nele); a tarde,
# com um 2º gravador sem âncora nenhuma, tem 0 e segue duvidosa.
CLOCK_TRUST_MIN_ANCHORS = 3


# ── Pareamento SEM timecode ──────────────────────────────────────────────────


def _pair_by_waveform(
    groups: dict[str, list[_Clip]],
    order: list[str],
    sounds: list[_Sound],
    fps: float,
    emit: ProgressCallback,
    on_clip,
    on_sound=None,
    selected: set[str] | None = None,
) -> None:
    """
    Sem timecode: cada clipe é correlacionado contra TODOS os sons; vence o de
    maior pico.

    A ambiguidade acústica (tomadas repetidas da mesma cena soam parecidas) é
    resolvida por CRONOLOGIA — clipes e sons avançam na mesma ordem, então um
    clipe duvidoso fica restrito aos sons entre os seus vizinhos confiáveis.
    Restrição física, não acústica: nenhuma métrica de áudio resolve isso sozinha.

    `selected` (RE-SYNC PARCIAL) — quem fica de fora não passa pela passada 1 (não
    lê o arquivo, não corre contra `sounds`); ele já chegou aqui com `c.sound`
    resolvido por `pinned`, com confiança no teto — e é isso que o credencia como
    âncora da passada 2 (`trusted`, mais abaixo) sem precisar de nenhum caso especial
    ali.
    """
    # O total (e o progresso) conta só o que VAI SER PROCESSADO. Num re-sync
    # parcial isto é o que impede a barra de andar por toda a diária e dar a
    # impressão de que tudo foi reprocessado — o pulado nem entra na conta.
    def _in_scope(c: _Clip) -> bool:
        return selected is None or str(c.path) in selected

    total = sum(1 for g in groups.values() for c in g if _in_scope(c))
    done = 0

    for gid in order:
        clips = groups[gid]

        # Passada 1: busca livre, contra todos os sons.
        for c in clips:
            if not _in_scope(c):
                continue

            ok, reason = c.syncable
            if not ok:
                c.flagged, c.flag_reason = True, reason
                done += 1
                emit(f"{c.path.name}: não sincronizável ({reason})", done, total)
                _emit_clip(on_clip, c, fps)
                continue

            emit(f"Sincronizando {c.path.name}...", done, total)
            c.pcm = normalize(extract_pcm(str(c.path)))
            c.peaks = _peaks_b64(c.pcm, c.path)

            best = None
            for s in sounds:
                offset, ratio = sync_camera_to_wav(
                    wav_path=str(s.path), camera_path=str(c.path), fps=fps,
                    ref_pcm=s.load_pcm(), cam_pcm=c.pcm,
                )
                if best is None or ratio > best[1]:
                    best = (offset, ratio, s)

            offset, ratio, snd = best
            c.sound, c.offset_frames, c.confidence = snd, offset, ratio
            c.sync_source = "waveform"
            done += 1
            emit(f"Sync {c.path.name}: {offset:+d} frames", done, total)
            _emit_clip(on_clip, c, fps)

        # Passada 2: os duvidosos são reexaminados só entre os sons que a
        # CRONOLOGIA permite — entre o som do vizinho confiável anterior e o do
        # próximo. Uma câmera não grava dois arquivos ao mesmo tempo, e o gravador
        # não volta no tempo: é uma restrição física, e é o que resolve a
        # ambiguidade acústica das tomadas repetidas (nenhuma métrica de áudio
        # resolve isso sozinha).
        trusted = {c for c in clips if c.confidence >= TRUST_RATIO and c.sound}
        snd_index = {s: i for i, s in enumerate(sounds)}

        for i, c in enumerate(clips):
            if c.flagged or c.confidence >= TRUST_RATIO or not c.sound:
                continue

            prev = next((clips[j] for j in range(i - 1, -1, -1) if clips[j] in trusted), None)
            nxt = next((clips[j] for j in range(i + 1, len(clips)) if clips[j] in trusted), None)
            if prev is None and nxt is None:
                # Grupo inteiro ambíguo: não há âncora com que desambiguar.
                c.flagged, c.flag_reason = True, "ambiguous"
                _emit_clip(on_clip, c, fps)
                continue

            lo = snd_index[prev.sound] if prev else 0
            hi = snd_index[nxt.sound] if nxt else len(sounds) - 1
            window = sounds[lo : hi + 1]
            if not window:
                c.flagged, c.flag_reason = True, "ambiguous"
                _emit_clip(on_clip, c, fps)
                continue

            emit(f"Refinando {c.path.name} entre vizinhos...", done, total)
            best = None
            for s in window:
                # A cronologia restringe DUAS coisas, e as duas importam:
                #   - QUAL som (a janela acima), quando há vários;
                #   - ONDE dentro do som, quando um vizinho compartilha o mesmo
                #     som. Este clipe tem que começar depois do fim do anterior e
                #     terminar antes do início do próximo — uma câmera não grava
                #     dois arquivos ao mesmo tempo.
                # Sem a segunda, um projeto com um único som direto (o caso de uma
                # gravação contínua) fica sem desambiguação nenhuma.
                lo = hi = None
                if prev is not None and prev.sound is s:
                    lo = prev.offset_frames + prev.duration_frames
                if nxt is not None and nxt.sound is s:
                    hi = nxt.offset_frames - c.duration_frames
                if lo is not None and hi is not None and hi < lo:
                    # Janela impossível: uma das âncoras está errada, ou a ordem
                    # dos arquivos do grupo está.
                    continue

                offset, ratio = sync_camera_to_wav(
                    wav_path=str(s.path), camera_path=str(c.path), fps=fps,
                    ref_pcm=s.load_pcm(), cam_pcm=c.pcm,
                    min_offset_frames=lo, max_offset_frames=hi,
                )
                if best is None or ratio > best[1]:
                    best = (offset, ratio, s)

            if best is None:
                c.flagged, c.flag_reason = True, "anchor_window_impossible"
                _emit_clip(on_clip, c, fps)
                continue

            offset, ratio, snd = best
            c.sound, c.offset_frames, c.confidence = snd, offset, ratio
            c.sync_source = "waveform"
            if ratio < FLAG_RATIO:
                c.flagged, c.flag_reason = True, "ambiguous"
            _emit_clip(on_clip, c, fps)

        for c in clips:
            if c.sound and c not in c.sound.clips:
                c.sound.clips.append(c)
            if c.sound:
                _emit_sound(on_sound, c.sound, c, fps)
            c.pcm = None


# ── Posições na timeline ─────────────────────────────────────────────────────


def _place_on_timeline(
    groups: dict[str, list[_Clip]],
    order: list[str],
    sounds: list[_Sound],
    fps: float,
) -> None:
    """
    Onde cada arquivo cai na timeline.

    A regra, na ordem de autoridade:

    1. DENTRO de uma ilha do grafo clipe ↔ som ↔ clipe, mandam os OFFSETS DE SYNC.
       Eles são a única coisa que foi MEDIDA contra o áudio de verdade.

    2. ENTRE ilhas, manda o TIMECODE de uma câmera de referência. Numa diária cada
       tomada é uma ilha (o som de uma tomada não tem relação nenhuma com o da
       outra), e o relógio da câmera é o que diz onde cada uma cai no dia — com os
       buracos reais entre elas, como num NLE.

    Por que nesta ordem, e não o contrário
    ──────────────────────────────────────
    O timecode de uma câmera pode não ser um relógio de parede. A câmera do
    dataset antigo grava em REC-RUN: o TC só avança enquanto ela grava, então os
    buracos entre os clipes simplesmente não existem nele. Posicionar por TC ali
    dá 51 s de intervalo onde a realidade (e a waveform) diz 166 s.

    Deixando o sync mandar dentro da ilha, isso deixa de importar: naquele dataset
    tudo compartilha um único som direto, o grafo é uma ilha só, e o TC vira apenas
    um deslocamento global — que a normalização da origem come. Já numa diária, em
    que as ilhas são independentes, o TC é indispensável e (por ser free-run) é
    confiável. Cada regime usa o que ele tem de bom.

    Sobras (clipe sem som — a câmera rodou antes do gravador, ou é um plano MOS):
    o clipe é uma ilha de um elemento só, ancorada pelo próprio TC.
    """
    # ── Ilhas do grafo clipe ↔ som ───────────────────────────────────────────
    all_clips = [c for gid in order for c in groups[gid]]
    islands: list[tuple[list[_Clip], list[_Sound]]] = []
    seen: set[_Clip] = set()

    for c0 in all_clips:
        if c0 in seen:
            continue
        clips: list[_Clip] = []
        snds: list[_Sound] = []
        stack = [c0]
        while stack:
            c = stack.pop()
            if c in seen:
                continue
            seen.add(c)
            clips.append(c)
            s = c.sound
            if s is not None and s not in snds:
                snds.append(s)
                stack.extend(x for x in s.clips if x not in seen)
        islands.append((clips, snds))

    # ── Posições RELATIVAS dentro de cada ilha, a partir dos offsets ─────────
    for clips, snds in islands:
        rel: dict = {clips[0]: 0}
        changed = True
        while changed:
            changed = False
            for s in snds:
                if s in rel:
                    continue
                anchor = next((c for c in s.clips if c in rel), None)
                if anchor is not None:
                    rel[s] = rel[anchor] - anchor.offset_frames
                    changed = True
            for c in clips:
                if c in rel or c.sound is None or c.sound not in rel:
                    continue
                rel[c] = rel[c.sound] + c.offset_frames
                changed = True

        for c in clips:
            c.timeline_start = rel.get(c, 0)
        for s in snds:
            s.timeline_start = rel.get(s, 0)
            s.placed = True

    # ── Ancorar cada ilha no dia, pelo relógio da câmera de referência ───────
    ref_gid = max(
        (gid for gid in order if _tc_usable(groups[gid])),
        key=lambda g: len(groups[g]),
        default=None,
    )

    cursor = 0
    for clips, snds in islands:
        anchor = None
        if ref_gid is not None:
            anchor = next((c for c in clips
                           if c.group_id == ref_gid and c.tc_frames is not None), None)
        if anchor is None:
            anchor = next((c for c in clips if c.tc_frames is not None
                           and _tc_usable(groups[c.group_id])), None)

        if anchor is not None:
            shift = anchor.tc_frames - anchor.timeline_start
        else:
            # Ilha sem relógio nenhum: emendada depois da última. Não há
            # informação para espalhá-la, e inventar um buraco seria mentir.
            shift = cursor - min(c.timeline_start for c in clips)

        for c in clips:
            c.timeline_start += shift
        for s in snds:
            s.timeline_start += shift

        cursor = max(cursor,
                     max(c.timeline_start + c.duration_frames for c in clips))

    # ── Sons SEM câmera nenhuma: posicionados pelo próprio TC ────────────────
    #
    # Um som que não pareou com câmera (o relógio do gravador está horas distante
    # do da câmera, como na D02 do PROJETO X) não entra em ilha nenhuma e ficaria
    # de fora. Mas o arquivo EXISTE e tem lugar no dia — é o que o Premiere mostra.
    # Ancora pelo próprio TC; sem TC, emenda depois do último (não há como
    # espalhá-lo, e inventar um buraco seria mentir).
    for s in sounds:
        if s.placed:
            continue
        dur_frames = math.ceil(s.duration_s * fps)
        if s.tc_sec is not None:
            s.timeline_start = round(s.tc_sec * fps)
        else:
            s.timeline_start = cursor
        s.placed = True
        cursor = max(cursor, s.timeline_start + dur_frames)

    # ── Nenhum clipe da MESMA câmera (nem dois sons) se sobrepõe ─────────────
    _resolve_track_overlaps(islands, [s for s in sounds if not s.clips], fps)


# Track "virtual" de todo som direto — dois sons também não podem se sobrepor.
_SOUND_TRACK = "__sound__"


def _resolve_track_overlaps(
    islands: list[tuple[list["_Clip"], list["_Sound"]]],
    orphan_snds: list["_Sound"],
    fps: float,
) -> None:
    """
    Empurra as UNIDADES (tomadas e sons órfãos) para a frente até nenhum clipe da
    MESMA câmera — nem dois sons — se sobrepor. Uma câmera não grava dois arquivos
    ao mesmo tempo, e o gravador não grava dois sons ao mesmo tempo: na timeline
    isso vira uma track só, e uma track não tem dois clipes no mesmo instante.

    Move a UNIDADE INTEIRA (os clipes E o som da tomada, pelo mesmo Δ), então o sync
    interno se preserva — é a mesma razão de `_place_on_timeline` posicionar por
    ilha. Só empurra para a FRENTE, e só o mínimo: uma tomada que já cabe não se mexe.

    ⚠️ SLOW-MOTION é a EXCEÇÃO e está PENDENTE: um clipe em câmera lenta dura mais
    (tempo real) do que o seu intervalo de TC sugere, então ele PODE, legitimamente,
    invadir o TC do próximo. Por ora este passe o empurra como a qualquer outro —
    quando a detecção de slow entrar, excluir esses clipes daqui.
    """
    def sound_end(s: "_Sound") -> int:
        return s.timeline_start + math.ceil(s.duration_s * fps)

    # Uma unidade = uma ilha (clipes+som) ou um som órfão sozinho.
    units = [(clips, snds) for clips, snds in islands]
    units += [([], [s]) for s in orphan_snds]

    def unit_start(u):
        clips, snds = u
        return min([c.timeline_start for c in clips]
                   + [s.timeline_start for s in snds])

    units.sort(key=unit_start)

    track_end: dict[str, int] = {}   # track → onde o último clipe dela terminou
    for clips, snds in units:
        intervals = [
            (c.group_id, c.timeline_start, c.timeline_start + c.duration_frames)
            for c in clips
        ]
        intervals += [(_SOUND_TRACK, s.timeline_start, sound_end(s)) for s in snds]

        # O Δ para a frente que zera TODA sobreposição desta unidade (o máximo, numa
        # passada: empurrar por ele deixa cada início ≥ o fim já ocupado na track).
        shift = 0
        for key, start, _end in intervals:
            te = track_end.get(key)
            if te is not None and start < te:
                shift = max(shift, te - start)

        if shift:
            for c in clips:
                c.timeline_start += shift
            for s in snds:
                s.timeline_start += shift

        for key, _start, end in intervals:
            end += shift
            track_end[key] = max(track_end.get(key, end), end)


# ── Materialização ───────────────────────────────────────────────────────────


def _build_daily(
    groups: dict[str, list[_Clip]],
    order: list[str],
    names: dict[str, str],
    sounds: list[_Sound],
    all_clips: list[_Clip],
    fps: float,
    project_name: str,
    start_tc_frames: int,
) -> Daily:
    tpf = _ticks_per_frame(fps)
    angle_of: dict[_Clip, CameraAngle] = {}

    camera_groups: list[CameraGroup] = []
    for gid in order:
        angles = []
        for c in groups[gid]:
            angle = CameraAngle(
                path=c.path,
                fps=fps,
                duration_frames=c.duration_frames,
                timeline_start_frames=c.timeline_start,
                sync_offset_frames=c.offset_frames,
                tc_start_frames=c.tc_frames,
                alternate_start_ticks=None if c.tc_frames is None else c.tc_frames * tpf,
                audio_channels=int(c.meta.get("channels") or 2),
                flagged=c.flagged,
                flag_reason=c.flag_reason,
                confidence=c.confidence,
                sync_source=c.sync_source,
            )
            angle_of[c] = angle
            angles.append(angle)
        camera_groups.append(CameraGroup(cameras=angles, name=names[gid], id=gid))

    def _sound_clip(s: _Sound) -> SoundClip:
        return SoundClip(
            path=s.path,
            sample_rate=int(s.meta.get("sample_rate") or 48000),
            duration_ms=float(s.meta.get("duration_ms") or 0.0),
            channels=int(s.meta.get("channels") or 2),
            timeline_start_frames=s.timeline_start,
            tc_start_sec=s.tc_sec,
            scene=s.meta.get("scene"),
            take=s.meta.get("take"),
        )

    takes: list[Take] = []
    orphan_sounds: list[SoundClip] = []
    for s in sounds:
        if s.clips:
            takes.append(Take(
                sound=_sound_clip(s),
                cameras=[angle_of[c] for c in s.clips],
            ))
        else:
            # Som sem câmera: não vira tomada, mas NÃO some — vai posicionado pelo
            # próprio TC (ver `_place_on_timeline`). É o que faz o app mostrar o
            # mesmo que o Premiere quando o relógio do gravador destoa do da câmera.
            orphan_sounds.append(_sound_clip(s))

    orphans = [angle_of[c] for c in all_clips if c.sound is None]

    daily = Daily(
        camera_groups=camera_groups,
        takes=takes,
        orphan_cameras=orphans,
        orphan_sounds=orphan_sounds,
        fps=fps,
        name=project_name,
        start_tc_frames=start_tc_frames,
    )
    daily.normalize_origin()
    return daily


def _emit_clip(on_clip, c: _Clip, fps: float) -> None:
    """
    Manda o estado atual de um clipe para a timeline (upsert por path).

    A posição vai como o TIMECODE do clipe — a posição definitiva só existe no
    fim, depois de o grafo de sync ser resolvido e a origem normalizada. Para o
    preenchimento ao vivo isso basta e é honesto: o TC é onde o clipe cai no dia, e
    é onde ele vai ficar.
    """
    if not on_clip:
        return
    on_clip({
        "group_id": c.group_id,
        "group_name": c.group_name,
        "path": str(c.path),
        "name": c.path.name,
        "fps": fps,
        "duration_frames": c.duration_frames,
        "timeline_start_frames": c.tc_frames or 0,
        "sync_offset_frames": c.offset_frames,
        "sound_path": str(c.sound.path) if c.sound else None,
        "flagged": c.flagged,
        "flag_reason": c.flag_reason,
        "confidence": c.confidence,
        "sync_source": c.sync_source,
        "peak_rate": PEAK_RATE,
        "peaks": c.peaks,
    })


def _emit_sound(on_sound, s: "_Sound", anchor: _Clip, fps: float) -> None:
    """Manda um som para a timeline, pendurado no clipe que o ancora."""
    if not on_sound or s.peaks is None:
        return
    on_sound({
        "path": str(s.path),
        "name": s.path.name,
        "fps": fps,
        "duration_ms": s.meta.get("duration_ms") or 0.0,
        "timeline_start_frames": (anchor.tc_frames or 0) - anchor.offset_frames,
        "channels": int(s.meta.get("channels") or 2),
        "peak_rate": PEAK_RATE,
        "peaks": s.peaks,
    })
