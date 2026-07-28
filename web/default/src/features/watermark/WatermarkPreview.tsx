import { useEffect, useRef, useState } from "react";
import { decodeImageBitmap, drawWatermark } from "./engine";
import type { WatermarkSettings } from "./types";

export type WatermarkQueueItem = {
  id: string;
  file: File;
  previewUrl: string;
};

type Props = {
  item: WatermarkQueueItem | null;
  settings: WatermarkSettings;
  logoFile: File | null;
};

export default function WatermarkPreview({ item, settings, logoFile }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) {
      setError(null);
      return;
    }

    let cancelled = false;
    let sourceBitmap: ImageBitmap | null = null;
    let logoBitmap: ImageBitmap | null = null;

    void (async () => {
      try {
        setError(null);
        sourceBitmap = await decodeImageBitmap(item.file);
        if (settings.mode === "image" && logoFile) {
          logoBitmap = await decodeImageBitmap(logoFile);
        }
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = sourceBitmap.width;
        canvas.height = sourceBitmap.height;
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("当前浏览器无法显示图片预览");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(sourceBitmap, 0, 0);
        drawWatermark(context, sourceBitmap.width, sourceBitmap.height, settings, logoBitmap);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "图片预览失败");
        }
      } finally {
        sourceBitmap?.close();
        logoBitmap?.close();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item, logoFile, settings]);

  if (!item) {
    return (
      <section className="watermark-preview watermark-preview--empty">
        <div className="watermark-empty-mark" aria-hidden>
          W
        </div>
        <h2>先加入需要处理的图片</h2>
        <p>支持 JPG、PNG、WebP，可一次选择多张</p>
      </section>
    );
  }

  return (
    <section className="watermark-preview" aria-label="水印预览">
      <div className="watermark-preview-meta">
        <span>实时预览</span>
        <b>{item.file.name}</b>
      </div>
      <div className="watermark-canvas-stage">
        <canvas ref={canvasRef} aria-label={`${item.file.name} 水印预览`} />
      </div>
      {error && (
        <p className="watermark-inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
