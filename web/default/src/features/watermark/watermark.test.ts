import { describe, expect, test } from "vitest";
import { watermarkedFilename } from "./archive";
import { singlePlacement, tilePlacements } from "./geometry";
import {
  embedInvisibleMark,
  extractInvisibleMark,
  fingerprintTextFor,
  textToBits,
  type PixelImage,
} from "./stego";

describe("watermark geometry", () => {
  test("places marks in all nine positions", () => {
    const expected = {
      "top-left": { x: 32, y: 32 },
      "top-center": { x: 480, y: 32 },
      "top-right": { x: 928, y: 32 },
      "middle-left": { x: 32, y: 360 },
      center: { x: 480, y: 360 },
      "middle-right": { x: 928, y: 360 },
      "bottom-left": { x: 32, y: 688 },
      "bottom-center": { x: 480, y: 688 },
      "bottom-right": { x: 928, y: 688 },
    } as const;

    for (const [position, placement] of Object.entries(expected)) {
      expect(
        singlePlacement(1200, 800, 240, 80, position as keyof typeof expected, 32),
      ).toEqual(placement);
    }
  });

  test("clamps negative margins and gaps while always terminating", () => {
    expect(singlePlacement(500, 300, 100, 40, "top-left", -20)).toEqual({
      x: 0,
      y: 0,
    });
    const points = tilePlacements(100, 80, 30, 20, -100, -100);
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThan(500);
  });

  test("tiles beyond all canvas edges in row-major order", () => {
    const points = tilePlacements(1000, 700, 180, 60, 80, 60);
    expect(Math.min(...points.map((point) => point.x))).toBeLessThan(0);
    expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(1000);
    expect(Math.min(...points.map((point) => point.y))).toBeLessThan(0);
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(700);
    expect(points[1]?.y).toBe(points[0]?.y);
  });
});

describe("watermark archive names", () => {
  test("keeps extensions and resolves case-insensitive duplicates", () => {
    const used = new Set<string>();
    expect(watermarkedFilename("evidence.PNG", used)).toBe("evidence-watermarked.PNG");
    expect(watermarkedFilename("Evidence.png", used)).toBe("Evidence-watermarked-2.png");
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticImage(width: number, height: number, seed = 7): PixelImage {
  const random = mulberry32(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(random() * 256);
    data[i + 1] = Math.floor(random() * 256);
    data[i + 2] = Math.floor(random() * 256);
    data[i + 3] = 255;
  }
  return { data, width, height };
}

describe("invisible fingerprint", () => {
  test("encodes text to bits and rejects empty text", () => {
    expect(textToBits("仅供资料使用").length).toBeGreaterThan(0);
    expect(textToBits("   ")).toEqual([]);
  });

  test("roundtrips a chinese fingerprint through embed and extract", () => {
    const image = syntheticImage(320, 256);
    expect(embedInvisibleMark(image, "仅供资料使用")).toBe(true);
    const result = extractInvisibleMark(image);
    expect(result.found).toBe(true);
    expect(result.text).toBe("仅供资料使用");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test("survives uniform pixel noise", () => {
    const image = syntheticImage(320, 256);
    embedInvisibleMark(image, "张三律师");
    const random = mulberry32(99);
    for (let i = 0; i < image.data.length; i += 4) {
      const noise = Math.floor(random() * 13) - 6;
      image.data[i] = image.data[i] + noise;
      image.data[i + 1] = image.data[i + 1] + noise;
      image.data[i + 2] = image.data[i + 2] + noise;
    }
    const result = extractInvisibleMark(image);
    expect(result.found).toBe(true);
    expect(result.text).toBe("张三律师");
  });

  test("survives erasing a third of the image blocks", () => {
    const image = syntheticImage(320, 256);
    embedInvisibleMark(image, "合同原件");
    const random = mulberry32(42);
    const cols = Math.floor(image.width / 8);
    const rows = Math.floor(image.height / 8);
    for (let by = 0; by < rows; by += 1) {
      for (let bx = 0; bx < cols; bx += 1) {
        if (random() > 1 / 3) continue;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            const offset = ((by * 8 + y) * image.width + bx * 8 + x) * 4;
            image.data[offset] = 128;
            image.data[offset + 1] = 128;
            image.data[offset + 2] = 128;
          }
        }
      }
    }
    const result = extractInvisibleMark(image);
    expect(result.found).toBe(true);
    expect(result.text).toBe("合同原件");
  });

  test("finds nothing in a clean image", () => {
    const result = extractInvisibleMark(syntheticImage(320, 256));
    expect(result.found).toBe(false);
  });

  test("refuses images too small to hold the fingerprint", () => {
    expect(embedInvisibleMark(syntheticImage(16, 16), "仅供资料使用")).toBe(false);
  });

  test("truncates long fingerprints on utf-8 boundaries", () => {
    const long = "这是一条非常非常非常长的水印指纹文字";
    const truncated = fingerprintTextFor(long, "兜底");
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(24);
    expect(fingerprintTextFor("  ", "兜底")).toBe("兜底");
  });
});
