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
};

export const DEFAULT_WATERMARK_SETTINGS: WatermarkSettings = {
  mode: "text",
  layout: "single",
  position: "center",
  text: "仅供资料使用",
  color: "#ffffff",
  sizePercent: 8,
  opacity: 0.32,
  rotation: -20,
  marginPercent: 4,
  gapXPercent: 12,
  gapYPercent: 10,
};

export function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type as SupportedImageType);
}
