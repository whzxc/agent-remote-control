# Reserved brand assets

Some assets in this directory appear in the current UI. See `control-sources/index.ts` and the manifest's `controlSourceUsage` for control-source mappings. Keep original file contents. Do not manually recolor monochrome marks.

- `mono.svg` is a monochrome symbol. `color.svg` is the upstream color symbol.
- `wordmark*.svg` contains wordmarks. `app.png` is an existing original app icon.
- `favicon.*` contains website icons, distinct from desktop app logos.
- A missing color variant means it is not collected here. It does not mean the brand has no color design.
- SVG `currentColor` supports theme coloring when inlined. An img reference usually displays it in black.

## Index

Open [preview.html](preview.html) to inspect graphics. [manifest.json](manifest.json) records exact sources, licenses, and SHA-256 values.

| Entry | Collected files |
| --- | --- |
| control-sources/chatgpt | [app.png](control-sources/chatgpt/app.png), [mono.svg](control-sources/chatgpt/mono.svg), [wordmark.svg](control-sources/chatgpt/wordmark.svg) |
| control-sources/google | [mono.svg](control-sources/google/mono.svg) |
| control-sources/anthropic | [mono.svg](control-sources/anthropic/mono.svg) |
| control-sources/microsoft | [mono.svg](control-sources/microsoft/mono.svg) |
| control-sources/github | [mono.svg](control-sources/github/mono.svg) |
| control-sources/xai | [mono.svg](control-sources/xai/mono.svg) |
| control-sources/notion | [mono.svg](control-sources/notion/mono.svg), [wordmark.svg](control-sources/notion/wordmark.svg) |
| agents/codex | [app.png](agents/codex/app.png), [color.svg](agents/codex/color.svg), [mono.svg](agents/codex/mono.svg), [wordmark.svg](agents/codex/wordmark.svg) |
| agents/goose | [mono.svg](agents/goose/mono.svg) |
| agents/codebuddy | [mono.svg](agents/codebuddy/mono.svg) |
| agents/pi | [mono.svg](agents/pi/mono.svg), [wordmark.svg](agents/pi/wordmark.svg) |
| agents/opencode | [mono.svg](agents/opencode/mono.svg), [wordmark.svg](agents/opencode/wordmark.svg) |
| agents/gemini | [color.svg](agents/gemini/color.svg), [mono.svg](agents/gemini/mono.svg), [wordmark.svg](agents/gemini/wordmark.svg) |
| agents/claude | [color.svg](agents/claude/color.svg), [mono.svg](agents/claude/mono.svg), [wordmark.svg](agents/claude/wordmark.svg) |
| agents/cursor | [mono.svg](agents/cursor/mono.svg), [wordmark.svg](agents/cursor/wordmark.svg) |
| agents/grok | [mono.svg](agents/grok/mono.svg), [wordmark.svg](agents/grok/wordmark.svg) |
| agents/copilot | [color.svg](agents/copilot/color.svg), [mono.svg](agents/copilot/mono.svg), [wordmark.svg](agents/copilot/wordmark.svg) |
| agents/kimi | [color.svg](agents/kimi/color.svg), [mono.svg](agents/kimi/mono.svg), [wordmark.svg](agents/kimi/wordmark.svg) |
| agents/qwen | [color.svg](agents/qwen/color.svg), [mono.svg](agents/qwen/mono.svg), [wordmark.svg](agents/qwen/wordmark.svg) |
| agents/kiro | [color.svg](agents/kiro/color.svg), [mono.svg](agents/kiro/mono.svg), [wordmark.svg](agents/kiro/wordmark.svg) |
| agents/devin | [color.svg](agents/devin/color.svg), [mono.svg](agents/devin/mono.svg), [wordmark.svg](agents/devin/wordmark.svg) |
| agents/cline | [mono.svg](agents/cline/mono.svg), [wordmark.svg](agents/cline/wordmark.svg) |
| agents/junie | [color.svg](agents/junie/color.svg), [mono.svg](agents/junie/mono.svg), [wordmark.svg](agents/junie/wordmark.svg) |
| agents/hermes | [favicon.ico](agents/hermes/favicon.ico), [favicon.svg](agents/hermes/favicon.svg), [logo.png](agents/hermes/logo.png), [mono.svg](agents/hermes/mono.svg), [wordmark.svg](agents/hermes/wordmark.svg) |
| agents/dsh | [mono.svg](agents/dsh/mono.svg) |
| control-sources/slack | [color.svg](control-sources/slack/color.svg), [mono.svg](control-sources/slack/mono.svg), [wordmark-color.svg](control-sources/slack/wordmark-color.svg), [wordmark.svg](control-sources/slack/wordmark.svg) |

## Sources and usage boundaries

Most SVGs come from [Lobe Icons](https://github.com/lobehub/lobe-icons), pinned to 1.95.1. Slack SVGs come from [Devicon](https://github.com/devicons/devicon) at the manifest's pinned commit. Corresponding MIT licenses are under licenses/. The graphics' MIT code license does not grant trademark rights.

ChatGPT/Codex PNGs reuse existing official app resources. They belong to OpenAI and are excluded from the project MIT license. The ChatGPT monochrome file is the general OpenAI mark. Codex has a separate symbol. Hermes logos and favicons come from its official repository. Check upstream brand requirements before use.

See Slack's [media kit](https://slack.com/media-kit) and [brand terms](https://slack.com/terms-of-service/slack-brand). Agent Remote Control (ARC) icons come from existing project app resources. Custom control sources have no fixed brand or assigned logo.

This directory does not invent a desktop app logo for each CLI or use wordmarks as color icons.

## Runtime mappings

[magpie/manifest.json](magpie/manifest.json) pins the Magpie revision, original filenames, source URLs, SHA-256 values, and Agent/platform/product mappings. These SVG files are copied unchanged from Magpie's bundled GUI resources. [magpie/index.ts](magpie/index.ts) resolves those mappings for the renderer. Magpie's MIT notice is bundled in [licenses/magpie-LICENSE.txt](../../../../licenses/magpie-LICENSE.txt). Brand trademarks remain with their owners.

Agent artwork distinguishes Codex from OpenAI, Claude Code from Claude, Gemini CLI from Gemini, and GitHub Copilot from Microsoft Copilot. Droid uses Factory's mark; Oh My Pi uses its own mark. Junie retains the existing upstream resource because the pinned Magpie library has no matching icon. Mistral Vibe uses the Mistral mark because that library has no separate Vibe symbol.

Agent management, topology roots and account children, task prose, and quota surfaces share the Agent mapping. Platform navigation uses provider marks; connector instances use product marks. Cursor has its own platform group. GitHub Copilot belongs to Microsoft. OpenCode and Alibaba group the additional OpenCode and Qwen Code MCP products.

ChatGPT, Notion, Slack, and Grok Bot retain the existing resources where the Magpie library does not provide a separate matching product mark. Monochrome SVGs inherit currentColor; color graphics retain the original fills. SVG titles are removed only when rendering decorative artwork so the enclosing control owns its accessible name.
