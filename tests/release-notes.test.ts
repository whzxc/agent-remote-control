import test from "node:test";
import assert from "node:assert/strict";
import { groupedReleaseNotes, localizedReleaseNotes, releaseList, updateRange } from "../ui/state/releaseNotes.ts";

test("update confirmation uses the downloaded version and includes only applicable notes", () => {
  // Regression: an update could show just its own notes while skipping intermediate versions.
  const chineseHeading = "修复", chineseNote = "- 修复面板位置。";
  const target = { version: "0.9.50", notes: `## Fixes\n\n- Correct overview position.\n\n<!-- lang:zh-CN -->\n\n## ${chineseHeading}\n\n${chineseNote}` };
  const releases = [
    { version: "0.9.51", notes: "- A newer release." },
    { version: "0.9.48", notes: "- The installed release." },
    { version: "0.9.49", notes: "## Fixes\n\n- Restore task bubbles." },
  ];
  const range = updateRange(releases, "0.9.48", target);
  assert.deepEqual(range.map(row => row.version), ["0.9.50", "0.9.49"]);
  assert.deepEqual(groupedReleaseNotes(range, "zh-CN"), [{ title: chineseHeading, entries: [
    { version: "0.9.50", markdown: chineseNote },
    { version: "0.9.49", markdown: "- Restore task bubbles." },
  ] }]);
  assert.deepEqual(updateRange([], "0.9.48", target), [target]);
  assert.deepEqual(releaseList([...releases, target], "0.9.50").map(row => row.version), ["0.9.50", "0.9.49", "0.9.48"]);
});

test("the archived MCP Events notice appears in its original release", () => {
  // Regression: historical release bodies repeated the MCP Events notice after the migration.
  const notes = "- An update.\n\n## MCP Events / 事件升级\n\n- One-time instructions.\n\n## Fixes\n\n- A later section.";
  assert.equal(localizedReleaseNotes({ version: "0.9.50", notes }, "en"),
    "- An update.\n\n## Fixes\n\n- A later section.");
  assert.equal(localizedReleaseNotes({ version: "0.9.19", notes }, "en"), notes);
});
