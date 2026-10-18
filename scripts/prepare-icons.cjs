/* global require, process, __dirname, __filename, console */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Converte o ícone existente para a resolução exigida pelos instaladores.
// A imagem fonte permanece intacta; o resultado pertence ao build.
if (process.versions.electron) {
    const { app, nativeImage } = require('electron');
    app.whenReady()
        .then(() => {
            const root = join(__dirname, '..');
            const icon = nativeImage.createFromPath(join(root, 'icon.png'));
            if (icon.isEmpty()) throw new Error('Ícone do Meshy Torrent indisponível');
            const destination = join(root, '.build-resources');
            mkdirSync(destination, { recursive: true });
            writeFileSync(
                join(destination, 'icon.png'),
                icon.resize({ width: 512, height: 512, quality: 'best' }).toPNG(),
            );
            app.quit();
        })
        .catch((error) => {
            console.error(error);
            app.exit(1);
        });
} else {
    const { execFileSync } = require('node:child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
}
