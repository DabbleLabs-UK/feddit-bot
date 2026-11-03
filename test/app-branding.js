'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

for (const [name, title, size] of [
  ['index.html', 'Feddit bots', 28],
  ['population.html', 'Feddit background population', 32],
]) {
  const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
  assert.ok(html.includes('<title>' + title + '</title>'), name + ' preserves its page title');
  assert.match(html, /<link rel="icon" href="\/branding\/app\.ico" type="image\/x-icon">/);
  assert.match(html, /<link rel="icon" href="\/branding\/icon-32\.png" type="image\/png" sizes="32x32">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/branding\/apple-touch-icon\.png" sizes="180x180">/);
  assert.ok(html.includes('<h1><img class="app-logo" src="/branding/logo.png" width="' + size +
    '" height="' + size + '" alt=""><span>' + title + '</span></h1>'),
    name + ' uses a compact decorative logo beside the accessible page heading');
  assert.match(html, /\.app-logo\s*\{[^}]*object-fit:\s*contain;[^}]*flex:\s*0 0 auto;/);
}

for (const [name, size] of [
  ['logo.png', 256],
  ['icon-32.png', 32],
  ['apple-touch-icon.png', 180],
]) {
  const png = fs.readFileSync(path.join(publicDir, 'branding', name));
  assert.ok(png.subarray(0, 8).equals(pngSignature), name + ' is a PNG image');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), size, name + ' has the expected width');
  assert.equal(png.readUInt32BE(20), size, name + ' has the expected height');
}

const ico = fs.readFileSync(path.join(publicDir, 'branding', 'app.ico'));
assert.ok(ico.equals(fs.readFileSync(path.join(root, 'desktop', 'branding', 'app.ico'))),
  'web and native icons share the same generated source');
assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field is valid');
assert.equal(ico.readUInt16LE(2), 1, 'browser icon is an ICO image');
assert.ok(ico.readUInt16LE(4) > 1, 'browser icon includes multiple resolutions');
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const entry = 6 + i * 16;
  const bytes = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert.ok(bytes > 0 && offset >= 6 + ico.readUInt16LE(4) * 16 && offset + bytes <= ico.length,
    'ICO image entry is contained in the packaged file');
}

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.match(server, /'\.png': 'image\/png'/, 'static handler serves PNG with its image type');
assert.match(server, /'\.ico': 'image\/x-icon'/, 'static handler serves ICO with its image type');

const installer = fs.readFileSync(path.join(root, 'desktop', 'installer', 'FedditBots.nsi'), 'utf8');
assert.match(installer, /!define MUI_ICON .*branding\\app\.ico/);
assert.match(installer, /!define MUI_UNICON .*branding\\app\.ico/);
assert.equal((installer.match(/CreateShortcut .*"\$INSTDIR\\FedditBots\.Desktop\.exe" 0/g) || []).length, 2,
  'both shortcuts explicitly use the native app icon');
assert.match(installer, /"DisplayIcon"/);
const builder = fs.readFileSync(path.join(root, 'desktop', 'build-desktop.ps1'), 'utf8');
assert.ok(!builder.includes('-p:Version=$Version'), 'launcher version is independent of app package version');

console.log('app-branding: all checks passed');
