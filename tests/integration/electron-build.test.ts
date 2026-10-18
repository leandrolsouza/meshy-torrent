import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { MeshyAPI } from '../../shared/types';

interface BuiltEntry {
    fileName: string;
    imports: string[];
    code: string;
}

describe('build Electron', () => {
    it('preserva imports do main e executa o preload com os recursos do sandbox', async () => {
        // Compila em memória: não inicia Electron nem acessa a sessão do usuário.
        const output = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `
                    import { resolveConfig } from 'electron-vite';
                    import { build } from 'vite';
                    const { config } = await resolveConfig({}, 'build', 'production');
                    const entries = {};
                    for (const target of ['main', 'preload']) {
                        const result = await build({
                            ...config[target],
                            logLevel: 'silent',
                            build: { ...config[target].build, write: false },
                        });
                        entries[target] = result.output.find(chunk => chunk.isEntry);
                    }
                    process.stdout.write(JSON.stringify(entries));
                `,
            ],
            { cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000 },
        );
        const entries = JSON.parse(output) as { main: BuiltEntry; preload: BuiltEntry };

        expect(entries.main.fileName).toBe('index.mjs');
        expect(entries.main.imports).toEqual(expect.arrayContaining(['electron', 'webtorrent']));
        expect(entries.preload.fileName).toBe('index.js');

        const exposeInMainWorld = jest.fn();
        const invoke = jest.fn().mockResolvedValue({ success: true, data: [] });
        runInNewContext(entries.preload.code, {
            require: (name: string) => {
                if (name !== 'electron') throw new Error(`Import indisponível no sandbox: ${name}`);
                return {
                    contextBridge: { exposeInMainWorld },
                    ipcRenderer: { invoke },
                };
            },
        });

        expect(exposeInMainWorld).toHaveBeenCalledWith('meshy', expect.any(Object));
        const api = exposeInMainWorld.mock.calls[0][1] as MeshyAPI;
        await api.getAll();
        expect(invoke).toHaveBeenCalledWith('torrent:get-all');
        await api.registerMagnetHandler();
        expect(invoke).toHaveBeenCalledWith('app:register-magnet-handler');
        await api.getMagnetHandlerStatus();
        expect(invoke).toHaveBeenCalledWith('app:get-magnet-handler-status');
        await api.openMagnetDefaultApps();
        expect(invoke).toHaveBeenCalledWith('app:open-magnet-default-apps');
        await api.getUpdateStatus();
        expect(invoke).toHaveBeenCalledWith('app:update-status');
        await api.checkForUpdates();
        expect(invoke).toHaveBeenCalledWith('app:check-updates');
        await api.installUpdate();
        expect(invoke).toHaveBeenCalledWith('app:install-update');
    });
});
