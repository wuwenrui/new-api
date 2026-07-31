import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readSkillFileAsBase64, skillDownloadFilename } from "./api";

describe("skill market client helpers", () => {
  test("encodes the exact zip bytes as base64", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 254, 255])], "skill.zip", {
      type: "application/zip",
    });

    assert.equal(await readSkillFileAsBase64(file), "AAEC/v8=");
  });

  test("builds a stable download filename from the current version", () => {
    assert.equal(
      skillDownloadFilename({ name: "case-review", latest_version: 3 }),
      "case-review-v3.zip",
    );
  });
});
