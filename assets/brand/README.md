# Agent Remote Control (ARC) brand assets

ARC — Agent Remote Control.

The two mark sets have identical directory structures and filenames. Replace the entire directory to switch sets:

- `primary/`: final design with uniform, round-ended arcs.
- `alternate/`: alternative with tapered arcs and the same structure.

Both sets use orange for the upper arc and left dot. The lower arc and right dot use a blue-violet gradient spanning mark coordinates x=18 to 92. Menu bar templates remain unchanged.

## Directory

| Path | Purpose |
| --- | --- |
| `svg/mark.svg`, `mark-dark.svg` | Mark sources for light/dark backgrounds |
| `svg/mark-mono.svg` | Monochrome mark for stamps and single-color printing |
| `svg/mark-template.svg` | Menu bar template source using black and transparency |
| `svg/app-icon.svg`, `app-icon-dark.svg` | App icon sources on a 1024 canvas |
| `svg/lockup.svg`, `lockup-dark.svg` | Horizontal mark + ARC + AGENT REMOTE CONTROL. Text is outlined, so no font installation is needed. |
| `png/app-icon-{16…1024}.png` | App icons at multiple sizes |
| `png/menubar-{16,18,22}Template(@2x).png` | macOS menu bar templates with automatic system light/dark adaptation |
| `png/mark-{256,512,1024}.png`, `lockup-1200.png` | Transparent bitmaps |
| `icons/AppIcon.icns`, `app.ico` | macOS/Windows app icons |
| `icons/favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | Website icons. The SVG follows system dark mode. |
| `social/x-avatar-400.png`, `og-card-1200x630.png` | X avatar and link-sharing card |

The mark's visible width is 80% of the icon background width, excluding SVG padding. Static icons use an 824-wide background. Icon Composer uses the native 1024-wide background. Both center the mark.

Run `npm run brand -- primary` from the repository root to generate the app icons and branding assets.

## Colors

| Name | Values | Purpose |
| --- | --- | --- |
| Source orange | `#D97757` / `#E8865E` | Light/dark control-source side |
| Agent gradient | `#9C8CFF → #3F63FF` / `#B7AAFF → #5C7CFF` | Light/dark Agent side |
| Agent solid | `#5B5FF5` / `#7A7DFF` | Raster sizes at or below 32px, website SVGs, and uses unsuitable for gradients |
| Neutral ink | `#1D1D1F` / `#F5F5F7` | Wordmarks and the source side in non-ARC themes |
| Icon background | `#F4F2EE` / `#1A1A1F` | Light/dark app icons |

ARC is the default theme. Other themes use neutral ink and the selected accent without gradients. Small PNG, ICO, and ICNS representations use solid colors. Large app icons use gradients.

## Typography

- Wordmark: Geist Bold, 0.04em letter spacing.
- Subtitle: Geist Mono Regular, uppercase, 0.1em letter spacing.

## Regeneration and integration

Install `cairosvg pillow fonttools` in a temporary venv. Extract fonts with `npm pack geist`. Run `python3 assets/brand/brand.py assets/brand <geist-package>/dist/fonts`.

From the repository root, `npm run brand -- primary` generates platform icons, Icon Composer sources, tray assets, and UI assets. Use `alternate` to switch sets. The macOS build uses Xcode to compile the Icon Composer assets.
