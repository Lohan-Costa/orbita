import { IconTimeline, IconWaveSquare, IconLayoutGrid } from "@tabler/icons-react";
import { useAppStore, type SyncMethod } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { ProjectSettings } from "./ProjectSettings";

/** Grade de tempo do projeto (fps + início) e método de sincronização — entre a
 *  mídia/monitor e a timeline, para decidir ANTES de ver o resultado. */
export function SyncSettingsBar() {
  const t = useI18n();
  const { syncMethod, setSyncMethod } = useAppStore();

  // Ordem: Híbrido primeiro (é o default e o mais robusto — TC propõe, waveform
  // confirma), depois Timecode (rápido, quando o TC está certo), depois Waveform.
  const methods: { id: SyncMethod; label: string; icon: React.ReactNode }[] = [
    { id: "hybrid", label: t.sync.methods.hybrid, icon: <IconLayoutGrid size={12} /> },
    { id: "timecode", label: t.sync.methods.timecode, icon: <IconTimeline size={12} /> },
    { id: "waveform", label: t.sync.methods.waveform, icon: <IconWaveSquare size={12} /> },
  ];

  return (
    <div className="flex-shrink-0 border-t border-line bg-surface-2 px-4 py-2 flex items-center gap-6 flex-wrap">
      <ProjectSettings />

      <div className="flex items-center gap-2">
        <span className="panel-title">{t.sync.syncMethod}</span>
        <div className="flex">
          {methods.map((m) => (
            <button
              key={m.id}
              className={`seg-btn ${syncMethod === m.id ? "selected" : ""}`}
              onClick={() => setSyncMethod(m.id)}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
