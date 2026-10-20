# ARC 宣传视频

成片在 `docs/media/arc-promo.mp4`（30 秒，1080p，带音轨）。中英文 README 顶部使用 GitHub 视频附件，直接显示播放器。`docs/media/arc-loop.gif` 是另外导出的无声短预览。

## 文件

| 文件 | 用途 |
|---|---|
| `promo.html` | 全部画面。`render(t)` 按时间确定性绘制每一帧；文案在 `CAPS`、`BL`/`BR`，Loop 圈数与每圈时长在 `buildLoop(...)` 的参数里 |
| `synth.py` | 程序合成的音乐与音效，读取页面导出的事件时间线（`SFX`、`MARKS`），与画面同步 |
| `render.py` | 逐帧截图 → ffmpeg 编码 → 合成音轨 → 响度标准化到 -14 LUFS → 导出无声短预览 GIF |

## 预览

浏览器打开 `promo.html#play` 实时循环播放；`promo.html#19.4` 定格在 19.4 秒。

## 重新渲染

依赖 python3、playwright（chromium）、numpy、scipy、ffmpeg。字体用 Geist，不入库：

```sh
cd assets/promo
npm pack geist && tar xzf geist-*.tgz && mkdir -p fonts
cp package/dist/fonts/geist-sans/Geist-{Regular,Medium,SemiBold,Bold}.woff2 package/dist/fonts/geist-mono/GeistMono-{Regular,Medium}.woff2 fonts/
rm -rf package geist-*.tgz && cd ../..
python3 assets/promo/render.py            # 覆盖 docs/media 下的视频与 GIF
python3 assets/promo/render.py --still 19.4  # 只出单帧到 assets/promo/out/
```

整片约 3 分钟渲染完。改了 Loop 时间后音效会自动跟随，不需要手动对时间。

更新 README 视频时，在 GitHub 的 Markdown 编辑器中通过附件按钮上传新的 `docs/media/arc-promo.mp4`，将生成的 `https://github.com/user-attachments/assets/...` 地址单独放在一行，并同步替换中英文 README 中的地址。仓库内的 MP4 相对路径仅用于链接，不能替代附件播放器。

## 约定

- 第三方产品用字母圆标，不用官方 logo。
- 演示中的任务、测试数和轮次是示意数据。
- 标识与配色遵循 `assets/brand/README.md`，使用 primary 套装。
