"""
Orbita — tipos de domínio do sync engine (agnósticos de NLE).

O modelo de uma DIÁRIA
──────────────────────
Uma diária de ficção é feita de TOMADAS. Cada tomada tem o seu som direto (um
arquivo por take) e um ou mais clipes de câmera. Não existe "um som contínuo do
dia" — essa premissa (que o material de teste antigo escondia) era o que fazia o
app recusar material real.

  Daily
   ├── camera_groups: [CameraGroup]   ← câmeras FÍSICAS (uma = uma track de vídeo)
   ├── takes:         [Take]          ← uma tomada = um som + as câmeras dela
   └── orphan_cameras:[CameraAngle]   ← clipes sem som (sinalizados, não descartados)

Um clipe de câmera aparece EM UM lugar só: ou numa tomada, ou entre os órfãos.
`camera_groups` é uma visão transversal (a que câmera física cada clipe pertence),
não uma cópia.

As DUAS grandezas de tempo — não confundir
──────────────────────────────────────────
`CameraAngle.sync_offset_frames` é a RELAÇÃO DE SYNC: quantos frames a câmera
começa depois do SEU som direto. É o que a correlação mede, o que o usuário
corrige arrastando na timeline, e o que o merged clip precisa.

`timeline_start_frames` é a POSIÇÃO ABSOLUTA na timeline. Vem do timecode da
câmera (é assim que um NLE distribui uma diária: cada clipe no seu lugar do dia,
com os buracos reais entre as tomadas). Sem timecode, os clipes de uma câmera
ficam emendados.

Fundir as duas foi o erro do modelo antigo, que derivava a posição do offset — o
que só funciona quando existe UM som servindo de origem para todo mundo.

Consequência: o som direto de uma tomada é posicionado ATRAVÉS da câmera dela
(`posição_da_câmera − sync_offset`), e não o contrário. É a câmera que carrega o
relógio do dia.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class CameraAngle:
    """Um arquivo de câmera."""
    path: Path
    fps: float
    duration_frames: int

    # Onde este clipe cai na timeline (≥ 0 depois de normalizado pela origem).
    timeline_start_frames: int = 0

    # Relação de sync com o som direto da SUA tomada, em frames do projeto.
    # Positivo → a câmera começa depois do som. Só faz sentido se o clipe estiver
    # numa Take; para um órfão é 0 e não significa nada.
    sync_offset_frames: int = 0

    # TC embutido, em frames desde 00:00:00:00 (base nominal). None = sem TC.
    tc_start_frames: int | None = None
    # O mesmo TC em ticks do Premiere (254 016 000 000 ticks/s), para o builder.
    alternate_start_ticks: int | None = None

    audio_channels: int = 2
    flagged: bool = False
    flag_reason: str | None = None
    # Razão pico/melhor-concorrente da correlação (ver sync/waveform.py). NÃO é o
    # valor bruto da correlação — é o quão inequívoco foi o match.
    confidence: float = 0.0
    # COMO este clipe foi sincronizado: "waveform" (o som confirmou de verdade) ou
    # "timecode" (só posicionado pelo TC, SEM verificação de áudio). A timeline
    # pinta os dois diferente — um TC puro pode estar errado e não pode se disfarçar
    # de sync verificado. `None` = órfão / não sincronizado. Ver draw.ts.
    sync_source: str | None = None


@dataclass
class CameraGroup:
    """Uma câmera FÍSICA. Vira uma track de vídeo no NLE."""
    cameras: list[CameraAngle] = field(default_factory=list)
    name: str = ""
    # Identidade estável (na prática, o caminho da pasta arrastada). Casa uma
    # track da timeline com a sua linha na lista, e sobrevive ao round-trip
    # sync → exportar.
    id: str = ""


@dataclass
class SoundClip:
    """Um arquivo de som direto — o som de UMA tomada."""
    path: Path
    sample_rate: int
    duration_ms: float
    channels: int = 2

    # Posição na timeline. Derivada da câmera da tomada (ver o cabeçalho): o som
    # não tem relógio comum com a câmera, então não se posiciona sozinho.
    timeline_start_frames: int = 0

    # Início do arquivo em segundos desde a meia-noite (chunk bext do BWF).
    # É o relógio do GRAVADOR — outro relógio, não o da câmera.
    tc_start_sec: float | None = None

    # Cena e tomada, como o gravador de som as escreveu. É como o material se
    # chama na claquete e no relatório de continuidade.
    scene: str | None = None
    take: str | None = None


@dataclass
class Take:
    """Uma tomada: um som direto e as câmeras que a filmaram."""
    sound: SoundClip
    cameras: list[CameraAngle] = field(default_factory=list)

    @property
    def name(self) -> str:
        """Nome de exibição. O nome do ARQUIVO de som ganha da cena/take dos
        metadados: é ele que o sonoplasta e a continuidade usam, e no material
        real o campo SCENE traz o nome do projeto, não o da cena."""
        return self.sound.path.stem


@dataclass
class SubGroup:
    """
    Um recorte temático de uma diária — "cena 01", "a entrevista".

    Guarda só PATHS. É uma vista da diária, não uma cópia: o sync é o MESMO dado, e
    corrigir um clipe na cena corrige na diária porque é o mesmo clipe.

    Os paths chegam do frontend JÁ RESOLVIDOS — com o som direto das tomadas cujas
    câmeras foram escolhidas. A regra de "puxar o som junto" tem UM dono, e é o
    frontend (`viewOf`, em `types/timeline.ts`): o que o usuário vê na timeline da
    cena é literalmente o que vai para a sequência. Reimplementá-la aqui criaria uma
    segunda versão da regra, e um dia as duas divergiriam.

    NÃO tem "modo" (sequência ou multicam). Isso é escolha de EXPORT, muda por
    trabalho e é específica do NLE — vive num `ExportOptions` do adapter. Ver a
    entrada de 2026-07-12 no DECISIONS.md.
    """
    id: str
    name: str
    paths: list[str] = field(default_factory=list)


@dataclass
class Daily:
    """Uma diária inteira: as câmeras físicas, as tomadas, e o que sobrou."""
    camera_groups: list[CameraGroup] = field(default_factory=list)
    takes: list[Take] = field(default_factory=list)
    # Clipes de câmera sem som direto. Normal (a câmera roda antes do gravador,
    # entre tomadas, e em planos sem som) e NUNCA descartados — vão para a bin
    # sinalizados, para o usuário decidir.
    orphan_cameras: list[CameraAngle] = field(default_factory=list)
    # Sons diretos sem NENHUMA câmera correspondente. Acontece muito quando o TC do
    # gravador está num relógio horas distante do da câmera (D02 do PROJETO X): o
    # TC não sobrepõe nenhuma câmera, mas o arquivo EXISTE e precisa aparecer no seu
    # lugar do dia — é o que o Premiere mostra. Posicionados pelo próprio TC, nunca
    # descartados.
    orphan_sounds: list[SoundClip] = field(default_factory=list)
    # As cenas desta diária. Recortes, não cópias — ver SubGroup.
    sub_groups: list[SubGroup] = field(default_factory=list)

    fps: float = 24000 / 1001
    name: str = "DIARIA"
    # TC exibido na origem da timeline, em frames desde 00:00:00:00.
    start_tc_frames: int = 0

    @property
    def cameras(self) -> list[CameraAngle]:
        """Todos os clipes de câmera, achatados, na ordem dos grupos."""
        return [cam for g in self.camera_groups for cam in g.cameras]

    @property
    def sounds(self) -> list[SoundClip]:
        return [t.sound for t in self.takes]

    @property
    def all_sounds(self) -> list[SoundClip]:
        """Todos os sons — os das tomadas E os órfãos. É o que a origem e a
        normalização precisam ver, para os órfãos serem deslocados junto com o
        resto e não ficarem num referencial diferente."""
        return self.sounds + self.orphan_sounds

    @property
    def origin_frames(self) -> int:
        """
        Onde a timeline começa: o início do PRIMEIRO CLIPE a entrar, seja ele uma
        câmera ou um som. Subtrair isto de qualquer posição a torna ≥ 0 — nenhum
        NLE aceita posição negativa.
        """
        starts = [c.timeline_start_frames for c in self.cameras]
        starts += [s.timeline_start_frames for s in self.all_sounds]
        return min(starts) if starts else 0

    def view(self, paths: set[str]) -> Daily:
        """
        A diária restrita a `paths` — a vista de um sub-grupo.

        **Não copia posições nem clipes**: os `CameraAngle`/`SoundClip` devolvidos são
        os MESMOS objetos, só reagrupados. É o que garante que um clipe caia no mesmo
        lugar na sequência da cena e na da diária — não há uma segunda aritmética que
        possa discordar da primeira.

        Só FILTRA. Não decide o que entra: `paths` já vem resolvido do frontend (com o
        som das tomadas junto). Uma fonte que ficou sem clipes desaparece — ela não
        está nesta cena, e uma track de vídeo vazia no Premiere seria ruído.

        `start_tc_frames` é o da DIÁRIA, e continua sendo. Onde a sequência da cena
        começa é outra pergunta, e quem responde é o builder (ver `origin_frames`).
        """
        groups = [
            CameraGroup(cameras=[c for c in g.cameras if str(c.path) in paths],
                        name=g.name, id=g.id)
            for g in self.camera_groups
        ]
        takes = [
            Take(sound=t.sound,
                 cameras=[c for c in t.cameras if str(c.path) in paths])
            for t in self.takes
            if str(t.sound.path) in paths
        ]
        return Daily(
            camera_groups=[g for g in groups if g.cameras],
            takes=takes,
            orphan_cameras=[c for c in self.orphan_cameras if str(c.path) in paths],
            orphan_sounds=[s for s in self.orphan_sounds if str(s.path) in paths],
            fps=self.fps,
            name=self.name,
            start_tc_frames=self.start_tc_frames,
        )

    def normalize_origin(self) -> None:
        """
        Desloca tudo para que o primeiro clipe caia em 0.

        Chamado uma vez, no fim do sync. Depois disso `timeline_start_frames` é
        posição final e ninguém precisa mais saber da origem — em particular o
        builder, que antes espalhava aritmética de `offset − origin` por todo
        lado.

        Percorre `camera_groups` (e NÃO também `orphan_cameras`): os órfãos são os
        MESMOS objetos, referenciados de novo, e deslocá-los duas vezes os jogaria
        para trás. `takes[].cameras` idem.
        """
        origin = self.origin_frames
        if origin == 0:
            return
        for cam in self.cameras:
            cam.timeline_start_frames -= origin
        for snd in self.all_sounds:
            snd.timeline_start_frames -= origin


@dataclass
class Project:
    """
    O trabalho inteiro: N diárias.

    É só um ENVELOPE, e de propósito. Cada `Daily` continua sendo a unidade que se
    sincroniza sozinha — as câmeras de um dia contra o som DAQUELE dia, nunca contra
    o de outro. Duas diárias têm duas origens de tempo sem relação entre si, e é por
    isso que o `Project` não tem fps, nem `start_tc_frames`, nem origem: nada aqui é
    global, porque nada É global.

    O que o envelope compra: um erro numa diária não derruba as outras
    (`main.py` roda uma por vez, com try/except), e o export pode montar UMA bin por
    diária num arquivo só.
    """
    name: str = "PROJETO"
    groups: list[Daily] = field(default_factory=list)
