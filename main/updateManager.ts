import type { AppUpdater } from 'electron-updater';
import type { AppUpdateStatus, UpdateDisabledReason } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';
import { logger } from './logger';

export type UpdateDriver = Pick<
    AppUpdater,
    | 'autoDownload'
    | 'autoInstallOnAppQuit'
    | 'allowPrerelease'
    | 'allowDowngrade'
    | 'disableWebInstaller'
    | 'logger'
    | 'checkForUpdates'
    | 'quitAndInstall'
    | 'on'
    | 'removeListener'
>;

export function createUpdateManager(options: {
    driver: UpdateDriver;
    currentVersion: string;
    disabledReason: UpdateDisabledReason | undefined;
    publish: (status: AppUpdateStatus) => void;
    persistSession: () => void | Promise<void>;
    confirmInstall: () => Promise<boolean>;
    setQuitting: (value: boolean) => void;
}) {
    const { driver } = options;
    let disposed = false;
    let started = false;
    let checking = false;
    let confirming = false;
    let startup: ReturnType<typeof setTimeout> | undefined;
    let periodic: ReturnType<typeof setInterval> | undefined;
    let installation: ReturnType<typeof setImmediate> | undefined;
    let status: AppUpdateStatus = {
        revision: 0,
        currentVersion: options.currentVersion,
        phase: options.disabledReason ? 'disabled' : 'idle',
        ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
    };
    driver.autoDownload = true;
    // O instalador só inicia após confirmação; nunca durante shutdown/logoff do OS.
    driver.autoInstallOnAppQuit = false;
    driver.allowPrerelease = options.currentVersion.split('+')[0]?.includes('-') ?? false;
    driver.allowDowngrade = false;
    driver.disableWebInstaller = true;
    driver.logger = null;

    const snapshot = () => ({ ...status });
    const change = (next: Omit<AppUpdateStatus, 'revision' | 'currentVersion'>) => {
        if (disposed) return;
        status = { ...next, revision: status.revision + 1, currentVersion: options.currentVersion };
        try {
            options.publish(snapshot());
        } catch {
            logger.warn('[Updates] Não foi possível notificar a interface');
        }
    };
    const failed = () => {
        if (disposed) return;
        if (status.phase === 'installing') options.setQuitting(false);
        logger.warn('[Updates] Operação de atualização falhou');
        change({ phase: 'error', error: ErrorCodes.UPDATE_FAILED });
    };
    const onChecking = () => change({ phase: 'checking' });
    const onAvailable = (info: { version: string }) =>
        change({ phase: 'downloading', availableVersion: info.version, percent: 0 });
    const onNotAvailable = () => change({ phase: 'upToDate' });
    const onProgress = (info: { percent: number }) => {
        if (status.phase !== 'downloading' || !Number.isFinite(info.percent)) return;
        change({
            phase: 'downloading',
            ...(status.availableVersion ? { availableVersion: status.availableVersion } : {}),
            percent: Math.min(100, Math.max(0, info.percent)),
        });
    };
    const onDownloaded = (info: { version: string }) => {
        logger.info('[Updates] Atualização verificada e pronta para instalar');
        change({ phase: 'downloaded', availableVersion: info.version, percent: 100 });
    };
    // Em builds desabilitados não conecte eventos que possam habilitar a instalação.
    if (!options.disabledReason) {
        driver.on('checking-for-update', onChecking);
        driver.on('update-available', onAvailable);
        driver.on('update-not-available', onNotAvailable);
        driver.on('download-progress', onProgress);
        driver.on('update-downloaded', onDownloaded);
        driver.on('error', failed);
    }

    const check = (): AppUpdateStatus => {
        if (disposed || options.disabledReason) throw new Error(ErrorCodes.UPDATE_UNAVAILABLE);
        if (checking || ['downloading', 'downloaded', 'installing'].includes(status.phase))
            return snapshot();
        checking = true;
        change({ phase: 'checking' });
        // Resposta IPC imediata; rede/download são acompanhados pelos eventos.
        void Promise.resolve()
            .then(() => (disposed ? null : driver.checkForUpdates()))
            .then((result) => {
                if (result?.downloadPromise) void result.downloadPromise.catch(failed);
                else if (!disposed && status.phase === 'checking') change({ phase: 'idle' });
            })
            .catch(failed)
            .finally(() => {
                checking = false;
            });
        return snapshot();
    };

    return {
        getStatus: snapshot,
        check,
        start() {
            if (started || disposed || options.disabledReason) return;
            started = true;
            startup = setTimeout(() => {
                check();
            }, 30_000);
            periodic = setInterval(
                () => {
                    check();
                },
                6 * 60 * 60 * 1000,
            );
            startup.unref();
            periodic.unref();
        },
        async install(): Promise<AppUpdateStatus> {
            if (disposed || options.disabledReason) throw new Error(ErrorCodes.UPDATE_UNAVAILABLE);
            if (status.phase !== 'downloaded') throw new Error(ErrorCodes.UPDATE_NOT_READY);
            if (confirming) return snapshot();
            confirming = true;
            try {
                if (!(await options.confirmInstall()) || disposed) return snapshot();
                if (status.phase !== 'downloaded') throw new Error(ErrorCodes.UPDATE_NOT_READY);
                // Erro de persistência deve impedir a atualização e permitir nova tentativa.
                try {
                    await options.persistSession();
                } catch {
                    throw new Error(ErrorCodes.UPDATE_SESSION_FAILED);
                }
                options.setQuitting(true);
                change({
                    phase: 'installing',
                    ...(status.availableVersion
                        ? { availableVersion: status.availableVersion }
                        : {}),
                });
                installation = setImmediate(() => {
                    if (disposed || status.phase !== 'installing') return;
                    try {
                        driver.quitAndInstall(true, true);
                    } catch {
                        failed();
                    }
                });
                return snapshot();
            } finally {
                confirming = false;
            }
        },
        dispose() {
            disposed = true;
            clearTimeout(startup);
            clearInterval(periodic);
            if (installation) clearImmediate(installation);
            driver.removeListener('checking-for-update', onChecking);
            driver.removeListener('update-available', onAvailable);
            driver.removeListener('update-not-available', onNotAvailable);
            driver.removeListener('download-progress', onProgress);
            driver.removeListener('update-downloaded', onDownloaded);
            driver.removeListener('error', failed);
        },
    };
}

export type UpdateManager = ReturnType<typeof createUpdateManager>;
