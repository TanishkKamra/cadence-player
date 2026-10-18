// npm run ffmpeg (also postinstall and dist): fetches the decoder into native/ffmpeg/. ffmpeg-static's build has no
// libsoxr, so Cadence ships BtbN's LGPL Windows build (has --enable-libsoxr) pinned to one dated release.
// Both the zip and the extracted ffmpeg.exe must match the SHA-256 below; anything else is deleted, never run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-17-20-51/ffmpeg-n8.1.3-18-g46d899d7a0-win64-lgpl-8.1.zip';
const ZIP_SHA256 = 'de63d7eab2529dfa543852c6ad49dff1ae02651bfc2f88b8b80f0e43f7f1d677'; // = release checksums.sha256 and GitHub asset digest
const EXE_SHA256 = '34f6dc936bb20e53add980e867abd429d22ab4b374c6754e690612cde6cbcf33';
const DIR = path.join(import.meta.dirname, '..', 'native', 'ffmpeg'), EXE = path.join(DIR, 'ffmpeg.exe');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

if (fs.existsSync(EXE) && sha256(EXE) === EXE_SHA256) process.exit(0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-ffmpeg-')), zip = path.join(tmp, 'ffmpeg.zip');
try {
  console.log('downloading', URL);
  const res = await fetch(URL, { signal: AbortSignal.timeout(10 * 60e3) }); // a stalled connection must not hang npm install
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  if (sha256(zip) !== ZIP_SHA256) throw new Error('ffmpeg zip checksum mismatch');
  // Windows' own bsdtar reads zip; Git's GNU tar on PATH does not
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp, '*/bin/ffmpeg.exe', '*/LICENSE.txt']);
  const top = path.join(tmp, path.basename(URL, '.zip'));
  if (sha256(path.join(top, 'bin', 'ffmpeg.exe')) !== EXE_SHA256) throw new Error('ffmpeg.exe checksum mismatch');
  fs.mkdirSync(DIR, { recursive: true });
  fs.copyFileSync(path.join(top, 'LICENSE.txt'), path.join(DIR, 'LICENSE.txt'));
  // copy beside, then rename: an interrupted copy never leaves a truncated ffmpeg.exe in place
  fs.copyFileSync(path.join(top, 'bin', 'ffmpeg.exe'), EXE + '.tmp');
  fs.renameSync(EXE + '.tmp', EXE);
  fs.writeFileSync(path.join(DIR, 'SOURCE.txt'), `${URL}\nsha256 ${EXE_SHA256}\nFFmpeg (LGPL v2.1+) with libsoxr; source: https://github.com/BtbN/FFmpeg-Builds\n`);
  console.log('ffmpeg ready:', EXE);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
