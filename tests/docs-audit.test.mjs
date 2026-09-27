import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFiles, headingIds } from "../scripts/verify-docs.mjs";

test("Chinese headings and repeated headings have stable link IDs", () => {
  assert.deepEqual([...headingIds("# 本地运行\n## API + WebRTC\n## 本地运行")], ["本地运行", "api--webrtc", "本地运行-1"]);
});

test("local links, images and Chinese heading fragments are checked", () => {
  assert.deepEqual(auditFiles(new Map([
    ["README.md", "[运行](docs/run.md#本地运行) ![图](docs/view.png) [官方](https://example.com/)"],
    ["docs/run.md", "# 本地运行"], ["docs/view.png", ""],
  ])), []);
});

test("missing files, missing fragments and outside paths fail", () => {
  const result = auditFiles(new Map([["README.md", "[a](missing.md) [b](#不存在) [c](../private.md)"]]));
  assert.equal(result.length, 3);
});

test("link-like examples in fenced code do not create false positives", () => {
  assert.deepEqual(auditFiles(new Map([["README.md", "# 示例\n```md\n[不检查](missing.md)\n```"]])), []);
});

test("private files fail while configuration examples are allowed", () => {
  assert.equal(auditFiles(new Map([["apps/web/.env.local", ""], ["docs/.private/log.md", ""]])).length, 2);
  assert.deepEqual(auditFiles(new Map([["apps/web/.env.example", ""], ["apps/edge/.dev.vars.example", ""]])), []);
});

test("native diagrams need unique IDs and a PNG counterpart", () => {
  const file = "docs/diagrams/test.excalidraw";
  const valid = JSON.stringify({ type: "excalidraw", files: {}, elements: [{ id: "a", type: "text" }] });
  assert.deepEqual(auditFiles(new Map([[file, valid], ["docs/diagrams/test.png", ""]])), []);
  assert.equal(auditFiles(new Map([[file, valid]])).length, 1);
  const invalid = JSON.stringify({ type: "excalidraw", elements: [{ id: "a", type: "cameraUpdate" }] });
  assert.equal(auditFiles(new Map([[file, invalid], ["docs/diagrams/test.png", ""]])).length, 1);
});
