# Cadence

A Windows music player modelled on feature set and look, written from scratch (no code or assets).

Run it from the **Cadence** shortcut on the Desktop / Start Menu, or `release\Cadence-win32-x64\Cadence.exe`.

## What's in it

**Playback engine**: ffmpeg decodes every format (FLAC up to 32-bit/384 kHz, ALAC, MP3, AAC, Opus, Vorbis, WAV/AIFF, APE, WavPack, DSD, WMA, …) to 32-bit float. Rate conversion uses the SoX resampler (libsoxr) at very high quality, as does. The decoded audio runs through an AudioWorklet player and then the Web Audio DSP chain.
- Sample-accurate gapless playback, crossfade (no fading / different albums only / all / shuffled only), and short or full crossfade on manual skips.
- Fade on play/pause and seek, plus optional silence between tracks.
- ReplayGain (track or album, with preamps and peak-based clip prevention), plus tempo (0.5–2×) and pitch (±12 semitones).
- Output device selection and output sample rate (auto follows the device).
- Internet radio (HTTP/HLS, `.m3u`/`.pls`) with ICY "now playing" titles.
- CUE sheets: virtual tracks inside one big image file.

**Equalizer screen** (three tabs):
- Equalizer
  - Graphic EQ with 5–31 bands, or parametric EQ (drag points on the curve, scroll to change Q, double-click to add a band).
  - Live spectrum behind the response curve, presets, your own saved presets, and presets bound to an output device.
  - 8,850 AutoEq headphone profiles.
- Tone & Volume: bass and treble with their frequencies, balance, stereo expand, mono, tempo, pitch, volume.
- Reverb: Size, Damp, Filter, Fade, Pre-Delay, Pre-Delay Mix, Mix, with the nine -named presets.
- Limiter, and an Audio Info panel showing the full signal chain (Ctrl+I).

**Library**
- Library categories: All Songs, Folders, Folders Hierarchy, Albums, Artists (with artist photos), Album Artists, Genres, Years, Composers, Playlists (plus `.m3u`/`.pls` files found in your music folders), and Streams.
- Smart lists: Queue, Bookmarks, Most Played, Top Rated, Low Rated, Recently Played, Recently Added, Long.
- Watched folders with automatic incremental rescans.
- Global search, a filter for each list, A–Z jump, grid or list view for each category, and categories you can hide.
- queue: "Play next" and "Add to queue" play first, then the list continues.
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
- layout: tinted, blurred album-art backdrop, accent colour taken from the cover, pill-shaped controls, 5-button transport (<<< and >>> jump albums, or seek ±10 s on long tracks), and a waveform seek bar.
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

**Migrated from your phone**: 10 playlists, play counts, likes, date-added, and your EQ (parametric Soft Bass, preamp, tone, limiter). Crossfade, ReplayGain, visualizer, background and library settings came across too. The data was captured over adb into `import/`.

## Limitations and known differences from 
- **No bit-perfect or WASAPI-exclusive output.** Audio goes through Windows' shared mixer at 32-bit float. Web Audio can't take exclusive control of the device.
- **Phone-only features have no desktop version.** That covers Chromecast/DLNA, Android Auto, the lock screen and widgets. The mini player stands in for the widgets.
- **Last.fm scrobbling isn't supported.** It needs an API key and secret registered by the user; ListenBrainz needs only a token.

## Development
```
npm install         # also fetches the ffmpeg build (libsoxr) into native/ffmpeg, checksum-verified
npm start           # run from source
npm test            # lyrics parser + queue self-checks
npm run dist        # build release\Cadence-win32-x64\Cadence.exe
```
User data (library cache, covers, settings, playlists, stats) lives in `%APPDATA%\Cadence`.

Design: Geist / Geist Mono typefaces (SIL OFL, `renderer/fonts`) and Phosphor Light icons (MIT, generated into `renderer/icons.js` from `@phosphor-icons/core`).

Code layout: `main.mjs` (ffmpeg decoder with flow control, scanner, CUE, tags, art, lyrics, AutoEq), `preload.cjs` (IPC allow-list), `renderer/` (`engine.js` + `worklet.js` audio engine, `core.js` state/queue, `views.js`, `player.js`, `eq.js`, `settings.js`, `lyricsview.js`, `actions.js`, `ui.js`, `app.js`).
