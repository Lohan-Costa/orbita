import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IconVideoOff, IconAlertTriangle, IconX } from "@tabler/icons-react";
import { useActiveResult, useAppStore } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { useTimelineData } from "../hooks/useTimelineData";
import { transport } from "../lib/transport";
import * as vlc from "../lib/vlc";
import { programFrameAt, timelineTc } from "../types/timeline";
import { secondsToTc } from "../lib/timecode";

/**
 * Monitor do programa multicam.
 *
 * O ÂNGULO é uma câmera física. Como uma câmera grava em pedaços, "mostrar a
 * CAM_A" significa mostrar o ARQUIVO dela que existe sob a agulha — e trocar de
 * arquivo quando ela cruza a fronteira. Onde aquele ângulo não gravou nada, a
 * tela fica preta: é a verdade, e é informação.
 *
 * O áudio NUNCA vem daqui — quem toca é o som direto, no transporte. É o que faz
 * do monitor um teste de sync e não um preview: você vê a câmera e ouve a
 * referência contra a qual ela foi sincronizada.
 *
 * DOIS MOTORES, e a ordem entre eles importa
 * ──────────────────────────────────────────
 * 1. `<video>` do próprio WebView — o CAMINHO PRINCIPAL. Ele toca mp4/H.264
 *    (o material real) nativamente, com `currentTime` EXATO AO FRAME e
 *    reprodução fluida, e vive no DOM (nada de view nativa por cima de tudo).
 *
 * 2. VLC — só o FALLBACK, para o que o WebView não toca (MXF, XDCAM…).
 *
 * Foi o contrário disto que quebrou o monitor: com o VLC tocando um mp4, o seek
 * pausado caía no KEYFRAME anterior (este material tem GOP de 23 frames), e o
 * monitor mostrava um frame ANTERIOR ao pedido. O usuário via a claquete fechar
 * numa posição da agulha em que o pico do som já tinha passado, e concluía —
 * corretamente, a partir do que via — que o sync estava errado. O sync estava
 * certo; o player é que mentia. Um monitor que mente é pior do que nenhum.
 *
 * A escolha do motor é EMPÍRICA, não por lista de extensões: tenta-se carregar no
 * `<video>`; se ele falhar (`error`), o VLC assume. Adivinhar quais formatos o
 * WebView toca é justamente o tipo de suposição que já custou caro aqui.
 */

/**
 * Como o vídeo é mantido em cima do relógio — e por que NÃO com seek.
 *
 * Corrigir a deriva com um seek É o engasgo. E ele dispara sozinho: na largada, o
 * áudio e o vídeo têm latências de início diferentes (uma décima de segundo cada),
 * a diferença estoura qualquer tolerância apertada, e o seek entra — repetidamente.
 * Foi o mesmo erro que fazia o áudio tocar um átimo e sumir.
 *
 * A correção certa é EMPURRAR a velocidade: se o vídeo está atrasado, ele toca a
 * 1,02× até alcançar, e volta a 1×. A convergência é suave e invisível — e vídeo e
 * som rodam os dois em tempo real, então a deriva verdadeira entre eles é de ppm; o
 * que se corrige aqui é só a largada.
 *
 * O seek fica reservado para o desvio GROSSO (troca de arquivo, um salto), onde
 * empurrar a velocidade levaria minutos para convergir.
 */
const DRIFT_CHECK_MS = 200;
/** Abaixo disto está em cima — mexer só introduziria ruído. ~1 frame. */
const DRIFT_DEADBAND_S = 0.04;
/** Acima disto, empurrar a velocidade não convergiria: seek. */
const DRIFT_JUMP_S = 1.0;
/** Quanto a velocidade pode se afastar de 1× (2% é imperceptível). */
const MAX_RATE_TRIM = 0.02;

/** Enquanto PARADO no modo VLC, no máximo um seek a cada tanto (cada um é uma ida
 *  ao processo nativo). Tem borda de saída — sem ela, o último movimento do
 *  arrasto era descartado e o vídeo ficava numa posição anterior à da agulha. */
const SCRUB_SEEK_MS = 60;

type Engine = "none" | "html5" | "vlc";

export function Monitor() {
  const t = useI18n();
  const syncResult = useActiveResult();
  const {
    activeAngleId,
    setActiveAngleId,
    monitorWidth,
    timelineHeight,
    previewClip,
    setPreviewClip,
  } = useAppStore();
  const data = useTimelineData();

  const screenRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const clipNameRef = useRef<HTMLSpanElement>(null);
  const localTcRef = useRef<HTMLSpanElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);

  const [engine, setEngine] = useState<Engine>("none");
  const engineRef = useRef<Engine>("none");
  engineRef.current = engine;

  const isPlaying = useSyncExternalStore(
    (cb) => transport.subscribe(cb),
    () => transport.isPlaying
  );

  /**
   * Os ângulos DA VISTA — não os da diária.
   *
   * Numa cena em que a CAM B não entrou, o botão dela não pode existir: escolhê-la
   * daria tela preta (não há clipe dela sob a agulha), e o usuário não teria como
   * saber por quê. As tracks saem daqui com a V1 embaixo (convenção de NLE), então a
   * ordem das fontes se recupera invertendo — é ela que numera os atalhos 1..N.
   */
  const angles = useMemo(
    () =>
      (data?.tracks ?? [])
        .filter((tr) => tr.kind === "camera")
        .reverse()
        .map((tr) => ({ id: tr.id, name: tr.label })),
    [data]
  );

  // Sem ângulo escolhido (ou o escolhido sumiu num sync novo) → assume o primeiro.
  useEffect(() => {
    if (angles.length === 0) return;
    if (!activeAngleId || !angles.some((g) => g.id === activeAngleId)) {
      setActiveAngleId(angles[0].id);
    }
  }, [angles, activeAngleId, setActiveAngleId]);

  // ── Retângulo da tela (só o VLC precisa: a view dele é nativa) ─────────────
  const rectOf = useCallback((): vlc.Rect | null => {
    const el = screenRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, []);

  useEffect(() => {
    if (engine !== "vlc") return;
    const push = () => {
      const r = rectOf();
      if (r) void vlc.setRect(r);
    };
    push();
    const el = screenRef.current;
    const ro = el ? new ResizeObserver(push) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", push);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", push);
    };
  }, [engine, rectOf, monitorWidth, timelineHeight]);

  // ── O arquivo no ar ────────────────────────────────────────────────────────
  /** O arquivo que o motor tem carregado. */
  const onAir = useRef<string | null>(null);
  /** Carregar é assíncrono; enquanto uma carga corre, as outras esperam. */
  const loading = useRef(false);
  const restart = useRef(false);
  const lastSeek = useRef(0);
  const scrubTrailing = useRef(0);

  useEffect(() => {
    if (!data) return;

    /** Põe o arquivo no ar, escolhendo o motor. */
    const load = async (path: string | null, startSec: number) => {
      if (loading.current) {
        restart.current = true;
        return;
      }
      loading.current = true;
      try {
        if (!path) {
          onAir.current = null;
          const v = videoRef.current;
          if (v) {
            v.pause();
            v.removeAttribute("src");
            v.load();
          }
          if (engineRef.current === "vlc") await vlc.stop();
          setEngine("none");
          return;
        }

        // 1. Tenta o WebView. É o caminho exato, e é o normal.
        const v = videoRef.current;
        if (!v) return;
        const ok = await new Promise<boolean>((resolve) => {
          const done = (value: boolean) => {
            v.removeEventListener("loadeddata", onOk);
            v.removeEventListener("error", onErr);
            resolve(value);
          };
          const onOk = () => done(true);
          const onErr = () => done(false);
          v.addEventListener("loadeddata", onOk, { once: true });
          v.addEventListener("error", onErr, { once: true });
          v.src = convertFileSrc(path);
          v.load();
        });

        if (ok) {
          if (engineRef.current === "vlc") await vlc.stop();
          setEngine("html5");
          onAir.current = path;
          v.currentTime = Math.max(0, startSec);
          return;
        }

        // 2. O WebView não dá conta deste formato → VLC.
        const r = rectOf();
        if (r) {
          await vlc.open(path, startSec * 1000, r);
          if (transport.isPlaying) await vlc.play();
          setEngine("vlc");
          onAir.current = path;
        }
      } catch {
        onAir.current = null;   // falhou → tenta de novo na próxima passada
      } finally {
        loading.current = false;
        if (restart.current) {
          restart.current = false;
          update();
        }
      }
    };

    const update = () => {
      const sec = transport.positionSec;
      const frame = programFrameAt(data, activeAngleId, sec);

      if (tcRef.current) tcRef.current.textContent = timelineTc(data, sec);
      if (clipNameRef.current) clipNameRef.current.textContent = frame?.clip.name ?? "";
      if (localTcRef.current) {
        localTcRef.current.textContent = frame ? secondsToTc(frame.localSec, data.fps) : "";
      }

      const path = frame?.clip.path ?? null;
      const localSec = frame?.localSec ?? 0;

      if (path !== onAir.current) {
        void load(path, localSec);
        return;
      }
      if (!path) return;

      // ── O motor segue a agulha ────────────────────────────────────────────
      if (engineRef.current === "html5") {
        const v = videoRef.current;
        if (!v) return;
        if (transport.isPlaying) {
          if (v.paused) void v.play().catch(() => {});
          // Tocando, o vídeo anda sozinho; a deriva é corrigida à parte, e é
          // ínfima (dois relógios de mídia, ambos em tempo real).
        } else {
          if (!v.paused) v.pause();
          // Parado, ele segue a agulha AO FRAME. `currentTime` no WebView é
          // exato — é justamente o que o VLC não dava.
          if (Math.abs(v.currentTime - localSec) > 0.001) {
            v.currentTime = Math.max(0, localSec);
          }
        }
        return;
      }

      if (engineRef.current === "vlc" && !transport.isPlaying) {
        const now = performance.now();
        const ms = localSec * 1000;
        if (now - lastSeek.current >= SCRUB_SEEK_MS) {
          lastSeek.current = now;
          void vlc.seek(ms);
        } else {
          window.clearTimeout(scrubTrailing.current);
          scrubTrailing.current = window.setTimeout(() => {
            lastSeek.current = performance.now();
            void vlc.seek(ms);
          }, SCRUB_SEEK_MS);
        }
      }
    };

    const unsubscribe = transport.subscribe(update);
    update();

    let raf = 0;
    const loop = () => {
      if (!transport.isPlaying) return;
      update();
      raf = requestAnimationFrame(loop);
    };
    if (isPlaying) raf = requestAnimationFrame(loop);

    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(scrubTrailing.current);
    };
  }, [data, activeAngleId, isPlaying, rectOf]);

  // ── Play/pause: o vídeo segue o transporte ─────────────────────────────────
  useEffect(() => {
    if (!onAir.current) return;
    if (engine === "html5") {
      const v = videoRef.current;
      if (!v) return;
      if (isPlaying) void v.play().catch(() => {});
      else v.pause();
    } else if (engine === "vlc") {
      void (isPlaying ? vlc.play() : vlc.pause());
    }
  }, [isPlaying, engine]);

  // ── O vídeo é mantido em cima do relógio (ver o cabeçalho das constantes) ──
  useEffect(() => {
    if (!isPlaying || !data || engine === "none") return;

    const id = setInterval(async () => {
      const frame = programFrameAt(data, activeAngleId, transport.positionSec);
      if (!frame || frame.clip.path !== onAir.current || loading.current) return;

      if (engine === "html5") {
        const v = videoRef.current;
        if (!v || v.paused || v.seeking) return;

        const error = frame.localSec - v.currentTime;   // >0 → o vídeo está atrasado

        if (Math.abs(error) > DRIFT_JUMP_S) {
          v.playbackRate = 1;
          v.currentTime = Math.max(0, frame.localSec);
        } else if (Math.abs(error) > DRIFT_DEADBAND_S) {
          // Empurra a velocidade em vez de saltar: converge em ~1 s, sem engasgo.
          const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, error));
          v.playbackRate = 1 + trim;
        } else if (v.playbackRate !== 1) {
          v.playbackRate = 1;
        }
        return;
      }

      // VLC não expõe ajuste fino de velocidade de forma confiável — aqui só o
      // desvio grosso é corrigido, e com seek mesmo.
      const actual = await vlc.time();
      if (actual < 0) return;
      if (Math.abs(actual - frame.localSec * 1000) > DRIFT_JUMP_S * 1000) {
        void vlc.seek(frame.localSec * 1000);
      }
    }, DRIFT_CHECK_MS);

    return () => clearInterval(id);
  }, [isPlaying, data, activeAngleId, engine]);

  // Sem sync → nada no ar.
  useEffect(() => {
    if (syncResult) return;
    onAir.current = null;
    setEngine("none");
    void vlc.stop();
  }, [syncResult]);

  useEffect(
    () => () => {
      onAir.current = null;
      void vlc.stop();
    },
    []
  );

  // Teclas 1..9 trocam de ângulo, como no monitor multicam do Premiere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > angles.length) return;
      e.preventDefault();
      setActiveAngleId(angles[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [angles, setActiveAngleId]);

  /**
   * Prévia de um clipe do bin (duplo-clique em `MediaContent`) — TOTALMENTE
   * separada do motor sincronizado acima: seu próprio `<video>`, com som (o
   * outro fica `muted` de propósito) e controles nativos, sem tocar em
   * `onAir`/engine/VLC. É só "olhar o arquivo", não um segundo transporte.
   */
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    if (previewClip) {
      v.src = convertFileSrc(previewClip.path);
      v.currentTime = 0;
      void v.play().catch(() => {});
    } else {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
  }, [previewClip]);

  /**
   * ⚠️ A view do VLC é NATIVA — ela fica POR CIMA de todo o HTML, inclusive de um
   * overlay com z-index. Sem escondê-la, abrir a prévia num material de fallback
   * (MXF, XDCAM) tocava o áudio sem imagem nenhuma: o usuário via o monitor
   * parado e concluía que o duplo-clique não funcionou.
   */
  useEffect(() => {
    if (engine !== "vlc") return;
    void vlc.setVisible(!previewClip);
    return () => {
      void vlc.setVisible(true);
    };
  }, [previewClip, engine]);

  // Dar play no transporte principal sai da prévia — os dois não competem.
  useEffect(() => {
    if (isPlaying && previewClip) setPreviewClip(null);
  }, [isPlaying, previewClip, setPreviewClip]);

  return (
    <div className="flex flex-col h-full min-w-0 bg-surface">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line flex-shrink-0">
        <span className="panel-title">{t.monitor.title}</span>
        {engine === "vlc" && (
          <span className="status-pill pill-muted gap-1" title={t.monitor.vlcHint}>
            <IconAlertTriangle size={11} />
            VLC
          </span>
        )}
        <span ref={tcRef} className="text-[11px] font-mono tabular-nums text-ink-2 ml-auto" />
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center p-3 overflow-hidden">
        <div
          ref={screenRef}
          className="relative w-full h-full bg-black rounded-[3px] overflow-hidden flex items-center justify-center"
        >
          {/* O áudio da câmera NUNCA soa: quem toca é o som direto. `muted` no
              elemento torna isso estrutural, e não uma lembrança. */}
          <video
            ref={videoRef}
            muted
            playsInline
            preload="auto"
            className="w-full h-full object-contain"
            style={{ display: engine === "html5" ? "block" : "none" }}
          />
          {engine !== "html5" && !syncResult && (
            <div className="flex flex-col items-center gap-2 text-ink-3">
              <IconVideoOff size={20} />
              <p className="text-[12px]">{t.monitor.empty}</p>
            </div>
          )}

          {/* Prévia de bin — por cima da tela sincronizada, seu próprio player,
              com som (o de cima fica sempre mudo). */}
          {previewClip && (
            <div className="absolute inset-0 z-10 bg-black flex flex-col">
              <div className="flex items-center gap-2 px-2 h-6 bg-black/70 flex-shrink-0">
                <span className="text-[10px] text-white/90 truncate flex-1" title={previewClip.name}>
                  {previewClip.name}
                </span>
                <button
                  className="text-white/70 hover:text-white flex-shrink-0"
                  title={t.monitor.closePreview}
                  onClick={() => setPreviewClip(null)}
                >
                  <IconX size={13} />
                </button>
              </div>
              <video
                ref={previewVideoRef}
                controls
                playsInline
                className="flex-1 min-h-0 w-full object-contain"
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 px-3 pb-3 flex flex-col gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {angles.map((g, i) => (
            <button
              key={g.id}
              className={`seg-btn ${activeAngleId === g.id ? "selected" : ""}`}
              onClick={() => setActiveAngleId(g.id)}
              title={`${g.name} (${i + 1})`}
            >
              <span className="text-ink-3">{i + 1}</span>
              {g.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-3 min-h-[16px]">
          <span ref={clipNameRef} className="truncate" />
          <span ref={localTcRef} className="font-mono tabular-nums ml-auto" />
        </div>
      </div>
    </div>
  );
}
