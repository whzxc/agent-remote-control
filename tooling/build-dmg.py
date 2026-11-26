# /// script
# requires-python = ">=3.10"
# dependencies = ["dmgbuild>=1.6.7,<2"]
# ///
"""Package the ARC app with a Finder-independent drag-to-install layout."""
import sys
from pathlib import Path

import dmgbuild

if len(sys.argv) != 3:
    raise SystemExit("Usage: build-dmg.py <app-bundle> <output.dmg>")
application, output = map(Path, sys.argv[1:])
if not (application / "Contents" / "Info.plist").is_file():
    raise SystemExit(f"Build the MyGo app first: {application}")
root = Path(__file__).resolve().parent.parent
output.parent.mkdir(parents=True, exist_ok=True)

dmgbuild.build_dmg(str(output), application.stem, settings={
    "format": "UDZO",
    "files": [str(application)],
    "symlinks": {"Applications": "/Applications"},
    "icon": str(root / "desktop/icons/macos/Icon.icns"),
    "background": str(root / "desktop/assets/dmg-background.png"),
    "window_rect": ((200, 160), (720, 480)),
    "icon_locations": {application.name: (205, 210), "Applications": (515, 210)},
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
