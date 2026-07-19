import { AlphaNotice } from "./components/AlphaNotice";
import { MediaTree } from "./components/MediaTree";
import { MediaContent } from "./components/MediaContent";
import { Monitor } from "./components/Monitor";
import { Timeline } from "./components/Timeline/Timeline";
import { Splitter } from "./components/Splitter";
import { SyncSettingsBar } from "./components/SyncSettingsBar";
import { SyncControls } from "./components/SyncControls";
import { StatusBar } from "./components/StatusBar";
import { useSidecarProgress } from "./hooks/useSidecarProgress";
import { useNotificationSounds } from "./hooks/useNotificationSounds";
import { useAppStore } from "./store/appStore";

export default function App() {
  // Registrado no topo da árvore para nunca perder eventos do sidecar.
  useSidecarProgress();
  // Alerta sonoro ao fim de um sync/export (sucesso ou falha).
  useNotificationSounds();

  const {
    timelineHeight,
    setTimelineHeight,
    monitorWidth,
    setMonitorWidth,
    mediaTreeWidth,
    setMediaTreeWidth,
  } = useAppStore();

  return (
    <div className="flex flex-col h-full bg-surface">
      <AlphaNotice />

      {/* Área de cima, TRÊS regiões: o NAVEGADOR de mídia (árvore + conteúdo) à
          esquerda, e o MONITOR à direita — sempre visível, sem competir com a
          mídia. A timeline fica em largura total embaixo. */}
      <div className="flex-1 min-h-0 flex">
        {/* Árvore de bins (navegação) */}
        <div className="flex-shrink-0 p-4 flex flex-col" style={{ width: mediaTreeWidth }}>
          <MediaTree />
        </div>
        <Splitter
          axis="x"
          invert
          size={mediaTreeWidth}
          onResize={setMediaTreeWidth}
          min={180}
          max={520}
        />
        {/* Conteúdo do que está selecionado (colunas informativas) */}
        <div className="flex-1 min-w-0 flex flex-col">
          <MediaContent />
        </div>
        <Splitter
          axis="x"
          size={monitorWidth}
          onResize={setMonitorWidth}
          min={280}
          max={900}
        />
        {/* Monitor — sempre visível */}
        <div className="flex-shrink-0 border-l border-line" style={{ width: monitorWidth }}>
          <Monitor />
        </div>
      </div>

      <SyncSettingsBar />
      <Splitter size={timelineHeight} onResize={setTimelineHeight} />
      <Timeline height={timelineHeight} />
      <SyncControls />
      <StatusBar />
    </div>
  );
}
