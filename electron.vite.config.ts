import { isAbsolute, resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const torrentPackages = ['webtorrent', 'torrent-discovery', 'bittorrent-tracker'];
const udpTrackerModule = '/bittorrent-tracker/lib/client/udp-tracker.js';

export default defineConfig({
    main: {
        plugins: [
            {
                name: 'meshy-torrent-transports',
                enforce: 'pre',
                configResolved(config) {
                    // O preset Electron adiciona uma lista de builtins; substitua após o merge
                    // para permitir somente a troca de dgram no cliente de tracker UDP.
                    config.build.rollupOptions.external = (id, importer) => {
                        if (id === 'cross-fetch-ponyfill') return false;
                        if (
                            id === 'dgram' &&
                            importer?.replace(/\\/g, '/').endsWith(udpTrackerModule)
                        )
                            return false;
                        return (
                            !id.startsWith('.') &&
                            !id.startsWith('\0') &&
                            !isAbsolute(id) &&
                            !torrentPackages.some(
                                (name) => id === name || id.startsWith(`${name}/`),
                            )
                        );
                    };
                },
                resolveId(source, importer) {
                    if (source === 'cross-fetch-ponyfill')
                        return resolve(__dirname, 'main/torrentHttpTransport.ts');
                    if (
                        source === 'dgram' &&
                        importer?.replace(/\\/g, '/').endsWith(udpTrackerModule)
                    )
                        return resolve(__dirname, 'main/torrentUdpTransport.ts');
                    return null;
                },
            },
        ],
        build: {
            // Estas três bibliotecas entram no bundle para vincular seus transportes.
            // As demais dependências (inclusive módulos nativos) continuam externas.
            externalizeDeps: false,
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'main/index.ts'),
                },
                output: {
                    format: 'es',
                    entryFileNames: '[name].mjs',
                },
            },
        },
    },
    preload: {
        build: {
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'electron/preload.ts'),
                },
            },
        },
    },
    renderer: {
        root: resolve(__dirname, 'src'),
        publicDir: resolve(__dirname, 'src/public'),
        build: {
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'src/index.html'),
                },
            },
        },
        resolve: {
            alias: {
                '@renderer': resolve(__dirname, 'src'),
            },
        },
        plugins: [react()],
    },
});
