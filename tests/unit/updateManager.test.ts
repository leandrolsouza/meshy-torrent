import { EventEmitter } from 'events';
import { createUpdateManager } from '../../main/updateManager';
import type { UpdateDriver } from '../../main/updateManager';
import { getUpdateDisabledReason } from '../../main/updatePolicy';
import type { UpdateDisabledReason } from '../../shared/types';
import { ErrorCodes } from '../../shared/errorCodes';

function setup(
    disabledReason: UpdateDisabledReason | undefined = undefined,
    version = '0.1.0-beta.1',
) {
    const driver = Object.assign(new EventEmitter(), {
        autoDownload: false,
        autoInstallOnAppQuit: true,
        allowPrerelease: false,
        allowDowngrade: true,
        disableWebInstaller: false,
        logger: null,
        checkForUpdates: jest.fn<Promise<unknown>, []>(async () => null),
        quitAndInstall: jest.fn(),
    });
    const publish = jest.fn();
    const persistSession = jest.fn();
    const confirmInstall = jest.fn(async () => true);
    const setQuitting = jest.fn();
    const manager = createUpdateManager({
        driver: driver as unknown as UpdateDriver,
        currentVersion: version,
        disabledReason,
        publish,
        persistSession,
        confirmInstall,
        setQuitting,
    });
    return { manager, driver, publish, persistSession, confirmInstall, setQuitting };
}

const flush = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('verifica ao iniciar e periodicamente uma única vez, sem instalar no encerramento normal', async () => {
    const { manager, driver } = setup();
    manager.start();
    manager.start();
    expect(driver.autoDownload).toBe(true);
    expect(driver.autoInstallOnAppQuit).toBe(false);
    expect(driver.allowPrerelease).toBe(true);
    expect(driver.allowDowngrade).toBe(false);
    expect(driver.disableWebInstaller).toBe(true);
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(6 * 60 * 60 * 1000);
    await flush();
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(2);
    manager.dispose();
    expect(jest.getTimerCount()).toBe(0);
    expect(driver.listenerCount('update-downloaded')).toBe(0);
});

test.each(['0.1.0', '0.1.0+build-42'])(
    'versão estável %s não recebe pré-release nem downgrade',
    (version) => {
        const { manager, driver } = setup(undefined, version);
        expect(driver.allowPrerelease).toBe(false);
        expect(driver.allowDowngrade).toBe(false);
        manager.dispose();
    },
);

test.each<UpdateDisabledReason>(['development', 'platform', 'configuration'])(
    'bloqueia verificações e instalação quando desabilitado por %s',
    async (reason) => {
        const { manager, driver } = setup(reason);
        manager.start();
        jest.advanceTimersByTime(24 * 60 * 60 * 1000);
        expect(manager.getStatus()).toMatchObject({ phase: 'disabled', disabledReason: reason });
        expect(() => manager.check()).toThrow(ErrorCodes.UPDATE_UNAVAILABLE);
        await expect(manager.install()).rejects.toThrow(ErrorCodes.UPDATE_UNAVAILABLE);
        driver.emit('update-downloaded', { version: '0.1.0-beta.2' });
        expect(manager.getStatus().phase).toBe('disabled');
        expect(driver.checkForUpdates).not.toHaveBeenCalled();
        expect(driver.quitAndInstall).not.toHaveBeenCalled();
        manager.dispose();
    },
);

test('deduplica consultas, acompanha progresso e só fica atualizado após resposta do feed', async () => {
    const { manager, driver } = setup();
    let finish!: (value: unknown) => void;
    driver.checkForUpdates.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    expect(manager.getStatus().phase).toBe('idle');
    manager.check();
    manager.check();
    await flush();
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    driver.emit('update-available', { version: '0.1.0-beta.2' });
    driver.emit('download-progress', { percent: 42 });
    expect(manager.getStatus()).toMatchObject({ phase: 'downloading', percent: 42 });
    manager.check();
    finish(null);
    await flush();
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    driver.emit('update-not-available', {});
    expect(manager.getStatus().phase).toBe('upToDate');
    manager.dispose();
});

test('instala somente após download verificado, confirmação e persistência, liberando a bandeja', async () => {
    const { manager, driver, confirmInstall, persistSession, setQuitting } = setup();
    await expect(manager.install()).rejects.toThrow(ErrorCodes.UPDATE_NOT_READY);
    driver.emit('update-downloaded', { version: '0.1.0-beta.2' });
    confirmInstall.mockResolvedValueOnce(false);
    await manager.install();
    expect(persistSession).not.toHaveBeenCalled();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect((await manager.install()).phase).toBe('installing');
    expect(persistSession).toHaveBeenCalledTimes(1);
    expect(setQuitting).toHaveBeenCalledWith(true);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    expect(driver.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(persistSession.mock.invocationCallOrder[0]).toBeLessThan(
        driver.quitAndInstall.mock.invocationCallOrder[0]!,
    );
    await expect(manager.install()).rejects.toThrow(ErrorCodes.UPDATE_NOT_READY);
    manager.dispose();
});

test('falha ao salvar a sessão impede instalar e preserva o download para tentar novamente', async () => {
    const { manager, driver, persistSession, setQuitting } = setup();
    driver.emit('update-downloaded', { version: '0.1.0-beta.2' });
    persistSession.mockImplementation(async () => {
        throw new Error('disco indisponível');
    });
    await expect(manager.install()).rejects.toThrow(ErrorCodes.UPDATE_SESSION_FAILED);
    jest.advanceTimersByTime(0);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(setQuitting).not.toHaveBeenCalled();
    expect(manager.getStatus().phase).toBe('downloaded');
    manager.dispose();
});

test('deduplica confirmação e restaura fechamento na bandeja se o instalador falhar', async () => {
    const { manager, driver, confirmInstall, setQuitting } = setup();
    let confirm!: (value: boolean) => void;
    confirmInstall.mockImplementation(
        () =>
            new Promise((resolve) => {
                confirm = resolve;
            }),
    );
    driver.emit('update-downloaded', { version: '0.1.0-beta.2' });
    const installing = manager.install();
    await manager.install();
    expect(confirmInstall).toHaveBeenCalledTimes(1);
    confirm(true);
    await installing;
    driver.quitAndInstall.mockImplementation(() => {
        throw new Error('falhou');
    });
    jest.advanceTimersByTime(0);
    expect(setQuitting).toHaveBeenLastCalledWith(false);
    expect(manager.getStatus()).toMatchObject({ phase: 'error', error: ErrorCodes.UPDATE_FAILED });
    manager.dispose();
});

test('trata rejeições de consulta e download sem enviar detalhes internos ao renderer', async () => {
    const { manager, driver, publish } = setup();
    driver.checkForUpdates.mockRejectedValueOnce(new Error('C:\\pasta-pessoal\\segredo'));
    manager.check();
    await flush();
    expect(manager.getStatus()).toMatchObject({ phase: 'error', error: ErrorCodes.UPDATE_FAILED });
    driver.checkForUpdates.mockResolvedValueOnce({
        downloadPromise: Promise.reject(new Error('checksum incorreto')),
    });
    manager.check();
    await flush();
    expect(manager.getStatus().error).toBe(ErrorCodes.UPDATE_FAILED);
    expect(JSON.stringify(publish.mock.calls)).not.toContain('segredo');
    expect(JSON.stringify(publish.mock.calls)).not.toContain('checksum incorreto');
    manager.dispose();
});

test('descarta conclusões tardias após dispose e trata a rejeição do download pendente', async () => {
    const { manager, driver, publish } = setup();
    let finish!: (value: unknown) => void;
    driver.checkForUpdates.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    manager.check();
    await flush();
    manager.dispose();
    publish.mockClear();
    finish({ downloadPromise: Promise.reject(new Error('rede encerrada')) });
    await flush();
    expect(publish).not.toHaveBeenCalled();
});

test('falha de verificação não permite instalar, mesmo com download iniciado', async () => {
    const { manager, driver } = setup();
    driver.emit('update-available', { version: '0.1.0-beta.2' });
    driver.emit('error', new Error('assinatura ou hash inválido'));
    await expect(manager.install()).rejects.toThrow(ErrorCodes.UPDATE_NOT_READY);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    manager.dispose();
});

test('erro antes da instalação agendada cancela a saída e não executa o instalador', async () => {
    const { manager, driver, setQuitting } = setup();
    driver.emit('update-downloaded', { version: '0.1.0-beta.2' });
    await manager.install();
    driver.emit('error', new Error('cache removido'));
    jest.advanceTimersByTime(0);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(setQuitting).toHaveBeenLastCalledWith(false);
    manager.dispose();
});

test('dispose antes da microtask impede iniciar uma consulta de rede', async () => {
    const { manager, driver } = setup();
    manager.check();
    manager.dispose();
    await flush();
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
});

const signedConfig = {
    provider: 'github',
    owner: 'leandrolsouza',
    repo: 'meshy-torrent',
    publisherName: ['Editor de teste'],
};
const policy = (configuration: unknown) =>
    getUpdateDisabledReason({ isPackaged: true, platform: 'win32', arch: 'x64', configuration });

test('limita atualizações ao feed oficial e aceita builds sem certificado', () => {
    expect(policy(signedConfig)).toBeUndefined();
    expect(policy({ ...signedConfig, publisherName: undefined })).toBeUndefined();
    expect(policy({ ...signedConfig, publisherName: null })).toBeUndefined();
    expect(policy({ ...signedConfig, publisherName: [] })).toBe('configuration');
    expect(policy({ ...signedConfig, publisherName: [' '] })).toBe('configuration');
    expect(policy({ ...signedConfig, publisherName: [12] })).toBe('configuration');
    expect(policy({ ...signedConfig, repo: 'outro' })).toBe('configuration');
    expect(policy({ ...signedConfig, protocol: 'http' })).toBe('configuration');
    expect(policy(null)).toBe('configuration');
    expect(
        getUpdateDisabledReason({
            isPackaged: false,
            platform: 'win32',
            arch: 'x64',
            configuration: signedConfig,
        }),
    ).toBe('development');
    expect(
        getUpdateDisabledReason({
            isPackaged: true,
            platform: 'linux',
            arch: 'x64',
            configuration: signedConfig,
        }),
    ).toBe('platform');
});
