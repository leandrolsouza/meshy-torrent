/* global require, process, console */
const { app } = require('electron');
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const run = resolve(process.env.MESHY_QA_ROOT);
const profile = join(run, 'electron-profile');
for (const directory of [
    profile,
    join(profile, 'session'),
    join(run, 'logs'),
    join(run, 'ui-downloads'),
])
    mkdirSync(directory, { recursive: true });
app.setName('Meshy Torrent QA');
app.setAppPath(process.env.MESHY_QA_WORKSPACE);
app.setPath('userData', profile);
app.setPath('sessionData', join(profile, 'session'));
app.setPath('logs', join(run, 'logs'));
app.setPath('downloads', join(run, 'ui-downloads'));
app.disableHardwareAcceleration();
import(
    pathToFileURL(join(process.env.MESHY_QA_WORKSPACE, '.build-resources/qa/renderer.mjs')).href
).catch((error) => {
    console.error(error);
    app.exit(1);
});
