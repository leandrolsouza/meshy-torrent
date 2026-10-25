/* global process, console, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { createProtectedStore } from '../../main/protectedStore';
import WebTorrent from 'webtorrent';
import updater from 'electron-updater';
import { createSettingsManager } from '../../main/settingsManager';
import { createDownloadManager } from '../../main/downloadManager';
import { createTorrentEngine } from '../../main/torrentEngine';
import { createUpdateManager } from '../../main/updateManager';
import { createExternalTorrentInbox } from '../../main/externalTorrents';
import { registerIpcHandlers, attachWindowEvents } from '../../main/ipcHandler';
import { rendererSecurity } from '../../main/rendererSecurity';

await app.whenReady();
const root = process.env.MESHY_QA_WORKSPACE;
const run = process.env.MESHY_QA_ROOT;
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const profile = app.getPath('userData');
const client = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    utPex: false,
    utp: false,
    natUpnp: false,
    natPmp: false,
});
const storageProbe = 'SYNTHETIC_QA_PRIVATE_PASSKEY';
const privateTracker = `https://tracker.example.test/${storageProbe}/announce`;
// Perfil isolado: comprova a migração e o round-trip usando o cofre real do OS.
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ globalTrackers: [privateTracker] }));
const store = createProtectedStore({ cwd: profile, name: 'settings' });
assert(!readFileSync(join(profile, 'settings.json'), 'utf8').includes(storageProbe));
assert.deepEqual(createProtectedStore({ cwd: profile, name: 'settings' }).get('globalTrackers'), [
    privateTracker,
]);
store.set({
    destinationFolder: app.getPath('downloads'),
    schemaVersion: 1,
    notificationsEnabled: false,
    closeToTray: false,
    dhtEnabled: false,
    pexEnabled: false,
    utpEnabled: false,
});
const settings = createSettingsManager({
    store: {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
        setMany: (values) => store.set(values),
    },
    getDownloadsPath: () => app.getPath('downloads'),
});
const engine = createTorrentEngine(
    {
        downloadPath: app.getPath('downloads'),
        downloadSpeedLimit: 0,
        uploadSpeedLimit: 0,
        dhtEnabled: false,
        pexEnabled: false,
        utpEnabled: false,
    },
    client,
);
const session = createProtectedStore({ cwd: profile, name: 'downloads' });
session.set(
    'qaProbe',
    `magnet:?xt=urn:btih:${'a'.repeat(40)}&tr=${encodeURIComponent(privateTracker)}`,
);
assert(!readFileSync(join(profile, 'downloads.json'), 'utf8').includes(storageProbe));
assert.equal(
    createProtectedStore({ cwd: profile, name: 'downloads' }).get('qaProbe'),
    session.get('qaProbe'),
);
session.delete('qaProbe');
const manager = createDownloadManager(engine, settings, session, undefined, {
    disableCleanupTimer: true,
});
const updates = createUpdateManager({
    driver: updater.autoUpdater,
    currentVersion: version,
    disabledReason: undefined,
    publish: () => {},
    persistSession: () => manager.persistSession(),
    confirmInstall: async () => false,
    setQuitting: () => {},
});
const denied = async () => {
    throw new Error('Integração do sistema desabilitada na homologação');
};
registerIpcHandlers(manager, settings, engine, undefined, {
    inbox: createExternalTorrentInbox(() => {}),
    updates,
    registerMagnetHandler: denied,
    getMagnetHandlerStatus: denied,
    openMagnetDefaultApps: denied,
});
const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
        preload: join(root, 'out/preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
    },
});
const file = join(root, 'out/renderer/index.html');
rendererSecurity.trustWindow(window, pathToFileURL(file).href);
attachWindowEvents(manager, engine, window);
const errors = [];
window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
window.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
window.webContents.session.webRequest.onHeadersReceived((details, callback) =>
    callback({
        responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'",
            ],
        },
    }),
);
const waitForUI = async (text) => {
    const end = Date.now() + 10_000;
    while (
        !(await window.webContents.executeJavaScript(
            `document.body.textContent.includes(${JSON.stringify(text)})`,
        ))
    ) {
        if (Date.now() > end) throw new Error(`Interface não ficou pronta: ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};
const timeout = setTimeout(() => {
    console.error('Timeout do renderer');
    app.exit(1);
}, 60_000);
let succeeded = false;
try {
    const captures = [];
    for (const theme of ['vs-code-dark', 'vs-code-light']) {
        for (const locale of ['pt-BR', 'en-US']) {
            settings.set({ theme, locale });
            await window.loadFile(file);
            await waitForUI(
                locale === 'pt-BR' ? 'Verificação automática ativa' : 'Automatic checks enabled',
            );
            // Aguarda a transição de cores de 300 ms e a pintura da interface.
            await new Promise((resolve) => setTimeout(resolve, 450));
            await window.webContents.executeJavaScript(
                'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
            );
            const state = await window.webContents.executeJavaScript(`(async () => ({
                settings: await window.meshy.getSettings(), downloads: await window.meshy.getAll(),
                update: await window.meshy.getUpdateStatus(),
                background: getComputedStyle(document.documentElement).getPropertyValue('--color-bg'),
                theme: document.documentElement.dataset.theme,
                dropBackground: getComputedStyle(document.querySelector('[role="region"]')).backgroundColor,
                navigation: document.querySelectorAll('nav button').length,
                exposedNode: typeof window.require !== 'undefined',
                overflow: document.documentElement.scrollWidth > innerWidth,
            }))()`);
            assert.equal(state.settings.success, true);
            assert.equal(state.settings.data.locale, locale);
            assert.equal(state.settings.data.theme, theme);
            assert.equal(state.downloads.success, true);
            assert.deepEqual(state.downloads.data, []);
            assert.equal(state.update.data.phase, 'idle');
            assert.equal(state.update.data.disabledReason, undefined);
            assert.equal(state.update.data.currentVersion, version);
            assert.equal(state.theme, theme);
            assert.equal(
                state.dropBackground,
                theme === 'vs-code-light' ? 'rgb(243, 243, 243)' : 'rgb(37, 37, 38)',
            );
            assert.equal(state.exposedNode, false);
            assert.ok(state.navigation >= 3);
            assert.equal(state.overflow, false);
            const image = await window.webContents.capturePage();
            const capture = `${theme}-${locale}.png`;
            writeFileSync(join(run, capture), image.toPNG());
            captures.push({ theme, locale, background: state.background.trim(), capture });
        }
    }
    assert.deepEqual(errors, []);
    const report = {
        ok: true,
        protectedStorage: {
            legacyMigration: true,
            settingsRoundTrip: true,
            downloadsRoundTrip: true,
            plaintextProbeAbsent: true,
        },
        captures,
        scope: 'Renderer e preload de produção com serviços e IPC reais em janela oculta e perfil isolado; não executa main/index nem instalador',
    };
    writeFileSync(join(run, 'renderer-report.json'), JSON.stringify(report, null, 4));
    console.log(JSON.stringify(report, null, 4));
    succeeded = true;
} catch (error) {
    console.error(error);
} finally {
    clearTimeout(timeout);
    updates.dispose();
    window.destroy();
    await new Promise((resolve) => client.destroy(resolve));
    app.exit(succeeded ? 0 : 1);
}
