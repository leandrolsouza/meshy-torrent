import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import policy from '../../security/audit-policy.json';

const { evaluateAudit, verifyEvidence } = require('../../scripts/audit-production.cjs') as {
    evaluateAudit: (
        report: unknown,
        lock: unknown,
        policy: unknown,
        now: Date,
    ) => { reviewed: number };
    verifyEvidence: (root: string, policy: unknown) => void;
};
const now = new Date('2026-10-18T12:00:00Z');
const fixture = () => {
    const vulnerabilities = Object.fromEntries(
        Object.entries(policy.packages).map(([name, entry]) => [
            name,
            {
                name,
                severity: 'high',
                nodes: [`node_modules/${name}`],
                via: [
                    'via' in entry
                        ? entry.via
                        : {
                              url: policy.advisory,
                              name: 'ip',
                              dependency: 'ip',
                              severity: 'high',
                              range: '<=2.0.1',
                          },
                ],
            },
        ]),
    );
    const lock = {
        packages: Object.fromEntries(
            Object.entries(policy.packages).map(([name, entry]) => [
                `node_modules/${name}`,
                { version: entry.version },
            ]),
        ),
    };
    return {
        report: {
            auditReportVersion: 2,
            vulnerabilities,
            metadata: { vulnerabilities: { high: 4, critical: 0 } },
        },
        lock,
    };
};

describe('política de auditoria de produção', () => {
    it('reconhece somente a cadeia e as versões avaliadas antes do vencimento', () => {
        const { report, lock } = fixture();
        expect(evaluateAudit(report, lock, policy, now)).toEqual({ reviewed: 4 });
    });

    it('permite relatório sem alertas altos/críticos mesmo após o vencimento', () => {
        const { report, lock } = fixture();
        report.vulnerabilities = {};
        report.metadata.vulnerabilities.high = 0;
        expect(evaluateAudit(report, lock, policy, new Date('2027-01-01'))).toEqual({
            reviewed: 0,
        });
    });

    it.each(['2026-11-17T00:00:00Z', '2027-01-01T00:00:00Z'])(
        'rejeita exceção vencida em %s',
        (date) => {
            const { report, lock } = fixture();
            expect(() => evaluateAudit(report, lock, policy, new Date(date))).toThrow(/expirada/);
        },
    );

    it('rejeita versão diferente mesmo para o mesmo aviso', () => {
        const { report, lock } = fixture();
        lock.packages['node_modules/ip'].version = '2.0.0';
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/avaliação válida/);
    });

    it('rejeita outro aviso no pacote conhecido', () => {
        const { report, lock } = fixture();
        const via = report.vulnerabilities.ip.via[0];
        if (typeof via !== 'string') via.url = 'https://github.com/advisories/GHSA-outro';
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/diferente do avaliado/);
    });

    it('rejeita uma segunda causa no pacote conhecido', () => {
        const { report, lock } = fixture();
        report.vulnerabilities.webtorrent.via.push('outra-dependencia');
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/avaliação válida/);
    });

    it('rejeita alertas críticos inclusive nos pacotes conhecidos', () => {
        const { report, lock } = fixture();
        report.vulnerabilities.ip.severity = 'critical';
        report.metadata.vulnerabilities = { high: 3, critical: 1 };
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/avaliação válida/);
    });

    it('rejeita alerta alto de outro pacote', () => {
        const { report, lock } = fixture();
        report.vulnerabilities.outro = { ...report.vulnerabilities.ip, name: 'outro' };
        report.metadata.vulnerabilities.high = 5;
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/outro/);
    });

    it('rejeita outra cópia vulnerável de ip na árvore', () => {
        const { report, lock } = fixture();
        report.vulnerabilities.ip.nodes.push('node_modules/outro/node_modules/ip');
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/avaliação válida/);
    });

    it('rejeita cadeia alterada ou incompleta', () => {
        const { report, lock } = fixture();
        report.vulnerabilities.webtorrent.via = ['ip'];
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/Cadeia/);
        delete report.vulnerabilities.webtorrent;
        report.metadata.vulnerabilities.high = 3;
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/incompleta/);
    });

    it('rejeita erro de consulta, relatório inválido ou contagem inconsistente', () => {
        const { report, lock } = fixture();
        for (const invalid of [{}, { ...report, error: { code: 'ENETUNREACH' } }])
            expect(() => evaluateAudit(invalid, lock, policy, now)).toThrow(/inválido/);
        report.metadata.vulnerabilities.high = 0;
        expect(() => evaluateAudit(report, lock, policy, now)).toThrow(/inconsistente/);
    });
});

describe('evidências da avaliação', () => {
    let root: string;
    const source = 'module.exports = {};\n';
    const evidencePolicy = {
        packages: { ip: { version: '2.0.1' } },
        files: {
            'node_modules/ip/index.js': createHash('sha256').update(source).digest('hex'),
        },
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'meshy-audit-'));
        for (const directory of ['main', 'electron', 'shared', 'src', 'node_modules/ip'])
            mkdirSync(join(root, directory), { recursive: true });
        writeFileSync(
            join(root, 'package-lock.json'),
            JSON.stringify({ packages: { 'node_modules/ip': { version: '2.0.1' } } }),
        );
        writeFileSync(join(root, 'node_modules/ip/package.json'), '{"version":"2.0.1"}');
        writeFileSync(join(root, 'node_modules/ip/index.js'), source);
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('confere fontes com LF ou CRLF sem importar a biblioteca', () => {
        expect(() => verifyEvidence(root, evidencePolicy)).not.toThrow();
        writeFileSync(join(root, 'node_modules/ip/index.js'), source.replace(/\n/g, '\r\n'));
        expect(() => verifyEvidence(root, evidencePolicy)).not.toThrow();
    });

    it('rejeita alteração nas fontes avaliadas', () => {
        writeFileSync(join(root, 'node_modules/ip/index.js'), `${source}alterado`);
        expect(() => verifyEvidence(root, evidencePolicy)).toThrow(/Evidência alterada/);
    });

    it('rejeita versão instalada diferente do lock', () => {
        writeFileSync(join(root, 'node_modules/ip/package.json'), '{"version":"2.0.0"}');
        expect(() => verifyEvidence(root, evidencePolicy)).toThrow(/Versão diferente/);
    });

    it.each(["import ip from 'ip';", "const ip = require('ip');", "await import('ip');"])(
        'rejeita uso direto no aplicativo: %s',
        (code) => {
            writeFileSync(join(root, 'main/example.ts'), code);
            expect(() => verifyEvidence(root, evidencePolicy)).toThrow(/Uso direto/);
        },
    );
});
