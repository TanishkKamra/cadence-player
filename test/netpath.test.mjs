// node test/netpath.test.mjs — UNC/device path guard from main.mjs (main imports electron, so the helpers are lifted out of its source)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// one-line const, or a multi-line arrow body closed by '};' at column 0
const pick = name => { const m = src.match(new RegExp(`^const ${name} = (?:.*\\{\\n[\\s\\S]*?^\\};|.*)$`, 'm')); assert.ok(m, `${name} not found in main.mjs`); return m[0]; };
const library = { folders: [] };
// a fake disk for linkOk: paths listed in `links` are symlinks (lstat never follows, readlink returns the target); everything else is a plain entry
const links = {};
const fakeFs = {
  lstatSync: p => ({ isSymbolicLink: () => p in links }),
  readlinkSync: p => { if (!(p in links)) throw new Error('EINVAL'); return links[p]; },
};
const { netOk, plEntry, playable, linkOk } = new Function('path', 'library', 'fileURLToPath', 'fs',
  `${['under', 'plainPath', 'netPath', 'netOk', 'linkOk', 'isUrl', 'plEntry', 'playable'].map(pick).join('\n')}\nreturn { netOk, plEntry, playable, linkOk };`)(nodePath.win32, library, fileURLToPath, fakeFs);

const local = ['D:\\Lossless music'], share = ['D:\\Lossless music', '\\\\nas\\music'];

// local files are always fine
assert.equal(netOk('D:\\Lossless music\\a.flac', local), true);
assert.equal(netOk('C:\\elsewhere\\b.mp3', local), true);

// UNC and device paths are refused without a share in the library
for (const f of ['\\\\attacker\\share\\x.flac', '//host/x', '\\/host/x', '\\\\?\\GLOBALROOT\\Device\\Mup\\nas\\music\\a.flac', '\\\\.\\pipe\\x', '\\\\?\\UNC\\nas\\music\\a.flac', '\\??\\UNC\\attacker\\share\\x.flac', '/??/UNC/attacker/share/x.flac', '\\rooted\\x.flac', 'relative.flac'])
  assert.equal(netOk(f, local), false, f);
// long forms compare as their plain path: a share in the library is reachable however it is spelled, any other host is not
for (const f of ['\\??\\UNC\\nas\\music\\a.flac', '\\\\?\\UNC\\nas\\music\\a.flac', '\\\\.\\UNC\\NAS\\Music\\a.flac', '//?/UNC/nas/music/a.flac'])
  assert.equal(netOk(f, share), true, f);
for (const f of ['\\??\\UNC\\attacker\\music\\a.flac', '\\\\?\\UNC\\attacker\\s\\x', '\\\\.\\UNC\\nas\\other\\x', '\\\\?\\GLOBALROOT\\Device\\Mup\\nas\\music\\a.flac'])
  assert.equal(netOk(f, share), false, f);
// ...but never with '.' or '..' segments: Windows lets them climb out of \\.\UNC\server\share, Node does not
for (const f of ['\\\\.\\UNC\\nas\\music\\..\\..\\attacker\\s\\x.flac', '\\\\?\\UNC\\nas\\music\\..\\x.flac', '\\??\\UNC\\nas\\music\\.\\a.flac', '//./UNC/nas/music/../../attacker/s'])
  assert.equal(netOk(f, share), false, f);
assert.equal(netOk('\\\\nas\\music\\..\\x.flac', share), true); // a plain UNC root cannot be climbed out of, here Windows and Node agree
// long forms of a local drive path are local
assert.equal(netOk('\\\\?\\C:\\x.flac', local), true);
assert.equal(netOk('\\??\\D:\\Lossless music\\a.flac', local), true);

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
for (const l of ['\\\\attacker\\share\\x.flac', '//host/x.flac', 'file://attacker/share/x.flac', '\\\\?\\UNC\\attacker\\share\\x.flac', '\\\\.\\UNC\\attacker\\s\\x'])
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

// symlinks: a link inside a music folder must not lead to an unapproved host; links the user chose (a library folder itself) are trusted
library.folders = ['D:\\Lossless music', 'D:\\NasLink'];
Object.assign(links, {
  'D:\\Lossless music\\evil.flac': '\\\\attacker\\s\\x.flac',
  'D:\\Lossless music\\nasdir': '\\\\nas\\music',
  'D:\\Lossless music\\local': 'E:\\Music',
  'D:\\Lossless music\\junction': '\\\\?\\E:\\Music\\',
  'D:\\Lossless music\\vol': '\\\\?\\Volume{1234}\\',
  'D:\\Lossless music\\rel.flac': '..\\other.flac',
  'D:\\Lossless music\\hop': 'D:\\Lossless music\\evildir',
  'D:\\Lossless music\\evildir': '//attacker/s',
  'D:\\Lossless music\\loop1': 'D:\\Lossless music\\loop2',
  'D:\\Lossless music\\loop2': 'D:\\Lossless music\\loop1',
  'D:\\NasLink': '\\\\otherhost\\m',
});
assert.equal(linkOk('D:\\Lossless music\\a.flac'), true);
assert.equal(linkOk('D:\\Lossless music\\evil.flac'), false);
assert.equal(linkOk('D:\\Lossless music\\nasdir\\a.flac'), false); // \\nas\music is not a library folder yet
assert.equal(linkOk('D:\\Lossless music\\local\\a.flac'), true);
assert.equal(linkOk('D:\\Lossless music\\junction\\a.flac'), true);
assert.equal(linkOk('D:\\Lossless music\\vol\\a.flac'), true);
assert.equal(linkOk('D:\\Lossless music\\rel.flac'), true);
assert.equal(linkOk('D:\\Lossless music\\hop\\x.flac'), false); // link to a link to a host
assert.equal(linkOk('D:\\Lossless music\\loop1\\x.flac'), false);
assert.equal(linkOk('D:\\NasLink\\a.flac'), true); // the user added this link as a library folder
assert.equal(playable('D:\\Lossless music\\evil.flac'), false);
library.folders.push('\\\\nas\\music');
assert.equal(linkOk('D:\\Lossless music\\nasdir\\a.flac'), true); // now an approved share
assert.equal(linkOk('\\\\nas\\music\\a.flac'), true);
assert.equal(linkOk('\\\\attacker\\music\\a.flac'), false);

console.log('netpath ok');

// AutoEq profile paths: no way out of results/, whichever separator or encoding
{
  const aeqPathOk = new Function(`${pick('aeqPathOk')}; return aeqPathOk;`)();
  assert.ok(aeqPathOk('crinacle/711%20in-ear/1Custom%20SA02'));
  for (const bad of ['../x', 'a/../b', 'a/..\\b', 'a\\..\\b', 'a/%2e%2e/b', 'a/%2E%2E%5Cb', 'a/%zz']) assert.equal(aeqPathOk(bad), false, bad);
  console.log('ok   AutoEq paths: .. with / or \\, encoded or not, and bad escapes are refused');
}
