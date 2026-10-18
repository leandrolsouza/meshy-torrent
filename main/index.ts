import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdirSync, readFileSync } from 'fs';
import { isAllowedRendererUrl, rendererSecurity } from './rendererSecurity';
import { createSettingsManager } from './settingsManager';
import { createTorrentEngine } from './torrentEngine';
import { createDownloadManager } from './downloadManager';
import { createNotificationManager } from './notificationManager';
import { registerIpcHandlers, attachWindowEvents } from './ipcHandler';
import type { DownloadManager } from './downloadManager';
import { logger } from './logger';
import { metrics } from './metrics';
import { createTorrentPreparation } from './torrentPreparation';
import { createDiskSpaceService } from './diskSpace';
import { createExternalTorrentInbox } from './externalTorrents';
import { createBackgroundController } from './backgroundController';
import { randomUUID } from 'crypto';
import { createBandwidthController } from './bandwidthController';
import { createDownloadDiagnostics } from './downloadDiagnostics';
import { createMagnetAssociation } from './magnetAssociation';
import updater from 'electron-updater';
import { load, FAILSAFE_SCHEMA } from 'js-yaml';
import { createUpdateManager } from './updateManager';
import { getUpdateDisabledReason } from './updatePolicy';
import ptBR from '../src/locales/pt-BR.json';
import enUS from '../src/locales/en-US.json';

import ElectronStore from 'electron-store';

// ─── Caminho de dados do usuário ──────────────────────────────────────────────
// Preserva o diretório legado "Meshy" independente do productName atual,
// garantindo que configurações e sessão de downloads de instalações anteriores
// não se percam ao atualizar. Deve ser chamado antes de app.ready.
{
    const legacyUserData = join(app.getPath('appData'), 'Meshy');
    mkdirSync(legacyUserData, { recursive: true });
    app.setPath('userData', legacyUserData);
}

// Module-level references so the before-quit handler can access them
let downloadManager: DownloadManager | null = null;
let desktopReady = false;
let showMainWindow = () => { };
let background: ReturnType<typeof createBackgroundController> | undefined;
const externalTorrents = createExternalTorrentInbox(() => {
    if (!desktopReady) return;
    showMainWindow();
    const window = BrowserWindow.getAllWindows()[0];
    if (window && !window.isDestroyed())
        window.webContents.send('app:external-torrents', externalTorrents.getPending());
});

// ─── Crash handlers ───────────────────────────────────────────────────────────
//
// Capturam exceções e rejeições não tratadas no processo principal.
// Persistem a sessão antes de encerrar para evitar perda de dados.

process.on('uncaughtException', (error) => {
    logger.error('[CRASH] Exceção não capturada:', error.message, error.stack);

    // Erros de rede do WebTorrent (uTP bind, DHT) são não-fatais.
    // O app pode continuar funcionando sem uTP — apenas logar e continuar.
    const isNetworkError =
        error.message === 'permission denied' ||
        error.message?.includes('EACCES') ||
        error.message?.includes('EADDRINUSE') ||
        error.stack?.includes('utp-native') ||
        error.stack?.includes('bittorrent-dht');

    if (isNetworkError) {
        logger.warn('[CRASH] Erro de rede não-fatal ignorado:', error.message);
        return;
    }

    // Persistir sessão para não perder o estado dos downloads
    try {
        downloadManager?.persistSession();
    } catch (persistError) {
        logger.error('[CRASH] Falha ao persistir sessão:', String(persistError));
    }

    // Persistir métricas para análise post-mortem
    try {
        metrics.persistSnapshot();
    } catch {
        // Falha silenciosa — não queremos erros ao persistir métricas
    }

    // Exibir diálogo de erro para o usuário (se o app ainda estiver funcional)
    try {
        dialog.showErrorBox(
            'Meshy Torrent — Erro inesperado',
            `O Meshy Torrent encontrou um erro inesperado e precisa ser reiniciado.\n\n${error.message}`,
        );
    } catch {
        // Se o diálogo falhar, apenas encerrar
    }

    app.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('[CRASH] Rejeição não tratada:', message, stack);

    // Persistir sessão para não perder o estado dos downloads
    try {
        downloadManager?.persistSession();
    } catch (persistError) {
        logger.error('[CRASH] Falha ao persistir sessão:', String(persistError));
    }

    // Persistir métricas para análise post-mortem
    try {
        metrics.persistSnapshot();
    } catch {
        // Falha silenciosa
    }
});

// ─── Factory para criação de BrowserWindow ────────────────────────────────────

/**
 * Cria e configura uma nova BrowserWindow com as opções padrão do Meshy Torrent.
 * Centraliza a criação para evitar duplicação entre o boot inicial e o
 * handler de `activate` (macOS).
 */
function createMainWindow(): BrowserWindow {
    const window = new BrowserWindow({
        width: 1200,
        height: 800,
        // Mantém os menus e atalhos acessíveis por Alt no Windows/Linux.
        autoHideMenuBar: true,
        icon: join(__dirname, '../../icon.png'),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    // ── CSP — Content-Security-Policy ─────────────────────────────────────────
    // Define uma política restritiva para mitigar XSS no renderer.
    // Em dev, o Vite injeta scripts inline para HMR e precisa de connect-src
    // para WebSocket. Relaxamos a CSP apenas em dev.
    const isDev = !app.isPackaged;
    const rendererFile = join(__dirname, '../renderer/index.html');
    const developmentUrl = isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
    const rendererUrl = developmentUrl || pathToFileURL(rendererFile).href;
    rendererSecurity.trustWindow(window, rendererUrl);

    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const cspDirectives = isDev
            ? [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                "font-src 'self'",
                "connect-src 'self' ws://localhost:*",
                "frame-src 'none'",
                "object-src 'none'",
                "base-uri 'none'",
            ]
            : [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                "font-src 'self'",
                "connect-src 'self'",
                "frame-src 'none'",
                "object-src 'none'",
                "base-uri 'none'",
            ];

        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [cspDirectives.join('; ')],
            },
        });
    });

    // ── Proteção contra navegação externa ─────────────────────────────────────
    // Bloqueia qualquer tentativa de navegar para URLs externas dentro da janela
    // principal. Impede que metadata malicioso de torrents redirecione o renderer.
    window.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedRendererUrl(url, rendererUrl)) {
            event.preventDefault();
            logger.warn('[Security] Navegação externa bloqueada');
        }
    });
    window.webContents.on('will-redirect', (event, url) => {
        if (!isAllowedRendererUrl(url, rendererUrl)) event.preventDefault();
    });
    window.webContents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame || !isAllowedRendererUrl(event.url, rendererUrl))
            event.preventDefault();
    });

    // Bloqueia abertura de novas janelas (popups, target="_blank", window.open)
    window.webContents.setWindowOpenHandler(({ url }) => {
        logger.warn('[Security] Abertura de janela bloqueada:', url);
        return { action: 'deny' };
    });

    // ── Carregamento do renderer ──────────────────────────────────────────────
    // ELECTRON_RENDERER_URL só é respeitada em dev (app não empacotado).
    // Em produção, sempre carrega o arquivo local para evitar que uma env var
    // maliciosa redirecione o renderer para uma URL arbitrária.
    if (developmentUrl) {
        window.loadURL(developmentUrl);
    } else {
        window.loadFile(rendererFile);
    }

    return window;
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

// Multiple processes otherwise restore the same session and duplicate discovery.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', (_event, args, cwd) => {
    externalTorrents.enqueueArguments(args, cwd);
    if (desktopReady) showMainWindow();
});
// macOS entrega estes eventos antes de ready em lançamentos pelo Finder/navegador.
app.on('open-url', (event, url) => {
    event.preventDefault();
    externalTorrents.enqueueArguments([url]);
});
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    externalTorrents.enqueueArguments([filePath]);
});
if (ownsInstance) externalTorrents.enqueueArguments(process.argv.slice(process.defaultApp ? 2 : 1));

app.whenReady()
    .then(async () => {
        if (!ownsInstance) return;
        // ── Habilitar persistência de métricas ─────────────────────────────────────
        try {
            const logsDir = app.getPath('logs');
            metrics.enablePersistence(logsDir);
        } catch {
            logger.warn('[Metrics] Falha ao habilitar persistência de métricas');
        }

        // ── Instantiate core services ──────────────────────────────────────────────
        const settingsManager = createSettingsManager();
        const settings = settingsManager.get();

        const torrentEngine = createTorrentEngine({
            downloadPath: settings.destinationFolder,
            downloadSpeedLimit: settings.downloadSpeedLimit,
            uploadSpeedLimit: settings.uploadSpeedLimit,
            dhtEnabled: settings.dhtEnabled,
            pexEnabled: settings.pexEnabled,
            utpEnabled: settings.utpEnabled,
        });

        // Shared electron-store instance for download session persistence
        const downloadsStore = new ElectronStore({ name: 'downloads' });
        const persistedStore = {
            get: (key: string) => downloadsStore.get(key),
            set: (key: string, value: unknown) => downloadsStore.set(key, value),
        } as import('./downloadManager').PersistedStore;

        const preparation = createTorrentPreparation({
            getNetworkOptions: () => settingsManager.get(),
        });
        downloadManager = createDownloadManager(
            torrentEngine,
            settingsManager,
            persistedStore,
            undefined,
            {
                diskSpace: createDiskSpaceService(),
                recoverMetadata: async (magnetUri) => {
                    const requestId = randomUUID();
                    try {
                        await preparation.prepare(requestId, { kind: 'magnet', magnetUri });
                        return preparation.get(requestId);
                    } finally {
                        preparation.cancel(requestId);
                    }
                },
            },
        );
        const diskTimer = setInterval(() => {
            void downloadManager
                ?.checkDiskSpace()
                .catch((error) => logger.warn('[Main] Falha na proteção de espaço:', error));
        }, 5000);
        diskTimer.unref();
        const bandwidth = createBandwidthController({
            settings: settingsManager,
            engine: torrentEngine,
        });
        const diagnostics = createDownloadDiagnostics({
            manager: downloadManager,
            engine: torrentEngine,
        });
        void diagnostics.refresh();

        // Restore previous session — falha não é fatal; o app inicia com estado vazio
        try {
            await downloadManager.restoreSession();
            downloadManager.setMaxConcurrentDownloads(settings.maxConcurrentDownloads);
        } catch (sessionErr) {
            logger.warn(
                '[Main] Falha ao restaurar sessão anterior — iniciando com estado vazio:',
                (sessionErr as Error).message,
            );
        }

        let updateConfiguration: unknown = null;
        if (app.isPackaged && process.platform === 'win32') {
            try {
                updateConfiguration = load(
                    readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'),
                    { schema: FAILSAFE_SCHEMA },
                );
            } catch {
                logger.warn('[Updates] Configuração de atualização indisponível');
            }
        }
        const updates = createUpdateManager({
            driver: updater.autoUpdater,
            currentVersion: app.getVersion(),
            setQuitting: (value) => background?.setQuitting(value),
            disabledReason: getUpdateDisabledReason({
                isPackaged: app.isPackaged,
                platform: process.platform,
                arch: process.arch,
                configuration: updateConfiguration,
            }),
            publish: (status) => {
                for (const window of BrowserWindow.getAllWindows()) {
                    if (!window.isDestroyed() && !window.webContents.isDestroyed())
                        window.webContents.send('app:update-status', status);
                }
            },
            persistSession: () => {
                if (downloadManager?.getAll().some((item) => item.fileOperation))
                    throw new Error('Operação de arquivos em andamento');
                downloadManager?.persistSession();
                metrics.persistSnapshot();
            },
            confirmInstall: async () => {
                const messages = settingsManager.get().locale === 'en-US' ? enUS : ptBR;
                const result = await dialog.showMessageBox({
                    type: 'question',
                    title: messages['updates.confirmTitle'],
                    message: messages['updates.confirmMessage'],
                    buttons: [messages['common.cancel'], messages['updates.restart']],
                    defaultId: 0,
                    cancelId: 0,
                    noLink: true,
                });
                return result.response === 1;
            },
        });

        // ── Register before-quit handler to persist session ────────────────────────
        app.on('before-quit', () => {
            desktopReady = false;
            background?.dispose();
            bandwidth.dispose();
            diagnostics.dispose();
            clearInterval(diskTimer);
            preparation.dispose();
            updates.dispose();
            downloadManager?.persistSession();
            metrics.persistSnapshot();
        });

        // ── Create main window ────────────────────────────────────────────────────
        const mainWindow = createMainWindow();

        // Register IPC handlers ONCE (global — survives window close/reopen on macOS).
        const magnetAssociation = createMagnetAssociation({
            app,
            openExternal: (url) => shell.openExternal(url),
        });
        registerIpcHandlers(downloadManager, settingsManager, torrentEngine, preparation, {
            updates,
            bandwidth,
            diagnostics,
            inbox: externalTorrents,
            registerMagnetHandler: () => magnetAssociation.register(),
            getMagnetHandlerStatus: () => magnetAssociation.getStatus(),
            openMagnetDefaultApps: () => magnetAssociation.openDefaultApps(),
        });

        // Attach per-window resources (progress interval, error forwarding).
        attachWindowEvents(downloadManager, torrentEngine, mainWindow, diagnostics);

        // ── Detectar crash do renderer process ────────────────────────────────────
        attachRendererCrashHandler(mainWindow);

        // Inicializar notificações nativas do OS com referência à janela principal
        createNotificationManager(downloadManager, settingsManager, { mainWindow });
        showMainWindow = () => {
            let window = BrowserWindow.getAllWindows()[0];
            if (!window) {
                const newWindow = createMainWindow();
                // Only attach per-window events — IPC handlers are already registered.
                attachWindowEvents(downloadManager!, torrentEngine, newWindow, diagnostics);
                attachRendererCrashHandler(newWindow);
                background?.attachWindow(newWindow);
                window = newWindow;
            }
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
        };
        background = createBackgroundController({
            manager: downloadManager,
            settings: settingsManager,
            iconPath: join(__dirname, '../../icon.png'),
            showWindow: () => showMainWindow(),
        });
        background.attachWindow(mainWindow);
        desktopReady = true;
        updates.start();
        app.on('activate', () => showMainWindow());
    })
    .catch((err: unknown) => {
        // Captura qualquer erro não tratado durante a inicialização do app.
        // Erros aqui são fatais — sem a janela principal o app não funciona.
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        logger.error('[Main] Falha crítica na inicialização do app:', message, stack);
        app.exit(1);
    });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ─── Renderer crash handler ───────────────────────────────────────────────────

/**
 * Detecta quando o renderer process crasha ou é encerrado inesperadamente.
 * Loga o motivo e persiste a sessão para evitar perda de dados.
 */
function attachRendererCrashHandler(window: BrowserWindow): void {
    window.webContents.on('render-process-gone', (_event, details) => {
        logger.error(
            '[CRASH] Renderer process encerrado:',
            `reason=${details.reason}`,
            `exitCode=${details.exitCode}`,
        );

        // Registrar nas métricas
        metrics.recordRendererCrash();

        // Persistir sessão ao detectar crash do renderer
        try {
            downloadManager?.persistSession();
        } catch (persistError) {
            logger.error(
                '[CRASH] Falha ao persistir sessão após crash do renderer:',
                String(persistError),
            );
        }

        // Para crashes recuperáveis, recarregar a janela automaticamente
        if (details.reason === 'crashed' || details.reason === 'oom') {
            logger.info('[CRASH] Tentando recarregar a janela...');
            try {
                if (!window.isDestroyed()) {
                    window.webContents.reload();
                }
            } catch {
                logger.error('[CRASH] Falha ao recarregar a janela');
            }
        }
    });
}
