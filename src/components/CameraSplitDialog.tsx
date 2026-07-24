import { useState } from "react";
import {
  IconVideoFilled,
  IconMicrophoneFilled,
  IconChevronUp,
  IconChevronDown,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { useI18n } from "../hooks/useI18n";

/**
 * "Achei mais de uma câmera nesta pasta — confirma?"
 *
 * A heurística do `plan_split` (Rust) PROPÕE; quem decide é o usuário. Isso não é
 * cerimônia: o palpite se apoia na FORMA do nome dos arquivos, e material real
 * inclui câmera renomeada à mão, GoPro, RED com um arquivo por subpasta. Importar
 * calado significaria descobrir o erro só na timeline, com as tracks já erradas.
 *
 * As três saídas cobrem o que pode acontecer:
 *   - confirmar   → a ORDEM da lista vira CAM A, CAM B…
 *   - tirar uma   → aquela pasta não é importada
 *   - falso positivo → tudo vira uma câmera só (o comportamento antigo)
 */

export interface SplitCandidate {
  group_id: string;
  group_name: string | null;
  files: string[];
  split_from?: string | null;
  /** Palpite do Rust por extensão. O `probe` confirma depois. */
  kind?: string | null;
}

export function CameraSplitDialog({
  folder,
  candidates,
  onConfirm,
  onMergeAll,
  onCancel,
}: {
  folder: string;
  candidates: SplitCandidate[];
  /** Na ORDEM escolhida — é ela que define quem é CAM A. */
  onConfirm: (chosen: SplitCandidate[]) => void;
  onMergeAll: () => void;
  onCancel: () => void;
}) {
  const t = useI18n();
  const [items, setItems] = useState(candidates);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());

  const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const chosen = items.filter((c) => !excluded.has(c.group_id));
  const cams = chosen.filter((c) => c.kind !== "sound").length;
  const sounds = chosen.length - cams;

  /**
   * O rótulo é POR TIPO: as câmeras contam A, B, C… e os gravadores contam 1,
   * 2, 3… Antes tudo virava "CAM alguma coisa", e o som direto era oferecido
   * como CAM B — o que é errado e induz o usuário ao erro logo na importação.
   */
  const labelFor = (c: SplitCandidate): string => {
    const before = chosen.slice(0, chosen.indexOf(c));
    if (c.kind === "sound") {
      const n = before.filter((x) => x.kind === "sound").length + 1;
      return t.split.soundLabel.replace("{{n}}", String(n));
    }
    const n = before.filter((x) => x.kind !== "sound").length;
    return t.split.cameraLabel.replace("{{letter}}", String.fromCharCode(65 + n));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-line rounded-lg shadow-xl w-[540px] flex flex-col">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <IconAlertTriangle size={14} className="text-ink-warning flex-shrink-0" />
          <div className="text-[13px] font-medium text-ink">{t.split.title}</div>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <p className="text-[11px] text-ink-2 leading-snug">
            {t.split.hint
              .replace("{{cams}}", String(cams))
              .replace("{{sounds}}", String(sounds))
              .replace("{{folder}}", folderName)}
          </p>

          <div className="border border-line rounded-md overflow-hidden">
            {items.map((c, i) => {
              const off = excluded.has(c.group_id);
              const Icon = c.kind === "sound" ? IconMicrophoneFilled : IconVideoFilled;
              return (
                <div
                  key={c.group_id}
                  className={`flex items-center gap-2 px-2.5 py-2 border-b border-line last:border-b-0 ${
                    off ? "opacity-40" : ""
                  }`}
                >
                  <Icon
                    size={13}
                    className={`flex-shrink-0 ${
                      c.kind === "sound" ? "text-ink-success" : "text-ink-3"
                    }`}
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {!off && (
                        <span
                          className={`status-pill flex-shrink-0 ${
                            c.kind === "sound" ? "pill-success" : "pill-info"
                          }`}
                        >
                          {labelFor(c)}
                        </span>
                      )}
                      <span className="text-[12px] text-ink truncate">
                        {c.group_name ?? folderName}
                      </span>
                    </div>
                    <div className="text-[10px] text-ink-3 truncate font-mono">
                      {t.split.filesCount.replace("{{n}}", String(c.files.length))}
                      {" · "}
                      {c.files[0]?.split(/[\\/]/).pop()}
                    </div>
                  </div>

                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      className="tbtn p-1"
                      onClick={() => move(i, -1)}
                      disabled={i === 0 || off}
                      title={t.split.moveUp}
                    >
                      <IconChevronUp size={12} />
                    </button>
                    <button
                      className="tbtn p-1"
                      onClick={() => move(i, 1)}
                      disabled={i === items.length - 1 || off}
                      title={t.split.moveDown}
                    >
                      <IconChevronDown size={12} />
                    </button>
                    <button
                      className={`tbtn ml-1 ${off ? "" : "danger"}`}
                      onClick={() => toggle(c.group_id)}
                    >
                      {off ? t.split.include : t.split.exclude}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-[10px] text-ink-3 leading-snug">{t.split.orderHint}</p>
        </div>

        <div className="px-4 py-3 border-t border-line flex items-center gap-2">
          {/* Falso positivo: era uma câmera só, em pastas diferentes. */}
          <button className="tbtn" onClick={onMergeAll}>
            {t.split.sameCamera}
          </button>
          <button className="tbtn ml-auto" onClick={onCancel}>
            {t.split.cancel}
          </button>
          <button
            className="tbtn primary"
            onClick={() => onConfirm(chosen)}
            disabled={chosen.length === 0}
          >
            {t.split.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
