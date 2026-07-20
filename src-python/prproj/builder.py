"""
Orbita — PRPROJ builder.

Generates a Premiere Pro Multi-Camera Source Sequence (SEM MERGED format):
  N video tracks  (one per camera)
  2 audio tracks  (WAV ch0 on A1, WAV ch1 on A2, both adaptive)
  Gzip-compressed XML conforming to PremiereData Version="3".

Entry point: build_prproj(group, output_path)
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Sequence

from sync.model import CameraAngle, Daily, Project, SoundClip
from prproj.uid import new_uid, OIDCounter
from prproj.compress import write_prproj

# ── Premiere tick rate ────────────────────────────────────────────────────────
TICKS_PER_SEC = 254_016_000_000
AUDIO_FRAME_RATE = 5_292_000      # ticks/audio-sample @ 48000 Hz
# FrameRate string used on audio tracks/components
_AFR = str(AUDIO_FRAME_RATE)

# ── ClassIDs (all from reverse-engineering PROJETO_MULTICAM_TEMPLATE.prproj) ──
_CLS = {
    "Project":               "62ad66dd-0dcd-42da-a660-6d8fbde94876",
    "ProjViewStateList":     "aab0946f-7a21-4425-8908-fafa2119e30e",
    "ProjectViewState":      "18fb911d-4f21-4b7b-b196-b250dad79838",
    "ColumnList":            "a1c709cd-35df-4821-8200-03565d374155",
    "LabelColumn":           "0b8cc011-65dd-4b47-aad9-751ca2891f4a",
    "NameColumn":            "e4d65c8c-33ab-4c4f-8aef-50e53bb63e0b",
    "ProjectSettings":       "50c16708-a1a1-4d2f-98d5-4e283ae28353",
    "VideoSettings":         "58474264-30c4-43a2-bba5-dc0812df8a3a",
    "AudioSettings":         "6baf5521-b132-4634-840e-13cec5bc86a4",
    "VideoCompileSettings":  "db372db5-7de2-4d3c-98ae-f42659d77b22",
    "AudioCompileSettings":  "34b10007-ab6d-49a7-bac5-7b60d919e387",
    "DummyCaptureSettings":  "328c2aa2-47f9-4211-805b-b6a6dbd4ca29",
    "DefaultSeqSettings":    "567bdf53-d6d9-4d61-b2f1-f4834bebea9b",
    "CompileSettings":       "18a35d66-597e-4157-b783-938b5bec3547",
    "ScratchDiskSettings":   "4c6ed82b-a81c-4df1-8bd0-750504c4b560",
    "IngestSettings":        "2db8f76b-2c37-48ee-925d-9a4f7278152d",
    "WorkspaceSettings":     "c4372273-e1aa-4683-98aa-a2ceadf3066c",
    "RootProjectItem":       "1c307a89-9318-47d7-a583-bf2553736543",
    "BinProjectItem":        "dbfd6653-24da-480e-a35e-ba45e9504e4b",
    "ClipProjectItem":       "cb4e0ed7-aca1-4171-8525-e3658dec06dd",
    "MasterClip":            "fb11c33a-b0a9-4465-aa94-b6d5db2628cf",
    "ClipLoggingInfo":       "77ab7fdd-dcdf-465d-9906-7a330ca1e738",
    "Markers":               "bee50706-b524-416c-9f03-b596ce5f6866",
    "Sequence":              "6a15d903-8739-11d5-af2d-9b7855ad8974",
    "Media":                 "7a5c103e-f3ac-4391-b6b4-7cc3d2f9a7ff",
    "VideoStream":           "a36e4719-3ec6-4a0c-ab11-8b4aab377aa5",
    "AudioStream":           "0b5cf52f-2b85-4863-890b-8844b64ecfe9",
    "VideoMediaSource":      "e64ddf74-8fac-4682-8aa8-0e0ca2248949",
    "AudioMediaSource":      "f588da05-fc2a-4fbc-9383-74d653b379e3",
    "VideoClip":             "9308dbef-2440-4acb-9ab2-953b9a4e82ec",
    "AudioClip":             "b8830d03-de02-41ee-84ec-fe566dc70cd9",
    "SubClip":               "e0c58dc9-dbdd-4166-aef7-5db7e3f22e84",
    "SecondaryContent":      "f9d004b5-cb04-4e2f-af6f-64fadc2c4be9",
    "VideoTrackGroup":       "9e9abf7a-0918-49c2-91ae-991b5dde77bb",
    "AudioTrackGroup":       "9b9238b9-53a8-4cc3-b03f-b36246d052e6",
    "DataTrackGroup":        "b714b71d-6838-48dd-9b77-db19088ced7e",
    "VideoClipTrack":        "f68dcd81-8805-11d5-af2d-9bfa89d4ddd4",
    "AudioClipTrack":        "097f6203-99ae-11d5-84f2-8cf14bde7040",
    "AudioMixTrack":         "4b1d8400-e89e-11d5-abc4-a1a13b1e80a0",
    "VideoClipTrackItem":    "368b0406-29e3-4923-9fcd-094fbf9a1089",
    "AudioClipTrackItem":    "064ec682-9ba6-11d5-af2d-9ca32c7d6164",
    "Link":                  "149d4ea5-a7d4-4b34-9bb7-16d783904bf2",
    "AudioComponentChain":   "3cb131d1-d3c0-47ae-a19a-bdf75ea11674",
    "VideoComponentChain":   "0970e08a-f58f-4108-b29a-1a717b8e12e2",
    "AudioFader":            "1a38c583-ed5c-11d5-abc4-c1cbf61ec590",
    "AudioMeter":            "72ea4700-f615-11d5-abc4-c186585e63e0",
    "AudioParamVolume":      "a714635e-a628-4b27-9d59-77eba47dbc1a",
    "AudioParamMute":        "32657501-3aa4-445f-a49b-d09ecb9fa1ae",
    "StereoToStereoPan":     "7bf86a01-efbe-11d5-abc4-c1ce2b1e9090",
    "StereoTo16ChannelPan":  "1a356806-5dc5-4e2f-914c-d8353e1a6581",
    "DefaultPanProcessor":   "33a94282-ee2c-11d5-abc4-c1cd7f9e3c10",
    "AudioTrackInlet":       "be3af080-e8c6-11d5-abc4-a1c6d5dee670",
    "AudioSequenceSource":   "e8d4cc83-38cb-491f-9d94-e5f7e3b205ee",
    "VideoSequenceSource":   "4752dfa9-7a7e-4a3b-a25b-cafde1a8d036",
    "ClipChannelGroupVec":   "a3127a8c-95d4-456e-a7f5-171b3f922426",
    "ClipChannelVec":        "333d203b-3a53-4195-8894-fc7523ff3dc7",
    "ClipChannelSerializer": "5c89aa7a-89a6-4483-becd-f2b1def42316",
}

# TrackGroup type GUIDs (fixed by Premiere)
_TG_VIDEO = "228cda18-3625-4d2d-951e-348879e4ed93"
_TG_AUDIO = "80b8e3d5-6dca-4195-aefb-cb5f407ab009"
_TG_DATA  = "d8143ffe-eec4-4d2a-a909-d5f7bf094dc5"

# Fixed UUID used in all MasterClips as DefMappingID
_DEF_MAPPING_ID = "b7f34681-bada-438d-83d6-7f12236011ba"

# Bin/clip label names, confirmed against the working template's own
# ClipProjectItem "Column.PropertyText.Label" values:
#   raw camera (video) bin item  -> BE.Prefs.LabelColors.1
#   raw WAV (audio) bin item     -> BE.Prefs.LabelColors.2
#   "- Merged" bin item          -> BE.Prefs.LabelColors.4 (Premiere's own
#                                    automatic default for Merge Clips)
_LABEL_VIDEO_NAME = "BE.Prefs.LabelColors.1"
_LABEL_AUDIO_NAME = "BE.Prefs.LabelColors.2"

# Explicit override for "- Merged" clips (Cerulean).
# NOTE: "BE.Prefs.LabelColors.N" is an internal Premiere preference key, NOT
# the visual position in the (localized) label picker menu — confirmed
# empirically: user picked "Cerúleo" in Premiere's UI, saved, and the file
# came back with .4 (not .5, which was our wrong first guess based on menu
# position). .4 is also exactly what the original reference template already
# used for its own "- Merged" bin clips, so this was Premiere's own default
# merge-clip color all along.
_LABEL_MERGED_NAME = "BE.Prefs.LabelColors.4"
_LABEL_MERGED_COLOR = "5814353"

# Audio channel layout JSON constants — compact (no spaces) to match Premiere's format
_LAYOUT_STEREO   = json.dumps([{"channellabel": 100}, {"channellabel": 101}], separators=(",", ":"))
_LAYOUT_MONO     = json.dumps([{"channellabel": 0}], separators=(",", ":"))
# Barramento ADAPTATIVO: 32 canais discretos (channellabel 0). É a forma que o
# Premiere escreve na master track e na saída do panner de uma sequência com >2
# canais — o NumAdaptiveChannels do TrackGroup diz quantos desses 32 estão ativos.
# Medido no material de referência do usuário (multicam de 5 canais que faz flatten
# correto para 1 2 3 4 5). Uma master estéreo (2 canais) dobrava os canais 3..5 no
# canal 1 ao dar flatten.
_LAYOUT_ADAPTIVE = json.dumps([{"channellabel": 0}] * 32, separators=(",", ":"))


# A sub-bin das cenas, dentro da bin da diária.
_SUB_BIN_NAME = "SUB-GRUPOS"


@dataclass
class ExportOptions:
    """
    O que o usuário quer TIRAR do material — do ADAPTER, nunca do domínio.

    `Daily`/`SubGroup` são o que foi filmado e como se alinha: é medida, é verdade, e
    é a mesma para qualquer NLE. Isto aqui é preferência, muda a cada trabalho, e é
    específica do Premiere. Misturar as duas obrigaria a re-sincronizar para trocar
    uma opção de saída. Ver a entrada de 2026-07-12 no DECISIONS.md.

    E são FLAGS INDEPENDENTES, nunca variantes nomeadas: dois toggles já dão quatro
    nomes, e os cinco que o usuário listou dariam 32. O builder LÊ os flags.
    """

    # Os ids das cenas que saem como sequência MULTICAM. As demais saem como
    # sequência normal. É por CENA porque a escolha é por cena: "cena 01" pode ser um
    # multicam para montar, e "planos da varanda" uma sequência simples.
    #
    # ⚠️ ALPHA: o multicam está DESLIGADO (a diária sai como sequência normal). O áudio
    # da multicam adaptativa (5 canais discretos) tem um bug aberto — a sequência é lida
    # como "0 Channel" e fica muda como fonte/nest. Até resolver, entregamos sempre
    # timelines normais sincronizadas. O código de multicam segue aqui, gated, para
    # voltar depois. Ver DECISIONS.md.
    multicam_sub_groups: set[str] = field(default_factory=set)

    def is_multicam(self, sub_group_id: str) -> bool:
        return sub_group_id in self.multicam_sub_groups

    # Incluir o ÁUDIO ORIGINAL da câmera como tracks a mais, DEPOIS das tracks do som
    # direto (A1..An = som direto; A(n+1).. = canais da câmera). O som direto vem
    # sempre primeiro. Útil para o montador ter o som de referência da câmera à mão.
    include_camera_audio: bool = False

    # ⚠️ REGRA CONSCIENTE PARA QUANDO O MERGED CLIP VOLTAR (hoje desligado): um merged
    # clip só nasce de um MATCH DE SYNC REAL — uma TOMADA (`Daily.takes`), que tem
    # câmera E som. Um vídeo órfão (sem som) ou um som órfão (sem câmera) NUNCA vira
    # merged, mesmo que o usuário ligue a flag de merged no export: não há o que fundir
    # (um "merged" só com vídeo, ou só com áudio, não é um merged). O órfão continua
    # na timeline como clipe normal (a timeline tem TODOS os arquivos). Concretamente:
    # o laço que gera merged itera `d.takes`, NUNCA `d.cameras`/`d.all_sounds`, e
    # `orphan_cameras`/`orphan_sounds` ficam de fora por construção. Ver DECISIONS.md.


def _channel_layout(n: int) -> str:
    """Return Premiere AudioChannelLayout JSON for n channels.
    Stereo (2ch) uses L/R labels (100/101); everything else uses generic (0)."""
    if n == 1:
        return _LAYOUT_MONO
    if n == 2:
        return _LAYOUT_STEREO
    return json.dumps([{"channellabel": 0}] * n, separators=(",", ":"))

# Codec fourCC for ProRes (the reference camera codec)
_CODEC_PRORES    = "1634755439"   # 'apcn' in big-endian int32

# Preview format GUID for sequences
_PREVIEW_FORMAT  = "fc3cd4d9-d839-8259-9276-05c5000000ea"


# ── Helper: make XML element ──────────────────────────────────────────────────

def _el(tag: str, attrib: dict | None = None, text: str | None = None) -> ET.Element:
    e = ET.Element(tag, attrib or {})
    if text is not None:
        e.text = str(text)
    return e


def _sub(parent: ET.Element, tag: str, attrib: dict | None = None,
         text: str | None = None) -> ET.Element:
    e = ET.SubElement(parent, tag, attrib or {})
    if text is not None:
        e.text = str(text)
    return e


# ── Builder ───────────────────────────────────────────────────────────────────

class _B:
    """Collects all XML elements that will be direct children of PremiereData."""

    def __init__(self, project: Project, options: ExportOptions | None = None):
        self.project = project
        # Sem opções = os defaults: as cenas saem como sequência normal. O default
        # nunca é "multicam" porque multicam é uma ESCOLHA, e escolher pelo usuário
        # em silêncio é como se perde a confiança nele.
        self.options = options or ExportOptions()
        # A DIÁRIA que está sendo montada agora. É estado mutável, e é de propósito:
        # a aritmética de ticks depende do fps DELA (duas diárias podem ter fps
        # diferentes), e passar o fps por parâmetro em vinte métodos só empurraria a
        # mesma dependência para as assinaturas. `_build_daily` é o único que escreve
        # aqui, e nada fora dele roda entre uma diária e a seguinte.
        self.daily: Daily = project.groups[0] if project.groups else Daily()
        self._oid = OIDCounter(start=50)   # 1-49 reserved for project infra
        self._els: list[ET.Element] = []

        # ── Cache de mídia do PROJETO INTEIRO, chaveado pelo path ─────────────
        # Um arquivo tem UM Media/MasterClip no projeto, mesmo que seja referenciado
        # de mais de um lugar (a sequência da diária e a de um sub-grupo, em E8).
        # Duplicar a mídia faz o Premiere abrir o mesmo arquivo duas vezes na bin —
        # e o usuário não tem como saber qual das duas é "a de verdade".
        self.cam_media: dict[str, tuple[str, str, str, int, str]] = {}   # path → (mc, vms, markers, dur, ams)
        self.snd_media: dict[str, tuple[str, list[str], int, int]] = {}   # path → (mc, ams[], dur, canais)

    def add(self, el: ET.Element) -> ET.Element:
        self._els.append(el)
        return el

    def next_oid(self) -> str:
        return self._oid.next()

    # ── Tick math ─────────────────────────────────────────────────────────────

    def _tpf(self) -> int:
        """Ticks per frame — da DIÁRIA que está sendo montada."""
        return round(TICKS_PER_SEC / self.daily.fps)

    def _cam_duration_ticks(self, cam: CameraAngle) -> int:
        return cam.duration_frames * self._tpf()

    def _sound_duration_ticks(self, ds: SoundClip) -> int:
        return round(ds.duration_ms / 1000 * TICKS_PER_SEC)

    def _start_ticks(self, frames: int) -> int:
        """Posição na timeline (frames do projeto) → ticks do Premiere."""
        return frames * self._tpf()

    def _sync_offset_ticks(self, cam: CameraAngle) -> int:
        return cam.sync_offset_frames * self._tpf()

    def _wav_window(self, snd: SoundClip, sync_offset: int,
                    cam_dur: int) -> tuple[int, int, int, int]:
        """
        Trecho do SOM DIRETO que acompanha esta câmera, em duas coordenadas.

        Devolve `(wav_in, wav_out, seq_in, seq_out)`:
          - `wav_in`/`wav_out` — recorte DENTRO do arquivo WAV, sempre em
            [0, wav_dur]: é de onde o áudio é lido.
          - `seq_in`/`seq_out` — onde esse trecho cai no eixo da CÂMERA (0 = o
            primeiro frame da câmera), que é o eixo da sequência de merged clip.

        As duas coordenadas coincidem com o simples `[sync_offset, sync_offset +
        cam_dur]` / `[0, cam_dur]` sempre que a câmera cabe inteira dentro do
        WAV — o caso comum. Elas se separam quando a câmera começa antes do
        gravador ou continua depois dele: aí o merged clip cobre só a parte em
        que existe som direto, em vez de pedir ao Premiere áudio fora do arquivo.
        """
        wav_dur = self._sound_duration_ticks(snd)
        wav_in = max(0, sync_offset)
        wav_out = min(wav_dur, sync_offset + cam_dur)
        if wav_out <= wav_in:
            # Câmera inteiramente fora do WAV — não há som direto nenhum para ela.
            return 0, 0, 0, 0
        return wav_in, wav_out, wav_in - sync_offset, wav_out - sync_offset

    # ── Common sub-elements ───────────────────────────────────────────────────

    def _node_props(self, parent: ET.Element, props: dict[str, str]) -> None:
        node = _sub(parent, "Node", {"Version": "1"})
        p = _sub(node, "Properties", {"Version": "1"})
        for k, v in props.items():
            _sub(p, k, text=v)

    def _marker_owner(self, parent: ET.Element, markers_oid: str) -> None:
        mo = _sub(parent, "MarkerOwner", {"Version": "1"})
        _sub(mo, "Markers", {"ObjectRef": markers_oid})

    # ── Markers object ────────────────────────────────────────────────────────

    def _make_markers(self) -> str:
        """Create a Markers object, return its OID."""
        oid = self.next_oid()
        m = _el("Markers", {"ObjectID": oid, "ClassID": _CLS["Markers"], "Version": "4"})
        _sub(m, "ByGUID", text="byGUID")
        _sub(m, "LastMetadataState", text="00000000-0000-0000-0000-000000000000")
        _sub(m, "LastContentState", text=new_uid())
        self.add(m)
        return oid

    # ── Media layer: WAV ──────────────────────────────────────────────────────

    def _make_wav_media(self, ds: SoundClip) -> list[str]:
        """
        UM `Media` + `AudioStream` + `AudioMediaSource` **POR CANAL** do WAV.
        Devolve os OIDs dos AudioMediaSource, na ordem dos canais.

        ── É ASSIM QUE O PREMIERE SELECIONA UM CANAL. Não há outro jeito. ──

        Medido no projeto que o próprio Premiere escreveu (`PROJETO-Y-SYNC-COM-TC`, WAV
        de 4 canais): ele cria **quatro** objetos `Media` para o mesmo arquivo. Todos
        com o MESMO `FileKey` e o MESMO `ContentAndMetadataState` (esses identificam
        o ARQUIVO), cada um com o seu `AudioStream` **MONO**, e distinguidos por um
        único campo:

            <StreamNumber>N</StreamNumber>        (ausente = canal 0)

        O que fazíamos antes: UM `Media` declarando os 5 canais, e a escolha do canal
        confiada só a `AudioClip.SecondaryIndex` + `SubClip.OrigChGrp`. O Premiere
        honra isso pela metade — as 5 tracks apareciam, mas **todas tocavam o canal
        1**, e o áudio piscava ao passar o mouse (a estrutura contradiz o que ele
        conforma). `SecondaryIndex` e `OrigChGrp` continuam sendo escritos: o Premiere
        escreve os três. Mas quem de fato aponta para o canal é o `StreamNumber`.

        (O canal 0 NÃO leva `StreamNumber` — ausência significa "o primeiro".)
        """
        wav_dur_ticks = self._sound_duration_ticks(ds)
        n_ch = max(1, ds.channels)

        # Identidade do ARQUIVO — a mesma em todos os canais. Gerar um FileKey por
        # canal faria o Premiere ver N arquivos diferentes que por acaso têm o mesmo
        # caminho.
        file_key = new_uid()
        content_state = new_uid()

        ams_oids: list[str] = []
        for ch in range(n_ch):
            astream_oid = self.next_oid()
            astream = _el("AudioStream", {"ObjectID": astream_oid,
                                          "ClassID": _CLS["AudioStream"], "Version": "7"})
            # MONO: este Media É um canal, não o arquivo inteiro.
            _sub(astream, "AudioChannelLayout", text=_channel_layout(1))
            _sub(astream, "FrameRate", text=_AFR)
            _sub(astream, "Duration", text=str(wav_dur_ticks))
            _sub(astream, "SampleType", text="4")
            self.add(astream)

            media_uid = new_uid()
            media = _el("Media", {"ObjectUID": media_uid,
                                  "ClassID": _CLS["Media"], "Version": "30"})
            _sub(media, "AudioStream", {"ObjectRef": astream_oid})
            _sub(media, "RelativePath", text=self._relative_path(ds.path))
            _sub(media, "FilePath", text=str(ds.path))
            _sub(media, "ImplementationID", text="1fa18bfa-255c-44b1-ad73-56bcd99fceaf")
            _sub(media, "Title", text=ds.path.name)
            _sub(media, "FileKey", text=file_key)
            _sub(media, "ConformedAudioRate", text=_AFR)
            if ch > 0:
                # A ordem importa: o Premiere escreve StreamNumber entre
                # ConformedAudioRate e ContentAndMetadataState.
                _sub(media, "StreamNumber", text=str(ch))
            _sub(media, "ContentAndMetadataState", text=content_state)
            _sub(media, "ActualMediaFilePath", text=str(ds.path))
            self.add(media)

            ams_oid = self.next_oid()
            ams = _el("AudioMediaSource", {"ObjectID": ams_oid,
                                           "ClassID": _CLS["AudioMediaSource"],
                                           "Version": "2"})
            ms = _sub(ams, "MediaSource", {"Version": "4"})
            _sub(ms, "Content", {"Version": "10"})
            _sub(ms, "Media", {"ObjectURef": media_uid})
            _sub(ams, "OriginalDuration", text=str(wav_dur_ticks))
            self.add(ams)

            ams_oids.append(ams_oid)

        return ams_oids

    # ── Media layer: Camera ───────────────────────────────────────────────────

    def _make_camera_media(self, cam: CameraAngle) -> tuple[str, str, str, str]:
        """
        Create Media, VideoStream, AudioStream, VideoMediaSource, AudioMediaSource.
        Returns (media_uid, video_stream_oid, video_media_src_oid, audio_media_src_oid).
        """
        cam_dur_ticks = self._cam_duration_ticks(cam)
        media_uid = new_uid()
        tpf_str = str(self._tpf())

        # VideoStream
        vstream_oid = self.next_oid()
        vs = _el("VideoStream", {"ObjectID": vstream_oid,
                                  "ClassID": _CLS["VideoStream"], "Version": "21"})
        _sub(vs, "FrameRate", text=tpf_str)
        _sub(vs, "Duration", text=str(cam_dur_ticks))
        _sub(vs, "CodecType", text=_CODEC_PRORES)
        _sub(vs, "FrameRect", text="0,0,1920,1080")
        _sub(vs, "OriginalColorSpace",
             text='{"baseColorProfile":{"colorProfileName":"BT.709,10-bit,Display-Referred"},"baseProfileType":1}')
        _sub(vs, "InputLUTSpecified", text="false")
        _sub(vs, "OriginalImageOrientationType", text="1")
        self.add(vs)

        # AudioStream
        astream_oid = self.next_oid()
        astr = _el("AudioStream", {"ObjectID": astream_oid,
                                    "ClassID": _CLS["AudioStream"], "Version": "7"})
        _sub(astr, "AudioChannelLayout", text=_LAYOUT_STEREO)
        _sub(astr, "FrameRate", text=_AFR)
        _sub(astr, "Duration", text=str(cam_dur_ticks))
        _sub(astr, "SampleType", text="4")
        self.add(astr)

        # Media
        media = _el("Media", {"ObjectUID": media_uid,
                               "ClassID": _CLS["Media"], "Version": "30"})
        _sub(media, "AudioStream", {"ObjectRef": astream_oid})
        _sub(media, "VideoStream", {"ObjectRef": vstream_oid})
        _sub(media, "RelativePath", text=self._relative_path(cam.path))
        _sub(media, "FilePath", text=str(cam.path))
        _sub(media, "ImplementationID", text="1fa18bfa-255c-44b1-ad73-56bcd99fceaf")
        _sub(media, "Title", text=cam.path.name)
        _sub(media, "FileKey", text=new_uid())
        if cam.alternate_start_ticks is not None:
            _sub(media, "AlternateStart", text=str(cam.alternate_start_ticks))
            _sub(media, "UseAlternateStart", text="true")
        _sub(media, "ConformedAudioRate", text=_AFR)
        _sub(media, "ContentAndMetadataState", text=new_uid())
        _sub(media, "ActualMediaFilePath", text=str(cam.path))
        self.add(media)

        # VideoMediaSource
        vms_oid = self.next_oid()
        vms = _el("VideoMediaSource", {"ObjectID": vms_oid,
                                        "ClassID": _CLS["VideoMediaSource"], "Version": "2"})
        ms = _sub(vms, "MediaSource", {"Version": "4"})
        _sub(ms, "Content", {"Version": "10"})
        _sub(ms, "Media", {"ObjectURef": media_uid})
        _sub(vms, "OriginalDuration", text=str(cam_dur_ticks))
        self.add(vms)

        # AudioMediaSource (cameras also have one, referencing same Media)
        ams_oid = self.next_oid()
        ams = _el("AudioMediaSource", {"ObjectID": ams_oid,
                                        "ClassID": _CLS["AudioMediaSource"], "Version": "2"})
        ms2 = _sub(ams, "MediaSource", {"Version": "4"})
        _sub(ms2, "Content", {"Version": "10"})
        _sub(ms2, "Media", {"ObjectURef": media_uid})
        _sub(ams, "OriginalDuration", text=str(cam_dur_ticks))
        self.add(ams)

        return media_uid, vstream_oid, vms_oid, ams_oid

    # ── ClipChannelGroup (shared by all MasterClips) ─────────────────────────

    def _make_clip_channel_group_per_source(self, n_channels: int) -> str:
        """
        Grupo de canais de um MasterClip de MÍDIA MULTICANAL: um vetor por CLIP.

        A diferença com `_make_clip_channel_group` é sutil e custou o bug do canal
        replicado. As duas escrevem N vetores de um canal; o que muda é QUAL índice
        varia (medido nos dois arquivos, lado a lado):

          MasterClip da SEQUÊNCIA  →  SourceClipIndex=0,   mSourceChannelIndex=0..N-1
              (um clip só — a sequência — com N canais DENTRO dele)

          MasterClip de MÍDIA      →  SourceClipIndex=0..N-1,  mSourceChannelIndex=0
              (N clips, um por canal, cada um MONO — ver `_make_wav_media`)

        Trocar um pelo outro faz todas as tracks lerem o canal 0.
        """
        grp_oid = self.next_oid()
        grp = _el("ClipChannelGroupVectorSerializer",
                  {"ObjectID": grp_oid, "ClassID": _CLS["ClipChannelGroupVec"],
                   "Version": "1"})
        vectors = _sub(grp, "ClipChannelVectors", {"Version": "1"})

        for i in range(n_channels):
            ccs_oid = self.next_oid()
            ccs = _el("ClipChannelSerializer",
                      {"ObjectID": ccs_oid, "ClassID": _CLS["ClipChannelSerializer"],
                       "Version": "1"})
            _sub(ccs, "SourceClipIndex", text=str(i))     # ← o clip (= o canal)
            _sub(ccs, "mSourceChannelIndex", text="0")    # ← e ele é mono
            self.add(ccs)

            vec_oid = self.next_oid()
            vec = _el("ClipChannelVectorSerializer",
                      {"ObjectID": vec_oid, "ClassID": _CLS["ClipChannelVec"],
                       "Version": "1"})
            ch = _sub(vec, "ClipChannels", {"Version": "1"})
            _sub(ch, "ClipChannelItem", {"Index": "0", "ObjectRef": ccs_oid})
            _sub(vec, "ChannelType", text="0")
            self.add(vec)

            _sub(vectors, "ClipChannelVectorItem", {"Index": str(i), "ObjectRef": vec_oid})

        self.add(grp)
        return grp_oid

    def _make_clip_channel_group(self, n_channels: int) -> str:
        """
        Grupo de canais de um MasterClip de SEQUÊNCIA: UM clip, N canais dentro dele.
        `SourceClipIndex=0`, `mSourceChannelIndex=0..N-1`.

        Para mídia MULTICANAL é o OUTRO — ver `_make_clip_channel_group_per_source`.
        """
        grp_oid = self.next_oid()
        grp = _el("ClipChannelGroupVectorSerializer",
                  {"ObjectID": grp_oid, "ClassID": _CLS["ClipChannelGroupVec"], "Version": "1"})
        vectors = _sub(grp, "ClipChannelVectors", {"Version": "1"})

        for i in range(n_channels):
            # ClipChannelSerializer
            ccs_oid = self.next_oid()
            ccs = _el("ClipChannelSerializer",
                      {"ObjectID": ccs_oid, "ClassID": _CLS["ClipChannelSerializer"], "Version": "1"})
            _sub(ccs, "SourceClipIndex", text="0")
            _sub(ccs, "mSourceChannelIndex", text=str(i))
            self.add(ccs)

            # ClipChannelVectorSerializer
            vec_oid = self.next_oid()
            vec = _el("ClipChannelVectorSerializer",
                      {"ObjectID": vec_oid, "ClassID": _CLS["ClipChannelVec"], "Version": "1"})
            ch = _sub(vec, "ClipChannels", {"Version": "1"})
            _sub(ch, "ClipChannelItem", {"Index": "0", "ObjectRef": ccs_oid})
            _sub(vec, "ChannelType", text="0")
            self.add(vec)

            _sub(vectors, "ClipChannelVectorItem", {"Index": str(i), "ObjectRef": vec_oid})

        self.add(grp)
        return grp_oid

    # NÃO recriar aqui uma variante "agrupada" (um único ClipChannelVectorItem com
    # todos os canais dentro). Ela existiu, era usada pelo MasterClip da sequência, e
    # era o que fazia a multicam entrar na timeline de edição como UM BLOCO de áudio
    # em vez de uma track por canal — o nest que não se desmancha na pós de som.
    # Um vetor por canal. Sempre.

    # ── AudioComponentChain (empty clip-level chain) ──────────────────────────

    def _make_clip_audio_chain(self) -> str:
        """Minimal AudioComponentChain for a clip (no components inside)."""
        oid = self.next_oid()
        acc = _el("AudioComponentChain",
                  {"ObjectID": oid, "ClassID": _CLS["AudioComponentChain"], "Version": "3"})
        _sub(acc, "DefaultVol", text="true")
        _sub(acc, "DefaultVolumeComponentID", text="1")
        chain = _sub(acc, "ComponentChain", {"Version": "3"})
        node = _sub(chain, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "MZ.ComponentChain.ActiveComponentID", text="1")
        _sub(props, "MZ.ComponentChain.ActiveComponentParamIndex", text="4294967295")
        _sub(acc, "AudioChannelLayout", text=_LAYOUT_MONO)
        _sub(acc, "ChannelType", text="0")
        _sub(acc, "FrameRate", text=_AFR)
        _sub(acc, "AutomationMode", text="1")
        self.add(acc)
        return oid

    def _make_empty_audio_chain(self) -> str:
        """AudioComponentChain de nível MasterClip. **Sempre MONO — uma por canal.**

        Medido no template: o MasterClip de uma sequência multicam tem uma cadeia por
        canal, todas com `ChannelType=0` e layout de um canal só. Uma cadeia
        multicanal aqui colapsa o áudio num bloco adaptativo ao inserir a multicam
        numa timeline (ver `_make_sequence_masterclip`)."""
        oid = self.next_oid()
        acc = _el("AudioComponentChain",
                  {"ObjectID": oid, "ClassID": _CLS["AudioComponentChain"], "Version": "3"})
        _sub(acc, "DefaultVol", text="true")
        _sub(acc, "DefaultVolumeComponentID", text="1")
        _sub(acc, "ComponentChain")
        _sub(acc, "AudioChannelLayout", text=_channel_layout(1))
        _sub(acc, "ChannelType", text="0")
        _sub(acc, "FrameRate", text=_AFR)
        _sub(acc, "AutomationMode", text="1")
        self.add(acc)
        return oid

    # ── MasterClip for a media file (camera or WAV) ───────────────────────────

    def _make_media_masterclip(
        self,
        name: str,
        markers_oid: str,
        primary_clip_oid: str,       # VideoClip or AudioClip
        audio_clip_oid: str | None,  # AudioClip (for cameras); None for WAV MasterClip secondary
        ams_oid: str,                # AudioMediaSource OID
        cam: CameraAngle | None,
        wav_dur_ticks: int | None,
        n_channels: int = 2,
        extra_audio_clip_oids: list[str] | None = None,
    ) -> str:
        """
        Create a MasterClip for a physical media file. Returns its ObjectUID.
        For cameras: primary_clip_oid = VideoClip, audio_clip_oid = AudioClip.
        For WAV: primary_clip_oid = AudioClip do canal 0, e `extra_audio_clip_oids`
        os canais 1..N-1 — UM CLIP POR CANAL, cada um lendo o seu `Media`
        (ver `_make_wav_media`). É o que faz o Premiere ler o canal certo.
        """
        mc_uid = new_uid()

        # Logging info
        cli_oid = self.next_oid()
        cli = _el("ClipLoggingInfo",
                  {"ObjectID": cli_oid, "ClassID": _CLS["ClipLoggingInfo"], "Version": "9"})
        _sub(cli, "ClipName", text=name)
        if cam is not None:
            _sub(cli, "TimecodeFormat", text="110")
            alt = cam.alternate_start_ticks or 0
            _sub(cli, "MediaInPoint", text=str(alt))
            _sub(cli, "MediaOutPoint", text=str(alt + self._cam_duration_ticks(cam)))
            _sub(cli, "MediaFrameRate", text=str(self._tpf()))
        else:
            _sub(cli, "MediaFrameRate", text="9223372036854775807")
        self.add(cli)

        chain_oids = [self._make_empty_audio_chain() for _ in range(n_channels)]

        # MasterClip
        mc = _el("MasterClip", {"ObjectUID": mc_uid,
                                  "ClassID": _CLS["MasterClip"], "Version": "12"})
        # Node properties (monitor settings)
        props_dict: dict[str, str] = {
            "AMM.CurrentSolo": "[]",
            "monitor.edit.time": "0",
            "monitor.zoom.in.time": "0",
            "monitor.take.video": "false" if cam is None else "true",
            "monitor.take.audio": "true",
            "monitor.show.audio.waveform": "false",
        }
        if cam is None:
            props_dict["monitor.show.audio.waveform"] = "true"
            props_dict["monitor.zoom.out.time"] = str(wav_dur_ticks or 0)
        else:
            props_dict["monitor.zoom.out.time"] = str(self._cam_duration_ticks(cam))

        self._node_props(mc, props_dict)
        _sub(mc, "LoggingInfo", {"ObjectRef": cli_oid})

        chains_el = _sub(mc, "AudioComponentChains", {"Version": "1"})
        for i, chain_oid in enumerate(chain_oids):
            _sub(chains_el, "AudioComponentChain", {"Index": str(i), "ObjectRef": chain_oid})

        clips_el = _sub(mc, "Clips", {"Version": "1"})
        idx = 0
        _sub(clips_el, "Clip", {"Index": str(idx), "ObjectRef": primary_clip_oid})
        idx += 1
        if audio_clip_oid is not None:
            _sub(clips_el, "Clip", {"Index": str(idx), "ObjectRef": audio_clip_oid})
            idx += 1
        for extra in (extra_audio_clip_oids or []):
            _sub(clips_el, "Clip", {"Index": str(idx), "ObjectRef": extra})
            idx += 1

        # Mídia multicanal (o WAV): N clips, um por canal → o vetor aponta para o
        # CLIP (`SourceClipIndex`). Caso contrário (câmera, WAV mono): um clip só.
        # Ver `_make_clip_channel_group_per_source` — trocar os dois faz todas as
        # tracks lerem o canal 0.
        if extra_audio_clip_oids:
            grp_oid = self._make_clip_channel_group_per_source(n_channels)
        else:
            grp_oid = self._make_clip_channel_group(n_channels)
        _sub(mc, "AudioClipChannelGroups", {"ObjectRef": grp_oid})
        _sub(mc, "DefMappingID", text=_DEF_MAPPING_ID)
        _sub(mc, "Name", text=name)
        _sub(mc, "MasterClipChangeVersion", text="2")

        self.add(mc)
        return mc_uid

    # ── VideoClip for a camera ────────────────────────────────────────────────

    def _make_video_clip(self, vms_oid: str, markers_oid: str,
                         duration_ticks: int) -> str:
        oid = self.next_oid()
        vc = _el("VideoClip", {"ObjectID": oid,
                                "ClassID": _CLS["VideoClip"], "Version": "11"})
        clip = _sub(vc, "Clip", {"Version": "18"})
        node = _sub(clip, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "asl.clip.label.color", text="13408882")
        _sub(props, "asl.clip.label.name", text="BE.Prefs.LabelColors.1")
        self._marker_owner(clip, markers_oid)
        _sub(clip, "Source", {"ObjectRef": vms_oid})
        _sub(clip, "ClipID", text=new_uid())
        _sub(clip, "InPoint", text="0")
        _sub(clip, "OutPoint", text=str(duration_ticks))
        _sub(clip, "InUse", text="false")
        self.add(vc)
        return oid

    # ── AudioClip for a media file ────────────────────────────────────────────

    def _make_audio_clip_for_media(
        self,
        ams_oid: str,
        markers_oid: str,
        duration_ticks: int,
        n_channels: int = 2,
        in_point: int = 0,
    ) -> str:
        """
        Create AudioClip for a MasterClip (not the sequence track clip).
        n_channels SecondaryContents covering all channels of the source.
        in_point: start trim offset (0 for normal, sync_offset for merged clips).
        Returns audio_clip_oid.
        """
        sc_oids = []
        for ch_idx in range(n_channels):
            sc_oid = self.next_oid()
            sc = _el("SecondaryContent",
                     {"ObjectID": sc_oid, "ClassID": _CLS["SecondaryContent"], "Version": "1"})
            _sub(sc, "Content", {"ObjectRef": ams_oid})
            _sub(sc, "ChannelIndex", text=str(ch_idx))
            self.add(sc)
            sc_oids.append(sc_oid)

        oid = self.next_oid()
        ac = _el("AudioClip", {"ObjectID": oid,
                                "ClassID": _CLS["AudioClip"], "Version": "8"})
        clip = _sub(ac, "Clip", {"Version": "18"})
        node = _sub(clip, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "asl.clip.label.color", text="10016297")
        _sub(props, "asl.clip.label.name", text="BE.Prefs.LabelColors.2")
        self._marker_owner(clip, markers_oid)
        _sub(clip, "Source", {"ObjectRef": ams_oid})
        _sub(clip, "ClipID", text=new_uid())
        _sub(clip, "InPoint", text=str(in_point))
        _sub(clip, "OutPoint", text=str(in_point + duration_ticks))
        _sub(clip, "InUse", text="false")

        sc_container = _sub(ac, "SecondaryContents", {"Version": "1"})
        for i, sc_oid in enumerate(sc_oids):
            _sub(sc_container, "SecondaryContentItem", {"Index": str(i), "ObjectRef": sc_oid})

        _sub(ac, "AudioChannelLayout", text=_channel_layout(n_channels))
        self.add(ac)
        return oid

    # ── AudioClip for sequence track (one channel) ────────────────────────────

    def _make_audio_clip_for_track(
        self,
        ams_oid: str,
        markers_oid: str,
        duration_ticks: int,
        channel_index: int,          # o número da TRACK: A1=0, A2=1 …
    ) -> str:
        """
        AudioClip de um `AudioClipTrackItem`.

        `ams_oid` é o `AudioMediaSource` DO CANAL, e por isso
        `SecondaryContent.ChannelIndex` é **sempre 0** — ver a explicação longa em
        `_make_audio_clip_for_track_segment`.
        """
        sc_oid = self.next_oid()
        sc = _el("SecondaryContent",
                 {"ObjectID": sc_oid, "ClassID": _CLS["SecondaryContent"], "Version": "1"})
        _sub(sc, "Content", {"ObjectRef": ams_oid})
        _sub(sc, "ChannelIndex", text="0")
        self.add(sc)

        oid = self.next_oid()
        ac = _el("AudioClip", {"ObjectID": oid,
                                "ClassID": _CLS["AudioClip"], "Version": "8"})
        clip = _sub(ac, "Clip", {"Version": "18"})
        node = _sub(clip, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "asl.clip.label.color", text="10016297")
        _sub(props, "asl.clip.label.name", text="BE.Prefs.LabelColors.2")
        self._marker_owner(clip, markers_oid)
        _sub(clip, "Source", {"ObjectRef": ams_oid})
        _sub(clip, "ClipID", text=new_uid())
        _sub(clip, "InPoint", text="0")
        _sub(clip, "OutPoint", text=str(duration_ticks))

        sc_container = _sub(ac, "SecondaryContents", {"Version": "1"})
        _sub(sc_container, "SecondaryContentItem", {"Index": "0", "ObjectRef": sc_oid})

        if channel_index > 0:
            _sub(ac, "SecondaryIndex", text=str(channel_index))
        _sub(ac, "AudioChannelLayout", text=_LAYOUT_MONO)
        self.add(ac)
        return oid

    # ── VideoClip for a sequence track ────────────────────────────────────────

    def _make_video_clip_for_track(self, vms_oid: str, markers_oid: str,
                                   duration_ticks: int) -> str:
        """
        VideoClip used in a sequence VideoClipTrackItem (referenced via SubClip).
        Unlike the media-level VideoClip, this must NOT have <InUse> — clips
        referenced by SubClip never carry it (Regra 1, confirmed on 71 VideoClips
        in the working template). Reusing _make_video_clip here was the bug.
        """
        oid = self.next_oid()
        vc = _el("VideoClip", {"ObjectID": oid,
                                "ClassID": _CLS["VideoClip"], "Version": "11"})
        clip = _sub(vc, "Clip", {"Version": "18"})
        node = _sub(clip, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "asl.clip.label.color", text="13408882")
        _sub(props, "asl.clip.label.name", text="BE.Prefs.LabelColors.1")
        self._marker_owner(clip, markers_oid)
        _sub(clip, "Source", {"ObjectRef": vms_oid})
        _sub(clip, "ClipID", text=new_uid())
        _sub(clip, "InPoint", text="0")
        _sub(clip, "OutPoint", text=str(duration_ticks))
        self.add(vc)
        return oid

    # ── SubClip ───────────────────────────────────────────────────────────────

    def _make_subclip(self, clip_oid: str, mc_uid: str,
                      orig_ch_grp: int, name: str) -> str:
        oid = self.next_oid()
        sc = _el("SubClip", {"ObjectID": oid,
                              "ClassID": _CLS["SubClip"], "Version": "6"})
        _sub(sc, "Clip", {"ObjectRef": clip_oid})
        _sub(sc, "MasterClip", {"ObjectURef": mc_uid})
        _sub(sc, "OrigChGrp", text=str(orig_ch_grp))
        _sub(sc, "Name", text=name)
        self.add(sc)
        return oid

    # ── VideoComponentChain (empty, for VideoClipTrackItem) ───────────────────

    def _make_video_component_chain(self) -> str:
        oid = self.next_oid()
        vcc = _el("VideoComponentChain",
                  {"ObjectID": oid, "ClassID": _CLS["VideoComponentChain"], "Version": "3"})
        _sub(vcc, "DefaultMotion", text="true")
        _sub(vcc, "DefaultOpacity", text="true")
        _sub(vcc, "DefaultMotionComponentID", text="1")
        _sub(vcc, "DefaultOpacityComponentID", text="2")
        chain = _sub(vcc, "ComponentChain", {"Version": "3"})
        node = _sub(chain, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "MZ.ComponentChain.ActiveComponentID", text="2")
        _sub(props, "MZ.ComponentChain.ActiveComponentParamIndex", text="4294967295")
        self.add(vcc)
        return oid

    # ── Track-level AudioComponentChain with Fader+Meter ─────────────────────

    def _make_track_audio_chain(self, mono: bool = False) -> str:
        """
        AudioComponentChain at track level: contains AudioFader + AudioMeter.
        mono=True → mono layout (ChannelType=0, used in merged clip sequences).
        Returns the chain OID.
        """
        layout = _LAYOUT_MONO if mono else _LAYOUT_STEREO
        ct = "0" if mono else "1"

        # AudioComponentParam: Volume
        vol_oid = self.next_oid()
        vol = _el("AudioComponentParam",
                  {"ObjectID": vol_oid, "ClassID": _CLS["AudioParamVolume"], "Version": "9"})
        _sub(vol, "ParameterControlType", text="2")
        _sub(vol, "UpperBound", text="5.6234130859375")
        _sub(vol, "UnitsString", text="dB")
        _sub(vol, "Name", text="Volume")
        self.add(vol)

        # AudioComponentParam: Mute
        mute_oid = self.next_oid()
        mute = _el("AudioComponentParam",
                   {"ObjectID": mute_oid, "ClassID": _CLS["AudioParamMute"], "Version": "9"})
        _sub(mute, "ParameterControlType", text="4")
        _sub(mute, "Name", text="Mute")
        self.add(mute)

        # AudioFader
        fader_oid = self.next_oid()
        fader = _el("AudioFader", {"ObjectID": fader_oid,
                                    "ClassID": _CLS["AudioFader"], "Version": "3"})
        ac_el = _sub(fader, "AudioComponent", {"Version": "3"})
        comp = _sub(ac_el, "Component", {"Version": "6"})
        params = _sub(comp, "Params", {"Version": "1"})
        _sub(params, "Param", {"Index": "0", "ObjectRef": vol_oid})
        _sub(params, "Param", {"Index": "1", "ObjectRef": mute_oid})
        _sub(comp, "ID", text="1")
        _sub(comp, "Bypass", text="false")
        _sub(comp, "Intrinsic", text="false")
        _sub(comp, "ArchivedType", text="0")
        _sub(ac_el, "AudioChannelLayout", text=layout)
        _sub(ac_el, "ChannelType", text=ct)
        _sub(ac_el, "FrameRate", text=_AFR)
        _sub(ac_el, "AudioComponentType", text="1")
        self.add(fader)

        # AudioMeter
        meter_oid = self.next_oid()
        meter = _el("AudioMeter", {"ObjectID": meter_oid,
                                    "ClassID": _CLS["AudioMeter"], "Version": "2"})
        ac_m = _sub(meter, "AudioComponent", {"Version": "3"})
        comp_m = _sub(ac_m, "Component", {"Version": "6"})
        _sub(comp_m, "ID", text="2")
        _sub(comp_m, "Bypass", text="false")
        _sub(comp_m, "Intrinsic", text="false")
        _sub(comp_m, "ArchivedType", text="0")
        _sub(ac_m, "AudioChannelLayout", text=layout)
        _sub(ac_m, "ChannelType", text=ct)
        _sub(ac_m, "FrameRate", text=_AFR)
        _sub(ac_m, "AudioComponentType", text="2")
        self.add(meter)

        # AudioComponentChain (track level)
        chain_oid = self.next_oid()
        chain = _el("AudioComponentChain",
                    {"ObjectID": chain_oid, "ClassID": _CLS["AudioComponentChain"], "Version": "3"})
        comp_chain = _sub(chain, "ComponentChain", {"Version": "3"})
        comps = _sub(comp_chain, "Components", {"Version": "1"})
        _sub(comps, "Component", {"Index": "0", "ObjectRef": fader_oid})
        _sub(comps, "Component", {"Index": "1", "ObjectRef": meter_oid})
        _sub(chain, "AudioChannelLayout", text=layout)
        _sub(chain, "ChannelType", text=ct)
        _sub(chain, "FrameRate", text=_AFR)
        _sub(chain, "AutomationMode", text="1")
        self.add(chain)
        return chain_oid

    def _make_default_pan_mono(self) -> str:
        """DefaultPanProcessor for a mono audio track (used in merged clip sequences)."""
        oid = self.next_oid()
        pan = _el("DefaultPanProcessor",
                  {"ObjectID": oid, "ClassID": _CLS["DefaultPanProcessor"], "Version": "2"})
        pp = _sub(pan, "PanProcessor", {"Version": "3"})
        ac = _sub(pp, "AudioComponent", {"Version": "3"})
        comp = _sub(ac, "Component", {"Version": "6"})
        _sub(comp, "ID", text="4294967280")
        _sub(comp, "Bypass", text="false")
        _sub(comp, "Intrinsic", text="false")
        _sub(comp, "ArchivedType", text="0")
        _sub(ac, "AudioChannelLayout", text=_LAYOUT_MONO)
        _sub(ac, "ChannelType", text="0")
        _sub(ac, "FrameRate", text=_AFR)
        _sub(ac, "AudioComponentType", text="0")
        _sub(pan, "DefaultPannerInputChannelType", text="0")
        _sub(pan, "DefaultPannerOutputChannelType", text="0")
        self.add(pan)
        return oid

    # ── StereoToStereoPanProcessor (panner for adaptive audio clip track) ────

    def _make_stereo_to_stereo_pan(self) -> str:
        # Balance AudioComponentParam (ClassID same as Volume, but Balance semantics)
        bal_oid = self.next_oid()
        bal = _el("AudioComponentParam",
                  {"ObjectID": bal_oid, "ClassID": _CLS["AudioParamVolume"], "Version": "9"})
        _sub(bal, "StartKeyframe", text="-91445760000000000,0.5,0,0,0,0,0,0")
        _sub(bal, "CurrentValue", text="0.5")
        _sub(bal, "ParameterControlType", text="2")
        _sub(bal, "RangeLocked", text="true")
        _sub(bal, "IsInverted", text="true")
        _sub(bal, "Name", text="Balance")
        self.add(bal)

        oid = self.next_oid()
        pan = _el("StereoToStereoPanProcessor",
                  {"ObjectID": oid, "ClassID": _CLS["StereoToStereoPan"], "Version": "1"})
        pp = _sub(pan, "PanProcessor", {"Version": "3"})
        ac = _sub(pp, "AudioComponent", {"Version": "3"})
        comp = _sub(ac, "Component", {"Version": "6"})
        params = _sub(comp, "Params", {"Version": "1"})
        _sub(params, "Param", {"Index": "0", "ObjectRef": bal_oid})
        _sub(comp, "ID", text="4294967280")
        _sub(comp, "Bypass", text="false")
        _sub(comp, "Intrinsic", text="false")
        _sub(comp, "ArchivedType", text="0")
        _sub(ac, "AudioChannelLayout", text=_LAYOUT_STEREO)
        _sub(ac, "ChannelType", text="1")
        _sub(ac, "FrameRate", text=_AFR)
        _sub(ac, "AudioComponentType", text="0")
        self.add(pan)
        return oid

    # ── StereoTo16ChannelPanProcessor (panner de track numa sequência adaptativa) ──

    def _make_stereo_to_16_channel_pan(self, out_channel: int) -> str:
        """Panner que roteia o áudio da track para o CANAL `out_channel` do barramento
        adaptativo (saída de 32 canais discretos), em vez de dobrar tudo em L/R.

        É a diferença entre o multicam sair com 5 canais ao dar flatten (1 2 3 4 5) e
        colapsar (1 2 1 1 1).

        ROTEAMENTO POR PAR (decodificado da multicam canônica do Premiere): o canal `c`
        entra pela entrada `c%2` do bus adaptativo (o `SecondaryIndex=c` do clipe põe
        par na esquerda, ímpar na direita) e a matriz roteia o PAR inteiro para as
        saídas do par — `[[0,[2·⌊c/2⌋]],[1,[2·⌊c/2⌋+1]]]`. Assim o canal cai na saída
        `c`, e a matriz continua VÁLIDA (cada entrada para uma saída distinta) — o que
        faz a multicam ter som como FONTE/nest, não só ao abrir como timeline. Uma
        matriz de saída única (`[[0,[c]]]`) deixava o ímpar (que está na entrada 1)
        mudo; mandar as duas entradas para a MESMA saída também não rendia como fonte."""
        pair_lo = 2 * (out_channel // 2)
        pair_hi = pair_lo + 1
        bal_oid = self.next_oid()
        bal = _el("AudioComponentParam",
                  {"ObjectID": bal_oid, "ClassID": _CLS["AudioParamVolume"], "Version": "9"})
        _sub(bal, "StartKeyframe", text="-91445760000000000,0.5,0,0,0,0,0,0")
        _sub(bal, "CurrentValue", text="0.5")
        _sub(bal, "ParameterControlType", text="2")
        _sub(bal, "RangeLocked", text="true")
        _sub(bal, "IsInverted", text="true")
        _sub(bal, "Name", text="Balance")
        self.add(bal)

        oid = self.next_oid()
        pan = _el("StereoTo16ChannelPanProcessor",
                  {"ObjectID": oid, "ClassID": _CLS["StereoTo16ChannelPan"], "Version": "2"})
        dpp = _sub(pan, "DirectPanProcessor", {"Version": "2"})
        pp = _sub(dpp, "PanProcessor", {"Version": "3"})
        ac = _sub(pp, "AudioComponent", {"Version": "3"})
        comp = _sub(ac, "Component", {"Version": "6"})
        params = _sub(comp, "Params", {"Version": "1"})
        _sub(params, "Param", {"Index": "0", "ObjectRef": bal_oid})
        _sub(comp, "ID", text="4294967280")
        _sub(comp, "Bypass", text="false")
        _sub(comp, "Intrinsic", text="false")
        _sub(comp, "ArchivedType", text="0")
        _sub(ac, "AudioChannelLayout", text=_LAYOUT_STEREO)
        _sub(ac, "ChannelType", text="1")
        _sub(ac, "FrameRate", text=_AFR)
        _sub(ac, "AudioComponentType", text="0")
        _sub(pp, "OutputAudioChannelLayout", text=_LAYOUT_ADAPTIVE)
        _sub(dpp, "Matrix", text=f"[[0,[{pair_lo}]],[1,[{pair_hi}]]]")
        self.add(pan)
        return oid

    # ── MasterTrack (AudioMixTrack) ───────────────────────────────────────────

    def _make_master_track(self, audio_track_uids: list[str], mono: bool = False,
                           adaptive: bool = False) -> str:
        """Build AudioMixTrack (master track).
        mono=True → used in merged clip sequences (ChannelType=0, no Node in Track).
        adaptive=True → saída ADAPTATIVA de N canais (>2): ChannelType=3 e barramento
        de 32 canais discretos. Sem isso a master é estéreo e o flatten dobra os
        canais 3..N no canal 1. Medido contra a multicam de 5 canais do usuário."""
        layout = _LAYOUT_ADAPTIVE if adaptive else (_LAYOUT_MONO if mono else _LAYOUT_STEREO)
        ct = "3" if adaptive else ("0" if mono else "1")

        # Master AudioFader params
        vol_oid = self.next_oid()
        vol = _el("AudioComponentParam",
                  {"ObjectID": vol_oid, "ClassID": _CLS["AudioParamVolume"], "Version": "9"})
        _sub(vol, "ParameterControlType", text="2")
        _sub(vol, "UpperBound", text="5.6234130859375")
        _sub(vol, "UnitsString", text="dB")
        _sub(vol, "Name", text="Volume")
        self.add(vol)

        mute_oid = self.next_oid()
        mute = _el("AudioComponentParam",
                   {"ObjectID": mute_oid, "ClassID": _CLS["AudioParamMute"], "Version": "9"})
        _sub(mute, "ParameterControlType", text="4")
        _sub(mute, "Name", text="Mute")
        self.add(mute)

        fader_oid = self.next_oid()
        fader = _el("AudioFader", {"ObjectID": fader_oid,
                                    "ClassID": _CLS["AudioFader"], "Version": "3"})
        ac_f = _sub(fader, "AudioComponent", {"Version": "3"})
        comp_f = _sub(ac_f, "Component", {"Version": "6"})
        params = _sub(comp_f, "Params", {"Version": "1"})
        _sub(params, "Param", {"Index": "0", "ObjectRef": vol_oid})
        _sub(params, "Param", {"Index": "1", "ObjectRef": mute_oid})
        _sub(comp_f, "ID", text="1")
        _sub(comp_f, "Bypass", text="false")
        _sub(comp_f, "Intrinsic", text="false")
        _sub(comp_f, "ArchivedType", text="0")
        _sub(ac_f, "AudioChannelLayout", text=layout)
        _sub(ac_f, "ChannelType", text=ct)
        _sub(ac_f, "FrameRate", text=_AFR)
        _sub(ac_f, "AudioComponentType", text="1")
        self.add(fader)

        # Master AudioMeter
        meter_oid = self.next_oid()
        meter = _el("AudioMeter", {"ObjectID": meter_oid,
                                    "ClassID": _CLS["AudioMeter"], "Version": "2"})
        ac_m = _sub(meter, "AudioComponent", {"Version": "3"})
        comp_m = _sub(ac_m, "Component", {"Version": "6"})
        _sub(comp_m, "ID", text="2")
        _sub(comp_m, "Bypass", text="false")
        _sub(comp_m, "Intrinsic", text="false")
        _sub(comp_m, "ArchivedType", text="0")
        _sub(ac_m, "AudioChannelLayout", text=layout)
        _sub(ac_m, "ChannelType", text=ct)
        _sub(ac_m, "FrameRate", text=_AFR)
        _sub(ac_m, "AudioComponentType", text="2")
        self.add(meter)

        master_chain_oid = self.next_oid()
        mchain = _el("AudioComponentChain",
                     {"ObjectID": master_chain_oid,
                      "ClassID": _CLS["AudioComponentChain"], "Version": "3"})
        cchain = _sub(mchain, "ComponentChain", {"Version": "3"})
        comps = _sub(cchain, "Components", {"Version": "1"})
        _sub(comps, "Component", {"Index": "0", "ObjectRef": fader_oid})
        _sub(comps, "Component", {"Index": "1", "ObjectRef": meter_oid})
        _sub(mchain, "AudioChannelLayout", text=layout)
        _sub(mchain, "ChannelType", text=ct)
        _sub(mchain, "FrameRate", text=_AFR)
        _sub(mchain, "AutomationMode", text="1")
        self.add(mchain)

        # DefaultPanProcessor — mono uses ID=4294967280, stereo uses ID=4294967279
        pan_comp_id = "4294967280" if (mono or adaptive) else "4294967279"
        dpan_oid = self.next_oid()
        dpan = _el("DefaultPanProcessor",
                   {"ObjectID": dpan_oid, "ClassID": _CLS["DefaultPanProcessor"], "Version": "2"})
        pp = _sub(dpan, "PanProcessor", {"Version": "3"})
        ac_p = _sub(pp, "AudioComponent", {"Version": "3"})
        comp_p = _sub(ac_p, "Component", {"Version": "6"})
        _sub(comp_p, "ID", text=pan_comp_id)
        _sub(comp_p, "Bypass", text="false")
        _sub(comp_p, "Intrinsic", text="false")
        _sub(comp_p, "ArchivedType", text="0")
        _sub(ac_p, "AudioChannelLayout", text=layout)
        _sub(ac_p, "ChannelType", text=ct)
        _sub(ac_p, "FrameRate", text=_AFR)
        _sub(ac_p, "AudioComponentType", text="0")
        _sub(dpan, "DefaultPannerInputChannelType", text=ct)
        _sub(dpan, "DefaultPannerOutputChannelType", text=ct)
        self.add(dpan)

        # AudioTrackInlet
        inlet_oid = self.next_oid()
        inlet = _el("AudioTrackInlet",
                    {"ObjectID": inlet_oid, "ClassID": _CLS["AudioTrackInlet"], "Version": "3"})
        sources = _sub(inlet, "Sources", {"Version": "1"})
        for i, uid in enumerate(audio_track_uids):
            _sub(sources, "Source", {"Index": str(i), "ObjectURef": uid})
        _sub(inlet, "AudioChannelLayout", text=layout)
        _sub(inlet, "ChannelType", text=ct)
        _sub(inlet, "FrameRate", text=_AFR)
        self.add(inlet)

        # AudioMixTrack (SubType=3 = master)
        mt_oid = self.next_oid()
        mt = _el("AudioMixTrack", {"ObjectID": mt_oid,
                                    "ClassID": _CLS["AudioMixTrack"], "Version": "4"})
        at = _sub(mt, "AudioTrack", {"Version": "11"})
        co = _sub(at, "ComponentOwner", {"Version": "1"})
        _sub(co, "Components", {"ObjectRef": master_chain_oid})
        _sub(at, "Panner", {"ObjectRef": dpan_oid})
        _sub(at, "ID", text=new_uid())
        _sub(at, "ChannelType", text=ct)
        _sub(at, "FrameRate", text=_AFR)
        _sub(at, "AutomationMode", text="1")
        _sub(at, "SubType", text="3")
        _sub(at, "Assign", text="0")
        # Stereo master panner id=4294967279, mono master panner id=4294967280; next = id - 1
        _sub(at, "NextPannerID", text="4294967279" if (mono or adaptive) else "4294967278")
        _sub(at, "Solo", text="0")
        _sub(at, "MutedBySolo", text="0")

        track = _sub(mt, "Track", {"Version": "3"})
        if not mono:
            node = _sub(track, "Node", {"Version": "1"})
            props = _sub(node, "Properties", {"Version": "1"})
            _sub(props, "TL.SQTrackShy", text="0")
            _sub(props, "TL.SQTrackAudioKeyframeStyle", text="2")
            _sub(props, "TL.SQTrackExpanded", text="0")
            _sub(props, "TL.SQTrackExpandedHeight", text="41")
        _sub(track, "ID", text="1")
        _sub(track, "IsLocked", text="false")
        _sub(track, "MediaType", text=_TG_AUDIO)
        _sub(track, "Index", text="0")
        _sub(track, "IsMuted", text="false")
        _sub(track, "IsSyncLocked", text="true")

        _sub(mt, "Inlet", {"ObjectRef": inlet_oid})
        self.add(mt)
        return mt_oid

    # ── AudioClipTrack (A1 or A2) ─────────────────────────────────────────────

    def _make_audio_clip_track(
        self,
        track_index: int,          # 0=A1, 1=A2
        track_id: int,             # internal track ID (2 for A1, 3 for A2)
        track_item_oids: list[str],
        mono: bool = False,
        adaptive_out_channel: int | None = None,
        targeted: bool = True,
    ) -> str:
        """Creates AudioClipTrack, returns its ObjectUID.
        mono=True → mono channel (ChannelType=0, DefaultPanProcessor), used in merged clip sequences.
        mono=False → stereo (ChannelType=1, StereoToStereoPanProcessor), used in main multicam sequences.
        adaptive_out_channel set → sequência ADAPTATIVA (>2 canais): a track roteia
        para ESSE canal da saída (StereoTo16ChannelPanProcessor), em vez de dobrar em
        L/R. É o que faz o flatten preservar os N canais (ver o panner)."""
        track_uid = new_uid()

        # Track-level AudioComponentChain and Panner
        chain_oid = self._make_track_audio_chain(mono=mono)
        if adaptive_out_channel is not None:
            pan_oid = self._make_stereo_to_16_channel_pan(adaptive_out_channel)
        elif mono:
            pan_oid = self._make_default_pan_mono()
        else:
            pan_oid = self._make_stereo_to_stereo_pan()

        track = _el("AudioClipTrack",
                    {"ObjectUID": track_uid,
                     "ClassID": _CLS["AudioClipTrack"], "Version": "6"})

        ct = _sub(track, "ClipTrack", {"Version": "2"})
        t = _sub(ct, "Track", {"Version": "3"})
        if not mono:
            # Main multicam sequences have Node/Properties; merged clip sequences do not
            node = _sub(t, "Node", {"Version": "1"})
            props = _sub(node, "Properties", {"Version": "1"})
            if adaptive_out_channel is not None and not targeted:
                # Track de ÂNGULO DE CÂMERA: áudio da câmera dentro da multicam, NÃO
                # targeted (fora da saída, fora da contagem adaptativa). O Premiere a
                # escreve com o bloco Properties VAZIO. A presença dessas tracks é o que
                # dá à sequência uma base multicanal real ("Multichannel", não
                # "0 Channel") e faz a multicam ter som como FONTE.
                pass
            elif adaptive_out_channel is not None:
                # Track ADAPTATIVA de multicam, TARGETED (canal do som que entra na
                # saída). O conjunto EXATO de 4 props que a multicam NATIVA do Premiere
                # escreve — NADA de MZ.SourceTrackState/SourceTrackNumber (isso é de
                # track de source-monitor, não de multicam; escrevê-las fazia a
                # sequência ser lida como "0 Channel" e ficar muda como fonte).
                _sub(props, "MZ.TrackTargeted", text="1")
                _sub(props, "CM.KeyframeMode", text="true")
                _sub(props, "TL.SQTrackExpanded", text="0")
                _sub(props, "TL.SQTrackExpandedHeight", text="41")
            else:
                _sub(props, "TL.SQTrackShy", text="0")
                _sub(props, "TL.SQTrackAudioKeyframeStyle", text="0")
                _sub(props, "MZ.SourceTrackState", text="0")
                _sub(props, "MZ.SourceTrackNumber", text="0" if track_index == 0 else "-1")
                _sub(props, "TL.SQTrackExpanded", text="0")
                _sub(props, "TL.SQTrackExpandedHeight", text="41")
        _sub(t, "ID", text=str(track_id))
        _sub(t, "IsLocked", text="false")
        _sub(t, "MediaType", text=_TG_AUDIO)
        _sub(t, "Index", text=str(track_index))
        _sub(t, "IsMuted", text="false")
        _sub(t, "IsSyncLocked", text="true")

        ci = _sub(ct, "ClipItems", {"Version": "3"})
        ti_container = _sub(ci, "TrackItems", {"Version": "1"})
        for idx, ti_oid in enumerate(track_item_oids):
            _sub(ti_container, "TrackItem", {"Index": str(idx), "ObjectRef": ti_oid})
        _sub(ci, "MediaType", text=_TG_AUDIO)
        _sub(ci, "Index", text=str(track_index))
        ti_el = _sub(ct, "TransitionItems", {"Version": "3"})
        _sub(ti_el, "MediaType", text=_TG_AUDIO)
        _sub(ti_el, "Index", text=str(track_index))

        at = _sub(track, "AudioTrack", {"Version": "11"})
        co = _sub(at, "ComponentOwner", {"Version": "1"})
        _sub(co, "Components", {"ObjectRef": chain_oid})
        _sub(at, "Panner", {"ObjectRef": pan_oid})
        _sub(at, "ID", text=new_uid())
        _sub(at, "ChannelType", text="0" if mono else "1")
        _sub(at, "FrameRate", text=_AFR)
        _sub(at, "AutomationMode", text="1")
        _sub(at, "SubType", text="1")
        _sub(at, "Assign", text="1")
        _sub(at, "NextPannerID", text="4294967279")
        _sub(at, "Solo", text="0")
        _sub(at, "MutedBySolo", text="0")
        _sub(track, "RecordChannel", text="0")

        self.add(track)
        return track_uid

    # ── AudioClipTrackItem (for WAV channel) ──────────────────────────────────

    def _make_audio_clip_track_item(
        self,
        audio_clip_oid: str,
        subclip_oid: str,
        start_ticks: int,
        end_ticks: int,
    ) -> str:
        chain_oid = self._make_clip_audio_chain()
        oid = self.next_oid()
        item = _el("AudioClipTrackItem",
                   {"ObjectID": oid, "ClassID": _CLS["AudioClipTrackItem"], "Version": "11"})
        cti = _sub(item, "ClipTrackItem", {"Version": "8"})
        co = _sub(cti, "ComponentOwner", {"Version": "1"})
        _sub(co, "Components", {"ObjectRef": chain_oid})
        ti = _sub(cti, "TrackItem", {"Version": "3"})
        _sub(ti, "Start", text=str(start_ticks))
        _sub(ti, "End", text=str(end_ticks))
        _sub(cti, "SubClip", {"ObjectRef": subclip_oid})
        _sub(item, "ID", text=new_uid())
        _sub(item, "PreRenderComponentChainHashVersion", text="1")
        self.add(item)
        return oid

    # ── VideoClipTrack ────────────────────────────────────────────────────────

    def _make_video_clip_track(
        self,
        track_index: int,
        track_id: int,
        track_item_oids: list[str],
        tpf: str,
    ) -> str:
        track_uid = new_uid()
        track = _el("VideoClipTrack",
                    {"ObjectUID": track_uid,
                     "ClassID": _CLS["VideoClipTrack"], "Version": "1"})
        ct = _sub(track, "ClipTrack", {"Version": "2"})
        t = _sub(ct, "Track", {"Version": "3"})
        node = _sub(t, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "TL.SQTrackShy", text="0")
        if track_index == 0:
            # Only the first video track is "targeted"; the template never sets
            # this on V2+ (confirmed: absent on every Index>0 VideoClipTrack).
            _sub(props, "MZ.TrackTargeted", text="1")
        _sub(props, "MZ.SourceTrackState", text="0")
        _sub(props, "MZ.SourceTrackNumber", text="0" if track_index == 0 else "-1")
        _sub(props, "TL.SQTrackExpanded", text="0")
        _sub(props, "TL.SQTrackExpandedHeight", text="41")
        _sub(t, "ID", text=str(track_id))
        _sub(t, "IsLocked", text="false")
        _sub(t, "MediaType", text=_TG_VIDEO)
        _sub(t, "Index", text=str(track_index))
        _sub(t, "IsMuted", text="false")
        _sub(t, "IsSyncLocked", text="true")

        ci = _sub(ct, "ClipItems", {"Version": "3"})
        ti_container = _sub(ci, "TrackItems", {"Version": "1"})
        for idx, ti_oid in enumerate(track_item_oids):
            _sub(ti_container, "TrackItem", {"Index": str(idx), "ObjectRef": ti_oid})
        _sub(ci, "MediaType", text=_TG_VIDEO)
        _sub(ci, "Index", text=str(track_index))
        ti_el = _sub(ct, "TransitionItems", {"Version": "3"})
        _sub(ti_el, "MediaType", text=_TG_VIDEO)
        _sub(ti_el, "Index", text=str(track_index))
        self.add(track)
        return track_uid

    # ── VideoClipTrackItem ────────────────────────────────────────────────────

    def _make_video_clip_track_item(
        self,
        subclip_oid: str,
        start_ticks: int,
        end_ticks: int,
    ) -> str:
        chain_oid = self._make_video_component_chain()
        oid = self.next_oid()
        item = _el("VideoClipTrackItem",
                   {"ObjectID": oid, "ClassID": _CLS["VideoClipTrackItem"], "Version": "8"})
        cti = _sub(item, "ClipTrackItem", {"Version": "8"})
        co = _sub(cti, "ComponentOwner", {"Version": "1"})
        _sub(co, "Components", {"ObjectRef": chain_oid})
        ti = _sub(cti, "TrackItem", {"Version": "3"})
        _sub(ti, "Start", text=str(start_ticks))
        _sub(ti, "End", text=str(end_ticks))
        _sub(cti, "SubClip", {"ObjectRef": subclip_oid})
        _sub(item, "FrameRect", text="0,0,1920,1080")
        _sub(item, "PixelAspectRatio", text="1,1")
        _sub(item, "ToneMapSettings", text='{"peak":-1,"version":3}')
        self.add(item)
        return oid

    # ── Link ─────────────────────────────────────────────────────────────────

    def _make_link(self, track_item_oids: list[str]) -> str:
        oid = self.next_oid()
        link = _el("Link", {"ObjectID": oid, "ClassID": _CLS["Link"], "Version": "1"})
        tig = _sub(link, "TrackItemGroup", {"Version": "1"})
        tis = _sub(tig, "TrackItems", {"Version": "1"})
        for i, ti_oid in enumerate(track_item_oids):
            _sub(tis, "TrackItem", {"Index": str(i), "ObjectRef": ti_oid})
        self.add(link)
        return oid

    # ── Sequence MasterClip objects ───────────────────────────────────────────

    def _make_sequence_masterclip(
        self,
        seq_uid: str,
        seq_name: str,
        seq_duration_ticks: int,
        n_audio_channels: int = 2,
        multicam: bool = True,
        adaptive: bool = False,
    ) -> str:
        """
        Creates all objects for the sequence's MasterClip entry.
        n_audio_channels controls how many audio tracks appear when this
        multicam is inserted into a new timeline.
        Returns MasterClip ObjectUID.

        `multicam` é o que separa uma **Multi-Camera Source Sequence** de uma
        sequência comum — e a diferença mora AQUI, no MasterClip, não na Sequence.
        Sem isso o Premiere abre a sequência normalmente, com as câmeras em V1/V2…,
        mas ela NÃO entra no monitor multicam: não há como cortar entre ângulos, que
        é a razão de o app existir.

        São dois campos, não um (medido no PROJETO_MULTICAM_TEMPLATE: as 4 sequências
        `MULTICAM …` têm ambos; as 4 `SEQ NORMAL …` não têm nenhum):
          - `Source.Monitor.Multicam.Enabled`    = true
          - `Source.Monitor.Multicam.TrackIndex` = 0   (só existe quando habilitado)
        """
        # AudioSequenceSource
        ass_oid = self.next_oid()
        ass = _el("AudioSequenceSource",
                  {"ObjectID": ass_oid, "ClassID": _CLS["AudioSequenceSource"], "Version": "7"})
        ss = _sub(ass, "SequenceSource", {"Version": "4"})
        _sub(ss, "Content", {"Version": "10"})
        _sub(ss, "Sequence", {"ObjectURef": seq_uid})
        _sub(ass, "OriginalDuration", text=str(seq_duration_ticks))
        self.add(ass)

        # VideoSequenceSource
        vss_oid = self.next_oid()
        vss = _el("VideoSequenceSource",
                  {"ObjectID": vss_oid, "ClassID": _CLS["VideoSequenceSource"], "Version": "3"})
        ss2 = _sub(vss, "SequenceSource", {"Version": "4"})
        _sub(ss2, "Content", {"Version": "10"})
        _sub(ss2, "Sequence", {"ObjectURef": seq_uid})
        _sub(vss, "OriginalDuration", text=str(seq_duration_ticks))
        self.add(vss)

        # n_audio_channels SecondaryContents for the sequence AudioClip
        sc_n_oids = []
        for ch in range(n_audio_channels):
            sc_oid = self.next_oid()
            sc = _el("SecondaryContent",
                     {"ObjectID": sc_oid, "ClassID": _CLS["SecondaryContent"], "Version": "1"})
            _sub(sc, "Content", {"ObjectRef": ass_oid})
            _sub(sc, "ChannelIndex", text=str(ch))
            self.add(sc)
            sc_n_oids.append(sc_oid)

        # AudioClip (n_audio_channels ch, for sequence MasterClip)
        mc_ac_oid = self.next_oid()
        mc_ac = _el("AudioClip", {"ObjectID": mc_ac_oid,
                                   "ClassID": _CLS["AudioClip"], "Version": "8"})
        mc_ac_clip = _sub(mc_ac, "Clip", {"Version": "18"})
        mc_ac_node = _sub(mc_ac_clip, "Node", {"Version": "1"})
        _sub(mc_ac_node, "Properties", {"Version": "1"})
        _sub(mc_ac_clip, "Source", {"ObjectRef": ass_oid})
        _sub(mc_ac_clip, "ClipID", text=new_uid())
        _sub(mc_ac_clip, "OutPoint", text=str(seq_duration_ticks))
        _sub(mc_ac_clip, "InUse", text="false")
        sc_container = _sub(mc_ac, "SecondaryContents", {"Version": "1"})
        for i, sc_oid in enumerate(sc_n_oids):
            _sub(sc_container, "SecondaryContentItem", {"Index": str(i), "ObjectRef": sc_oid})
        # Numa sequência ADAPTATIVA (>2 canais) o AudioClip do MasterClip declara o
        # barramento de 32 canais discretos — a MESMA saída da master track. Sem isso
        # a multicam usada como FONTE/nest fica MUDA (o número de canais aqui não bate
        # com a saída adaptativa da master), mesmo que abrir a sequência como timeline
        # toque normal. Medido contra a multicam de referência do usuário.
        _sub(mc_ac, "AudioChannelLayout",
             text=_LAYOUT_ADAPTIVE if adaptive else _channel_layout(n_audio_channels))
        self.add(mc_ac)

        # VideoClip (seq)
        mc_vc_oid = self.next_oid()
        mc_vc = _el("VideoClip", {"ObjectID": mc_vc_oid,
                                   "ClassID": _CLS["VideoClip"], "Version": "11"})
        mc_vc_clip = _sub(mc_vc, "Clip", {"Version": "18"})
        mc_vc_node = _sub(mc_vc_clip, "Node", {"Version": "1"})
        _sub(mc_vc_node, "Properties", {"Version": "1"})
        _sub(mc_vc_clip, "Source", {"ObjectRef": vss_oid})
        _sub(mc_vc_clip, "ClipID", text=new_uid())
        _sub(mc_vc_clip, "OutPoint", text=str(seq_duration_ticks))
        _sub(mc_vc_clip, "InUse", text="false")
        self.add(mc_vc)

        # ── O MAPEAMENTO DE CANAIS: é ISTO que decide quantas tracks de áudio
        #    aparecem quando a multicam é inserida numa timeline de edição.
        #
        # UMA cadeia com N canais dentro (e um único ClipChannelVectorItem agrupando
        # todos) faz o áudio entrar como UM BLOCO adaptativo. Esse bloco não se
        # desmancha ao mandar para a pós de som — é retrabalho no departamento de
        # sonorização, e é o problema que este app existe para não criar (ver o
        # requisito crítico de áudio em VALIDATION.md).
        #
        # O certo é UMA CADEIA MONO POR CANAL e UM VETOR POR CANAL. Medido no
        # PROJETO_MULTICAM_TEMPLATE: as 4 sequências `MULTICAM …` têm, no MasterClip,
        # 4 AudioComponentChain (ChannelType=0, layout de um canal) e 4
        # ClipChannelVectorItem com mSourceChannelIndex 0,1,2,3 — um por canal.
        #
        # É a MESMA forma que os MasterClips de mídia já usam (`_make_media_masterclip`).
        chain_oids = [self._make_empty_audio_chain() for _ in range(n_audio_channels)]
        grp_oid = self._make_clip_channel_group(n_audio_channels)

        # ClipLoggingInfo
        cli_oid = self.next_oid()
        cli = _el("ClipLoggingInfo",
                  {"ObjectID": cli_oid, "ClassID": _CLS["ClipLoggingInfo"], "Version": "9"})
        _sub(cli, "ClipName", text=seq_name)
        _sub(cli, "MediaFrameRate", text="9223372036854775807")
        self.add(cli)

        # MasterClip for sequence
        mc_uid = new_uid()
        mc = _el("MasterClip", {"ObjectUID": mc_uid,
                                  "ClassID": _CLS["MasterClip"], "Version": "12"})
        mc_props: dict[str, str] = {
            "Source.Monitor.Multicam.Enabled": "true" if multicam else "false",
        }
        if multicam:
            mc_props["Source.Monitor.Multicam.TrackIndex"] = "0"
        mc_props.update({
            "AMM.CurrentSolo": "[]",
            "monitor.edit.time": "0",
            "monitor.zoom.in.time": "0",
            "monitor.zoom.out.time": str(seq_duration_ticks),
            "monitor.take.video": "true",
            "monitor.take.audio": "true",
            "monitor.show.audio.waveform": "false",
        })
        self._node_props(mc, mc_props)
        _sub(mc, "LoggingInfo", {"ObjectRef": cli_oid})
        chains_el = _sub(mc, "AudioComponentChains", {"Version": "1"})
        for i, chain_oid in enumerate(chain_oids):
            _sub(chains_el, "AudioComponentChain", {"Index": str(i), "ObjectRef": chain_oid})
        clips_el = _sub(mc, "Clips", {"Version": "1"})
        _sub(clips_el, "Clip", {"Index": "0", "ObjectRef": mc_ac_oid})
        _sub(clips_el, "Clip", {"Index": "1", "ObjectRef": mc_vc_oid})
        _sub(mc, "AudioClipChannelGroups", {"ObjectRef": grp_oid})
        _sub(mc, "Name", text=seq_name)
        _sub(mc, "MasterClipChangeVersion", text="1")
        self.add(mc)
        return mc_uid

    # ── Sequence ──────────────────────────────────────────────────────────────

    def _make_sequence(
        self,
        seq_name: str,
        video_track_uids: list[str],
        audio_track_uids: list[str],
        mt_oid: str,
        link_oids: list[str],
        work_out: int,
        zero_point: int,
        tpf: str,
        num_adaptive_channels: int | None = None,
    ) -> str:
        """Create Sequence element, return its ObjectUID.

        `num_adaptive_channels` — canais adaptativos da SAÍDA. Default = nº de tracks
        (o caso comum). Quando há tracks de ÂNGULO DE CÂMERA (não-targeted) além das do
        som, elas NÃO contam: passa-se só o nº de canais do som direto."""
        seq_uid = new_uid()

        # VideoTrackGroup
        vtg_oid = self.next_oid()
        vtg = _el("VideoTrackGroup",
                  {"ObjectID": vtg_oid, "ClassID": _CLS["VideoTrackGroup"], "Version": "13"})
        tg = _sub(vtg, "TrackGroup", {"Version": "1"})
        tracks = _sub(tg, "Tracks", {"Version": "1"})
        for i, uid in enumerate(video_track_uids):
            _sub(tracks, "Track", {"Index": str(i), "ObjectURef": uid})
        _sub(tg, "FrameRate", text=tpf)
        _sub(tg, "NextTrackID", text=str(len(video_track_uids) + 2))
        _sub(vtg, "FrameRect", text="0,0,1920,1080")
        _sub(vtg, "ColorManagementSettings",
             text='{"autoToneMapEnabled":true,"enableLogColorManagement":2,"graphicsWhiteLuminance":203,"lutInterpolationMethod":1}')
        _sub(vtg, "OutputColorSpace",
             text='{"baseColorProfile":{"colorProfileData":"AQAAAGQAAAA=","colorProfileName":"BT.709,8-bit,Display-Referred"},"baseProfileType":1,"colorSpaceMetadata":{"peakLuminance":100}}')
        _sub(vtg, "AutoInputGamutCompressionEnabled", text="true")
        _sub(vtg, "ImmersiveVideoVRConfiguration",
             text='{"ambisonicsHRIR":"","ambisonicsMonitoringType":0,"capturedHorizontalView":360,'
                  '"capturedVerticalView":180,"fieldOfHorizontalView":108,"fieldOfVerticalView":108,'
                  '"projectionType":0,"stereoscopicEye":0,"stereoscopicType":0,"version":3}')
        _sub(vtg, "ToneMappingDesaturation", text="0.5")
        _sub(vtg, "IsGraphicsWhiteSameAsProject", text="false")
        _sub(vtg, "IsColorAwareEffectsEnabledSameAsProject", text="false")
        self.add(vtg)

        # AudioTrackGroup
        atg_oid = self.next_oid()
        atg = _el("AudioTrackGroup",
                  {"ObjectID": atg_oid, "ClassID": _CLS["AudioTrackGroup"], "Version": "6"})
        tg2 = _sub(atg, "TrackGroup", {"Version": "1"})
        tracks2 = _sub(tg2, "Tracks", {"Version": "1"})
        for i, uid in enumerate(audio_track_uids):
            _sub(tracks2, "Track", {"Index": str(i), "ObjectURef": uid})
        _sub(tg2, "FrameRate", text=_AFR)
        _sub(tg2, "NextTrackID", text=str(len(audio_track_uids) + 2))
        _sub(atg, "MasterTrack", {"ObjectRef": mt_oid})
        _sub(atg, "ID", text=new_uid())
        _sub(atg, "AutomationSafeFlags", text="0")
        _sub(atg, "NumAdaptiveChannels",
             text=str(num_adaptive_channels if num_adaptive_channels is not None
                      else len(audio_track_uids)))
        self.add(atg)

        # DataTrackGroup
        dtg_oid = self.next_oid()
        dtg = _el("DataTrackGroup",
                  {"ObjectID": dtg_oid, "ClassID": _CLS["DataTrackGroup"], "Version": "1"})
        tg3 = _sub(dtg, "TrackGroup", {"Version": "1"})
        _sub(tg3, "FrameRate", text=tpf)
        _sub(tg3, "NextTrackID", text="1")
        self.add(dtg)

        # Sequence
        seq = _el("Sequence",
                  {"ObjectUID": seq_uid,
                   "ClassID": _CLS["Sequence"], "Version": "11"})
        self._node_props(seq, {
            "AM.TrackScrollPosition": "0",
            "AM.TrackVScrollPosition": "0",
            "TL.SQTimePerPixel": "10.0",
            "Monitor.ProgramZoomIn": "0",
            "Monitor.ProgramZoomOut": str(work_out),
            "TL.SQHeaderWidth": "204",
            "TL.SQHideShyTracks": "0",
            "TL.SQAVDividerPosition": "0.5",
            "TL.SQVisibleBaseTime": "0",
            "TL.SQVideoVisibleBase": "0",
            "TL.SQAudioVisibleBase": "0",
            "TL.SQDataVisibleBase": "0",
            "TL.SQDataTrackViewControlState": "0",
            "MZ.WorkInPoint": "0",
            "MZ.WorkOutPoint": str(work_out),
            "MZ.ZeroPoint": str(zero_point),
            "MZ.Sequence.VideoTimeDisplayFormat": "110",
            "Source.Monitor.Multicam.SwitchOnMulticamName": "0",
            "MZ.Sequence.EditingModeGUID": "795454d9-d3c2-429d-9474-923ab13b7018",
            "MZ.Sequence.PreviewUseMaxBitDepth": "false",
            "MZ.Sequence.PreviewUseMaxRenderQuality": "false",
            "MZ.Sequence.PreviewRenderingPresetPath":
                "EncoderPresets/SequencePreview/795454d9-d3c2-429d-9474-923ab13b7018/QuickTime.epr",
            "MZ.Sequence.PreviewRenderingPresetCodec": "1634755443",
            "MZ.Sequence.PreviewRenderingClassID": "1061109567",
            "MZ.Sequence.AudioTimeDisplayFormat": "200",
            "MZ.Sequence.PreviewFrameSizeWidth": "1920",
            "MZ.Sequence.PreviewFrameSizeHeight": "1080",
            "MZ.EditLine": "0",
            "AMM.CurrentSolo": "[]",
        })

        # PersistentGroupContainer.LinkContainer.Links
        pgc = _sub(seq, "PersistentGroupContainer", {"Version": "1"})
        lc = _sub(pgc, "LinkContainer", {"Version": "1"})
        links_el = _sub(lc, "Links", {"Version": "1"})
        for i, link_oid in enumerate(link_oids):
            _sub(links_el, "Link", {"Index": str(i), "ObjectRef": link_oid})

        # TrackGroups
        tgs = _sub(seq, "TrackGroups", {"Version": "1"})
        tg_v = _sub(tgs, "TrackGroup", {"Version": "1", "Index": "0"})
        _sub(tg_v, "First", text=_TG_VIDEO)
        _sub(tg_v, "Second", {"ObjectRef": vtg_oid})
        tg_a = _sub(tgs, "TrackGroup", {"Version": "1", "Index": "1"})
        _sub(tg_a, "First", text=_TG_AUDIO)
        _sub(tg_a, "Second", {"ObjectRef": atg_oid})
        tg_d = _sub(tgs, "TrackGroup", {"Version": "1", "Index": "2"})
        _sub(tg_d, "First", text=_TG_DATA)
        _sub(tg_d, "Second", {"ObjectRef": dtg_oid})

        _sub(seq, "Name", text=seq_name)
        _sub(seq, "PreviewFormatIdentifier", text=_PREVIEW_FORMAT)
        self.add(seq)
        return seq_uid

    # ── AudioClip for sequence track with custom InPt/OutPt ───────────────────

    def _make_audio_clip_for_track_segment(
        self,
        ams_oid: str,
        markers_oid: str,
        in_point: int,
        out_point: int,
        channel_index: int,
        content_channel_index: int = 0,
    ) -> str:
        """
        AudioClip de um `AudioClipTrackItem`, com InPt/OutPt próprios.

        `ams_oid` DEVE ser o `AudioMediaSource` DO CANAL (ver `_make_wav_media`), e
        `channel_index` é o número da track (A1=0, A2=1, …) — usado só no
        `SecondaryIndex`.

        ── `SecondaryContent.ChannelIndex` É SEMPRE 0. Custou o bug. ──

        `ChannelIndex` é "qual canal DENTRO da fonte". Como a fonte já É o canal (o
        `Media` dela tem `StreamNumber=N` e é MONO), o canal dentro dela é o 0 — e só
        existe o 0. Escrever `ChannelIndex=N` pede um canal que a fonte não tem: o
        Premiere não resolve, a track fica MUDA e SEM WAVEFORM, e o áudio pisca ao
        passar o mouse. Era exatamente o sintoma: A1 tocava (canal 0 não usa
        `SecondaryContent`) e A2–A5 não.

        Confirmado no XML que o Premiere escreve: `ChannelIndex=0` em TODAS as tracks.
        É o mesmo engano do `mSourceChannelIndex` — quando a fonte vira o canal, todo
        índice dentro dela zera. (Exceção: a CÂMERA usa UMA fonte multicanal, então aí
        `content_channel_index` = o número do canal.)
        """
        sc_oid = self.next_oid()
        sc = _el("SecondaryContent",
                 {"ObjectID": sc_oid, "ClassID": _CLS["SecondaryContent"], "Version": "1"})
        _sub(sc, "Content", {"ObjectRef": ams_oid})
        _sub(sc, "ChannelIndex", text=str(content_channel_index))
        self.add(sc)

        oid = self.next_oid()
        ac = _el("AudioClip", {"ObjectID": oid,
                                "ClassID": _CLS["AudioClip"], "Version": "8"})
        clip = _sub(ac, "Clip", {"Version": "18"})
        node = _sub(clip, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        _sub(props, "asl.clip.label.color", text="10016297")
        _sub(props, "asl.clip.label.name", text="BE.Prefs.LabelColors.2")
        self._marker_owner(clip, markers_oid)
        _sub(clip, "Source", {"ObjectRef": ams_oid})
        _sub(clip, "ClipID", text=new_uid())
        _sub(clip, "InPoint", text=str(in_point))
        _sub(clip, "OutPoint", text=str(out_point))
        sc_container = _sub(ac, "SecondaryContents", {"Version": "1"})
        _sub(sc_container, "SecondaryContentItem", {"Index": "0", "ObjectRef": sc_oid})
        if channel_index > 0:
            _sub(ac, "SecondaryIndex", text=str(channel_index))
        _sub(ac, "AudioChannelLayout", text=_LAYOUT_MONO)
        self.add(ac)
        return oid

    # ── Extra WAV AudioMediaSource for merged clips ───────────────────────────

    def _make_extra_wav_ams(self, ds: SoundClip) -> str:
        """Cópia da Media/AudioStream/AudioMediaSource de um som direto (o merged
        clip precisa de um AMS próprio por canal). Recebe o som por parâmetro:
        numa diária há um por tomada."""
        wav_dur_ticks = self._sound_duration_ticks(ds)
        media_uid = new_uid()

        astream_oid = self.next_oid()
        astream = _el("AudioStream", {"ObjectID": astream_oid,
                                       "ClassID": _CLS["AudioStream"], "Version": "7"})
        _sub(astream, "AudioChannelLayout", text=_channel_layout(ds.channels))
        _sub(astream, "FrameRate", text=_AFR)
        _sub(astream, "Duration", text=str(wav_dur_ticks))
        _sub(astream, "SampleType", text="4")
        self.add(astream)

        media = _el("Media", {"ObjectUID": media_uid,
                               "ClassID": _CLS["Media"], "Version": "30"})
        _sub(media, "AudioStream", {"ObjectRef": astream_oid})
        _sub(media, "RelativePath", text=self._relative_path(ds.path))
        _sub(media, "FilePath", text=str(ds.path))
        _sub(media, "ImplementationID", text="1fa18bfa-255c-44b1-ad73-56bcd99fceaf")
        _sub(media, "Title", text=ds.path.name)
        _sub(media, "FileKey", text=new_uid())
        _sub(media, "ConformedAudioRate", text=_AFR)
        _sub(media, "ContentAndMetadataState", text=new_uid())
        _sub(media, "ActualMediaFilePath", text=str(ds.path))
        self.add(media)

        ams_oid = self.next_oid()
        ams = _el("AudioMediaSource", {"ObjectID": ams_oid,
                                        "ClassID": _CLS["AudioMediaSource"], "Version": "2"})
        ms = _sub(ams, "MediaSource", {"Version": "4"})
        _sub(ms, "Content", {"Version": "10"})
        _sub(ms, "Media", {"ObjectURef": media_uid})
        _sub(ams, "OriginalDuration", text=str(wav_dur_ticks))
        self.add(ams)
        return ams_oid

    # ── Per-channel merged MasterClip ─────────────────────────────────────────

    def _make_merged_per_channel_masterclip(
        self,
        cam_name: str,
        snd: SoundClip,
        wav_ams_oid: str,
        sync_offset: int,
        cam_dur: int,
        wav_markers_oid: str,
        n_ch: int,
        channel_index: int,
    ) -> str:
        """
        Create a per-channel merged MasterClip (referenced by merged-clip-sequence
        SubClips and by COM MERGED multicam audio track SubClips).
        Returns mc_uid.
        """
        mc_uid = new_uid()

        cli_oid = self.next_oid()
        cli = _el("ClipLoggingInfo",
                  {"ObjectID": cli_oid, "ClassID": _CLS["ClipLoggingInfo"], "Version": "9"})
        _sub(cli, "ClipName", text=cam_name + " - Merged")
        _sub(cli, "TimecodeFormat", text="200")
        _sub(cli, "MediaFrameRate", text="9223372036854775807")
        self.add(cli)

        chain_oids = [self._make_empty_audio_chain() for _ in range(n_ch)]
        # Trim do WAV que acompanha esta câmera. Normalmente é exatamente
        # [sync_offset, sync_offset + cam_dur]; ver _wav_window para as bordas.
        wav_in, wav_out, _, _ = self._wav_window(snd, sync_offset, cam_dur)
        ac_oid = self._make_audio_clip_for_media(
            wav_ams_oid, wav_markers_oid, wav_out - wav_in,
            n_channels=n_ch, in_point=wav_in)
        grp_oid = self._make_clip_channel_group(n_ch)

        mc = _el("MasterClip", {"ObjectUID": mc_uid,
                                  "ClassID": _CLS["MasterClip"], "Version": "12"})
        node = _sub(mc, "Node", {"Version": "1"})
        p = _sub(node, "Properties", {"Version": "1"})
        _sub(p, "MZ.MergeClipUtils.AudioTrackNumberFromOriginalMergedClip",
             text=str(channel_index))
        _sub(p, "MZ.MergeClipUtils.ComponentMasterClipOriginalName",
             text=snd.path.name)
        _sub(mc, "LoggingInfo", {"ObjectRef": cli_oid})
        chains_el = _sub(mc, "AudioComponentChains", {"Version": "1"})
        for i, co in enumerate(chain_oids):
            _sub(chains_el, "AudioComponentChain", {"Index": str(i), "ObjectRef": co})
        clips_el = _sub(mc, "Clips", {"Version": "1"})
        _sub(clips_el, "Clip", {"Index": "0", "ObjectRef": ac_oid})
        _sub(mc, "AudioClipChannelGroups", {"ObjectRef": grp_oid})
        _sub(mc, "Name", text=cam_name + " - Merged")
        _sub(mc, "MasterClipChangeVersion", text="2")
        self.add(mc)
        return mc_uid

    # ── Merged-clip sequence (IsMergedClip=true) ──────────────────────────────

    def _make_merged_clip_sequence(
        self,
        cam: CameraAngle,
        snd: SoundClip,
        cam_vms_oid: str,
        cam_markers_oid: str,
        cam_dur: int,
        merged_wav_ams_oids: list[str],
        per_channel_mc_uids: list[str],
        cam_mc_uid: str,
        n_ch: int,
        tpf_str: str,
    ) -> str:
        """
        Create IsMergedClip=true sequence for one camera. Returns seq_uid.

        cam_vms_oid/cam_markers_oid/cam_mc_uid MUST be the dedicated merged-clip
        camera MasterClip built by _make_merged_camera_masterclip (never the bin
        "- Merged" MasterClip, whose source is this very sequence — using it here
        would make the sequence's own V1 SubClip point back at itself).
        """
        sync_offset = self._sync_offset_ticks(cam)
        cam_name = cam.path.name
        zero_point = cam.alternate_start_ticks or 0
        wav_markers_oid = self._make_markers()

        # V1: camera video
        vc_oid = self._make_video_clip_for_track(cam_vms_oid, cam_markers_oid, cam_dur)
        sc_v_oid = self._make_subclip(vc_oid, cam_mc_uid, 0, cam_name + " - Merged")
        ti_v_oid = self._make_video_clip_track_item(sc_v_oid, 0, cam_dur)
        vt_uid = self._make_video_clip_track(0, 1, [ti_v_oid], tpf_str)

        # A1..An: o som direto que acompanha esta câmera. O eixo da sequência de
        # merged clip é o da CÂMERA (0 = primeiro frame dela), então o áudio entra
        # em seq_in — que é 0 sempre que há som direto desde o início da câmera.
        wav_in, wav_out, seq_in, seq_out = self._wav_window(snd, sync_offset, cam_dur)
        audio_track_uids: list[str] = []
        audio_ti_oids: list[str] = []
        for ch in range(n_ch):
            ac_oid = self._make_audio_clip_for_track_segment(
                merged_wav_ams_oids[ch], wav_markers_oid, wav_in, wav_out, ch)
            sc_a_oid = self._make_subclip(
                ac_oid, per_channel_mc_uids[ch], ch, cam_name + " - Merged")
            ti_a_oid = self._make_audio_clip_track_item(ac_oid, sc_a_oid, seq_in, seq_out)
            audio_ti_oids.append(ti_a_oid)
            at_uid = self._make_audio_clip_track(ch, ch + 2, [ti_a_oid], mono=True)
            audio_track_uids.append(at_uid)

        mt_oid = self._make_master_track(audio_track_uids, mono=True)
        link_oid = self._make_link([ti_v_oid] + audio_ti_oids)

        # VideoTrackGroup
        vtg_oid = self.next_oid()
        vtg = _el("VideoTrackGroup",
                  {"ObjectID": vtg_oid, "ClassID": _CLS["VideoTrackGroup"], "Version": "13"})
        tg = _sub(vtg, "TrackGroup", {"Version": "1"})
        tracks = _sub(tg, "Tracks", {"Version": "1"})
        _sub(tracks, "Track", {"Index": "0", "ObjectURef": vt_uid})
        _sub(tg, "FrameRate", text=tpf_str)
        _sub(tg, "NextTrackID", text="2")
        _sub(vtg, "FrameRect", text="0,0,1920,1080")
        _sub(vtg, "ColorManagementSettings",
             text='{"autoToneMapEnabled":true,"enableLogColorManagement":2,"graphicsWhiteLuminance":203,"lutInterpolationMethod":1}')
        _sub(vtg, "OutputColorSpace",
             text='{"baseColorProfile":{"colorProfileData":"AQAAAGQAAAA=","colorProfileName":"BT.709,8-bit,Display-Referred"},"baseProfileType":1,"colorSpaceMetadata":{"peakLuminance":100}}')
        _sub(vtg, "AutoInputGamutCompressionEnabled", text="true")
        _sub(vtg, "ImmersiveVideoVRConfiguration",
             text='{"ambisonicsHRIR":"","ambisonicsMonitoringType":0,"capturedHorizontalView":360,'
                  '"capturedVerticalView":180,"fieldOfHorizontalView":108,"fieldOfVerticalView":108,'
                  '"projectionType":0,"stereoscopicEye":0,"stereoscopicType":0,"version":3}')
        _sub(vtg, "IsGraphicsWhiteSameAsProject", text="false")
        _sub(vtg, "IsColorAwareEffectsEnabledSameAsProject", text="false")
        self.add(vtg)

        # AudioTrackGroup
        atg_oid = self.next_oid()
        atg = _el("AudioTrackGroup",
                  {"ObjectID": atg_oid, "ClassID": _CLS["AudioTrackGroup"], "Version": "6"})
        tg2 = _sub(atg, "TrackGroup", {"Version": "1"})
        tracks2 = _sub(tg2, "Tracks", {"Version": "1"})
        for i, uid in enumerate(audio_track_uids):
            _sub(tracks2, "Track", {"Index": str(i), "ObjectURef": uid})
        _sub(tg2, "FrameRate", text=_AFR)
        _sub(tg2, "NextTrackID", text=str(n_ch + 2))
        _sub(atg, "MasterTrack", {"ObjectRef": mt_oid})
        _sub(atg, "ID", text=new_uid())
        _sub(atg, "AutomationSafeFlags", text="0")
        _sub(atg, "NumAdaptiveChannels", text="1")
        self.add(atg)

        # DataTrackGroup
        dtg_oid = self.next_oid()
        dtg = _el("DataTrackGroup",
                  {"ObjectID": dtg_oid, "ClassID": _CLS["DataTrackGroup"], "Version": "1"})
        tg3 = _sub(dtg, "TrackGroup", {"Version": "1"})
        _sub(tg3, "FrameRate", text=tpf_str)
        _sub(tg3, "NextTrackID", text="1")
        self.add(dtg)

        seq_uid = new_uid()
        seq = _el("Sequence", {"ObjectUID": seq_uid,
                                "ClassID": _CLS["Sequence"], "Version": "11"})
        self._node_props(seq, {
            "MZ.WorkInPoint": "0",
            "MZ.WorkOutPoint": str(cam_dur),
            "MZ.ZeroPoint": str(zero_point),
            "BE.Sequence.IsMergedClip": "true",
            "MZ.Sequence.VideoTimeDisplayFormat": "110",
            "MZ.MergedClip.AudioTimecodeBaseTrackNumber": "-1",
            "MZ.Sequence.EditingModeGUID": "795454d9-d3c2-429d-9474-923ab13b7018",
            "MZ.Sequence.PreviewUseMaxBitDepth": "false",
            "MZ.Sequence.PreviewUseMaxRenderQuality": "false",
            "MZ.Sequence.PreviewRenderingPresetPath":
                "EncoderPresets/SequencePreview/795454d9-d3c2-429d-9474-923ab13b7018/I-Frame Only MPEG.epr",
            "MZ.Sequence.PreviewRenderingPresetCodec": "0",
            "MZ.Sequence.PreviewRenderingClassID": "1297106761",
            "MZ.Sequence.AudioTimeDisplayFormat": "200",
            "MZ.Sequence.PreviewFrameSizeWidth": "1920",
            "MZ.Sequence.PreviewFrameSizeHeight": "1080",
            "MZ.EditLine": "0",
        })
        pgc = _sub(seq, "PersistentGroupContainer", {"Version": "1"})
        lc = _sub(pgc, "LinkContainer", {"Version": "1"})
        links_el = _sub(lc, "Links", {"Version": "1"})
        _sub(links_el, "Link", {"Index": "0", "ObjectRef": link_oid})
        tgs = _sub(seq, "TrackGroups", {"Version": "1"})
        tg_v = _sub(tgs, "TrackGroup", {"Version": "1", "Index": "0"})
        _sub(tg_v, "First", text=_TG_VIDEO)
        _sub(tg_v, "Second", {"ObjectRef": vtg_oid})
        tg_a = _sub(tgs, "TrackGroup", {"Version": "1", "Index": "1"})
        _sub(tg_a, "First", text=_TG_AUDIO)
        _sub(tg_a, "Second", {"ObjectRef": atg_oid})
        tg_d = _sub(tgs, "TrackGroup", {"Version": "1", "Index": "2"})
        _sub(tg_d, "First", text=_TG_DATA)
        _sub(tg_d, "Second", {"ObjectRef": dtg_oid})
        _sub(seq, "Name", text=cam_name + " - Merged")
        _sub(seq, "PreviewFormatIdentifier", text=_PREVIEW_FORMAT)
        self.add(seq)
        return seq_uid

    # ── Main merged-clip MasterClip (bin entry, references merged sequence) ───

    def _create_main_merged_masterclip(
        self,
        mc_uid: str,
        cam: CameraAngle,
        merged_seq_uid: str,
        cam_dur: int,
        n_ch: int,
    ) -> None:
        """Create bin-entry MasterClip for a merged clip with pre-allocated mc_uid."""
        cam_name = cam.path.name

        ass_oid = self.next_oid()
        ass = _el("AudioSequenceSource",
                  {"ObjectID": ass_oid, "ClassID": _CLS["AudioSequenceSource"], "Version": "7"})
        ss = _sub(ass, "SequenceSource", {"Version": "4"})
        _sub(ss, "Content", {"Version": "10"})
        _sub(ss, "Sequence", {"ObjectURef": merged_seq_uid})
        _sub(ass, "OriginalDuration", text=str(cam_dur))
        self.add(ass)

        vss_oid = self.next_oid()
        vss = _el("VideoSequenceSource",
                  {"ObjectID": vss_oid, "ClassID": _CLS["VideoSequenceSource"], "Version": "3"})
        ss2 = _sub(vss, "SequenceSource", {"Version": "4"})
        _sub(ss2, "Content", {"Version": "10"})
        _sub(ss2, "Sequence", {"ObjectURef": merged_seq_uid})
        _sub(vss, "OriginalDuration", text=str(cam_dur))
        self.add(vss)

        sc_oid = self.next_oid()
        sc = _el("SecondaryContent",
                 {"ObjectID": sc_oid, "ClassID": _CLS["SecondaryContent"], "Version": "1"})
        _sub(sc, "Content", {"ObjectRef": ass_oid})
        _sub(sc, "ChannelIndex", text="0")
        self.add(sc)

        ac_oid = self.next_oid()
        ac = _el("AudioClip", {"ObjectID": ac_oid,
                                "ClassID": _CLS["AudioClip"], "Version": "8"})
        ac_clip = _sub(ac, "Clip", {"Version": "18"})
        ac_node = _sub(ac_clip, "Node", {"Version": "1"})
        ac_props = _sub(ac_node, "Properties", {"Version": "1"})
        _sub(ac_props, "asl.clip.label.color", text=_LABEL_MERGED_COLOR)
        _sub(ac_props, "asl.clip.label.name", text=_LABEL_MERGED_NAME)
        _sub(ac_clip, "Source", {"ObjectRef": ass_oid})
        _sub(ac_clip, "ClipID", text=new_uid())
        _sub(ac_clip, "InUse", text="false")
        sc_cont = _sub(ac, "SecondaryContents", {"Version": "1"})
        _sub(sc_cont, "SecondaryContentItem", {"Index": "0", "ObjectRef": sc_oid})
        _sub(ac, "AudioChannelLayout", text=_LAYOUT_MONO)
        self.add(ac)

        vc_oid = self.next_oid()
        vc = _el("VideoClip", {"ObjectID": vc_oid,
                                "ClassID": _CLS["VideoClip"], "Version": "11"})
        vc_clip = _sub(vc, "Clip", {"Version": "18"})
        vc_node = _sub(vc_clip, "Node", {"Version": "1"})
        vc_props = _sub(vc_node, "Properties", {"Version": "1"})
        _sub(vc_props, "asl.clip.label.color", text=_LABEL_MERGED_COLOR)
        _sub(vc_props, "asl.clip.label.name", text=_LABEL_MERGED_NAME)
        _sub(vc_clip, "Source", {"ObjectRef": vss_oid})
        _sub(vc_clip, "ClipID", text=new_uid())
        _sub(vc_clip, "InUse", text="false")
        self.add(vc)

        cli_oid = self.next_oid()
        cli = _el("ClipLoggingInfo",
                  {"ObjectID": cli_oid, "ClassID": _CLS["ClipLoggingInfo"], "Version": "9"})
        _sub(cli, "ClipName", text=cam_name)
        _sub(cli, "TimecodeFormat", text="110")
        alt = cam.alternate_start_ticks or 0
        _sub(cli, "MediaInPoint", text=str(alt))
        _sub(cli, "MediaOutPoint", text=str(alt + cam_dur))
        _sub(cli, "MediaFrameRate", text=str(self._tpf()))
        self.add(cli)

        chain_oids = [self._make_empty_audio_chain() for _ in range(n_ch)]
        grp_oid = self._make_clip_channel_group(n_ch)

        mc = _el("MasterClip", {"ObjectUID": mc_uid,
                                  "ClassID": _CLS["MasterClip"], "Version": "12"})
        self._node_props(mc, {
            "AMM.CurrentSolo": "[]",
            "monitor.edit.time": "0",
            "monitor.zoom.in.time": "0",
            "monitor.zoom.out.time": str(cam_dur),
            "monitor.take.video": "true",
            "monitor.take.audio": "true",
            "monitor.show.audio.waveform": "false",
        })
        _sub(mc, "LoggingInfo", {"ObjectRef": cli_oid})
        chains_el = _sub(mc, "AudioComponentChains", {"Version": "1"})
        for i, co in enumerate(chain_oids):
            _sub(chains_el, "AudioComponentChain", {"Index": str(i), "ObjectRef": co})
        clips_el = _sub(mc, "Clips", {"Version": "1"})
        _sub(clips_el, "Clip", {"Index": "0", "ObjectRef": ac_oid})
        _sub(clips_el, "Clip", {"Index": "1", "ObjectRef": vc_oid})
        _sub(mc, "AudioClipChannelGroups", {"ObjectRef": grp_oid})
        _sub(mc, "Name", text=cam_name + " - Merged")
        _sub(mc, "MasterClipChangeVersion", text="2")
        self.add(mc)

    # ── Merged-clip camera MasterClip (dedicated duplicate media, V1 source) ──

    def _make_merged_camera_masterclip(self, cam: CameraAngle, cam_dur: int) -> tuple[str, str, str]:
        """
        Create a dedicated duplicate MasterClip that wraps a FRESH copy of the
        camera's Media/VideoMediaSource/AudioMediaSource (not the one shared with
        the camera's own bin MasterClip). This is what the working template uses
        as the V1 SubClip target inside a merged-clip Sequence and inside every
        COM MERGED multicam sequence's video track — never the bin "- Merged"
        MasterClip itself (that one's Clips are AudioSequenceSource/
        VideoSequenceSource pointing AT the merged sequence, so reusing it as the
        sequence's own V1 SubClip target creates a self-referencing cycle, which
        is almost certainly what AR::AudioPrefetch chokes on).

        Returns (mc_uid, vms_oid, markers_oid) — vms_oid/markers_oid are reused
        by every V1 VideoClip built for this camera's merged context (sequence
        itself + each COM MERGED variant), exactly like the template does.
        """
        cam_name = cam.path.name
        n_ch = cam.audio_channels
        _, _, vms_oid, ams_oid = self._make_camera_media(cam)
        markers_oid = self._make_markers()

        vc_oid = self.next_oid()
        vc = _el("VideoClip", {"ObjectID": vc_oid,
                                "ClassID": _CLS["VideoClip"], "Version": "11"})
        vc_clip = _sub(vc, "Clip", {"Version": "18"})
        vc_node = _sub(vc_clip, "Node", {"Version": "1"})
        vc_props = _sub(vc_node, "Properties", {"Version": "1"})
        _sub(vc_props, "asl.clip.label.color", text="13408882")
        _sub(vc_props, "asl.clip.label.name", text="BE.Prefs.LabelColors.1")
        self._marker_owner(vc_clip, markers_oid)
        _sub(vc_clip, "Source", {"ObjectRef": vms_oid})
        _sub(vc_clip, "ClipID", text=new_uid())
        _sub(vc_clip, "InPoint", text="0")
        _sub(vc_clip, "OutPoint", text=str(cam_dur))
        _sub(vc_clip, "InUse", text="false")
        self.add(vc)

        sc_oids = []
        for ch_idx in range(n_ch):
            sc_oid = self.next_oid()
            sc = _el("SecondaryContent",
                     {"ObjectID": sc_oid, "ClassID": _CLS["SecondaryContent"], "Version": "1"})
            _sub(sc, "Content", {"ObjectRef": ams_oid})
            _sub(sc, "ChannelIndex", text=str(ch_idx))
            self.add(sc)
            sc_oids.append(sc_oid)

        ac_oid = self.next_oid()
        ac = _el("AudioClip", {"ObjectID": ac_oid,
                                "ClassID": _CLS["AudioClip"], "Version": "8"})
        ac_clip = _sub(ac, "Clip", {"Version": "18"})
        ac_node = _sub(ac_clip, "Node", {"Version": "1"})
        ac_props = _sub(ac_node, "Properties", {"Version": "1"})
        _sub(ac_props, "asl.clip.label.color", text="13408882")
        _sub(ac_props, "asl.clip.label.name", text="BE.Prefs.LabelColors.1")
        self._marker_owner(ac_clip, markers_oid)
        _sub(ac_clip, "Source", {"ObjectRef": ams_oid})
        _sub(ac_clip, "ClipID", text=new_uid())
        _sub(ac_clip, "InPoint", text="0")
        _sub(ac_clip, "OutPoint", text=str(cam_dur))
        _sub(ac_clip, "InUse", text="false")
        sc_container = _sub(ac, "SecondaryContents", {"Version": "1"})
        for i, sc_oid in enumerate(sc_oids):
            _sub(sc_container, "SecondaryContentItem", {"Index": str(i), "ObjectRef": sc_oid})
        _sub(ac, "AudioChannelLayout", text=_channel_layout(n_ch))
        self.add(ac)

        cli_oid = self.next_oid()
        cli = _el("ClipLoggingInfo",
                  {"ObjectID": cli_oid, "ClassID": _CLS["ClipLoggingInfo"], "Version": "9"})
        _sub(cli, "ClipName", text=cam_name + " - Merged")
        _sub(cli, "TimecodeFormat", text="110")
        alt = cam.alternate_start_ticks or 0
        _sub(cli, "MediaInPoint", text=str(alt))
        _sub(cli, "MediaOutPoint", text=str(alt + cam_dur))
        _sub(cli, "MediaFrameRate", text=str(self._tpf()))
        self.add(cli)

        chain_oids = [self._make_empty_audio_chain() for _ in range(n_ch)]
        grp_oid = self._make_clip_channel_group(n_ch)

        mc_uid = new_uid()
        mc = _el("MasterClip", {"ObjectUID": mc_uid,
                                  "ClassID": _CLS["MasterClip"], "Version": "12"})
        node = _sub(mc, "Node", {"Version": "1"})
        p = _sub(node, "Properties", {"Version": "1"})
        _sub(p, "MZ.MergeClipUtils.ComponentMasterClipOriginalName", text=cam_name)
        _sub(mc, "LoggingInfo", {"ObjectRef": cli_oid})
        chains_el = _sub(mc, "AudioComponentChains", {"Version": "1"})
        for i, co in enumerate(chain_oids):
            _sub(chains_el, "AudioComponentChain", {"Index": str(i), "ObjectRef": co})
        clips_el = _sub(mc, "Clips", {"Version": "1"})
        _sub(clips_el, "Clip", {"Index": "0", "ObjectRef": vc_oid})
        _sub(clips_el, "Clip", {"Index": "1", "ObjectRef": ac_oid})
        _sub(mc, "AudioClipChannelGroups", {"ObjectRef": grp_oid})
        _sub(mc, "DefMappingID", text=_DEF_MAPPING_ID)
        _sub(mc, "Name", text=cam_name + " - Merged")
        _sub(mc, "MasterClipChangeVersion", text="2")
        self.add(mc)

        return mc_uid, vms_oid, markers_oid

    # ── Build merged clip (all objects for one camera) ────────────────────────

    def _build_merged_clip(
        self,
        cam: CameraAngle,
        snd: SoundClip,
        cam_dur: int,
        n_ch: int,
        tpf_str: str,
    ) -> tuple[str, list[str], list[str], str, str, str]:
        """
        Build all merged-clip objects for one camera.
        Returns (main_mc_uid, per_channel_mc_uids, merged_wav_ams_oids,
                 cam_mc_uid, cam_vms_oid, cam_markers_oid).
        The last three are the dedicated merged-clip camera MasterClip (own
        duplicate media, not shared with the camera's plain bin MasterClip) —
        callers must reuse cam_vms_oid/cam_markers_oid for every V1 VideoClip
        built in this camera's merged context, and cam_mc_uid as the SubClip
        target (never main_mc_uid — see _make_merged_clip_sequence docstring).
        """
        sync_offset = self._sync_offset_ticks(cam)
        main_mc_uid = new_uid()
        wav_markers_oid = self._make_markers()

        cam_mc_uid, cam_vms_oid, cam_markers_oid = self._make_merged_camera_masterclip(cam, cam_dur)

        per_channel_mc_uids: list[str] = []
        merged_wav_ams_oids: list[str] = []
        for ch in range(n_ch):
            ams_oid = self._make_extra_wav_ams(snd)
            merged_wav_ams_oids.append(ams_oid)
            mc_uid = self._make_merged_per_channel_masterclip(
                cam.path.name, snd, ams_oid, sync_offset, cam_dur, wav_markers_oid, n_ch, ch)
            per_channel_mc_uids.append(mc_uid)

        merged_seq_uid = self._make_merged_clip_sequence(
            cam, snd, cam_vms_oid, cam_markers_oid, cam_dur,
            merged_wav_ams_oids, per_channel_mc_uids, cam_mc_uid, n_ch, tpf_str)
        self._create_main_merged_masterclip(main_mc_uid, cam, merged_seq_uid, cam_dur, n_ch)

        return (main_mc_uid, per_channel_mc_uids, merged_wav_ams_oids,
                cam_mc_uid, cam_vms_oid, cam_markers_oid)

    # ── COM MERGED audio segment list ─────────────────────────────────────────

    def _build_audio_segments(
        self,
        cameras: list[CameraAngle],
        sync_offsets: list[int],
        cam_dur_ticks: list[int],
        wav_ams_oid: str,
        wav_mc_uid: str,
        wav_filename: str,
        wav_dur: int,
        n_ch: int,
        per_ch_mc_uids_per_cam: list[list[str]] | None = None,
        merged_wav_ams_per_cam: list[list[str]] | None = None,
    ) -> list[dict]:
        """
        Fatia o áudio da timeline em segmentos alinhados aos intervalos das
        câmeras. Sobreposição: a primeira câmera vence.

        Isso NÃO é estética — é o que torna o vídeo SELECIONÁVEL no Premiere. Ele
        só dá seleção a um clipe de vídeo quando existe um Link juntando esse
        vídeo com o áudio que cobre o MESMO trecho. Um WAV contínuo não oferece
        "o áudio daquele trecho" para linkar, e o clipe de vídeo fica clicável só
        pelas bordas de trim. Por isso o áudio é fatiado mesmo na variante
        SEM MERGED.

        COM MERGED (per_ch_* preenchidos): os trechos de câmera apontam para os
        Merged Clips daquela câmera. SEM MERGED: apontam para o próprio WAV — o
        áudio soa igual, mas passa a existir um item por trecho para linkar.

        Todo segmento é recortado a [0, wav_dur] — o intervalo em que o WAV
        EXISTE. Uma câmera pode começar antes do gravador ou continuar depois
        dele; nesses trechos não há som direto, e pedir ao Premiere um InPoint
        negativo (ou além do fim do arquivo) é mandá-lo ler áudio inexistente.

        Cada segmento: {inpt, outpt, ams_per_ch, mc_per_ch, name}.
        """
        merged_mode = per_ch_mc_uids_per_cam is not None

        wav_mc_per_ch = [wav_mc_uid] * n_ch
        wav_ams_per_ch = [wav_ams_oid] * n_ch

        cam_info = sorted(
            zip(
                sync_offsets,
                cam_dur_ticks,
                per_ch_mc_uids_per_cam or [wav_mc_per_ch] * len(cameras),
                merged_wav_ams_per_cam or [wav_ams_per_ch] * len(cameras),
                range(len(cameras)),
            ),
            key=lambda x: x[0],
        )

        # Funde intervalos sobrepostos (a primeira câmera vence)
        merged: list[tuple] = []
        for s_off, dur, mc_per_ch, ams_per_ch, cam_i in cam_info:
            s_end = s_off + dur
            if merged and s_off < merged[-1][1]:
                if s_end > merged[-1][1]:
                    merged[-1] = (merged[-1][0], s_end) + merged[-1][2:]
            else:
                merged.append((s_off, s_end, mc_per_ch, ams_per_ch,
                                cameras[cam_i].path.name))

        # Recorta ao intervalo em que o WAV existe. No caso comum (gravador roda
        # antes e para depois de todas as câmeras) isso não muda nada — é só a
        # borda que evita pedir áudio fora do arquivo.
        clipped: list[tuple] = []
        for cam_start, cam_end, mc_per_ch, ams_per_ch, cam_name in merged:
            s = max(0, cam_start)
            e = min(wav_dur, cam_end)
            if e <= s:
                continue   # câmera inteiramente fora do WAV: não há áudio a fatiar
            clipped.append((s, e, mc_per_ch, ams_per_ch, cam_name))

        segments: list[dict] = []
        current = 0

        for cam_start, cam_end, mc_per_ch, ams_per_ch, cam_name in clipped:
            if current < cam_start:
                segments.append({
                    "inpt": current, "outpt": cam_start,
                    "ams_per_ch": wav_ams_per_ch, "mc_per_ch": wav_mc_per_ch,
                    "name": wav_filename,
                })
            segments.append({
                "inpt": cam_start, "outpt": cam_end,
                "ams_per_ch": ams_per_ch, "mc_per_ch": mc_per_ch,
                "name": (cam_name + " - Merged") if merged_mode else wav_filename,
            })
            current = cam_end

        if current < wav_dur:
            segments.append({
                "inpt": current, "outpt": wav_dur,
                "ams_per_ch": wav_ams_per_ch, "mc_per_ch": wav_mc_per_ch,
                "name": wav_filename,
            })
        return segments

    # ── Build one sequence variant ────────────────────────────────────────────

    def _build_one_sequence(
        self,
        cameras: list[CameraAngle],
        file_group_idx: list[int],
        n_groups: int,
        cam_vms_oids: list[str],
        cam_mc_uids: list[str],
        cam_markers_oids: list[str],
        cam_dur_ticks: list[int],
        sync_offsets: list[int],
        wav_ams_oid: str,
        wav_mc_uid: str,
        wav_dur: int,
        n_ch: int,
        tpf_str: str,
        seq_name: str,
        origin: int,
        merged_mode: bool,
        wav_filename: str,
        cam_merged_mc_uids: list[str] | None = None,
        cam_merged_vms_oids: list[str] | None = None,
        cam_merged_markers_oids: list[str] | None = None,
        per_ch_mc_uids_per_cam: list[list[str]] | None = None,
        merged_wav_ams_per_cam: list[list[str]] | None = None,
    ) -> str:
        """
        Build one of the 4 sequence variants. Returns seq_uid.

        `origin` (ticks, no eixo do WAV) é o que cai na posição 0 da sequência —
        e é a ÚNICA coisa que separa uma variante "COM GAP" de uma "SEM GAP":

          COM GAP  → origin = primeiro clipe (o WAV, ou uma câmera que o preceda)
          SEM GAP  → origin = primeira câmera (o cabeçalho do WAV é aparado)

        Toda posição é `posição_no_eixo_do_WAV - origin`, então nada cai em
        posição negativa (que o Premiere não aceita).
        """
        wav_markers_oid = self._make_markers()
        audio_track_uids: list[str] = []
        all_audio_ti_oids: list[str] = []

        # O áudio é SEMPRE segmentado nos limites das câmeras — nas duas
        # variantes. É isso que dá ao vídeo um item de áudio do mesmo trecho para
        # linkar, e sem esse Link o Premiere não deixa selecionar o clipe de
        # vídeo (só as bordas de trim). Ver _build_audio_segments.
        # segment_audio_ti[i] = ti_oids de áudio (um por canal) do segmento i.
        segments = self._build_audio_segments(
            cameras, sync_offsets, cam_dur_ticks,
            wav_ams_oid, wav_mc_uid, wav_filename, wav_dur, n_ch,
            per_ch_mc_uids_per_cam=per_ch_mc_uids_per_cam if merged_mode else None,
            merged_wav_ams_per_cam=merged_wav_ams_per_cam if merged_mode else None,
        )
        segment_audio_ti: list[list[str]] = [[] for _ in segments]

        # >2 canais → saída adaptativa (ver a mesma lógica em _build_sequence).
        adaptive = n_ch > 2
        for ch in range(n_ch):
            ch_ti_oids: list[str] = []
            for si, seg in enumerate(segments):
                tl_start = seg["inpt"] - origin
                tl_end = seg["outpt"] - origin
                if tl_end <= 0:
                    continue
                tl_start = max(0, tl_start)
                ac_oid = self._make_audio_clip_for_track_segment(
                    seg["ams_per_ch"][ch], wav_markers_oid,
                    seg["inpt"], seg["outpt"], ch)
                sc_oid = self._make_subclip(
                    ac_oid, seg["mc_per_ch"][ch], ch, seg["name"])
                ti_oid = self._make_audio_clip_track_item(
                    ac_oid, sc_oid, tl_start, tl_end)
                ch_ti_oids.append(ti_oid)
                all_audio_ti_oids.append(ti_oid)
                segment_audio_ti[si].append(ti_oid)
            at_uid = self._make_audio_clip_track(
                ch, ch + 2, ch_ti_oids, adaptive_out_channel=ch if adaptive else None)
            audio_track_uids.append(at_uid)

        mt_oid = self._make_master_track(audio_track_uids, adaptive=adaptive)

        # Video tracks — one VideoClipTrack per physical camera GROUP, holding
        # every clip of that camera as sequential TrackItems (same pattern as
        # _make_audio_clip_track's multi-item tracks). cam_ti_oids_video stays
        # flat/per-file: Links and cam_segment_index below index into it exactly
        # as before, regardless of which shared track a file's item belongs to.
        video_track_uids: list[str] = []
        cam_ti_oids_video: list[str] = []
        group_ti_oids: list[list[str]] = [[] for _ in range(n_groups)]
        cam_segment_index: dict[int, int] = {}   # índice da câmera -> índice do segmento
        for i, cam in enumerate(cameras):
            start_tl = sync_offsets[i] - origin
            end_tl = start_tl + cam_dur_ticks[i]
            if merged_mode:
                # Contexto merged: mídia/markers/MasterClip DUPLICADOS e dedicados
                # (nunca o MC da câmera crua na bin, nunca o MC "- Merged" da bin —
                # ver docstring de _make_merged_clip_sequence).
                seq_vc_oid = self._make_video_clip_for_track(
                    cam_merged_vms_oids[i], cam_merged_markers_oids[i], cam_dur_ticks[i])
                sc_name = cam.path.name + " - Merged"
                sc_mc = cam_merged_mc_uids[i]
            else:
                seq_vc_oid = self._make_video_clip_for_track(
                    cam_vms_oids[i], cam_markers_oids[i], cam_dur_ticks[i])
                sc_name = cam.path.name
                sc_mc = cam_mc_uids[i]

            # Casa o vídeo com o segmento de áudio que ele SOBREPÕE no tempo (não
            # por nome): quando uma câmera está inteiramente contida no intervalo
            # de outra, o "primeira câmera vence" de _build_audio_segments
            # descarta o segmento próprio dela — mas o segmento que cobre aquele
            # trecho existe (atribuído à outra câmera). Casar por sobreposição
            # ainda o encontra, e o vídeo continua selecionável em vez de virar um
            # item solto sem Link.
            cam_start_raw = sync_offsets[i]
            cam_end_raw = cam_start_raw + cam_dur_ticks[i]
            for si, seg in enumerate(segments):
                if seg["inpt"] < cam_end_raw and seg["outpt"] > cam_start_raw:
                    cam_segment_index[i] = si
                    break

            sc_oid = self._make_subclip(seq_vc_oid, sc_mc, 0, sc_name)
            ti_oid = self._make_video_clip_track_item(sc_oid, start_tl, end_tl)
            cam_ti_oids_video.append(ti_oid)
            group_ti_oids[file_group_idx[i]].append(ti_oid)

        for gi in range(n_groups):
            vt_uid = self._make_video_clip_track(gi, gi + 1, group_ti_oids[gi], tpf_str)
            video_track_uids.append(vt_uid)

        # Um Link por segmento da timeline: os trechos de gap (só WAV) linkam seus
        # canais de áudio entre si; os trechos de câmera linkam o item de VÍDEO
        # junto com o(s) canal(is) de áudio que cobrem o mesmo intervalo. Vídeo
        # sozinho num Link = vídeo não selecionável no Premiere.
        used_segment_idx = set(cam_segment_index.values())
        link_oids = []
        for i, ti_oid in enumerate(cam_ti_oids_video):
            si = cam_segment_index.get(i)
            items = ([ti_oid] + segment_audio_ti[si]) if si is not None else [ti_oid]
            link_oids.append(self._make_link(items))
        for si, ti_oids in enumerate(segment_audio_ti):
            if si in used_segment_idx or not ti_oids:
                continue
            link_oids.append(self._make_link(ti_oids))

        seq_end_times = [sync_offsets[i] - origin + cam_dur_ticks[i]
                         for i in range(len(cameras))]
        work_out = max(wav_dur - origin, *seq_end_times)

        # TC exibido na posição 0 da sequência. É o início do PROJETO, escolhido
        # pelo usuário — não o TC embutido de uma das câmeras. Herdar o TC da
        # câmera mais antiga (o que o builder fazia antes) é arbitrário quando as
        # câmeras estão em relógios diferentes, e indefinido quando quem abre a
        # timeline é o som direto, que não tem TC nenhum.
        zero_point = self.daily.start_tc_frames * self._tpf()

        return self._make_sequence(
            seq_name=seq_name,
            video_track_uids=video_track_uids,
            audio_track_uids=audio_track_uids,
            mt_oid=mt_oid,
            link_oids=link_oids,
            work_out=work_out,
            zero_point=zero_point,
            tpf=tpf_str,
        )

    # ── Project bin structure ─────────────────────────────────────────────────

    def _make_clip_item(self, mc_uid: str, name: str, label_name: str | None) -> str:
        """
        Uma linha da bin apontando para um MasterClip. `label_name` é uma das
        constantes _LABEL_*, ou None para omitir a Label (as sequências: o template
        do Premiere não põe uma). Devolve o ObjectUID do ClipProjectItem.
        """
        cpi_uid = new_uid()
        cpi = _el("ClipProjectItem",
                  {"ObjectUID": cpi_uid,
                   "ClassID": _CLS["ClipProjectItem"], "Version": "1"})
        pi = _sub(cpi, "ProjectItem", {"Version": "1"})
        node = _sub(pi, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        if label_name is not None:
            _sub(props, "Column.PropertyText.Label", text=label_name)
        _sub(pi, "Name", text=name)
        _sub(cpi, "MasterClip", {"ObjectURef": mc_uid})
        self.add(cpi)
        return cpi_uid

    def _make_container(self, tag: str, cls: str, name: str,
                        child_uids: list[str]) -> str:
        """
        Uma PASTA da bin — `BinProjectItem` (uma diária) ou `RootProjectItem` (a
        raiz). As duas têm a mesma forma: um ProjectItem com o nome, e um
        ProjectItemContainer com os filhos por ObjectURef. A forma saiu de um projeto
        real do Premiere (`PROJETO_TEMPLATE_VAZIO.prproj`).

        As Properties ficam VAZIAS: as do template (cor da etiqueta, ordem no grid,
        estado de aberto/fechado) são estado de VISTA, e o Premiere as regenera. Pôr
        um valor inventado ali seria fingir que sabemos algo que não sabemos.
        """
        uid = new_uid()
        el = _el(tag, {"ObjectUID": uid, "ClassID": cls, "Version": "1"})
        pi = _sub(el, "ProjectItem", {"Version": "1"})
        node = _sub(pi, "Node", {"Version": "1"})
        _sub(node, "Properties", {"Version": "1"})
        _sub(pi, "Name", text=name)
        pic = _sub(el, "ProjectItemContainer", {"Version": "1"})
        # Uma bin VAZIA não leva <Items> — é o que o template mostra.
        if child_uids:
            items = _sub(pic, "Items", {"Version": "1"})
            for idx, child in enumerate(child_uids):
                _sub(items, "Item", {"Index": str(idx), "ObjectURef": child})
        self.add(el)
        return uid

    def _make_bin(self, name: str, child_uids: list[str]) -> str:
        """A bin de uma DIÁRIA: as mídias dela e a sua sequência."""
        return self._make_container(
            "BinProjectItem", _CLS["BinProjectItem"], name, child_uids)

    def _make_root(self, child_uids: list[str]) -> str:
        """A raiz do projeto: uma bin por diária."""
        return self._make_container(
            "RootProjectItem", _CLS["RootProjectItem"], "Root", child_uids)

    # ── Project infrastructure (OIDs 1-49) ───────────────────────────────────

    def _make_project_infra(self, root_uid: str) -> None:
        """
        Emit minimal project infrastructure:
          - Project element (ObjectID=1) with nested ViewState/Columns
          - ProjectSettings (OID=3) and its sub-objects
          - CompileSettings stubs (OIDs 4-8)
          - ScratchDiskSettings (OID=9), IngestSettings (OID=10), Workspace (OID=11)
          - VideoSettings/AudioSettings stubs (OIDs 12-27)
        All OIDs are fixed to match Premiere's expected structure.
        """

        def _fixed(tag: str, oid: str, cls: str, ver: str) -> ET.Element:
            return _el(tag, {"ObjectID": oid, "ClassID": cls, "Version": ver})

        def _add_fixed(tag: str, oid: str, cls: str, ver: str) -> ET.Element:
            e = _fixed(tag, oid, cls, ver)
            self.add(e)
            return e

        # VideoSettings stubs (OIDs 12, 28-38 even — OIDs 20/22/24/26 are VideoCompileSettings)
        vs_oids = ["12", "28", "30", "32", "34", "36", "38"]
        for oid in vs_oids:
            vs = _add_fixed("VideoSettings", oid, _CLS["VideoSettings"], "9")
            _sub(vs, "FrameRate", text="8475667200")
            _sub(vs, "FrameSize", text="0,0,720,480")
            _sub(vs, "PixelAspectRatio", text="10,11")
            _sub(vs, "MaximumBitDepth", text="false")

        # AudioSettings stubs (OIDs 13, 29-39 odd — OIDs 21/23/25/27 are AudioCompileSettings)
        as_oids = ["13", "29", "31", "33", "35", "37", "39"]
        for oid in as_oids:
            aset = _add_fixed("AudioSettings", oid, _CLS["AudioSettings"], "7")
            _sub(aset, "ChannelType", text="1")
            _sub(aset, "FrameRate", text=_AFR)

        # VideoCompileSettings stubs (OIDs 14, 18, 20, 22, 24, 26)
        vcs_top = [("14", "28"), ("18", "30"), ("20", "32"), ("22", "34"),
                   ("24", "36"), ("26", "38")]
        for top_oid, vs_ref in vcs_top:
            vcs = _add_fixed("VideoCompileSettings", top_oid, _CLS["VideoCompileSettings"], "9")
            _sub(vcs, "VideoSettings", {"ObjectRef": vs_ref})
            _sub(vcs, "Compressor", text="1685480224")
            _sub(vcs, "VideoCompilerClassIDFourCC", text="1061109567")
            _sub(vcs, "VideoFileTypeFourCC", text="1299148630")
            _sub(vcs, "Depth", text="24")
            _sub(vcs, "RenderDepth", text="0")
            _sub(vcs, "Quality", text="100")
            _sub(vcs, "UseDataRate", text="false")
            _sub(vcs, "DataRate", text="3500")
            _sub(vcs, "ForceRecompress", text="true")
            _sub(vcs, "ForceRecompressValue", text="2")
            _sub(vcs, "Aspect43", text="false")
            _sub(vcs, "Deinterlace", text="false")
            _sub(vcs, "IgnoreVideoFilters", text="false")
            _sub(vcs, "OptimizeStills", text="false")
            _sub(vcs, "FramesAtMarkers", text="false")
            _sub(vcs, "RealTimePreview", text="true")
            _sub(vcs, "VideoFieldType", text="0")
            _sub(vcs, "DoKeyframeEveryNFrames", text="false")
            _sub(vcs, "DoKeyframeEveryNFramesValue", text="0")
            _sub(vcs, "AddKeyframesAtMarkers", text="false")
            _sub(vcs, "AddKeyframesAtEdits", text="false")
            _sub(vcs, "RelativeFrameSize", text="1")

        # AudioCompileSettings stubs
        acs_top = [("15", "29"), ("19", "31"), ("21", "33"), ("23", "35"),
                   ("25", "37"), ("27", "39")]
        for top_oid, as_ref in acs_top:
            acs = _add_fixed("AudioCompileSettings", top_oid, _CLS["AudioCompileSettings"], "6")
            _sub(acs, "AudioSettings", {"ObjectRef": as_ref})
            _sub(acs, "SampleType", text="3")
            _sub(acs, "Compressor", text="1380013856")
            _sub(acs, "Interleave", text="1")

        # DummyCaptureSettings OID=16
        _add_fixed("DummyCaptureSettings", "16", _CLS["DummyCaptureSettings"], "1")

        # DefaultSequenceSettings OID=17
        dss = _add_fixed("DefaultSequenceSettings", "17", _CLS["DefaultSeqSettings"], "2")
        _sub(dss, "TotalVideoTracks", text="1")
        _sub(dss, "DefaultAudioStandardMonoTracks", text="0")
        _sub(dss, "DefaultAudioStandardStereoTracks", text="1")
        _sub(dss, "DefaultAudioStandard51Tracks", text="0")
        _sub(dss, "DefaultAudioSubmixMonoTracks", text="0")
        _sub(dss, "DefaultAudioSubmixStereoTracks", text="0")
        _sub(dss, "DefaultAudioSubmix51Tracks", text="0")

        # ProjectSettings OID=3 (refs 12-17)
        ps = _add_fixed("ProjectSettings", "3", _CLS["ProjectSettings"], "21")
        _sub(ps, "VideoSettings", {"ObjectRef": "12"})
        _sub(ps, "AudioSettings", {"ObjectRef": "13"})
        _sub(ps, "VideoCompileSettings", {"ObjectRef": "14"})
        _sub(ps, "AudioCompileSettings", {"ObjectRef": "15"})
        _sub(ps, "CaptureSettings", {"ObjectRef": "16"})
        _sub(ps, "DefaultSequenceSettings", {"ObjectRef": "17"})
        _sub(ps, "VideoTimeDisplay", text="102")
        _sub(ps, "AudioTimeDisplay", text="200")
        _sub(ps, "VideoTimeDisplayInitial", text="102")
        _sub(ps, "ActionSafeWidth", text="10")
        _sub(ps, "ActionSafeHeight", text="10")
        _sub(ps, "TitleSafeWidth", text="20")
        _sub(ps, "TitleSafeHeight", text="20")
        _sub(ps, "ShouldScaleMedia", text="false")
        _sub(ps, "EditingModeID", text="00000000-0000-0000-0000-000000000000")
        _sub(ps, "PreviewFileFormatID", text="00000000-0000-0000-0000-000000000000")
        _sub(ps, "UsePreviewCache", text="false")
        _sub(ps, "ColorManagementSettings", text='{"enableLogColorManagement":2,"graphicsWhiteLuminance":203,"lutInterpolationMethod":1}')
        _sub(ps, "ColorAwareEffectsEnabled", text="0")

        # CompileSettings stubs OIDs 4-8
        cs_defs = [
            ("4",  "18", "19"),  # MovieCompileSettings
            ("5",  "20", "21"),  # StillCompileSettings
            ("6",  "22", "23"),  # AudioCompileSettings
            ("7",  "24", "25"),  # CustomCompileSettings
            ("8",  "26", "27"),  # VideoPreviewCompileSettings
        ]
        for top_oid, vcs_ref, acs_ref in cs_defs:
            cs = _add_fixed("CompileSettings", top_oid, _CLS["CompileSettings"], "4")
            _sub(cs, "VideoCompileSettings", {"ObjectRef": vcs_ref})
            _sub(cs, "AudioCompileSettings", {"ObjectRef": acs_ref})
            # OID 8 = VideoPreviewCompileSettings — matches both template files
            fourcc = "1061109567" if top_oid == "8" else "0"
            vfourcc = "1299148630" if top_oid == "8" else "0"
            _sub(cs, "CompilerClassIDFourCC", text=fourcc)
            _sub(cs, "CompilerFourCC", text=vfourcc)
            _sub(cs, "ExportVideo", text="true")
            _sub(cs, "ExportAudio", text="true")
            _sub(cs, "AddToProjectWhenFinished", text="true")
            _sub(cs, "BeepWhenFinished", text="false")
            _sub(cs, "ExportWorkAreaOnly", text="false")
            _sub(cs, "EmbedProjectLink", text="false")

        # ScratchDiskSettings OID=9
        sds = _add_fixed("ScratchDiskSettings", "9", _CLS["ScratchDiskSettings"], "4")
        for loc in ["AudioPreviewLocation0", "VideoPreviewLocation0", "DVDEncodingLocation0",
                    "TransferMediaLocation0", "CapsuleMediaLocation0", "AutoSaveLocation0",
                    "CCLibrariesLocation0", "CapturedVideoLocation0"]:
            _sub(sds, loc, text="SameAsProject")

        # IngestSettings OID=10
        ing = _add_fixed("IngestSettings", "10", _CLS["IngestSettings"], "2")
        _sub(ing, "Enabled", text="false")
        _sub(ing, "Action", text="copy")

        # WorkspaceSettings OID=11 (empty)
        _add_fixed("WorkspaceSettings", "11", _CLS["WorkspaceSettings"], "1")

        # ── Project element OID=1 (the main project object with nested columns) ──
        # Minimal ProjectViewState.List with 2 columns (Label + Name)
        view_state_uid = new_uid()

        # self-referential pointer
        proj_ref = _el("Project", {"ObjectRef": "1"})
        self._els.insert(0, proj_ref)   # must be FIRST child of PremiereData

        # ProjectViewState (ObjectID="1" inside the List context)
        pvs = _el("ProjectViewState",
                  {"ObjectID": "1", "ClassID": _CLS["ProjectViewState"], "Version": "3"})
        _sub(pvs, "ColumnListContents.Version", text="18")
        _sub(pvs, "ProjectViewState.ID", text=view_state_uid)
        _sub(pvs, "ProjectViewState.OriginalID", text="00000000-0000-0000-0000-000000000000")
        _sub(pvs, "ProjectViewState.BinID", text="1000000")
        _sub(pvs, "ProjectViewState.ViewHidden", text="false")
        _sub(pvs, "PreviewView.Visible", text="false")
        _sub(pvs, "ContentView.LastViewed", text="1")
        _sub(pvs, "IconView.Thumbnail.Size", text="200")
        _sub(pvs, "FreeformView.Scale", text="1")
        _sub(pvs, "ListView.Thumbnail.Size", text="0")
        _sub(pvs, "IconView.Thumbnail.State", text="true")
        _sub(pvs, "ListView.Thumbnail.State", text="false")
        _sub(pvs, "Thumbnail.ShowsEffects.State", text="true")
        _sub(pvs, "Sort.Type", text="0")
        _sub(pvs, "Sort.Enabled", text="true")
        _sub(pvs, "Sort.ColumnIndex", text="1")
        _sub(pvs, "Sort.Direction", text="0")
        _sub(pvs, "ListView.NameColumnWidth", text="0")
        _sub(pvs, "IconSort.Type", text="0")
        _sub(pvs, "IconSort.Direction", text="0")
        _sub(pvs, "IconSort.ColumnIndex", text="0")
        _sub(pvs, "Project.IsEAProject", text="false")
        _sub(pvs, "Columns.List", {"ObjectRef": "2"})

        # ColumnList (ObjectID="2" inside the List context)
        clist = _el("ColumnList",
                    {"ObjectID": "2", "ClassID": _CLS["ColumnList"], "Version": "1"})
        cols_el = _sub(clist, "Columns", {"Version": "1"})
        _sub(cols_el, "Column", {"Index": "0", "ObjectRef": "3"})
        _sub(cols_el, "Column", {"Index": "1", "ObjectRef": "4"})

        # LabelColumn (ObjectID="3" in local scope)
        lbl_col = _el("LabelColumn",
                      {"ObjectID": "3", "ClassID": _CLS["LabelColumn"], "Version": "1"})
        _sub(lbl_col, "Column.Name", text="Label")
        _sub(lbl_col, "Column.ID", text="Column.PropertyText.Label")
        _sub(lbl_col, "Column.Type", text="17")
        _sub(lbl_col, "Column.Class", text="1")
        _sub(lbl_col, "Column.Width", text="26")
        _sub(lbl_col, "Column.IsHidden", text="false")

        # NameColumn (ObjectID="4" in local scope)
        nm_col = _el("NameColumn",
                     {"ObjectID": "4", "ClassID": _CLS["NameColumn"], "Version": "1"})
        _sub(nm_col, "Column.Name", text="Name")
        _sub(nm_col, "Column.ID", text="Column.Name")
        _sub(nm_col, "Column.Type", text="0")
        _sub(nm_col, "Column.Class", text="1")
        _sub(nm_col, "Column.Width", text="180")
        _sub(nm_col, "Column.IsHidden", text="false")

        # ProjectViewState.List
        pvsl = _el("ProjectViewState.List",
                   {"ObjectID": "2", "ClassID": _CLS["ProjViewStateList"], "Version": "3"})
        pvsls = _sub(pvsl, "ProjectViewStates", {"Version": "1"})
        pvs_item = _sub(pvsls, "ProjectViewState", {"Version": "1", "Index": "0"})
        _sub(pvs_item, "First", text=view_state_uid)
        _sub(pvs_item, "Second", {"ObjectRef": "1"})
        pvsl.append(pvs)
        pvsl.append(clist)
        pvsl.append(lbl_col)
        pvsl.append(nm_col)

        # Main Project element
        proj = _el("Project",
                   {"ObjectID": "1", "ClassID": _CLS["Project"], "Version": "43"})
        node = _sub(proj, "Node", {"Version": "1"})
        props = _sub(node, "Properties", {"Version": "1"})
        props.append(pvsl)
        _sub(proj, "RootProjectItem", {"ObjectURef": root_uid})
        _sub(proj, "ProjectSettings", {"ObjectRef": "3"})
        _sub(proj, "MovieCompileSettings", {"ObjectRef": "4"})
        _sub(proj, "StillCompileSettings", {"ObjectRef": "5"})
        _sub(proj, "AudioCompileSettings", {"ObjectRef": "6"})
        _sub(proj, "CustomCompileSettings", {"ObjectRef": "7"})
        _sub(proj, "VideoPreviewCompileSettings", {"ObjectRef": "8"})
        _sub(proj, "ScratchDiskSettings", {"ObjectRef": "9"})
        _sub(proj, "IngestSettings", {"ObjectRef": "10"})
        _sub(proj, "ProjectWorkspace", {"ObjectRef": "11"})
        _sub(proj, "NextID", text="1000001")

        # Insert Project right after the pointer (at index 1)
        self._els.insert(1, proj)

    # ── Utility ───────────────────────────────────────────────────────────────

    def _relative_path(self, path: Path) -> str:
        """Simple relative path from a sibling 'DRAMASYNC' folder."""
        return path.name  # fallback; absolute path in FilePath is authoritative

    # ── Top-level build ───────────────────────────────────────────────────────

    # ── Mídia (cache do PROJETO) ─────────────────────────────────────────────

    def _camera_media(self, cam: CameraAngle) -> tuple[str, str, str, int]:
        """O Media/MasterClip desta câmera — criado UMA vez por arquivo."""
        key = str(cam.path)
        if key not in self.cam_media:
            dur = self._cam_duration_ticks(cam)
            _, _, vms_oid, ams_oid = self._make_camera_media(cam)
            marks = self._make_markers()
            vc = self._make_video_clip(vms_oid, marks, dur)
            ac = self._make_audio_clip_for_media(
                ams_oid, marks, dur, n_channels=cam.audio_channels)
            mc = self._make_media_masterclip(
                name=cam.path.name, markers_oid=marks,
                primary_clip_oid=vc, audio_clip_oid=ac, ams_oid=ams_oid,
                cam=cam, wav_dur_ticks=None, n_channels=cam.audio_channels,
            )
            self.cam_media[key] = (mc, vms_oid, marks, dur, ams_oid)
        return self.cam_media[key]

    def _sound_media(self, snd: SoundClip) -> tuple[str, list[str], int, int]:
        """
        O Media/MasterClip deste som — criado UMA vez por arquivo.

        UM Media/AudioMediaSource POR CANAL: é assim que o Premiere seleciona um canal
        de um WAV multipista. Ver `_make_wav_media`.
        """
        key = str(snd.path)
        if key not in self.snd_media:
            dur = self._sound_duration_ticks(snd)
            ams_oids = self._make_wav_media(snd)
            marks = self._make_markers()
            # Um AudioClip por canal, cada um MONO e lendo o seu próprio Media.
            ch_clips = [
                self._make_audio_clip_for_media(ams, marks, dur, n_channels=1)
                for ams in ams_oids
            ]
            mc = self._make_media_masterclip(
                name=snd.path.name, markers_oid=marks,
                primary_clip_oid=ch_clips[0], audio_clip_oid=None,
                extra_audio_clip_oids=ch_clips[1:],
                ams_oid=ams_oids[0],
                cam=None, wav_dur_ticks=dur, n_channels=snd.channels,
            )
            self.snd_media[key] = (mc, ams_oids, dur, snd.channels)
        return self.snd_media[key]

    # ── Uma sequência ────────────────────────────────────────────────────────

    def _build_sequence(self, d: Daily, seq_name: str, *, multicam: bool = True,
                        origin_frames: int = 0, include_camera_audio: bool = False) -> str:
        """
        Monta UMA sequência a partir de um `Daily` (a diária inteira, ou a vista de um
        sub-grupo) e devolve o ObjectUID do MasterClip dela.

        ⚠️ **`origin_frames` é a armadilha do timecode, do lado do export.**

        As posições em `timeline_start_frames` são ABSOLUTAS no dia. Uma cena cujo
        primeiro clipe cai aos 5 min geraria, sem mais nada, cinco minutos de vazio no
        começo da sequência. Então a sequência da cena começa NO PRIMEIRO CLIPE DELA:
        `origin_frames` é subtraído de toda posição.

        Só que deslocar as posições mudaria o TIMECODE — e aí o mesmo arquivo mostraria
        `01:00:00:00` na cena e `01:05:00:00` na diária. O `ZeroPoint` compensa
        exatamente o deslocamento:

            posição   = timeline_start − origin
            ZeroPoint = start_tc       + origin
            TC exibido = ZeroPoint + posição = start_tc + timeline_start   ← invariante

        O TC de um clipe é o mesmo nas duas sequências, e é isso que o teste
        `test_o_TC_de_um_clipe_e_o_MESMO_na_diaria_e_no_subgrupo` guarda. É a mesma
        correção que `assemble()` faz na timeline (`types/timeline.ts`), com a mesma
        forma — e é a única mentira que este app pode contar.

        Para a diária, `origin_frames = 0` (o `normalize_origin` já pôs o primeiro
        clipe no zero) e tudo isto colapsa no comportamento de sempre.

        A sequência espelha EXATAMENTE a timeline do app:
          - uma track de vídeo por CÂMERA FÍSICA, com os clipes dela nas posições
            de timecode (com os buracos reais entre as tomadas);
          - N tracks de áudio (N = canais do som direto), com o som de cada tomada
            debaixo da câmera dela;
          - um Link por tomada, juntando o vídeo com os canais do seu som.

        Por que uma sequência que espelha a tela, e não já os merged clips: é o que
        permite ao usuário CONFERIR — abrir no Premiere e comparar frame a frame com
        o que o app mostrou.

        As posições saem de `timeline_start_frames`, que o engine já resolveu (grafo
        de sync dentro da tomada, timecode entre tomadas). O builder não recalcula
        nada: se ele fizesse a sua própria aritmética, o arquivo poderia discordar
        da tela — e é exatamente essa discordância que o usuário precisa poder
        descartar.

        Cada diária tem o SEU fps, o SEU start_tc e a SUA origem de tempo — nada
        disso é do projeto. É por isso que `self.daily` muda aqui: toda a aritmética
        de ticks abaixo é medida na grade DESTA diária.
        """
        self.daily = d
        tpf = self._tpf()
        tpf_str = str(tpf)

        def pos(frames: int) -> int:
            """Posição na sequência. Ver `origin_frames` no docstring."""
            return self._start_ticks(frames - origin_frames)

        for cam in d.cameras:
            self._camera_media(cam)
        # `all_sounds` = as tomadas E os sons órfãos (sem câmera). O órfão vai para a
        # track de áudio no seu lugar, exatamente como o Premiere mostra — a timeline
        # tem TODOS os arquivos, em sync ou não. Ele só não entra em Link nenhum (não
        # tem câmera com que andar junto).
        for snd in d.all_sounds:
            self._sound_media(snd)
        cam_media = self.cam_media
        snd_media = self.snd_media

        # ── Tracks de vídeo: uma por câmera FÍSICA ────────────────────────────
        video_track_uids: list[str] = []
        ti_of_camera: dict[str, str] = {}
        # Áudio de cada câmera para as tracks de ÂNGULO (ver adiante). Cada item é
        # um clipe de câmera: (group_idx, cam_ams, masterclip, markers, tl_start,
        # dur_ticks, audio_channels, nome).
        cam_audio_segments: list[tuple] = []
        for gi, group in enumerate(d.camera_groups):
            ti_oids: list[str] = []
            for cam in group.cameras:
                mc, vms_oid, marks, dur, cam_ams = cam_media[str(cam.path)]
                vc = self._make_video_clip_for_track(vms_oid, marks, dur)
                sc = self._make_subclip(vc, mc, 0, cam.path.name)
                start = pos(cam.timeline_start_frames)
                ti = self._make_video_clip_track_item(sc, start, start + dur)
                ti_oids.append(ti)
                ti_of_camera[str(cam.path)] = ti
                if cam.audio_channels > 0:
                    cam_audio_segments.append(
                        (gi, cam_ams, mc, marks, start, dur, cam.audio_channels,
                         cam.path.name))
            video_track_uids.append(
                self._make_video_clip_track(gi, gi + 1, ti_oids, tpf_str))

        # ── Tracks de áudio: uma por CANAL do som direto ──────────────────────
        # O número de canais vem do arquivo, não de uma suposição: os WAVs reais
        # de som direto têm 5 (mix + os microfones), e assumir 2 jogava fora o
        # trabalho do sonoplasta.
        n_ch = max((s.channels for s in d.all_sounds), default=2)
        # A saída ADAPTATIVA (cada canal no seu, master de N canais, StereoTo16Channel)
        # é do MULTICAM. Com o multicam desligado (Alpha), a diária sai como sequência
        # NORMAL e o áudio usa a estrutura simples validada — sem o bug do "0 Channel".
        # Quando o multicam voltar (`multicam=True`), o adaptativo entra de novo.
        adaptive = multicam and n_ch > 2
        markers = self._make_markers()
        audio_track_uids: list[str] = []
        ti_of_sound: dict[str, list[str]] = {}
        for ch in range(n_ch):
            ch_tis: list[str] = []
            for snd in d.all_sounds:
                mc, ams_oids, dur, canais = snd_media[str(snd.path)]
                if ch >= canais:
                    continue
                # O AudioMediaSource DESTE canal — é ele que carrega o StreamNumber.
                # Apontar todos os canais para o mesmo AMS fazia as 5 tracks tocarem
                # o canal 1 e o áudio piscar ao passar o mouse.
                ac = self._make_audio_clip_for_track_segment(
                    ams_oids[ch], markers, 0, dur, ch)
                sc = self._make_subclip(ac, mc, ch, snd.path.name)
                start = pos(snd.timeline_start_frames)
                ti = self._make_audio_clip_track_item(ac, sc, start, start + dur)
                ch_tis.append(ti)
                ti_of_sound.setdefault(str(snd.path), []).append(ti)
            # Pares estéreo completos são TARGETED; um canal ímpar solto no fim (total
            # ímpar de canais) NÃO é targeted — é o que a multicam nativa do Premiere
            # escreve, e escrever diferente fazia a sequência ser lida como "0 Channel".
            ch_targeted = not (adaptive and ch == n_ch - 1 and n_ch % 2 == 1)
            audio_track_uids.append(self._make_audio_clip_track(
                ch, ch + 2, ch_tis, adaptive_out_channel=ch if adaptive else None,
                targeted=ch_targeted))

        # ── Tracks do ÁUDIO DA CÂMERA (opção do usuário) ──────────────────────
        # O som original de cada câmera, por canal, DEPOIS das tracks do som direto
        # (A1..An = som direto; A(n+1).. = câmera). O som direto vem SEMPRE primeiro.
        # Numa multicam (futuro) elas entram como ângulo não-targeted; numa sequência
        # NORMAL (Alpha) são tracks de áudio comuns.
        if include_camera_audio:
            n_groups = len(d.camera_groups)
            n_cam_ch = max((seg[6] for seg in cam_audio_segments), default=0)
            cam_track_index = n_ch
            for gi in range(n_groups):
                for ch in range(n_cam_ch):
                    ch_tis: list[str] = []
                    for (g, cam_ams, cmc, cmarks, cstart, cdur, cnch, cname) in cam_audio_segments:
                        if g != gi or ch >= cnch:
                            continue
                        ac = self._make_audio_clip_for_track_segment(
                            cam_ams, cmarks, 0, cdur, ch, content_channel_index=ch)
                        sc = self._make_subclip(ac, cmc, ch, cname)
                        ti = self._make_audio_clip_track_item(ac, sc, cstart, cstart + cdur)
                        ch_tis.append(ti)
                    audio_track_uids.append(self._make_audio_clip_track(
                        cam_track_index, cam_track_index + 2, ch_tis,
                        adaptive_out_channel=ch if adaptive else None,
                        targeted=not adaptive))
                    cam_track_index += 1

        mt_oid = self._make_master_track(audio_track_uids, adaptive=adaptive)

        # ── Links: um por TOMADA ──────────────────────────────────────────────
        # Cada Link junta o(s) clipe(s) de câmera da tomada com os canais do som
        # dela. Sem isso o clipe de vídeo não é selecionável no Premiere (só pelas
        # bordas de trim) — e os dois deixam de andar juntos ao serem movidos.
        link_oids: list[str] = []
        for take in d.takes:
            items = [ti_of_camera[str(c.path)] for c in take.cameras
                     if str(c.path) in ti_of_camera]
            items += ti_of_sound.get(str(take.sound.path), [])
            if len(items) > 1:
                link_oids.append(self._make_link(items))

        # ── A sequência ───────────────────────────────────────────────────────
        ends = [pos(c.timeline_start_frames) + self._cam_duration_ticks(c)
                for c in d.cameras]
        ends += [pos(s.timeline_start_frames) + self._sound_duration_ticks(s)
                 for s in d.all_sounds]
        work_out = max(ends) if ends else 0

        seq_uid = self._make_sequence(
            seq_name=seq_name,
            video_track_uids=video_track_uids,
            audio_track_uids=audio_track_uids,
            mt_oid=mt_oid,
            link_oids=link_oids,
            work_out=work_out,
            # TC exibido na posição 0 da sequência. Para a diária é o início do
            # projeto (ver Daily.start_tc_frames); para uma cena, ele ABSORVE o
            # deslocamento da origem — é o que faz o TC de um clipe ser o mesmo nas
            # duas sequências.
            zero_point=self._start_ticks(d.start_tc_frames + origin_frames),
            tpf=tpf_str,
            # Só no multicam adaptativo as tracks de câmera ficam FORA da contagem de
            # canais da saída. Numa sequência normal, vale o total de tracks (default).
            num_adaptive_channels=n_ch if adaptive else None,
        )
        # Uma track de vídeo por câmera física é exatamente a forma que o monitor
        # multicam do Premiere espera — por isso a sequência da DIÁRIA é sempre uma
        # Multi-Camera Source Sequence. Para um sub-grupo, quem decide é o usuário na
        # hora do export (ver ExportOptions).
        return self._make_sequence_masterclip(
            seq_uid, seq_name, work_out, n_audio_channels=n_ch, multicam=multicam,
            adaptive=n_ch > 2)

    # ── Uma diária: a sua sequência, as suas cenas, a sua bin ────────────────

    def _build_daily(self, d: Daily, options: ExportOptions) -> str:
        """Monta a bin de uma diária e devolve o ObjectUID dela."""
        # ALPHA: a diária sai como sequência NORMAL sincronizada (multicam desligado —
        # ver ExportOptions). O usuário pode incluir o áudio original da câmera.
        seq_mc = self._build_sequence(
            d, d.name, multicam=False,
            include_camera_audio=options.include_camera_audio)
        cam_media = self.cam_media
        snd_media = self.snd_media

        # ── A bin DESTA diária ────────────────────────────────────────────────
        # A mídia bruta PRECISA de entrada própria na bin: um MasterClip alcançável
        # só por um SubClip dentro da sequência é despejado pelo Premiere numa pasta
        # automática "Recovered Clips" ao abrir.
        children: list[str] = []
        for cam in d.cameras:
            children.append(self._make_clip_item(
                cam_media[str(cam.path)][0], cam.path.name, _LABEL_VIDEO_NAME))
        for snd in d.all_sounds:
            children.append(self._make_clip_item(
                snd_media[str(snd.path)][0], snd.path.name, _LABEL_AUDIO_NAME))
        children.append(self._make_clip_item(seq_mc, d.name, None))

        # ── As CENAS, numa sub-bin ────────────────────────────────────────────
        # Cada cena é uma sequência a mais — e SÓ isso. A mídia dela é a mesma da
        # diária (o cache por path garante), então nada aqui duplica arquivo: uma
        # cena que reimportasse a sua mídia daria dois clipes iguais na bin, e o
        # Premiere não teria como dizer qual é qual.
        sub_children: list[str] = []
        for sg in d.sub_groups:
            paths = set(sg.paths)
            view = d.view(paths)
            if not view.cameras and not view.sounds:
                continue   # cena esvaziada (os arquivos saíram) — nada a exportar
            sub_mc = self._build_sequence(
                view,
                f"{d.name} · {sg.name}",
                multicam=options.is_multicam(sg.id),
                # A cena começa NO PRIMEIRO CLIPE DELA, com o TC preservado.
                origin_frames=view.origin_frames,
                include_camera_audio=options.include_camera_audio,
            )
            sub_children.append(self._make_clip_item(sub_mc, sg.name, None))

        if sub_children:
            children.append(self._make_bin(_SUB_BIN_NAME, sub_children))

        return self._make_bin(d.name, children)

    def build(self) -> str:
        """
        Monta o PRPROJ do PROJETO INTEIRO: uma bin por diária, num arquivo só.

        O laço é a etapa toda. Cada diária se monta sozinha — o fps, o timecode
        inicial e a origem de tempo são DELA —, e o que as une é apenas o arquivo e o
        cache de mídia: um arquivo tem UM MasterClip no projeto, mesmo que apareça em
        mais de uma sequência (a da diária e a de uma cena).

        Um projeto sem diária nenhuma ainda é um PRPROJ válido: abre vazio, em vez de
        estourar. É o que o usuário espera de "exportar" sem ter sincronizado nada.
        """
        bins = [self._build_daily(d, self.options) for d in self.project.groups]

        root_uid = self._make_root(bins)
        self._make_project_infra(root_uid)

        # ── XML ───────────────────────────────────────────────────────────────
        pr_root = _el("PremiereData", {"Version": "3"})
        for el in self._els:
            pr_root.append(el)
        return '<?xml version="1.0" encoding="UTF-8"?>' + ET.tostring(pr_root, encoding="unicode")


# ── Public API ────────────────────────────────────────────────────────────────

def build_prproj(project: Project | Daily, output_path: Path,
                 options: ExportOptions | None = None) -> None:
    """
    Gera o PRPROJ e o escreve em `output_path`.

    Aceita uma `Daily` solta por conveniência dos testes e do caminho legado
    (`export_prproj`, que sincroniza e exporta numa tacada) — uma diária só é um
    projeto de uma diária só, e obrigar quem chama a envelopá-la seria cerimônia.
    """
    if isinstance(project, Daily):
        project = Project(name=project.name, groups=[project])
    write_prproj(_B(project, options).build(), output_path)
