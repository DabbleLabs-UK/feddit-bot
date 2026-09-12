'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const program = fs.readFileSync(path.join(root, 'desktop', 'FedditBots.Desktop', 'Program.cs'), 'utf8');
const form = fs.readFileSync(path.join(root, 'desktop', 'FedditBots.Desktop', 'PreparingForm.cs'), 'utf8');
const build = fs.readFileSync(path.join(root, 'desktop', 'build-desktop.ps1'), 'utf8');

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  checks++;
}

check(program.includes('Application.Run(preparing);'), 'first-run preparation has a real Windows message loop');
check(program.includes('_ = Task.Run(async () =>'), 'runtime verification and extraction run off the UI thread');
check(!program.includes('preparing.Show();'), 'startup does not return to an unpumped Show-only form');
check(!program.includes('Application.DoEvents();'), 'startup does not rely on manual event pumping');
check(form.includes('if (InvokeRequired)'), 'worker progress is marshalled to the UI thread');
check(form.includes('BeginInvoke(new Action(Complete))'), 'the worker can close the preparation form safely');
check(build.includes('-p:Version=$Version'), 'packaged launcher version follows the release version');

console.log('desktop first-run contract: ' + checks + ' checks passed');
