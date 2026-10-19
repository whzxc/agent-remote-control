"""Render the ARC promo: frames from promo.html -> silent MP4, timeline -> synth.py soundtrack -> final MP4 + README GIF.

Usage (from the repository root):
  python3 assets/promo/render.py            # writes docs/media/arc-promo.mp4 and docs/media/arc-loop.gif
  python3 assets/promo/render.py --still 19.4  # one PNG frame at t=19.4s into assets/promo/out/
"""
import argparse, json, pathlib, subprocess, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / 'out'
FPS = 30


def page_ctx(p):
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1920, 'height': 1080})
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto((HERE / 'promo.html').as_uri())
    pg.evaluate('document.fonts.ready')
    pg.wait_for_timeout(400)
    return b, pg, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--still', type=float)
    a = ap.parse_args()
    if not (HERE / 'fonts' / 'Geist-Regular.woff2').exists():
        sys.exit('Missing fonts: see assets/promo/README.md (npm pack geist).')
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        b, pg, errors = page_ctx(p)
        st = pg.locator('#stage')
        if a.still is not None:
            pg.evaluate(f'render({a.still})')
            st.screenshot(path=str(OUT / f'still-{a.still:05.2f}.png'))
            print(OUT / f'still-{a.still:05.2f}.png', errors or '')
            return
        json.dump({'sfx': pg.evaluate('SFX'), 'marks': pg.evaluate('MARKS')}, open(OUT / 'timeline.json', 'w'))
        n = int(pg.evaluate('DUR') * FPS)
        silent = OUT / 'silent.mp4'
        ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', str(FPS), '-c:v', 'png', '-i', '-',
                               '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', str(silent)], stdin=subprocess.PIPE)
        for i in range(n):
            pg.evaluate(f'render({i / FPS})')
            ff.stdin.write(st.screenshot(type='png'))
            if i % 150 == 0: print(f'frame {i}/{n}', flush=True)
        ff.stdin.close(); ff.wait(); b.close()
        if errors: print('page errors:', errors)
    subprocess.run([sys.executable, str(HERE / 'synth.py'), str(OUT / 'timeline.json'), str(OUT / 'audio.wav')], check=True)
    media = ROOT / 'docs' / 'media'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(silent), '-i', str(OUT / 'audio.wav'),
                    '-af', 'loudnorm=I=-14:TP=-1.0:LRA=11', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
                    '-shortest', '-movflags', '+faststart', str(media / 'arc-promo.mp4')], check=True)
    # README preview: the accelerating Loop and the delivery burst, silent
    bingo = json.load(open(OUT / 'timeline.json'))['marks']['BINGO']
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{bingo - 4.7:.2f}', '-t', '6.6', '-i', str(silent), '-vf',
                    'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];'
                    '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', str(media / 'arc-loop.gif')], check=True)
    print('wrote', media / 'arc-promo.mp4', media / 'arc-loop.gif')


if __name__ == '__main__':
    main()
