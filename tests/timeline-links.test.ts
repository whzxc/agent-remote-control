import test from "node:test";
import assert from "node:assert/strict";
import { timelineLink, timelineUrl } from "../ui/state/timelineLinks.ts";

test("message file references resolve without navigating to the UI origin", () => {
  // Recurring bug class: local Markdown images and source links were treated as UI routes.
  for (const [source, target] of [
    ["/tmp/example%20image.png", "/tmp/example image.png"],
    ["src/main.rs:24:3", "src/main.rs"],
    ["../notes.md#details", "../notes.md"],
    ["file:///tmp/report%23one.md#L12", "/tmp/report#one.md"],
    ["file:///C:/Workspace/main.ts", "C:/Workspace/main.ts"],
    ["C:\\Workspace\\main.ts:12", "C:\\Workspace\\main.ts"],
  ]) assert.deepEqual(timelineLink(source), { kind: "file", target });
});

test("supported external protocols and fragments retain their destinations", () => {
  // Algorithmic core: supported message destinations are not rewritten as local paths.
  for (const target of ["https://example.com/a?q=1#b", "http://localhost:1234/", "mailto:user@example.com", "codex://threads/example", "vscode://file/example", "agent-remote-control://example"]) {
    assert.deepEqual(timelineLink(target), { kind: "external", target });
    assert.equal(timelineUrl(target), target);
  }
  assert.deepEqual(timelineLink("#a-heading"), { kind: "fragment", target: "a-heading" });
  assert.deepEqual(timelineLink("//example.com/image.png"), { kind: "external", target: "https://example.com/image.png" });
});

test("executable URLs and unsupported resource protocols are not activated", () => {
  // Algorithmic core: message URL mapping rejects executable and unsupported schemes.
  for (const value of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:foo", "data:text/html,hello", "data:image/svg+xml,<svg/>", "sandbox:/mnt/data/image.png", "file://another-host/path", "java\tscript:alert(1)"]) {
    assert.equal(timelineLink(value), undefined);
    assert.equal(timelineUrl(value), "");
  }
  assert.equal(timelineLink("data:image/png;base64,AA==")?.kind, "image");
});
