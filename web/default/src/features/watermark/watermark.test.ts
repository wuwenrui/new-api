import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { watermarkedFilename } from "./archive";
import { singlePlacement, tilePlacements } from "./geometry";

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
