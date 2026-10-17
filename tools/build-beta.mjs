// npm run dist:beta: packages the working tree as "Cadence Beta" into release-beta/, side by side with the main app.
// It keeps its own data folder (%APPDATA%\Cadence Beta), seeded once with a copy of the main app's library,
// playlists, settings and cover cache; the main app's data is only read, never written.
import fs from 'node:fs';
import path from 'node:path';
import { packager, defaultSanitizePackageJson } from '@electron/packager';

const root = path.resolve(import.meta.dirname, '..');
const [appPath] = await packager({
  dir: root, name: 'Cadence Beta', platform: 'win32', arch: 'x64', icon: path.join(root, 'build/icon.ico'),
  out: path.join(root, 'release-beta'), overwrite: true, appCopyright: 'Cadence',
  asar: { unpack: '**/{ffmpeg-static/ffmpeg.exe,native/cadence-wasapi.exe}' },
  ignore: /^\/(test|release|release-beta|dist|tools|scratch|import|[.]git|[.]vscode)(\/|$)|^\/(README[.]md|package-lock[.]json|[.]gitignore)$|^\/native\/[^/]+[.]cs$|[.](log|bak|bad|tmp|map)$/,
  // the product name decides the data folder (app.getPath('userData')) and the single-instance lock
  sanitizePackageJson: [defaultSanitizePackageJson, pj => ({ ...pj, name: 'cadence-beta', productName: 'Cadence Beta' })],
});
console.log('built', appPath);

const appData = process.env.APPDATA, from = path.join(appData, 'Cadence'), to = path.join(appData, 'Cadence Beta');
if (fs.existsSync(path.join(to, 'library.json'))) console.log('beta data already exists, left as is:', to);
else if (fs.existsSync(from)) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of ['library.json', 'playlists.json', 'settings.json', 'bookmarks.json', 'stats.json', 'state.json', 'streams.json'])
    if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
  if (fs.existsSync(path.join(from, 'covers'))) fs.cpSync(path.join(from, 'covers'), path.join(to, 'covers'), { recursive: true });
  console.log('seeded beta data from', from);
}
