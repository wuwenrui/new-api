import { useState, type ChangeEvent, type DragEvent } from "react";
import { decodeImageBitmap } from "./engine";
import { extractInvisibleMark, type ExtractResult } from "./stego";
import { isSupportedImage } from "./types";

type VerifyState =
  | { status: "idle" }
  | { status: "checking"; name: string }
  | { status: "done"; name: string; result: ExtractResult }
  | { status: "error"; message: string };

export default function WatermarkVerifier() {
  const [state, setState] = useState<VerifyState>({ status: "idle" });

  const verify = async (file: File) => {
    if (!isSupportedImage(file)) {
      setState({ status: "error", message: `${file.name}：仅支持 JPG、PNG、WebP` });
      return;
    }
    setState({ status: "checking", name: file.name });
    const bitmap = await decodeImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法读取图片像素");
      context.drawImage(bitmap, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = extractInvisibleMark(imageData);
      setState({ status: "done", name: file.name, result });
    } catch (reason) {
      setState({
        status: "error",
        message: reason instanceof Error ? reason.message : "图片读取失败",
      });
    } finally {
      bitmap.close();
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void verify(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void verify(file);
  };

  return (
    <section className="watermark-verifier" aria-label="验证隐形指纹">
      <div className="watermark-section-heading">
        <span>03</span>
        <div>
          <p>验证指纹</p>
          <small>怀疑图片表面的水印被抹掉了？放进来验一验</small>
        </div>
      </div>

      <label
        className="watermark-verifier-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          aria-label="选择要验证的图片"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileInput}
        />
        <b>{state.status === "checking" ? `正在检测 ${state.name}…` : "拖入或点击选择一张图"}</b>
        <span>只读取像素，不上传</span>
      </label>

      {state.status === "done" &&
        (state.result.found ? (
          <div className="watermark-verifier-result is-found" role="status">
            <b>检测到隐形指纹</b>
            <p className="watermark-verifier-text">「{state.result.text}」</p>
            <small>
              来自 {state.name} · 可信度 {Math.round(state.result.confidence * 100)}%
              ——即使表面水印已被去除，这枚指纹仍能证明图片来源
            </small>
          </div>
        ) : (
          <div className="watermark-verifier-result" role="status">
            <b>未检测到隐形指纹</b>
            <small>
              {state.name}{" "}
              里没有本工坊写入的指纹：可能没开「隐形数字指纹」、图片被严重压缩裁剪，或水印来自其他工具
            </small>
          </div>
        ))}

      {state.status === "error" && (
        <p className="watermark-inline-error" role="alert">
          {state.message}
        </p>
      )}
    </section>
  );
}
