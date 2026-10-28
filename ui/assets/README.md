# Brand icons

- `chatgpt.png`: original `icon-chatgpt.png` bundled with the official OpenAI desktop app.
- `codex.png`: original `icon-codex-light.png` bundled with the official OpenAI desktop app.

These icons identify connected products. OpenAI retains the associated brand and asset rights. They are excluded from this project's MIT license.

## Agent Remote Control (ARC) mark and mascot

Brand sources and both asset sets live in `assets/brand/`. `npm run brand -- primary` regenerates platform icons and UI marks. Use `alternate` to select the other set.

`ui/assets/arc/` contains the current brand assets. macOS uses native light/dark appearances from `desktop/icons/AgentRemoteControl.icon` and `menubar-18Template(@2x).png` menu bar templates. Windows uses the generated ICO and color tray icons.

The homepage center always displays the ARC mark.

## Agent and platform icons

Runtime brand mappings live in [brand-reserve/magpie](brand-reserve/magpie/manifest.json), copied from Magpie's prepared resources. Agent icons are distinct from provider and product icons. Topology roots, account children, management cards, task prose, and quota views share the Agent mapping. See [brand-reserve/README.md](brand-reserve/README.md) for provenance and retained upstream assets.

Legacy collected graphics remain under `agents/` and `brand-reserve/agents/` with their original license notices. Brand trademarks remain with their owners.
