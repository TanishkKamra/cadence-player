# Cadence

A desktop music player for Windows, written from scratch in Electron, JavaScript and C#.

**Playback engine**: ffmpeg decodes every common format (FLAC up to 32-bit/384 kHz, ALAC, MP3, AAC, Opus, Vorbis, WAV/AIFF, APE, WavPack, DSD, WMA) to 32-bit float, resampled with the SoX resampler (libsoxr). Audio plays through an AudioWorklet engine and a Web Audio DSP chain, or through a native C# helper that owns the device in **WASAPI exclusive mode** for bit-perfect output and runs the same DSP chain in 64-bit.
- Sample-accurate gapless playback and crossfade (no fading / different albums only / all / shuffled only).
- Fade on play/pause and seek, optional silence between tracks.
- ReplayGain (track or album, with preamps and peak-based clip prevention), tempo (0.5–2×) and pitch (±12 semitones).
- Output device and sample-rate selection, internet radio (HTTP/HLS, `.m3u`/`.pls`) with ICY titles, CUE sheets.

**Equalizer screen** (three tabs):
- Equalizer
  - Graphic EQ with 5–31 bands, or parametric EQ (drag points on the curve, scroll to change Q, double-click to add a band).
  - Live spectrum behind the response curve, presets, your own saved presets, and presets bound to an output device.
  - 8,850 AutoEq headphone profiles.
- Tone & Volume: bass and treble with their frequencies, balance, stereo expand, mono, tempo, pitch, volume.
- Reverb: Size, Damp, Filter, Fade, Pre-Delay, Pre-Delay Mix, Mix, with nine presets.
- Limiter, and an Audio Info panel showing the full signal chain (Ctrl+I).

**Library**
- Library categories: All Songs, Folders, Folders Hierarchy, Albums, Artists (with artist photos), Album Artists, Genres, Years, Composers, Playlists (plus `.m3u`/`.pls` files found in your music folders), and Streams.
- Smart lists: Queue, Bookmarks, Most Played, Top Rated, Low Rated, Recently Played, Recently Added, Long.
- Watched folders with automatic incremental rescans.
- Global search, a filter for each list, A–Z jump, grid or list view for each category, and categories you can hide.
- Queue: "Play next" and "Add to queue" play first, then the list continues.
- Shuffle modes (songs / categories / both, with a "less random" option), repeat list or song.
- Ratings as thumbs or 5 stars, with play counts and "count as played after X %".
- Long tracks remember their position.
- Tag editor that rewrites tags without re-encoding (the decoded audio is verified identical before the original is replaced).
- Album art: choose a file, or download from iTunes, automatically or on demand.
- Delete to the Recycle Bin.

**Lyrics**
- Sources: `.lrc` sidecar, embedded tags, then LRCLIB online.
- Synced scrolling with karaoke word fill (enhanced LRC) and duet voices.
- Click a line to seek, offset and size controls, and web search for anything missing.

**Player and look**
- Layout: tinted, blurred album-art backdrop, accent colour taken from the cover, pill-shaped controls, 5-button transport (<<< and >>> jump albums, or seek ±10 s on long tracks), and a waveform seek bar.
- Immersive Now Playing view (click the cover, or press `P`).
- Milkdrop visualizer (butterchurn) on the cover or full screen, with a preset browser where you can like or hide presets. Spectrum bars are also available.
- Mini player (Ctrl+M), always on top.
- Sleep timer that fades out, or stops after the current song.
- Dark, Black (OLED), Light or system theme, with animation speed settings.

**Windows integration**
- Media keys and the Windows media overlay.
- Taskbar progress bar and thumbnail buttons.
- Track-change notifications.
- Pause when headphones disconnect, resume when they reconnect.
- Single instance, and open files or folders by dropping them on the window.
- ListenBrainz scrobbling.
- Backup and restore of all settings and data.

## Tech

| Part | What |
|---|---|
| `main.mjs` | Electron main process: ffmpeg decoder with flow control, library scanner, CUE, tags, art, lyrics, AutoEq |
| `exclusive.mjs`, `native/wasapi.cs`, `native/dsp.cs` | WASAPI exclusive-mode output helper and its 64-bit DSP chain |
| `renderer/engine.js`, `renderer/worklet.js` | Web Audio engine and AudioWorklet player |
| `renderer/` | UI: library views, player, EQ, lyrics, settings |
| `test/` | EQ, limiter, queue, lyrics, exclusive-mode and path-safety tests |

## Run it

Needs Windows 10/11 and Node.js 22+.

```
npm install          # also downloads ffmpeg
npm start            # run from source
npm test             # unit tests + native DSP self-test
npm run dist         # build release\Cadence-win32-x64\Cadence.exe
```

User data (library cache, covers, settings, playlists, stats) lives in `%APPDATA%\Cadence`.

## Known limits

- Phone-only features (Chromecast/DLNA, Android Auto, lock screen, widgets) have no desktop version; the mini player stands in for widgets.
- Last.fm scrobbling isn't supported (ListenBrainz is).

## License

MIT, see [LICENSE](LICENSE). ffmpeg is downloaded at install time and keeps its own license. Geist fonts are SIL OFL; Phosphor icons are MIT.
