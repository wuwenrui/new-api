import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
      assert.deepEqual(
        singlePlacement(1200, 800, 240, 80, position as keyof typeof expected, 32),
        placement,
      );
    }
  });

  test("clamps negative margins and gaps while always terminating", () => {
    assert.deepEqual(singlePlacement(500, 300, 100, 40, "top-left", -20), {
      x: 0,
      y: 0,
    });
    const points = tilePlacements(100, 80, 30, 20, -100, -100);
    assert.ok(points.length > 0);
    assert.ok(points.length < 500);
  });

  test("tiles beyond all canvas edges in row-major order", () => {
    const points = tilePlacements(1000, 700, 180, 60, 80, 60);
    assert.ok(Math.min(...points.map((point) => point.x)) < 0);
    assert.ok(Math.max(...points.map((point) => point.x)) > 1000);
    assert.ok(Math.min(...points.map((point) => point.y)) < 0);
    assert.ok(Math.max(...points.map((point) => point.y)) > 700);
    assert.equal(points[1]?.y, points[0]?.y);
  });
});

describe("watermark archive names", () => {
  test("keeps extensions and resolves case-insensitive duplicates", () => {
    const used = new Set<string>();
    assert.equal(watermarkedFilename("evidence.PNG", used), "evidence-watermarked.PNG");
    assert.equal(watermarkedFilename("Evidence.png", used), "Evidence-watermarked-2.png");
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
    assert.ok(textToBits("仅供资料使用").length > 0);
    assert.deepEqual(textToBits("   "), []);
  });

  test("roundtrips a chinese fingerprint through embed and extract", () => {
    const image = syntheticImage(320, 256);
    assert.equal(embedInvisibleMark(image, "仅供资料使用"), true);
    const result = extractInvisibleMark(image);
    assert.equal(result.found, true);
    assert.equal(result.text, "仅供资料使用");
    assert.ok(result.confidence > 0.5);
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
    assert.equal(result.found, true);
    assert.equal(result.text, "张三律师");
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
    assert.equal(result.found, true);
    assert.equal(result.text, "合同原件");
  });

  test("finds nothing in a clean image", () => {
    const result = extractInvisibleMark(syntheticImage(320, 256));
    assert.equal(result.found, false);
  });

  test("refuses images too small to hold the fingerprint", () => {
    assert.equal(embedInvisibleMark(syntheticImage(16, 16), "仅供资料使用"), false);
  });

  test("truncates long fingerprints on utf-8 boundaries", () => {
    const long = "这是一条非常非常非常长的水印指纹文字";
    const truncated = fingerprintTextFor(long, "兜底");
    assert.ok(new TextEncoder().encode(truncated).length <= 24);
    assert.equal(fingerprintTextFor("  ", "兜底"), "兜底");
  });
});
