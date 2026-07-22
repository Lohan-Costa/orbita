import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { IconVideoOff, IconAlertTriangle, IconX } from "@tabler/icons-react";
import { useActiveResult, useAppStore } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { useTimelineData } from "../hooks/useTimelineData";
import { transport } from "../lib/transport";
import { decodedRealFrame } from "../lib/videoProbe";
import * as proxy from "../lib/proxy";
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
 * UM MOTOR SÓ: o `<video>` do WebView, sempre. Ele toca mp4/H.264 (o material
 * real) nativamente, com `currentTime` EXATO AO FRAME, e vive no DOM.
 *
 * Para o que o WebView NÃO decodifica (ProRes, MXF, XDCAM…), NÃO se usa um player
 * nativo por cima (foi o VLC, e ele MENTIA: no seek pausado caía no keyframe
 * anterior — GOP de 23 frames —, mostrando um frame ANTERIOR ao pedido; a claquete
 * fechava numa posição em que o pico do som já tinha passado, e o sync CERTO
 * parecia errado; um monitor que mente é pior que nenhum). Em vez disso, o ffmpeg
 * gera um PROXY H.264 all-intra de um trecho (ver src-python/media/proxy.py) que o
 * MESMO `<video>` toca frame-exato. O still exato aparece na hora (monitor_frame,
 * Rust) enquanto o trecho transcodifica. Tudo no DOM, sem janela nativa nem
 * z-order, sem dependência externa.
 *
 * A escolha é EMPÍRICA, não por lista de extensões: tenta-se o ORIGINAL no
 * `<video>`; se ele falhar (`error`) OU carregar sem nunca decodificar um quadro de
 * verdade (`decodedRealFrame` — .mov 10-bit/4:2:2 no Windows: áudio e metadados
 * carregam, `loadeddata` dispara, quadro preto), entra o proxy. Adivinhar quais
 * formatos o WebView toca é justamente o tipo de suposição que já custou caro aqui.
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

/** No máximo um still de scrub a cada tanto (cada um é um decode no ffmpeg). Tem
 *  borda de saída — sem ela, o último movimento do arrasto era descartado. */
const SCRUB_SEEK_MS = 60;

/** A janela do proxy: quanto tempo o proxy cobre, e quanto dele fica ANTES da
 *  agulha (pré-roll), para cutucar em torno do ponto de sync não sair do cache. */
const WINDOW_DUR = 15;
const WINDOW_LEAD = 3;
/** Margem para trocar de janela um pouco antes da borda (não no último frame). */
const WINDOW_MARGIN = 0.15;

/** Os estados do motor do monitor:
 *  - `html5`: o `<video>` toca — o arquivo ORIGINAL (que o WebView decodifica) OU
 *    um PROXY (trecho transcodificado, ver media/proxy.py). Exato ao frame nos dois.
 *  - `caching`: o WebView não decodifica o original; mostrando o still exato
 *    (monitor_frame) enquanto o proxy do trecho transcodifica.
 *  - `unsupported`: nem isso deu conta (proxy falhou — arquivo corrompido). Estado
 *    DECLARADO, não ausência: a tela diz por que está preta.
 */
type Engine = "none" | "html5" | "caching" | "unsupported";

export function Monitor() {
  const t = useI18n();
  const syncResult = useActiveResult();
  const {
    activeAngleId,
    setActiveAngleId,
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

  /** A janela do proxy carregada no `<video>`, ou `null` se ele tem o arquivo
   *  ORIGINAL. Com proxy, `v.currentTime = localSec - proxyWin.start` (o proxy
   *  começa em t=0) — e quando a agulha sai da janela, geramos outra. */
  const proxyWin = useRef<{ clip: string; start: number; dur: number } | null>(null);
  /** Uma janela já está transcodificando — o scrub não dispara outra por cima. */
  const winLoading = useRef(false);
  /** Geração da janela: um pedido novo (troca de clipe, nova janela) invalida um
   *  transcode em voo, para o proxy velho nunca chegar depois e tocar o lugar errado. */
  const windowGen = useRef(0);
  /** O `<img>` do still exato, mostrado enquanto o proxy transcodifica. */
  const stillRef = useRef<HTMLImageElement>(null);
  const lastStill = useRef(0);

  /** Resolução de reprodução do proxy (teto FHD). Vem das Configurações. */
  const [resolution, setResolution] = useState<proxy.Resolution>("half");
  useEffect(() => {
    void invoke<{ playback_resolution?: proxy.Resolution }>("sidecar_call", {
      command: "get_settings",
      params: {},
    })
      .then((s) => {
        if (s?.playback_resolution) setResolution(s.playback_resolution);
      })
      .catch(() => {});
  }, []);

  /** O `<video>` não decodificou o clipe da prévia E o proxy também falhou
   *  (arquivo corrompido) — liga o aviso em vez de deixar a tela preta enganar. */
  const [previewNoDecode, setPreviewNoDecode] = useState(false);
  /** Gerando o proxy da prévia (clipe que o WebView não decodifica) — mostra
   *  "preparando" até o `<video controls>` poder tocar com som. */
  const [previewCaching, setPreviewCaching] = useState(false);

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

  // ── O arquivo no ar ────────────────────────────────────────────────────────
  /** O arquivo que o motor tem carregado. */
  const onAir = useRef<string | null>(null);
  /** Carregar é assíncrono; enquanto uma carga corre, as outras esperam. */
  const loading = useRef(false);
  const restart = useRef(false);

  useEffect(() => {
    if (!data) return;

    /** Pinta o quadro EXATO em `sec` (still do Rust) no `<img>` de cobertura.
     *  Conforto enquanto o proxy transcodifica — falhar aqui não quebra nada. */
    const paintStill = async (clipPath: string, sec: number) => {
      try {
        const buf = await proxy.frame(clipPath, sec, resolution);
        if (onAir.current !== clipPath) return;
        const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
        const img = stillRef.current;
        if (!img) {
          URL.revokeObjectURL(url);
          return;
        }
        const old = img.src;
        img.src = url;
        if (old.startsWith("blob:")) URL.revokeObjectURL(old);
      } catch {
        /* o still é conforto, não requisito */
      }
    };

    /** Transcodifica a janela em torno de `aroundSec` e a carrega no `<video>`.
     *  `gen` é a geração deste pedido — se outro pedido vier no meio, este bail. */
    const loadWindow = async (clipPath: string, aroundSec: number, gen: number) => {
      const wStart = Math.max(0, aroundSec - WINDOW_LEAD);
      const wDur = WINDOW_DUR;
      const current = () => gen === windowGen.current && onAir.current === clipPath;
      try {
        const proxyPath = await proxy.window(clipPath, wStart, wDur, resolution);
        if (!current()) return; // superado (novo clipe/janela) — não aplica
        const v = videoRef.current;
        if (!v) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            v.removeEventListener("loadeddata", ok);
            v.removeEventListener("error", ok);
            resolve();
          };
          const ok = () => done();
          v.addEventListener("loadeddata", ok, { once: true });
          v.addEventListener("error", ok, { once: true });
          v.src = convertFileSrc(proxyPath);
          v.load();
        });
        if (!current()) return;
        proxyWin.current = { clip: clipPath, start: wStart, dur: wDur };
        setEngine("html5");
        // Posiciona no ponto ATUAL da agulha (pode ter andado durante o transcode).
        const f = programFrameAt(data, activeAngleId, transport.positionSec);
        const localSec = f && f.clip.path === clipPath ? f.localSec : aroundSec;
        v.currentTime = Math.max(0, localSec - wStart);
        if (transport.isPlaying) void v.play().catch(() => {});
      } catch {
        if (current()) setEngine("unsupported");
      } finally {
        // Só o pedido AINDA vigente libera o guard — um superado não mexe nele.
        if (gen === windowGen.current) winLoading.current = false;
      }
    };

    /** Entra no modo proxy: still na hora + janela em background. Um pedido novo
     *  (troca de clipe, agulha saiu da janela) supera o anterior via `windowGen`. */
    const beginWindow = (clipPath: string, sec: number) => {
      const gen = ++windowGen.current;
      winLoading.current = true;
      proxyWin.current = null;
      setEngine("caching");
      void paintStill(clipPath, sec);
      void loadWindow(clipPath, sec, gen);
    };

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
          proxyWin.current = null;
          const v = videoRef.current;
          if (v) {
            v.pause();
            v.removeAttribute("src");
            v.load();
          }
          setEngine("none");
          return;
        }

        // 1. Tenta o WebView com o ORIGINAL. É o caminho exato, e é o normal.
        const v = videoRef.current;
        if (!v) return;
        const loaded = await new Promise<boolean>((resolve) => {
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
        // `loadeddata` pode disparar sem um quadro de verdade ter sido
        // decodificado (ver cabeçalho do arquivo) — só então confia nele.
        const ok = loaded && (await decodedRealFrame(v));

        if (ok) {
          setEngine("html5");
          proxyWin.current = null; // o `<video>` tem o ORIGINAL
          onAir.current = path;
          v.currentTime = Math.max(0, startSec);
          return;
        }

        // 2. O WebView não decodifica (ProRes…) → PROXY no próprio `<video>`.
        // Antes era o VLC (janela nativa por cima, que mente no seek pausado);
        // agora um proxy all-intra que o `<video>` toca frame-exato.
        onAir.current = path;
        beginWindow(path, startSec);
      } catch {
        // Nem o proxy deu conta (arquivo corrompido, ffmpeg falhou). Ficar em
        // `none` daria tela preta muda — e um monitor que mente é pior que
        // nenhum (ver o cabeçalho). `onAir` fica com o path DE PROPÓSITO: sem
        // isso, cada update tentaria recarregar, martelando o IPC.
        onAir.current = path;
        setEngine("unsupported");
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
      // Cacheando: o proxy ainda transcodifica — segue com o STILL exato.
      if (engineRef.current === "caching") {
        const now = performance.now();
        if (now - lastStill.current >= SCRUB_SEEK_MS) {
          lastStill.current = now;
          void paintStill(path, localSec);
        }
        return;
      }

      if (engineRef.current === "html5") {
        const v = videoRef.current;
        if (!v) return;
        const pw = proxyWin.current;
        if (pw && (localSec < pw.start || localSec > pw.start + pw.dur - WINDOW_MARGIN)) {
          // A agulha saiu da janela do proxy → gera outra (o still cobre a troca).
          if (!winLoading.current) beginWindow(path, localSec);
          return;
        }
        // Com proxy, o tempo-local do `<video>` é descontado do início da janela.
        const target = pw ? localSec - pw.start : localSec;
        if (transport.isPlaying) {
          if (v.paused) void v.play().catch(() => {});
          // Tocando, o vídeo anda sozinho; a deriva é corrigida à parte.
        } else {
          if (!v.paused) v.pause();
          // Parado, segue a agulha AO FRAME — o que o VLC não dava.
          if (Math.abs(v.currentTime - target) > 0.001) {
            v.currentTime = Math.max(0, target);
          }
        }
        return;
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
    };
  }, [data, activeAngleId, isPlaying, resolution]);

  // ── Play/pause: o vídeo segue o transporte ─────────────────────────────────
  useEffect(() => {
    if (!onAir.current) return;
    if (engine === "html5") {
      const v = videoRef.current;
      if (!v) return;
      if (isPlaying) void v.play().catch(() => {});
      else v.pause();
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

        // Com proxy, o tempo-local do `<video>` é descontado do início da janela.
        const pw = proxyWin.current;
        const target = pw ? frame.localSec - pw.start : frame.localSec;
        const error = target - v.currentTime; // >0 → o vídeo está atrasado

        if (Math.abs(error) > DRIFT_JUMP_S) {
          v.playbackRate = 1;
          v.currentTime = Math.max(0, target);
        } else if (Math.abs(error) > DRIFT_DEADBAND_S) {
          // Empurra a velocidade em vez de saltar: converge em ~1 s, sem engasgo.
          const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, error));
          v.playbackRate = 1 + trim;
        } else if (v.playbackRate !== 1) {
          v.playbackRate = 1;
        }
      }
    }, DRIFT_CHECK_MS);

    return () => clearInterval(id);
  }, [isPlaying, data, activeAngleId, engine]);

  // Sem sync → nada no ar.
  useEffect(() => {
    if (syncResult) return;
    onAir.current = null;
    proxyWin.current = null;
    setEngine("none");
  }, [syncResult]);

  useEffect(
    () => () => {
      onAir.current = null;
      proxyWin.current = null;
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
   * Prévia de um clipe do bin (duplo-clique em `MediaContent`) — separada do
   * monitor sincronizado acima. É "olhar o arquivo", COM som, no `<video controls>`.
   *
   * Primeiro o WebView com o ORIGINAL (o normal). Se ele não decodificar um quadro
   * de verdade (`decodedRealFrame` — ProRes, MXF…), gera um PROXY do clipe COM
   * áudio (media/proxy.py::preview) e toca ESSE no mesmo `<video>` — controles e
   * som nativos, sem player externo. Falhar o proxy (arquivo corrompido) → aviso.
   */
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    setPreviewNoDecode(false);
    setPreviewCaching(false);
    if (!previewClip) {
      v.pause();
      v.removeAttribute("src");
      v.load();
      return;
    }

    let cancelled = false;
    const clip = previewClip;
    // DETECÇÃO SILENCIOSA: o `<video>` não toca durante a sondagem — só carrega e
    // apresenta o primeiro quadro (`decodedRealFrame`). OU o WebView decodifica e
    // vira o player, OU o proxy assume — nunca os dois (era o `play()` aqui que
    // causava o áudio-com-tela-preta).
    v.muted = true;

    // WebView não decodifica → proxy do clipe COM áudio, tocado no MESMO `<video>`.
    const goProxy = async () => {
      if (cancelled) return;
      // Esvazia o `<video>` do original quebrado — senão o botão de play nativo
      // apareceria sobre a tela preta junto do "Preparando".
      v.pause();
      v.removeAttribute("src");
      v.load();
      setPreviewCaching(true);
      let proxyPath: string;
      try {
        proxyPath = await proxy.preview(clip.path, resolution);
      } catch {
        if (!cancelled) {
          setPreviewCaching(false);
          setPreviewNoDecode(true);
        }
        return;
      }
      if (cancelled) return;
      setPreviewCaching(false);
      v.muted = false;
      v.src = convertFileSrc(proxyPath);
      v.load();
      void v.play().catch(() => {});
    };

    const onLoaded = () => {
      void decodedRealFrame(v).then((ok) => {
        if (cancelled) return;
        if (ok) {
          // WebView decodifica o ORIGINAL → ele É o player, com som e controles.
          v.muted = false;
          void v.play().catch(() => {});
        } else {
          void goProxy();
        }
      });
    };
    // O `<video>` pode NÃO decodificar de dois jeitos: carrega e o quadro fica
    // preto (`loadeddata` + decodedRealFrame falso), OU nem carrega e dispara
    // `error` (o MXF/XDCAM). Os DOIS têm que cair no proxy — sem o `error` a
    // prévia ficava preta com o botão de play, sem nunca pedir o proxy.
    const onError = () => void goProxy();

    v.addEventListener("loadeddata", onLoaded, { once: true });
    v.addEventListener("error", onError, { once: true });
    v.src = convertFileSrc(clip.path);
    v.load();
    return () => {
      cancelled = true;
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("error", onError);
    };
  }, [previewClip, resolution]);

  // Dar play no transporte principal sai da prévia — os dois não competem.
  useEffect(() => {
    if (isPlaying && previewClip) setPreviewClip(null);
  }, [isPlaying, previewClip, setPreviewClip]);

  return (
    <div className="flex flex-col h-full min-w-0 bg-surface">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line flex-shrink-0">
        <span className="panel-title">{t.monitor.title}</span>
        {engine === "caching" && (
          <span className="status-pill pill-muted gap-1">{t.monitor.caching}</span>
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
          {/* Still exato enquanto o proxy transcodifica (o momento do sync-check
              já é visível antes de o trecho ficar tocável). */}
          <img
            ref={stillRef}
            alt=""
            className="absolute inset-0 w-full h-full object-contain"
            style={{ display: engine === "caching" ? "block" : "none" }}
          />
          {engine !== "html5" && engine !== "caching" && !syncResult && (
            <div className="flex flex-col items-center gap-2 text-ink-3">
              <IconVideoOff size={20} />
              <p className="text-[12px]">{t.monitor.empty}</p>
            </div>
          )}

          {/* Nenhum motor deu conta — diz POR QUE a tela está preta, em vez de
              deixar parecer "este ângulo não gravou aqui". */}
          {engine === "unsupported" && (
            <div className="flex flex-col items-center gap-2 text-ink-3 px-4 text-center">
              <IconAlertTriangle size={20} />
              <p className="text-[12px]">{t.monitor.noEngine}</p>
            </div>
          )}

          {/* Prévia de bin — por cima da tela sincronizada, seu próprio player
              com som (o monitor de cima fica sempre mudo). */}
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

              <div className="relative flex-1 min-h-0">
                {/* `<video controls>` toca o ORIGINAL (se o WebView decodifica) ou
                    o proxy do clipe COM áudio (media/proxy.py::preview). */}
                <video
                  ref={previewVideoRef}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
                {previewCaching && (
                  <div className="absolute inset-0 flex items-center justify-center text-white/80 pointer-events-none">
                    <p className="text-[11px]">{t.monitor.caching}</p>
                  </div>
                )}
                {previewNoDecode && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white/80 px-3 text-center">
                    <IconAlertTriangle size={16} />
                    <p className="text-[11px]">{t.monitor.previewNoDecode}</p>
                  </div>
                )}
              </div>
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
