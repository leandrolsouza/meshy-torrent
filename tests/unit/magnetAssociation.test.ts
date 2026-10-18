import { createMagnetAssociation } from '../../main/magnetAssociation';

function setup(platform: NodeJS.Platform = 'win32', defaultApp = true) {
    const executable = 'C:\\Meshy App\\electron.exe';
    const app = {
        getAppPath: jest.fn(() => 'C:\\Meshy Project'),
        setAsDefaultProtocolClient: jest.fn(() => true),
        isDefaultProtocolClient: jest.fn(() => true),
        getApplicationInfoForProtocol: jest.fn(async () => ({
            path: 'C:\\Program Files\\qBittorrent\\qbittorrent.exe',
            name: 'qBittorrent',
            icon: {} as Electron.NativeImage,
        })),
    };
    const writeRegistryValue = jest.fn(async () => { });
    const openExternal = jest.fn(async () => { });
    const association = createMagnetAssociation({
        app,
        platform,
        defaultApp,
        executable,
        writeRegistryValue,
        openExternal,
    });
    return { app, executable, writeRegistryValue, openExternal, association };
}

test('registro legado não afirma ser padrão quando o Windows ainda resolve qBittorrent', async () => {
    const { association, app } = setup();
    expect(await association.register()).toEqual({
        isDefault: false,
        canOpenDefaultApps: true,
        applicationName: 'Meshy Torrent (Dev)',
    });
    expect(app.isDefaultProtocolClient).toHaveBeenCalled();
    expect(app.getApplicationInfoForProtocol).toHaveBeenCalledWith('magnet:');
});

test('registro de desenvolvimento oferece Meshy nos padrões e preserva caminho de entrada com espaços', async () => {
    const { association, app, executable, writeRegistryValue } = setup();
    await association.register();
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('magnet', executable, [
        'C:\\Meshy Project',
    ]);
    const writes = writeRegistryValue.mock.calls as unknown as [string, string | null, string][];
    const command = writes.find(([key]) => key.endsWith('\\shell\\open\\command'));
    expect(command?.[2]).toBe('"C:\\Meshy App\\electron.exe" "C:\\Meshy Project" "%1"');
    const mapping = writes.find(([key]) => key.endsWith('\\URLAssociations'));
    expect(mapping?.slice(1)).toEqual(['magnet', 'org.meshy.client.dev.magnet']);
    expect(writes.find(([key]) => key === 'HKCU\\Software\\RegisteredApplications')?.[1]).toBe(
        'Meshy Torrent (Dev)',
    );
    expect(writes.every(([key]) => key.startsWith('HKCU\\') && !key.includes('UserChoice'))).toBe(
        true,
    );
});

test('consulta confirma o executável efetivo e ignora diferenças de caixa no Windows', async () => {
    const { association, app, executable } = setup();
    app.getApplicationInfoForProtocol.mockResolvedValueOnce({
        path: executable.toUpperCase(),
        name: 'Electron',
        icon: {} as Electron.NativeImage,
    });
    expect(await association.getStatus()).toMatchObject({ isDefault: true });
});

test('falha na consulta efetiva não apresenta sucesso e permite escolher pelo sistema', async () => {
    const { association, app } = setup();
    app.getApplicationInfoForProtocol.mockRejectedValueOnce(new Error('No association'));
    expect(await association.getStatus()).toMatchObject({
        isDefault: false,
        canOpenDefaultApps: true,
    });
});

test('versão instalada registra somente seu executável, sem entrada de desenvolvimento', async () => {
    const { association, app, executable, writeRegistryValue } = setup('win32', false);
    await association.register();
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('magnet', executable, []);
    const writes = writeRegistryValue.mock.calls as unknown as [string, string | null, string][];
    expect(writes.find(([key]) => key.endsWith('\\shell\\open\\command'))?.[2]).toBe(
        '"C:\\Meshy App\\electron.exe" "%1"',
    );
});

test('abre somente a página fixa do sistema para o aplicativo registrado', async () => {
    const { association, openExternal } = setup();
    await association.openDefaultApps();
    expect(openExternal).toHaveBeenCalledWith(
        'ms-settings:defaultapps?registeredAppUser=Meshy%20Torrent%20(Dev)',
    );
});

test.each(['darwin', 'linux'] as const)(
    'não usa registro ou configurações Windows em %s',
    async (platform) => {
        const { association, writeRegistryValue, openExternal } = setup(platform, false);
        expect(await association.register()).toMatchObject({
            isDefault: true,
            canOpenDefaultApps: false,
        });
        expect(writeRegistryValue).not.toHaveBeenCalled();
        await expect(association.openDefaultApps()).rejects.toThrow(
            'error.system.protocolRegistration',
        );
        expect(openExternal).not.toHaveBeenCalled();
    },
);

test('falha no registro não retorna status de sucesso', async () => {
    const { association, app } = setup();
    app.setAsDefaultProtocolClient.mockReturnValueOnce(false);
    await expect(association.register()).rejects.toThrow('error.system.protocolRegistration');
});

test('falha ao escrever capabilities não anuncia registro nem altera o cliente legado', async () => {
    const { association, app, writeRegistryValue } = setup();
    writeRegistryValue.mockRejectedValueOnce(new Error('Access denied'));
    await expect(association.register()).rejects.toThrow('error.system.protocolRegistration');
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
});
