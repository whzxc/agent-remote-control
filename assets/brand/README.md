# Agent Remote Control（ARC） 品牌素材

ARC — Agent Remote Control。

两套标识，文件夹结构和文件名完全一致，切换时整个文件夹替换即可：

- `primary/`：定稿。等粗圆头弧线。
- `alternate/`：备选。渐粗弧线，结构保持不变。

两套均为上弧、左点橙色，下弧、右点蓝紫渐变；渐变使用标识坐标 x=18 至 92。菜单栏模板保持原样。

## 目录

| 路径 | 用途 |
|---|---|
| `svg/mark.svg`、`mark-dark.svg` | 标识源文件，浅色底 / 深色底 |
| `svg/mark-mono.svg` | 单色标识，用于印章、单色印刷 |
| `svg/mark-template.svg` | 菜单栏模板图标源文件，黑色加透明度 |
| `svg/app-icon.svg`、`app-icon-dark.svg` | 应用图标源文件，1024 画布 |
| `svg/lockup.svg`、`lockup-dark.svg` | 标识 + ARC + AGENT REMOTE CONTROL 横排组合，文字已转曲，无需安装字体 |
| `png/app-icon-{16…1024}.png` | 应用图标各尺寸 |
| `png/menubar-{16,18,22}Template(@2x).png` | macOS 菜单栏模板图标，系统会自动适配明暗 |
| `png/mark-{256,512,1024}.png`、`lockup-1200.png` | 透明底位图 |
| `icons/AppIcon.icns`、`app.ico` | macOS / Windows 应用图标 |
| `icons/favicon.svg`、`favicon.ico`、`apple-touch-icon.png` | 网站图标，SVG 版会跟随系统深色模式 |
| `social/x-avatar-400.png`、`og-card-1200x630.png` | X 头像、链接分享卡片 |

应用图标中的标识实际可见宽度占底板宽度的 80%，不把 SVG 自身的留白算入标识宽度。静态图标按 824 宽的底板计算，Icon Composer 按 1024 宽的原生底板计算，均居中放置。

Tauri 项目可以直接用 `png/app-icon-1024.png` 运行 `npx tauri icon` 生成全套平台图标。

## 颜色

| 名称 | 色值 | 用途 |
|---|---|---|
| 来源橙 | `#D97757` / `#E8865E` | 浅色 / 深色来源侧 |
| Agent 渐变 | `#9C8CFF → #3F63FF` / `#B7AAFF → #5C7CFF` | 浅色 / 深色 Agent 侧 |
| Agent 纯色 | `#5B5FF5` / `#7A7DFF` | 32px 及以下栅格、网站 SVG 图标与不适合渐变的场景 |
| 中性墨 | `#1D1D1F` / `#F5F5F7` | 字标及非 ARC 主题来源侧 |
| 图标底色 | `#F4F2EE` / `#1A1A1F` | 浅色 / 深色应用图标 |

ARC 为默认主题；其他主题使用中性墨与所选强调色，不使用渐变。小尺寸 PNG、ICO、ICNS 表示使用纯色，大尺寸应用图标使用渐变。

## 字体

- 字标：Geist Bold，字距 0.04em
- 副标题：Geist Mono Regular，全大写，字距 0.1em

## 重新生成与接入

在临时 venv 中安装 `cairosvg pillow fonttools`，用 `npm pack geist` 解包字体后运行 `python3 assets/brand/brand.py assets/brand <geist包>/dist/fonts`。

在仓库根目录运行 `npm run brand -- primary` 生成全部平台图标、Icon Composer 源文件、托盘与 UI 素材；将参数改为 `alternate` 即切换套装。构建 macOS 应用时，现有构建流程使用 Xcode 编译 Icon Composer 产物。
