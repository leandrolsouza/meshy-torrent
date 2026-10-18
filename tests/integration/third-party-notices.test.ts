import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { renderPackage } = require('../../scripts/third-party-notices.cjs') as {
    renderPackage: (directory: string, fallbacks: unknown[], templates: unknown) => string;
};

describe('avisos de terceiros', () => {
    let directory: string;
    const manifest = {
        name: 'fixture',
        version: '1.0.0',
        license: 'MIT',
        author: 'Original Author',
    };
    const fallback = {
        ...manifest,
        declaredLicense: 'MIT',
        terms: 'MIT',
        source: 'https://example.com/fixture/v1.0.0',
        reason: 'Texto padrão da licença declarada, com atribuição original',
    };
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'meshy-notices-'));
        writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    it('preserva atribuição, texto de licença e NOTICE originais', () => {
        writeFileSync(
            join(directory, 'license-mit'),
            'Copyright Original Author\nPermission original',
        );
        writeFileSync(join(directory, 'NOTICE.txt'), 'Original attribution');
        const result = renderPackage(directory, [], {});
        expect(result).toContain('fixture@1.0.0');
        expect(result).toContain('Copyright Original Author\nPermission original');
        expect(result).toContain('Original attribution');
    });

    it('preserva a licença completa publicada no README', () => {
        writeFileSync(
            join(directory, 'README.md'),
            'Copyright Author\nPermission is hereby granted',
        );
        expect(renderPackage(directory, [], {})).toContain('Copyright Author');
    });

    it('usa somente complemento revisado para a versão e licença exatas', () => {
        writeFileSync(join(directory, 'README.md'), 'Original README');
        const result = renderPackage(directory, [fallback], { MIT: 'MIT terms' });
        expect(result).toContain('Original Author');
        expect(result).toContain('Original README');
        expect(result).toContain('MIT terms');
        expect(result).toContain(fallback.source);
        for (const changed of [
            { ...manifest, version: '1.0.1' },
            { ...manifest, license: 'BSD-2-Clause' },
        ]) {
            writeFileSync(join(directory, 'package.json'), JSON.stringify(changed));
            expect(() => renderPackage(directory, [fallback], { MIT: 'MIT terms' })).toThrow(
                /exige revisão/,
            );
        }
    });

    it('falha quando um pacote não possui aviso nem revisão', () => {
        expect(() => renderPackage(directory, [], {})).toThrow(/exige revisão/);
    });
});
