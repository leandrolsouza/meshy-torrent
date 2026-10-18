/* global process, console */
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { resolveConfig } from 'electron-vite';
import electron from 'electron';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, '.build-resources/qa');
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, 'run-'));
const { config } = await resolveConfig({}, 'build', 'production');
await build({
    ...config.main,
    build: {
        ...config.main.build,
        outDir: output,
        emptyOutDir: false,
        rollupOptions: {
            ...config.main.build.rollupOptions,
            input: {
                transfer: join(root, 'scripts/qa/transfer.mjs'),
                renderer: join(root, 'scripts/qa/renderer.mjs'),
            },
            output: {
                format: 'es',
                entryFileNames: '[name].mjs',
                chunkFileNames: 'chunks/[name]-[hash].mjs',
            },
        },
    },
});
if (!process.argv.includes('--renderer-only')) {
    const result = spawnSync(electron, [join(output, 'transfer.mjs'), run], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MESHY_QA_ROOT: run },
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
    });
    writeFileSync(join(run, 'transfer.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (result.error || result.status !== 0) {
        console.error(result.stdout, result.stderr, result.error?.message ?? '');
        throw new Error(`Falha na transferência real; evidências em ${run}`);
    }
    console.log(result.stdout.trim());
}
if (!process.argv.includes('--transfer-only')) {
    const env = { ...process.env, MESHY_QA_ROOT: run, MESHY_QA_WORKSPACE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const renderer = spawnSync(electron, [join(root, 'scripts/qa/startup.cjs')], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true,
    });
    writeFileSync(join(run, 'renderer.log'), `${renderer.stdout ?? ''}\n${renderer.stderr ?? ''}`);
    if (renderer.error || renderer.status !== 0) {
        console.error(renderer.stdout, renderer.stderr, renderer.error?.message ?? '');
        throw new Error(`Falha na inicialização do renderer; evidências em ${run}`);
    }
    console.log(renderer.stdout.trim());
}
console.log(`Evidências preservadas em ${run}`);
