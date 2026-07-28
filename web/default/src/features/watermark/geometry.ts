import type { WatermarkPosition } from "./types";

export type Point = { x: number; y: number };

function axisPlacement(
  containerSize: number,
  markSize: number,
  alignment: "start" | "center" | "end",
  margin: number,
): number {
  if (alignment === "start") return margin;
  if (alignment === "end") return containerSize - markSize - margin;
  return (containerSize - markSize) / 2;
}

export function singlePlacement(
  canvasWidth: number,
  canvasHeight: number,
  markWidth: number,
  markHeight: number,
  position: WatermarkPosition,
  margin: number,
): Point {
  const safeMargin = Math.max(0, margin);
  const [vertical, horizontal] = position === "center" ? ["middle", "center"] : position.split("-");
  let horizontalAlignment: "start" | "center" | "end" = "center";
  if (horizontal === "left") {
    horizontalAlignment = "start";
  } else if (horizontal === "right") {
    horizontalAlignment = "end";
  }
  let verticalAlignment: "start" | "center" | "end" = "center";
  if (vertical === "top") {
    verticalAlignment = "start";
  } else if (vertical === "bottom") {
    verticalAlignment = "end";
  }

  return {
    x: axisPlacement(canvasWidth, markWidth, horizontalAlignment, safeMargin),
    y: axisPlacement(canvasHeight, markHeight, verticalAlignment, safeMargin),
  };
}

export function tilePlacements(
  canvasWidth: number,
  canvasHeight: number,
  markWidth: number,
  markHeight: number,
  gapX: number,
  gapY: number,
): Point[] {
  const safeMarkWidth = Math.max(1, markWidth);
  const safeMarkHeight = Math.max(1, markHeight);
  const stepX = safeMarkWidth + Math.max(0, gapX);
  const stepY = safeMarkHeight + Math.max(0, gapY);
  const extension = Math.hypot(safeMarkWidth, safeMarkHeight);
  const points: Point[] = [];

  for (let y = -extension; y <= canvasHeight + extension; y += stepY) {
    for (let x = -extension; x <= canvasWidth + extension; x += stepX) {
      points.push({ x, y });
    }
  }

  return points;
}
