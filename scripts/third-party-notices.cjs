/* global require, module, process, __dirname, console */
const { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = resolve(__dirname, '..');
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const isNotice = (name) => /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(name);

function renderPackage(directory, fallbacks, templates) {
    const pkg = JSON.parse(read(join(directory, 'package.json')));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const author = typeof pkg.author === 'string' ? pkg.author : JSON.stringify(pkg.author ?? '');
    const notices = readdirSync(directory)
        .filter((file) => isNotice(file) && statSync(join(directory, file)).isFile())
        .sort();
    const parts = [
        `${pkg.name}@${pkg.version}`,
        `Licença declarada: ${pkg.license ?? 'ver texto original abaixo'}`,
        `Autoria declarada: ${author}`,
        `Repositório: ${repo ?? pkg.homepage ?? 'ver package.json'}`,
    ];
    for (const notice of notices) parts.push(`--- ${notice} ---\n${read(join(directory, notice))}`);
    if (!notices.length) {
        const readme = readdirSync(directory).find((name) => /^readme(\.|$)/i.test(name));
        const original = readme ? read(join(directory, readme)) : '';
        parts.push(`--- README original ---\n${original}`);
        if (!original.includes('Permission is hereby granted')) {
            const reviewed = fallbacks.find(
                (entry) => entry.name === pkg.name && entry.version === pkg.version,
            );
            if (!reviewed || reviewed.declaredLicense !== pkg.license || !templates[reviewed.terms])
                throw new Error(`Aviso de licença exige revisão: ${pkg.name}@${pkg.version}`);
            parts.push(
                `Revisão: ${reviewed.reason}\nFonte: ${reviewed.source}`,
                `--- Condições ${reviewed.terms}; atribuição original acima ---\n${templates[reviewed.terms]}`,
            );
        }
    }
    return parts.join('\n\n');
}

function main() {
    if (!process.env.npm_execpath) throw new Error('Execute npm run release:notices');
    const output = execFileSync(
        process.execPath,
        [process.env.npm_execpath, 'ls', '--omit=dev', '--all', '--parseable'],
        { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    const directories = [...new Set(output.trim().split(/\r?\n/))].filter(
        (directory) => resolve(directory) !== root,
    );
    const fallbacks = require('../third-party/npm-fallbacks.json');
    const sources = require('../third-party/sources.json').sources;
    const originals = new Map();
    for (const source of sources) {
        const text = read(join(root, 'third-party', source.file));
        if (createHash('sha256').update(text).digest('hex') !== source.sha256)
            throw new Error(`Texto de licença alterado: ${source.name}`);
        originals.set(source.name, text);
    }
    const templates = {
        MIT: originals
            .get('MIT')
            .slice(originals.get('MIT').indexOf('Permission is hereby granted')),
        'BSD-2-Clause': originals
            .get('BSD-2-Clause')
            .slice(originals.get('BSD-2-Clause').indexOf('Redistribution and use')),
    };
    const sections = directories.map((directory) => renderPackage(directory, fallbacks, templates));
    const intro = read(join(root, 'third-party/INTRO.txt'));
    const native = sources
        .filter((entry) => !['MIT', 'BSD-2-Clause'].includes(entry.name))
        .map(
            (entry) =>
                `${entry.name} (${entry.version})\nFonte: ${entry.source}\n\n${originals.get(entry.name)}`,
        );
    sections.push(
        `libutp — incluído por utp-native\n\n${read(join(root, 'node_modules/utp-native/deps/libutp/LICENSE'))}`,
    );
    const destination = join(root, '.build-resources/THIRD_PARTY_NOTICES.txt');
    mkdirSync(join(root, '.build-resources'), { recursive: true });
    writeFileSync(
        destination,
        `${intro}\n\n${[...sections.sort(), ...native].join('\n\n' + '='.repeat(80) + '\n\n')}\n`,
    );
    console.log(`Avisos gerados para ${directories.length} pacotes e componentes nativos/ícones`);
}

module.exports = { renderPackage };
if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
