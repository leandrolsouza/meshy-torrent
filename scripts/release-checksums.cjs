/* global require, process, __dirname, console */
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { stat, writeFile, readFile } = require('node:fs/promises');
const { load, FAILSAFE_SCHEMA } = require('js-yaml');
const { resolve, join } = require('node:path');
const { version } = require('../package.json');
const { productName } = require('../electron-builder.json');

async function main() {
    const directory = resolve(process.argv[2] || join(__dirname, '../dist'));
    const fileName = `${productName}-${version}-win-x64-setup.exe`;
    const installer = join(directory, fileName);
    if (!(await stat(installer)).isFile()) {
        throw new Error(`Instalador indisponível: ${fileName}`);
    }

    const hash = createHash('sha256');
    const updateHash = createHash('sha512');
    for await (const chunk of createReadStream(installer)) {
        hash.update(chunk);
        updateHash.update(chunk);
    }
    const sha512 = updateHash.digest('base64');
    const manifest = load(await readFile(join(directory, 'latest.yml'), 'utf8'), {
        schema: FAILSAFE_SCHEMA,
    });
    if (
        manifest?.version !== version ||
        !Array.isArray(manifest.files) ||
        !manifest.files.some((file) => file.url === fileName && file.sha512 === sha512)
    )
        throw new Error(
            'Manifesto de atualização ausente, obsoleto ou incompatível com o instalador',
        );

    const lines = [`${hash.digest('hex')}  ${fileName}`];
    for (const asset of [`${fileName}.blockmap`, 'latest.yml']) {
        const assetHash = createHash('sha256');
        for await (const chunk of createReadStream(join(directory, asset))) assetHash.update(chunk);
        lines.push(`${assetHash.digest('hex')}  ${asset}`);
    }
    await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
    console.log(`SHA256SUMS gerado para instalador, blockmap e manifesto de atualização`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
