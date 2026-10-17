// node test/netpath.test.mjs — UNC/device path guard from main.mjs (main imports electron, so the helpers are lifted out of its source)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// one-line const, or a multi-line arrow body closed by '};' at column 0
const pick = name => { const m = src.match(new RegExp(`^const ${name} = (?:.*\\{\\n[\\s\\S]*?^\\};|.*)$`, 'm')); assert.ok(m, `${name} not found in main.mjs`); return m[0]; };
const library = { folders: [] };
const { netOk, plEntry, playable } = new Function('path', 'library', 'fileURLToPath',
  `${['under', 'netPath', 'netOk', 'isUrl', 'plEntry', 'playable'].map(pick).join('\n')}\nreturn { netOk, plEntry, playable };`)(nodePath.win32, library, fileURLToPath);

const local = ['D:\\Lossless music'], share = ['D:\\Lossless music', '\\\\nas\\music'];

// local files are always fine
assert.equal(netOk('D:\\Lossless music\\a.flac', local), true);
assert.equal(netOk('C:\\elsewhere\\b.mp3', local), true);

// UNC and device paths are refused without a share in the library
for (const f of ['\\\\attacker\\share\\x.flac', '//host/x', '\\/host/x', '\\\\?\\C:\\x.flac', '\\\\.\\pipe\\x', '\\\\?\\UNC\\nas\\music\\a.flac', '\\??\\UNC\\attacker\\share\\x.flac', '/??/UNC/attacker/share/x.flac', '\\rooted\\x.flac', 'relative.flac'])
  assert.equal(netOk(f, local), false, f);
// NT-namespace paths are not inside a share folder either
assert.equal(netOk('\\??\\UNC\\nas\\music\\a.flac', share), false);

// ...and with one, only paths inside it pass
assert.equal(netOk('\\\\nas\\music\\Album\\a.flac', share), true);
assert.equal(netOk('//nas/music/Album/a.flac', share), true);
assert.equal(netOk('\\\\NAS\\Music\\a.flac', share), true);
assert.equal(netOk('\\\\nas\\other\\a.flac', share), false);
assert.equal(netOk('\\\\nas\\musicx\\a.flac', share), false);
assert.equal(netOk('\\\\nas\\music\\..\\other\\a.flac', share), true); // '..' cannot leave a share root: this is \\nas\music\other\a.flac
assert.equal(netOk('\\\\attacker\\music\\a.flac', share), false);
assert.equal(netOk('\\\\nas\\music', share), false);

// default folder list is the library's (empty here)
assert.equal(netOk('\\\\nas\\music\\a.flac'), false);
assert.equal(netOk('D:\\a.flac'), true);

// playlist entries: local, relative, file: and http(s) still resolve; UNC lines are dropped
const dir = 'D:\\Lossless music\\Lists';
assert.equal(plEntry(dir, '..\\Album\\01.flac'), 'D:\\Lossless music\\Album\\01.flac');
assert.equal(plEntry(dir, 'C:\\x\\a.mp3'), 'C:\\x\\a.mp3');
assert.equal(plEntry(dir, 'file:///D:/Lossless%20music/a.flac'), 'D:\\Lossless music\\a.flac');
assert.equal(plEntry(dir, 'https://radio.example/stream'), 'https://radio.example/stream');
for (const l of ['\\\\attacker\\share\\x.flac', '//host/x.flac', 'file://attacker/share/x.flac', '\\\\?\\C:\\x.flac'])
  assert.equal(plEntry(dir, l), null, l);

// playable: same rule, plus http(s) streams
assert.equal(playable('D:\\Lossless music\\a.flac'), true);
assert.equal(playable('http://radio.example/s'), true);
assert.equal(playable('\\??\\UNC\\attacker\\share\\x.flac'), false); // ffmpeg would pass this straight to NT
assert.equal(playable('\\\\attacker\\share\\x.flac'), false);
library.folders = ['\\\\nas\\music'];
assert.equal(playable('\\\\nas\\music\\a.flac'), true);
assert.equal(plEntry('\\\\nas\\music\\Lists', '..\\a.flac'), '\\\\nas\\music\\a.flac');
assert.equal(playable('\\\\attacker\\share\\x.flac'), false);

console.log('netpath ok');
