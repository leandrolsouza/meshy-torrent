import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { version } from '../../package.json';
import { createHash } from 'node:crypto';

describe('checksums do release Windows', () => {
    let directory: string;
    const script = resolve(__dirname, '../../scripts/release-checksums.cjs');
    const installer = `Meshy-${version}-win-x64-setup.exe`;
    const prepareAssets = (
        manifestVersion = version,
        sha512 = createHash('sha512').update('abc').digest('base64'),
    ) => {
        writeFileSync(join(directory, installer), 'abc');
        writeFileSync(join(directory, `${installer}.blockmap`), 'blockmap');
        writeFileSync(
            join(directory, 'latest.yml'),
            JSON.stringify({
                version: manifestVersion,
                files: [{ url: installer, sha512 }],
            }),
        );
    };

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'meshy-release-'));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('calcula SHA-256 dos arquivos de atualização da versão atual, ignorando instaladores antigos', () => {
        prepareAssets();
        writeFileSync(join(directory, 'Meshy-0.0.1-win-x64-setup.exe'), 'obsoleto');
        execFileSync(process.execPath, [script, directory]);

        const sums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8');
        expect(sums).toContain(
            `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ${installer}\n`,
        );
        expect(sums).not.toContain('0.0.1');
        expect(sums.trim().split('\n')).toHaveLength(3);
        for (const asset of [`${installer}.blockmap`, 'latest.yml']) {
            const expected = createHash('sha256')
                .update(readFileSync(join(directory, asset)))
                .digest('hex');
            expect(sums).toContain(`${expected}  ${asset}\n`);
        }
    });

    it.each(['versão antiga', 'hash incorreto'])('rejeita manifesto com %s', (scenario) => {
        if (scenario === 'versão antiga') prepareAssets('0.0.1');
        else prepareAssets(version, 'checksum-inválido');
        expect(() =>
            execFileSync(process.execPath, [script, directory], { stdio: 'pipe' }),
        ).toThrow();
        expect(existsSync(join(directory, 'SHA256SUMS'))).toBe(false);
    });

    it('falha sem produzir checksum quando só existe um instalador antigo', () => {
        writeFileSync(join(directory, 'Meshy-0.0.1-win-x64-setup.exe'), 'obsoleto');

        expect(() =>
            execFileSync(process.execPath, [script, directory], { stdio: 'pipe' }),
        ).toThrow();
        expect(existsSync(join(directory, 'SHA256SUMS'))).toBe(false);
    });
});
