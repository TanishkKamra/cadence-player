// Exclusive (bit-perfect) output: ffmpeg s32le at the source rate -> native/cadence-wasapi.exe, which owns the
// device in WASAPI exclusive mode. Speaks the worklet's message protocol, so renderer/engine.js drives both alike:
// in 'open' 'close' 'stop' 'play' 'queue' 'playing' 'volume' 'config'; out 'pos' 'switch' 'ended' 'format' 'refused' 'fail'.
const MAX_CRASHES = 3;
const gain = v => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0); // NaN/inf -> silence, never > unity
const AHEAD_SEC = 2; // audio handed to the helper ahead of playback; also how late a queued next track can still be swapped

export class Exclusive {
  // spawn(deviceLabel) -> ChildProcess; send(msg) -> renderer; ack(id, bytes) -> decoder flow control
  constructor({ spawn, send, ack }) {
    Object.assign(this, { spawnHelper: spawn, send, ack });
    this.streams = new Map();
    this.device = ''; this.volume = 1; this.crashes = 0; this.retryAt = 0; this.playing = false; this.epoch = 0;
    this.reset();
  }
  reset() {
    this.segs = []; this.written = 0; this.played = 0; this.feeding = null; this.next = null; this.audible = null; this.endedSent = false;
    this.awaitingNext = false; // a queued track was refused: hold 'ended' until the engine queues its replacement
    this.lastPosStream = null; this.lastPosFrames = -Infinity;
  }

  // ---------- from the decoder ----------
  stream(id) {
    let s = this.streams.get(id);
    if (!s) this.streams.set(id, s = { id, rate: 44100, bits: 16, q: [], ended: false });
    return s;
  }
  open(id, rate, bits) { Object.assign(this.stream(id), { rate, bits }); }
  data(id, buf) { const s = this.streams.get(id); if (s) { s.q.push(buf); if (s === this.feeding) this.pump(); } }
  end(id) { const s = this.streams.get(id); if (s) { s.ended = true; this.pump(); } }
  // decoder stopped: drop what wasn't handed over yet (the stream being fed keeps its segment for position mapping)
  forget(id) {
    const s = this.streams.get(id);
    if (!s) return;
    if (s === this.feeding) { s.q = []; s.ended = true; } else this.streams.delete(id);
  }

  // ---------- from the renderer ----------
  msg(m) {
    switch (m.type) {
      case 'config': this.device = m.device || ''; this.crashes = 0; this.retryAt = 0; break;
      case 'volume': this.volume = gain(m.value); this.write('V', this.volume); break;
      case 'playing': this.playing = m.value; this.write(m.value ? 'R' : 'P'); break;
      case 'play': {
        const s = this.streams.get(m.id);
        if (!s) break;
        if (!this.ensureHelper()) break;
        this.write('X', ++this.epoch);
        this.reset();
        for (const id of this.streams.keys()) if (id !== s.id) this.streams.delete(id); // the engine retires the rest
        this.startFeeding(s);
        break;
      }
      case 'queue': this.next = m.id; this.awaitingNext = false; this.pump(); break;
      case 'close': this.cut(m.id); break;
      case 'stop': this.kill(); this.reset(); break; // releases the device for other apps
    }
  }

  // a queued next track was cancelled: if it was already handed to the helper, take it back
  cut(id) {
    if (this.next === id) { this.next = null; return; }
    const i = this.segs.findIndex(g => g.s.id === id);
    if (i <= 0 || this.segs[i].s === this.audible) return; // never cut what is playing
    this.write('K', id); // the helper drops every queued item tagged with it
    // ponytail: up to ~100 ms of it may already sit in the device buffer; later positions drift by that much
    this.dropSegment(id, i);
  }
  dropSegment(id, i) { this.truncate(i); this.streams.delete(id); }
  truncate(i) {
    this.written = this.segs[i].start;
    this.segs.length = i;
    this.feeding = this.segs[i - 1].s;
    this.endedSent = false;
  }
  // the device refused a queued track's format: the helper skips its data and keeps running; the engine re-queues it
  // at another rate. The first segment (nothing played yet) is handled by the engine restarting playback.
  refuse(id, message) {
    const i = this.segs.findIndex(g => g.s.id === id);
    if (i < 0) return; // stale: that stream is gone (replaced by a newer play/seek); must not turn exclusive off
    if (i > 0 && this.played <= this.segs[i].start) { // none of it played yet: only the queued track is affected
      this.dropSegment(id, i);
      if (this.next === id) this.next = null;
      this.awaitingNext = true;
      this.send({ type: 'refused', id, message, queued: true });
    } else this.send({ type: 'refused', id, message, queued: false });
  }

  startFeeding(s) {
    this.feeding = s;
    this.segs.push({ s, start: this.written, len: 0 });
    this.write('F', s.rate, s.bits, s.id);
    this.pump();
  }

  // hand PCM to the helper until it holds AHEAD_SEC; roll into the queued next stream for gapless playback
  pump() {
    while (this.feeding && this.proc) {
      const s = this.feeding, seg = this.segs.at(-1);
      if ((this.written - this.played) / s.rate >= AHEAD_SEC) return;
      if (s.q.length) {
        const buf = s.q.shift(), frames = buf.length / 8;
        this.write('D', buf);
        seg.len += frames; this.written += frames;
        this.ack(s.id, buf.length);
        continue;
      }
      if (!s.ended) return;
      const n = this.next != null && this.streams.get(this.next);
      if (!n) return;
      this.next = null;
      this.startFeeding(n);
    }
  }

  // ---------- helper process ----------
  // a helper that died is respawned on the next play with backoff; after MAX_CRASHES in a row we stop and report
  ensureHelper() {
    if (this.proc) return true;
    if (this.crashes >= MAX_CRASHES || Date.now() < this.retryAt) {
      this.send({ type: 'fail', id: 0, message: 'Exclusive output helper keeps stopping' });
      return false;
    }
    const p = this.proc = this.spawnHelper(this.device);
    let rest = '', err = '';
    p.stdout.on('data', b => {
      const lines = (rest + b).split('\n');
      rest = lines.pop();
      for (const l of lines) this.line(l.trim().split(' '));
    });
    p.stderr?.on('data', b => { err = (err + b).slice(-2000); });
    p.stdin.on('error', () => {});
    p.on('error', e => this.fail(0, e.message));
    p.on('exit', code => { if (this.proc === p) { this.proc = null; this.crashes++; this.retryAt = Date.now() + Math.min(250 * 2 ** this.crashes, 4000); this.fail(0, err.trim().split('\n').pop() || `helper exited (${code})`); } });
    this.write('V', this.volume);
    this.write(this.playing ? 'R' : 'P');
    return true;
  }
  kill() { const p = this.proc; this.proc = null; p?.kill(); }
  fail(id, message) {
    this.kill();
    this.reset();
    this.send({ type: 'fail', id: +id, message: String(message).replace(/\s+/g, ' ').trim() });
  }

  line([kind, a, ...rest]) {
    const ok = (...n) => n.every(Number.isFinite); // drop malformed helper lines instead of forwarding NaN
    if (kind === 'open') { const [rate, bits, container] = rest.map(Number); if (!ok(+a, rate, bits, container)) return; this.send({ type: 'format', id: +a, rate, bits, container }); return; }
    if (kind === 'refuse') return ok(+a) ? this.refuse(+a, rest.join(' ')) : undefined;
    if (kind === 'fail') return this.fail(a, rest.join(' '));
    if (kind !== 'pos' || +a !== this.epoch) return;
    if (!ok(+rest[0]) || +rest[0] < 0) return;
    this.crashes = 0; // the helper is alive and playing
    this.played = +rest[0];
    this.position();
    this.pump();
  }

  // map the helper's frame count back onto streams: pos / switch / ended
  position() {
    const P = this.played;
    let i = this.segs.length - 1;
    while (i > 0 && this.segs[i].start >= P) i--; // a track is audible once its first frame has played, not at the boundary
    const g = this.segs[i];
    if (!g) return;
    if (this.audible !== g.s) {
      if (this.audible) this.send({ type: 'switch', id: g.s.id, from: this.audible.id });
      this.audible = g.s;
    }
    // the renderer extrapolates between updates; ~4 per second is plenty (switch/ended below still run every line)
    if (this.audible !== this.lastPosStream || Math.abs(P - this.lastPosFrames) >= g.s.rate / 4) {
      this.lastPosStream = this.audible; this.lastPosFrames = P;
      this.send({ type: 'pos', id: g.s.id, frames: Math.min(P - g.start, g.len) });
    }
    const last = i === this.segs.length - 1;
    if (last && g.s.ended && !g.s.q.length && P >= g.start + g.len && !this.endedSent && !this.awaitingNext) {
      this.endedSent = true;
      this.send({ type: 'ended', id: g.s.id });
    }
  }

  write(op, ...v) {
    const p = this.proc;
    if (!p || p.stdin.destroyed) return;
    if (op === 'D') {
      const h = Buffer.alloc(5); h.write('D'); h.writeInt32LE(v[0].length, 1);
      p.stdin.write(h); p.stdin.write(v[0]);
      return;
    }
    const b = Buffer.alloc(1 + 4 * v.length);
    b.write(op);
    v.forEach((x, i) => op === 'V' ? b.writeFloatLE(x, 1) : b.writeInt32LE(x, 1 + 4 * i));
    p.stdin.write(b);
  }
}
