"""Procedural soundtrack + SFX for the ARC promo, synced to timeline.json."""
import json, sys
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 48000
tl = json.load(open(sys.argv[1])); out = sys.argv[2]
M = tl['marks']; BINGO, S5, DUR = M['BINGO'], M['S5'], M['DUR']
N = int((DUR + 0.2) * SR)
music = np.zeros((N, 2)); sfx = np.zeros((N, 2)); verb = np.zeros((N, 2))
rng = np.random.default_rng(3)

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def tt(d): return np.arange(int(d * SR)) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)

def put(bus, t, sig, gain=1.0, pan=0.0, rv=0.0):
    i = int(t * SR)
    if i >= N or len(sig) == 0: return
    sig = sig[: N - i] * gain
    if np.ndim(pan) == 0: pan = np.full(len(sig), pan)
    else: pan = pan[: len(sig)]
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    bus[i:i + len(sig), 0] += sig * l; bus[i:i + len(sig), 1] += sig * r
    if rv:
        verb[i:i + len(sig), 0] += sig * l * rv; verb[i:i + len(sig), 1] += sig * r * rv

def env_adsr(n, a, r):
    e = np.ones(n); ai = max(1, int(a * SR)); ri = max(1, int(r * SR))
    e[:ai] = np.linspace(0, 1, ai)[:n]; e[-ri:] *= np.linspace(1, 0, ri)
    return e

def saw(f, t, det=0.0):
    ph = (f * (1 + det)) * t + rng.random()
    return 2 * (ph % 1) - 1

# ---------------- instruments ----------------
def kick(gain=1.0):
    t = tt(0.45); f = 44 + 120 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t * 7.5) + 0.25 * np.exp(-t * 300) * rng.standard_normal(len(t))
    return s * gain

def hat(d=0.06, g=0.25):
    t = tt(d); return hp(rng.standard_normal(len(t)), 7000) * np.exp(-t * 70) * g

def clap():
    t = tt(0.3); n = bp(rng.standard_normal(len(t)), 900, 3200)
    e = np.zeros(len(t))
    for o in (0, 0.011, 0.022): e += np.exp(-np.clip(t - o, 0, None) * 120) * (t >= o)
    e += 0.6 * np.exp(-t * 18)
    return n * e * 0.5

def bass_note(m, d):
    t = tt(d); f = mtof(m)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * lp(saw(f, t), 600)
    return s * np.exp(-t * 3.2) * env_adsr(len(t), 0.004, 0.05)

def bell(m, d=1.6, idx=3.0, g=1.0):
    t = tt(d); fc = mtof(m); I = idx * np.exp(-t * 4)
    s = np.sin(2 * np.pi * fc * t + I * np.sin(2 * np.pi * fc * 3.5 * t))
    return s * np.exp(-t * 2.6) * env_adsr(len(t), 0.002, 0.2) * g

def pluck(m, d=0.35, g=1.0):
    t = tt(d); f = mtof(m)
    s = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)
    return s * np.exp(-t * 11) * env_adsr(len(t), 0.002, 0.05) * g

def pad(notes, d, cutoff=1800):
    t = tt(d); s = np.zeros(len(t))
    for m in notes:
        f = mtof(m)
        for det in (-0.004, 0.0, 0.005): s += saw(f, t, det)
    s = lp(s / (3 * len(notes)), cutoff, 2)
    return s * env_adsr(len(t), min(0.8, d / 3), min(1.2, d / 2))

def noise_sweep(d, f0, f1, g=0.4):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros(len(t)); blk = 512
    for s in range(0, len(t), blk):
        x = s / len(t); fc = f0 * (f1 / f0) ** x
        seg = n[max(0, s - 2048): s + blk]
        y = bp(seg, max(60, fc * 0.7), min(SR / 2 - 100, fc * 1.4))
        out[s:s + blk] = y[-len(out[s:s + blk]):]
    e = np.sin(np.pi * np.linspace(0, 1, len(t))) ** 1.5
    return out * e * g

def tone_sweep(d, f0, f1, g=0.3):
    t = tt(d); f = f0 * (f1 / f0) ** (t / d)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) + 0.25 * np.sin(2 * ph)
    return s * np.sin(np.pi * np.linspace(0, 1, len(t))) ** 2 * g

# ---------------- music bed ----------------
BEAT = 0.5; T0 = 5.25  # logo hit = downbeat
CH = [  # (pad notes, bass root)
    ([60, 64, 67, 71, 74], 36),   # Cmaj9
    ([57, 60, 64, 67, 71], 33),   # Am9
    ([53, 57, 60, 64, 67], 29),   # Fmaj9
    ([55, 59, 62, 64, 69], 31),   # G6/9
]
# intro pad
put(music, 0.0, pad([60, 64, 67, 71], T0 + 0.4, 900), 0.35, 0, 0.3)
# chords every 2 bars from T0 until the end card
t = T0; ci = 0
while t < S5 + 0.4:
    d = min(4.0, S5 + 0.4 - t)
    put(music, t, pad(CH[ci % 4][0], d + 0.6, 2200 if t > BINGO else 1500), 0.32, 0, 0.25)
    ci += 1; t += 4.0
def chord_at(x): return CH[int(max(0, x - T0) // 4.0) % 4]
# drums + bass
nb = int((S5 + 0.3 - T0) / (BEAT / 4))
for i in range(nb):
    x = T0 + i * BEAT / 4  # 16th grid
    if BINGO - 0.26 < x < BINGO: continue        # tiny drop before the bingo
    q = i % 4 == 0; e8 = i % 2 == 0; beat = i // 4
    loop = x >= 9.3; post = x >= BINGO
    dense = loop and x > 9.3 + (BINGO - 9.3) * 0.55
    if q and (loop or beat % 2 == 0): put(music, x, kick(0.9 if loop else 0.6), 1.0)
    if post and q and beat % 2 == 1: put(music, x, clap(), 0.7, 0.05, 0.3)
    if loop and (e8 or dense): put(music, x, hat(0.05, 0.16 if e8 else 0.09), 1.0, 0.25 if e8 else -0.25)
    if not loop and x > T0 and e8 and not q: put(music, x, hat(0.04, 0.07), 1, 0.2)
    if e8 and x >= T0:
        root = chord_at(x)[1]
        put(music, x, bass_note(root + (12 if (i // 2) % 4 == 3 and loop else 0), BEAT / 2 + 0.05), 0.42 if loop else 0.3)
# riser into bingo
rd = 2.6
put(music, BINGO - rd, noise_sweep(rd, 300, 9000, 0.4) * np.linspace(0.2, 1.4, int(rd * SR)) ** 2, 1, 0, 0.3)
put(music, BINGO - rd, tone_sweep(rd, 220, 880, 0.05), 1, 0)

# ---------------- sfx ----------------
PENTA = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96, 98, 100, 103, 105, 108]
for e in tl['sfx']:
    ty, t0 = e['type'], e['t']
    if ty == 'key':
        k = hp(rng.standard_normal(int(0.012 * SR)), 2500) * np.exp(-tt(0.012) * 400)
        put(sfx, t0, k, 0.10 + 0.04 * rng.random(), -0.45)
    elif ty == 'send':
        put(sfx, t0, tone_sweep(0.12, 500, 1100, 0.35), 1, -0.45, 0.2)
    elif ty == 'msg':
        put(sfx, t0, pluck(84, 0.3, 0.18), 1, -0.45, 0.3)
    elif ty == 'whoosh':
        d = e.get('d', 0.8)
        put(sfx, t0, noise_sweep(d, 250, 4000, 0.5), 1, np.linspace(-0.6, 0.0, int(d * SR)), 0.3)
    elif ty == 'shimmer':
        put(sfx, t0, tone_sweep(0.9, 600, 2400, 0.08), 1, 0, 0.5)
        for j, m in enumerate([84, 88, 91, 96]): put(sfx, t0 + 0.12 * j, bell(m, 0.9, 1.5, 0.08), 1, -0.3 + 0.2 * j, 0.5)
    elif ty == 'logo':
        put(sfx, t0, kick(1.0), 0.45)
        for m in (48, 60, 64, 67, 71): put(sfx, t0, bell(m + 12, 2.2, 2.0, 0.12), 1, 0, 0.6)
        put(sfx, t0, bass_note(36, 1.2), 0.6)
    elif ty == 'pop':
        n = e['n']; put(sfx, t0, pluck([72, 76, 79, 84, 74, 77, 81, 86][n], 0.25, 0.14), 1, -0.4 if n < 4 else 0.4, 0.3)
    elif ty == 'zip':
        d, k, out_ = e['d'], e['k'], e['dir'] == 'O'
        lift = 2 ** (min(k, 7) * 2 / 12)
        f0, f1 = (420 * lift, 1050 * lift) if out_ else (1050 * lift, 420 * lift)
        panr = np.linspace(-0.7, 0.7, int(d * SR)) if out_ else np.linspace(0.7, -0.7, int(d * SR))
        put(sfx, t0, tone_sweep(d, f0, f1, 0.11), 1, panr, 0.25)
        put(sfx, t0, noise_sweep(d, 600 * lift, 5000, 0.16 + 0.02 * min(k, 6)), 1, panr, 0.2)
    elif ty == 'arrive':
        k = e['k']; idx = min(len(PENTA) - 1, 2 * min(k, 7) + (1 if e['dir'] == 'B' else 0))
        put(sfx, t0, pluck(PENTA[idx] - 12, 0.4, 0.22), 1, 0.6 if e['dir'] == 'O' else -0.6, 0.35)
    elif ty == 'bingo':
        crash = hp(rng.standard_normal(int(2.2 * SR)), 3000) * np.exp(-tt(2.2) * 2.2) * 0.32
        put(sfx, t0, crash, 1, 0, 0.4)
        put(sfx, t0, kick(1.3), 1)
        put(sfx, t0, bass_note(24, 1.6), 1.1)
        put(sfx, t0, bass_note(36, 1.2), 0.6)
        for m in (48, 55, 60, 64, 67, 72, 74):
            put(sfx, t0, pad([m + 12], 0.9, 3500) * 2.2, 0.16, 0, 0.4)
        for j, m in enumerate([84, 88, 91, 96, 100, 103]):
            put(sfx, t0 + 0.055 * j, bell(m, 1.8, 2.2, 0.27), 1, -0.5 + 0.2 * j, 0.6)
        sp = hp(rng.standard_normal(int(1.4 * SR)), 9000) * (rng.random(int(1.4 * SR)) > 0.9985) * np.exp(-tt(1.4) * 2) * 2.5
        put(sfx, t0 + 0.05, sp, 0.5, 0, 0.6)
    elif ty == 'tick':
        put(sfx, t0, pluck(PENTA[e['n'] % 10], 0.18, 0.07), 1, -0.5 + e['n'] * 0.1, 0.3)
    elif ty == 'end':
        put(sfx, t0, kick(1.0), 0.8)
        put(sfx, t0, bass_note(36, 2.5), 0.7)
        put(sfx, t0, pad([48, 55, 60, 64, 67, 71, 74], 4.0, 1600), 0.5, 0, 0.6)
        for j, m in enumerate([72, 76, 79, 84]): put(sfx, t0 + 0.09 * j, bell(m, 2.5, 2.0, 0.12), 1, -0.3 + 0.2 * j, 0.7)

# ---------------- reverb + master ----------------
ir_t = tt(1.8); ir = rng.standard_normal(len(ir_t)) * np.exp(-ir_t / 0.42); ir = lp(ir, 5000); ir /= np.sqrt((ir ** 2).sum())
wet = np.stack([fftconvolve(verb[:, c], ir)[:N] for c in range(2)], 1)
mix = music * 0.85 + sfx * 1.0 + wet * 0.55
# fades
fi = int(0.05 * SR); mix[:fi] *= np.linspace(0, 1, fi)[:, None]
fo0 = int((DUR - 1.6) * SR); mix[fo0:] *= np.linspace(1, 0, N - fo0)[:, None] ** 1.5
mix = hp(mix.T, 30).T
peak = np.abs(mix).max(); mix = np.tanh(mix / peak * 1.3) / np.tanh(1.3) * 0.89
wavfile.write(out, SR, (mix * 32767).astype(np.int16))
print('wrote', out, f'{N / SR:.2f}s')
