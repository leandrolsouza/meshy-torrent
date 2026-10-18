import { execFile } from 'child_process';
import { join, resolve, win32 } from 'path';
import { promisify } from 'util';
import type { App } from 'electron';
import type { MagnetHandlerStatus } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';

const execFileAsync = promisify(execFile);
type AssociationApp = Pick<
    App,
    | 'getAppPath'
    | 'setAsDefaultProtocolClient'
    | 'isDefaultProtocolClient'
    | 'getApplicationInfoForProtocol'
>;

interface MagnetAssociationDependencies {
    app: AssociationApp;
    openExternal: (url: string) => Promise<void>;
    platform?: NodeJS.Platform;
    executable?: string;
    defaultApp?: boolean;
    writeRegistryValue?: (key: string, name: string | null, value: string) => Promise<void>;
}

async function writeRegistryValue(key: string, name: string | null, value: string): Promise<void> {
    // Argumentos separados e executável do sistema: nenhum comando de shell ou caminho do renderer.
    await execFileAsync(
        join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe'),
        [
            'add',
            key,
            ...(name === null ? ['/ve'] : ['/v', name]),
            '/t',
            'REG_SZ',
            '/d',
            value,
            '/f',
        ],
        { windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 },
    );
}

function quoteWindowsArgument(value: string): string {
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/** Registra o cliente e consulta a associação efetiva, sem substituir a escolha protegida do SO. */
export function createMagnetAssociation({
    app,
    openExternal,
    platform = process.platform,
    executable = process.execPath,
    defaultApp = process.defaultApp ?? false,
    writeRegistryValue: writeValue = writeRegistryValue,
}: MagnetAssociationDependencies) {
    const applicationName = defaultApp ? 'Meshy Torrent (Dev)' : 'Meshy Torrent';
    const applicationId = defaultApp ? 'org.meshy.client.dev' : 'org.meshy.client';
    const progId = `${applicationId}.magnet`;
    const capabilities = `Software\\${applicationId}\\Capabilities`;
    const launchArgs = defaultApp ? [resolve(app.getAppPath())] : [];

    const getStatus = async (): Promise<MagnetHandlerStatus> => {
        let isDefault = app.isDefaultProtocolClient('magnet', executable, launchArgs);
        if (platform === 'win32') {
            try {
                // isDefaultProtocolClient só compara Software\Classes\magnet no Windows.
                // A resolução efetiva pode continuar apontando para outro ProgID (ex.: qBittorrent).
                const handler = await app.getApplicationInfoForProtocol('magnet:');
                isDefault =
                    isDefault &&
                    win32.resolve(handler.path).toLowerCase() ===
                    win32.resolve(executable).toLowerCase();
            } catch {
                isDefault = false;
            }
        }
        return { isDefault, canOpenDefaultApps: platform === 'win32', applicationName };
    };

    return {
        getStatus,
        async register(): Promise<MagnetHandlerStatus> {
            try {
                if (platform === 'win32') {
                    const classKey = `HKCU\\Software\\Classes\\${progId}`;
                    const command = [executable, ...launchArgs]
                        .map(quoteWindowsArgument)
                        .concat('"%1"')
                        .join(' ');
                    // Capabilities tornam o Meshy Torrent uma opção nos Aplicativos padrão, inclusive em dev.
                    await writeValue(classKey, null, `${applicationName} magnet`);
                    await writeValue(classKey, 'URL Protocol', '');
                    await writeValue(
                        `${classKey}\\DefaultIcon`,
                        null,
                        `${quoteWindowsArgument(executable)},0`,
                    );
                    await writeValue(`${classKey}\\shell\\open\\command`, null, command);
                    await writeValue(`HKCU\\${capabilities}`, 'ApplicationName', applicationName);
                    await writeValue(
                        `HKCU\\${capabilities}`,
                        'ApplicationDescription',
                        'Meshy Torrent BitTorrent client',
                    );
                    await writeValue(`HKCU\\${capabilities}\\URLAssociations`, 'magnet', progId);
                    await writeValue(
                        'HKCU\\Software\\RegisteredApplications',
                        applicationName,
                        capabilities,
                    );
                }
                if (!app.setAsDefaultProtocolClient('magnet', executable, launchArgs)) {
                    throw new Error(ErrorCodes.PROTOCOL_REGISTRATION_FAILED);
                }
                return await getStatus();
            } catch (error) {
                throw Object.assign(new Error(ErrorCodes.PROTOCOL_REGISTRATION_FAILED), {
                    cause: error,
                });
            }
        },
        async openDefaultApps(): Promise<void> {
            if (platform !== 'win32') throw new Error(ErrorCodes.PROTOCOL_REGISTRATION_FAILED);
            await openExternal(
                `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(applicationName)}`,
            );
        },
    };
}
