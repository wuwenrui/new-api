import { singlePlacement, tilePlacements, type Point } from "./geometry";
import type { WatermarkSettings } from "./types";

type MarkSize = { width: number; height: number };

export async function decodeImageBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`无法读取图片：${file.name}`);
  }
}

function markSize(
  context: CanvasRenderingContext2D,
  sourceWidth: number,
  sourceHeight: number,
  settings: WatermarkSettings,
  logo: ImageBitmap | null,
): MarkSize {
  const size = Math.max(1, (Math.min(sourceWidth, sourceHeight) * settings.sizePercent) / 100);
  if (settings.mode === "image") {
    if (!logo) throw new Error("请上传水印图片");
    return {
      width: size,
      height: size * (logo.height / logo.width),
    };
  }
  if (!settings.text.trim()) throw new Error("请输入水印文字");
  context.font = `600 ${size}px "Noto Sans SC", "PingFang SC", sans-serif`;
  return { width: context.measureText(settings.text).width, height: size };
}

function drawAt(
  context: CanvasRenderingContext2D,
  point: Point,
  size: MarkSize,
  settings: WatermarkSettings,
  logo: ImageBitmap | null,
): void {
  context.save();
  context.translate(point.x + size.width / 2, point.y + size.height / 2);
  context.rotate((settings.rotation * Math.PI) / 180);
  context.globalAlpha = settings.opacity;
  if (settings.mode === "image" && logo) {
    context.drawImage(logo, -size.width / 2, -size.height / 2, size.width, size.height);
  } else if (settings.mode === "text") {
    context.fillStyle = settings.color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(settings.text, 0, 0);
  }
  context.restore();
}

export function drawWatermark(
  context: CanvasRenderingContext2D,
  sourceWidth: number,
  sourceHeight: number,
  settings: WatermarkSettings,
  logo: ImageBitmap | null,
): void {
  const size = markSize(context, sourceWidth, sourceHeight, settings, logo);
  const shortEdge = Math.min(sourceWidth, sourceHeight);
  const points =
    settings.layout === "single"
      ? [
          singlePlacement(
            sourceWidth,
            sourceHeight,
            size.width,
            size.height,
            settings.position,
            (shortEdge * settings.marginPercent) / 100,
          ),
        ]
      : tilePlacements(
          sourceWidth,
          sourceHeight,
          size.width,
          size.height,
          (shortEdge * settings.gapXPercent) / 100,
          (shortEdge * settings.gapYPercent) / 100,
        );

  for (const point of points) {
    drawAt(context, point, size, settings, logo);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, filename: string, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error(`无法生成水印图片：${filename}`));
        }
      },
      type,
      0.95,
    );
  });
}

export async function renderWatermarkedBlob(
  file: File,
  settings: WatermarkSettings,
  logo: ImageBitmap | null,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const bitmap = await decodeImageBitmap(file);
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", {
      alpha: file.type !== "image/jpeg",
    });
    if (!context) throw new Error(`无法创建 ${file.name} 的图片画布`);
    context.drawImage(bitmap, 0, 0);
    drawWatermark(context, bitmap.width, bitmap.height, settings, logo);
    return await canvasToBlob(canvas, file.name, file.type);
  } finally {
    bitmap.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}
