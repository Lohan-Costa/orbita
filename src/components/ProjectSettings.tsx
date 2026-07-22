import { useEffect, useState } from "react";
import { useAppStore, useActiveResult } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import {
  PROJECT_FPS_OPTIONS,
  fpsLabel,
  framesToTc,
  isDropFrame,
  tcToFrames,
} from "../lib/timecode";

/**
 * Framerate e início do projeto.
 *
 * Os dois definem a GRADE de tempo: o fps é a unidade em que os offsets são
 * medidos, e o início é o timecode que a origem da timeline (o primeiro clipe)
 * exibe. O início vai para o ZeroPoint da sequência, então a régua daqui e a do
 * Premiere mostram o mesmo número.
 */
export function ProjectSettings() {
  const t = useI18n();
  const {
    projectFps,
    setProjectFps,
    projectStartTcFrames,
    setProjectStartTcFrames,
  } = useAppStore();
  const syncResult = useActiveResult();

  // fps efetivo: o escolhido, ou o que o último sync detectou. É ele que decide
  // como o campo de timecode abaixo conta os frames (e se é drop-frame).
  const effectiveFps = projectFps ?? syncResult?.fps ?? 24000 / 1001;

  // O texto do campo vive à parte do valor: enquanto o usuário digita, o TC está
  // quase sempre incompleto (e portanto inválido). Só um valor válido é gravado.
  const [tcText, setTcText] = useState(() =>
    framesToTc(projectStartTcFrames, effectiveFps)
  );
  const parsed = tcToFrames(tcText, effectiveFps);
  const invalid = parsed === null;

  // Trocar o fps reescreve o timecode: o MESMO instante tem outra numeração de
  // frames noutra grade (e 29,97 passa a usar ponto-e-vírgula).
  useEffect(() => {
    setTcText(framesToTc(projectStartTcFrames, effectiveFps));
  }, [effectiveFps, projectStartTcFrames]);

  const commit = () => {
    // Entrada quebrada volta ao último valor bom — o campo nunca fica exibindo
    // um timecode que não é o do projeto.
    if (parsed === null) {
      setTcText(framesToTc(projectStartTcFrames, effectiveFps));
      return;
    }
    setProjectStartTcFrames(parsed);
    setTcText(framesToTc(parsed, effectiveFps)); // normaliza ("10:00" → 00:00:10:00)
  };

  const detected = syncResult ? fpsLabel(syncResult.fps) : null;

  return (
    <div className="flex items-center gap-3">
      <span className="panel-title">{t.project.title}</span>

      <label className="flex items-center gap-1.5">
        <span className="text-[11px] text-ink-3">{t.project.fps}</span>
        <select
          className="field"
          title={t.project.fpsHint}
          value={projectFps ?? ""}
          onChange={(e) =>
            setProjectFps(e.target.value === "" ? null : Number(e.target.value))
          }
        >
          <option value="">
            {detected
              ? t.project.fpsAutoDetected.replace("{{fps}}", detected)
              : t.project.fpsAuto}
          </option>
          {PROJECT_FPS_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
              {isDropFrame(o.value) ? " DF" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5">
        <span className="text-[11px] text-ink-3">{t.project.startTc}</span>
        <input
          className={`field field-tc w-[92px] ${invalid ? "invalid" : ""}`}
          value={tcText}
          title={invalid ? t.project.startTcInvalid : t.project.startTcHint}
          spellCheck={false}
          onChange={(e) => setTcText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setTcText(framesToTc(projectStartTcFrames, effectiveFps));
              e.currentTarget.blur();
            }
          }}
        />
      </label>
    </div>
  );
}
