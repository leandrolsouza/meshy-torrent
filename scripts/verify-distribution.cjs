/* global require, module */
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const asar = require('@electron/asar');

module.exports = async function verifyDistribution(context) {
    if (context.electronPlatformName !== 'win32') return;
    const resources = join(context.appOutDir, 'resources');
    const notices = readFileSync(join(resources, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const required of ['node-datachannel@', 'libdatachannel', 'Microsoft', 'MPL', 'CC BY 4.0'])
        if (!notices.includes(required)) throw new Error(`Aviso ausente: ${required}`);
    for (const required of ['LICENSE.electron.txt', 'LICENSES.chromium.html'])
        if (!existsSync(join(context.appOutDir, required)))
            throw new Error(`Aviso do runtime ausente: ${required}`);
    const entries = asar.listPackage(join(resources, 'app.asar'));
    if (
        entries.some((entry) =>
            entry.split('\\').join('/').startsWith('/node_modules/react-icons/'),
        )
    )
        throw new Error('Fontes de coleções de ícones não utilizadas entraram no pacote');
    const native = readFileSync(
        join(
            resources,
            'app.asar.unpacked/node_modules/node-datachannel/build/Release/node_datachannel.node',
        ),
    ).toString('latin1');
    if (!native.includes('OpenSSL 3.6.2 '))
        throw new Error('Versão OpenSSL do prebuild mudou: revise os avisos nativos');
};
