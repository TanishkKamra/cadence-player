# python tools/brir.py <SADIE II D1.zip> renderer/brir.bin
# Virtual speakers: the SADIE II KU100 (subject D1) room responses for speakers at +-45 degrees (the nearest BRIR positions to a
# stereo pair; BRIRs exist every 45 degrees), from the 96 kHz set (SADIE's 44.1 and 48 kHz sets carry far less sub-bass), stored at
# 44.1, 48 and 96 kHz. SADIE II, University of York, Apache-2.0,
# https://www.york.ac.uk/sadie-project/database.html, DOI 10.3390/app8112029.
# One minimum-phase correction is applied to all four responses, so the interaural level and time differences are kept: it
# flattens the pair's power response (both ears, uncorrelated left and right) in every 1/3-octave band, pink-weighted, so music keeps its tonal
# balance and loudness and only gains the spatial cues. The common onset delay is trimmed.
# Output: int32 sets, then per set int32 rate, int32 length, float32 LL, LR, RL, RR (speaker -> ear), little-endian.
import struct, sys, zipfile
import numpy as np

def wav(data):
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE'
    i, fmt = 12, None
    while i < len(data):
        cid, n = data[i:i + 4], struct.unpack('<I', data[i + 4:i + 8])[0]
        body = data[i + 8:i + 8 + n]
        if cid == b'fmt ': fmt = struct.unpack('<HHIIHH', body[:16])
        if cid == b'data':
            tag, ch, rate, _, align, bits = fmt
            b = bits // 8
            raw = np.frombuffer(body[:len(body) // align * align], np.uint8).reshape(-1, b)
            v = np.zeros(len(raw), np.int64)
            for k in range(b): v |= raw[:, k].astype(np.int64) << (8 * k)
            v = np.where(v >= 1 << (bits - 1), v - (1 << bits), v)
            return rate, (v / float(1 << (bits - 1))).reshape(-1, ch)
        i += 8 + n + (n & 1)
    raise ValueError('no data chunk')

def minphase(mag, n):
    # real cepstrum folding: the minimum-phase spectrum with magnitude `mag` (bins 0..n/2)
    full = np.concatenate([mag, mag[-2:0:-1]])
    c = np.fft.ifft(np.log(np.maximum(full, 1e-9))).real
    w = np.zeros(n); w[0] = 1; w[1:n // 2] = 2; w[n // 2] = 1
    return np.fft.ifft(np.exp(np.fft.fft(c * w))).real

BANDS = 1000 * 2.0 ** (np.arange(-16, 14) / 3) # 1/3-octave centres, 25 Hz .. 20 kHz

def bandsdb(p, f):
    # pink-weighted (1/f) power average per 1/3-octave band, dB
    out = []
    for fc in BANDS:
        m = (f >= fc * 2 ** (-1 / 6)) & (f < fc * 2 ** (1 / 6))
        out.append(10 * np.log10((p[m] / f[m]).sum() / (1 / f[m]).sum()))
    return np.array(out)

def pairpower(ir, n):
    return sum(np.abs(np.fft.rfft(ir[s][e], n)) ** 2 for s in (0, 1) for e in (0, 1)) / 2 # per ear, uncorrelated left and right

def build(rate, ir):
    # ir[s][e]: speaker s (0 left, 1 right) to ear e (0 left, 1 right)
    n = 1 << int(np.ceil(np.log2(rate * 1.2)))
    f = np.fft.rfftfreq(n, 1 / rate); f[0] = f[1] / 2
    lf, top = np.log(f), min(20000 * 2 ** (1 / 6), rate * 0.49) # the top band is corrected whole
    bands = BANDS[BANDS * 2 ** (1 / 6) <= rate / 2]
    c = np.zeros(len(f)) # correction, dB: refined until every band of the corrected pair is flat
    for it in range(8):
        g = 10 ** (np.minimum(c, 12) / 20)
        eq = minphase(g, n)[:n // 4] * np.hanning(n // 2)[n // 4:] # taper the tail
        out = [[np.convolve(ir[s][e], eq) for e in (0, 1)] for s in (0, 1)]
        err = bandsdb(pairpower(out, n), f)[:len(bands)]
        if np.abs(err).max() < 0.05: break
        e = np.interp(lf, np.log(bands), err) # constant beyond the first and last band
        c -= e
        c[f > top] = c[np.searchsorted(f, top)]
    print(rate, 'Hz: bands within %.2f dB after %d passes, worst at %.0f Hz' % (np.abs(err).max(), it + 1, bands[np.abs(err).argmax()]))
    peak = max(np.abs(x).max() for r in out for x in r)
    on = max(0, min(int(np.argmax(np.abs(x) > peak * 1e-3)) for r in out for x in r) - 32)
    end = max(len(x) - int(np.argmax(np.abs(x[::-1]) > peak * 1e-5)) for r in out for x in r) # drop the inaudible tail
    return [[x[on:end] for x in r] for r in out]

def resample(x, r0, r1):
    # band-limited FFT resampling with a short taper below the new Nyquist; an impulse response keeps its gain
    q = r0 // np.gcd(r0, r1)
    L = -(-2 * len(x) // q) * q; L1 = L * r1 // r0
    X = np.fft.rfft(x, L)[:L1 // 2 + 1].copy()
    k = np.arange(len(X)); t = int(len(X) * 0.97)
    X[t:] *= 0.5 + 0.5 * np.cos(np.pi * (k[t:] - t) / (len(X) - t))
    return np.fft.irfft(X, L1)[:int(round(len(x) * r1 / r0))]

z = zipfile.ZipFile(sys.argv[1])
pair = []
for azi in ('45,0', '315,0'):
    r, x = wav(z.read(f'D1/D1_BRIR_WAV/96K_24bit/azi_{azi}_ele_0,0.wav'))
    assert r == 96000 and x.shape[1] == 2
    pair.append([x[:, 0], x[:, 1]])
# SADIE azimuths run counter-clockwise: the speaker louder at the left ear is the left one
if (pair[0][0] ** 2).sum() < (pair[0][1] ** 2).sum(): pair.reverse()
sets = []
for rate in (44100, 48000, 96000):
    ir = build(rate, [[resample(e, 96000, rate) for e in sp] for sp in pair])
    sets.append((rate, ir))
    print(rate, 'Hz:', len(ir[0][0]), 'taps')
with open(sys.argv[2], 'wb') as o:
    o.write(struct.pack('<i', len(sets)))
    for rate, ir in sets:
        n = len(ir[0][0])
        o.write(struct.pack('<ii', rate, n))
        for s in (0, 1):
            for e in (0, 1): o.write(np.asarray(ir[s][e], '<f4').tobytes())
