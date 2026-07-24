import { useCallback, useRef } from "react";

interface SplitterProps {
  /** Tamanho ATUAL do painel redimensionado (altura ou largura). */
  size: number;
  onResize: (size: number) => void;
  /** "y" = divisória horizontal (redimensiona altura); "x" = vertical (largura). */
  axis?: "x" | "y";
  /** Por padrão redimensiona o painel DEPOIS da divisória. Com `invert`, o de
   *  ANTES (ex.: a árvore de mídia, que fica à ESQUERDA do seu splitter). */
  invert?: boolean;
  min?: number;
  max?: number;
}

/**
 * Divisória arrastável. Redimensiona SEMPRE o painel que vem depois dela —
 * a timeline (abaixo) no eixo Y, o monitor (à direita) no eixo X.
 *
 * Por isso o delta é invertido nos dois casos: arrastar a divisória PARA TRÁS
 * (para cima, ou para a esquerda) faz o painel seguinte crescer. Pointer capture
 * para o arrasto não se perder quando o cursor sai do elemento.
 */
export function Splitter({
  size,
  onResize,
  axis = "y",
  invert = false,
  min = 140,
  max = 640,
}: SplitterProps) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const isX = axis === "x";

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { pos: isX ? e.clientX : e.clientY, size };
    },
    [size, isX]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!start.current) return;
      // Painel DEPOIS: cresce ao arrastar para trás. Painel ANTES (`invert`): o
      // contrário — arrastar para a frente (direita/baixo) o faz crescer.
      const raw = start.current.pos - (isX ? e.clientX : e.clientY);
      const delta = invert ? -raw : raw;
      onResize(Math.min(max, Math.max(min, start.current.size + delta)));
    },
    [onResize, min, max, isX, invert]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    start.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      className={
        "flex-shrink-0 bg-line hover:bg-accent transition-colors " +
        (isX ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize")
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="separator"
      aria-orientation={isX ? "vertical" : "horizontal"}
    />
  );
}
