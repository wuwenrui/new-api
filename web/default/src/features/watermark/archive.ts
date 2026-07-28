import JSZip from "jszip";
import { decodeImageBitmap, renderWatermarkedBlob } from "./engine";
import type { WatermarkSettings } from "./types";

export type ArchiveFailure = { name: string; message: string };
export type ArchiveProgress = { completed: number; total: number };
export type ArchiveResult = {
  zip: Blob | null;
  successCount: number;
  failures: ArchiveFailure[];
};

export function watermarkedFilename(originalName: string, usedNames: Set<string>): string {
  const extensionMatch = originalName.match(/(\.(?:jpe?g|png|webp))$/i);
  const extension = extensionMatch?.[1] ?? "";
  const base = extension ? originalName.slice(0, -extension.length) : originalName;
  let sequence = 1;
  let candidate = `${base}-watermarked${extension}`;
  while (usedNames.has(candidate.toLowerCase())) {
    sequence += 1;
    candidate = `${base}-watermarked-${sequence}${extension}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export async function buildWatermarkArchive(
  files: File[],
  settings: WatermarkSettings,
  logoFile: File | null,
  onProgress: (progress: ArchiveProgress) => void,
): Promise<ArchiveResult> {
  const archive = new JSZip();
  const failures: ArchiveFailure[] = [];
  const usedNames = new Set<string>();
  let successCount = 0;
  let logo: ImageBitmap | null = null;

  try {
    if (settings.mode === "image" && logoFile) {
      logo = await decodeImageBitmap(logoFile);
    }

    for (const [index, file] of files.entries()) {
      try {
        const blob = await renderWatermarkedBlob(file, settings, logo);
        archive.file(watermarkedFilename(file.name, usedNames), blob);
        successCount += 1;
      } catch (error) {
        failures.push({
          name: file.name,
          message: error instanceof Error ? error.message : "图片处理失败",
        });
      } finally {
        onProgress({ completed: index + 1, total: files.length });
      }

      if (index + 1 < files.length) {
        await yieldToBrowser();
      }
    }
  } finally {
    logo?.close();
  }

  return {
    zip: successCount > 0 ? await archive.generateAsync({ type: "blob" }) : null,
    successCount,
    failures,
  };
}
