export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];
export type WatermarkMode = "text" | "image";
export type WatermarkLayout = "single" | "tile";
export type WatermarkPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type WatermarkSettings = {
  mode: WatermarkMode;
  layout: WatermarkLayout;
  position: WatermarkPosition;
  text: string;
  color: string;
  sizePercent: number;
  opacity: number;
  rotation: number;
  marginPercent: number;
  gapXPercent: number;
  gapYPercent: number;
  /** 是否在导出时写入隐形数字指纹（真水印） */
  invisible: boolean;
};

export const DEFAULT_WATERMARK_SETTINGS: WatermarkSettings = {
  mode: "text",
  layout: "tile",
  position: "center",
  text: "仅供资料使用",
  color: "#ffffff",
  sizePercent: 9,
  opacity: 0.28,
  rotation: -25,
  marginPercent: 4,
  gapXPercent: 18,
  gapYPercent: 14,
  invisible: true,
};

export function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type as SupportedImageType);
}
