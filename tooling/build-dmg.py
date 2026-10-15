# /// script
# requires-python = ">=3.10"
# dependencies = ["dmgbuild==1.6.7"]
# ///
"""Package the Tauri app with a Finder-independent drag-to-install layout."""
import json
import plistlib
import sys
from pathlib import Path

import dmgbuild

root = Path(__file__).resolve().parent.parent
desktop = root / "desktop"
config = json.loads((desktop / "tauri.conf.json").read_text())
layout = config["bundle"]["macOS"]["dmg"]
profile = sys.argv[1] if len(sys.argv) > 1 else "release"
if profile not in {"debug", "release"}:
    raise SystemExit("Expected debug or release")
bundle = root / "target" / "aarch64-apple-darwin" / profile / "bundle"
name = config["productName"]
application = bundle / "macos" / f"{name}.app"
if not (application / "Contents" / "Info.plist").is_file():
    raise SystemExit(f"Build the Tauri app first: {application}")
version = plistlib.loads((application / "Contents" / "Info.plist").read_bytes())["CFBundleShortVersionString"]
output = bundle / "dmg" / f"{name}_{version}_aarch64.dmg"
output.parent.mkdir(parents=True, exist_ok=True)

dmgbuild.build_dmg(str(output), name, settings={
    "format": "UDZO",
    "files": [str(application)],
    "symlinks": {"Applications": "/Applications"},
    "icon": str(desktop / "icons" / "macos" / "Icon.icns"),
    "background": str(desktop / layout["background"]),
    "window_rect": ((200, 160), (layout["windowSize"]["width"], layout["windowSize"]["height"])),
    "icon_locations": {
        application.name: (layout["appPosition"]["x"], layout["appPosition"]["y"]),
        "Applications": (layout["applicationFolderPosition"]["x"], layout["applicationFolderPosition"]["y"]),
    },
    "icon_size": 112,
    "text_size": 14,
    "arrange_by": None,
    "show_status_bar": False,
    "show_tab_view": False,
    "show_toolbar": False,
    "show_pathbar": False,
    "show_sidebar": False,
})
print(f"DMG: {output}")
