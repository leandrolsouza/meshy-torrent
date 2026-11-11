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
const run = mkdtempSync(join(output, 'metadata-'));
const { config } = await resolveConfig({}, 'build', 'production');
await build({
    ...config.main,
    build: {
        ...config.main.build,
        outDir: output,
        emptyOutDir: false,
        rollupOptions: {
            ...config.main.build.rollupOptions,
            input: join(root, 'scripts/qa/metadata-capability.mjs'),
            output: { format: 'es', entryFileNames: 'metadata-capability.mjs' },
        },
    },
});
const result = spawnSync(electron, [join(output, 'metadata-capability.mjs')], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MESHY_QA_ROOT: run },
    encoding: 'utf8',
    timeout: 40_000,
    windowsHide: true,
});
writeFileSync(join(run, 'metadata.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
if (result.error || result.status !== 0) {
    console.error(result.stdout, result.stderr, result.error?.message ?? '');
    throw new Error(`Falha no ensaio de metadados; evidências em ${run}`);
}
console.log(result.stdout.trim());
console.log(`Evidências preservadas em ${run}`);
