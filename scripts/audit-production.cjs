/* global require, module, process, __dirname, console */
const { readFileSync, writeFileSync, mkdirSync, readdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function evaluateAudit(report, lock, policy, now = new Date()) {
    if (
        report?.error ||
        report?.auditReportVersion !== 2 ||
        !report.vulnerabilities ||
        !report.metadata?.vulnerabilities ||
        policy?.schemaVersion !== 1
    )
        throw new Error('Relatório de auditoria ou política inválido');

    const alerts = Object.entries(report.vulnerabilities).filter(([, item]) =>
        ['high', 'critical'].includes(item.severity),
    );
    const counts = report.metadata.vulnerabilities;
    if (alerts.length !== counts.high + counts.critical)
        throw new Error('Contagem de alertas inconsistente');
    if (!alerts.length) return { reviewed: 0 };

    const expires = new Date(`${policy.expiresOn}T00:00:00Z`);
    if (!Number.isFinite(expires.getTime()) || now >= expires)
        throw new Error('Exceção expirada: refaça a avaliação de aplicabilidade');

    for (const [name, alert] of alerts) {
        const expected = policy.packages[name];
        const path = `node_modules/${name}`;
        if (
            !expected ||
            alert.severity !== 'high' ||
            alert.name !== name ||
            alert.nodes?.length !== 1 ||
            alert.nodes[0] !== path ||
            lock.packages?.[path]?.version !== expected.version ||
            alert.via?.length !== 1
        )
            throw new Error(`Alerta sem avaliação válida: ${name}`);

        const via = alert.via[0];
        if (name === 'ip') {
            if (
                typeof via !== 'object' ||
                via.url !== policy.advisory ||
                via.name !== 'ip' ||
                via.dependency !== 'ip' ||
                via.severity !== 'high' ||
                via.range !== '<=2.0.1'
            )
                throw new Error('Aviso de ip diferente do avaliado');
        } else if (via !== expected.via || !report.vulnerabilities[via]) {
            throw new Error(`Cadeia de vulnerabilidade alterada: ${name}`);
        }
    }
    // A exceção cobre somente esta cadeia completa; relatórios parciais falham.
    if (alerts.length !== Object.keys(policy.packages).length)
        throw new Error('Cadeia de alertas incompleta: revise a avaliação');
    return { reviewed: alerts.length };
}

function verifyEvidence(root, policy) {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    for (const [name, expected] of Object.entries(policy.packages)) {
        const path = `node_modules/${name}`;
        const installed = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
        if (
            lock.packages[path]?.version !== expected.version ||
            installed.version !== expected.version
        )
            throw new Error(`Versão diferente da avaliada: ${name}`);
    }
    for (const [file, expectedHash] of Object.entries(policy.files)) {
        const source = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
        const hash = createHash('sha256').update(source).digest('hex');
        if (hash !== expectedHash) throw new Error(`Evidência alterada: ${file}`);
    }
    const inspect = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) inspect(path);
            else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) {
                const source = readFileSync(path, 'utf8');
                if (/(?:from\s*|(?:require|import)\s*\(\s*|import\s*)['"]ip['"]/.test(source))
                    throw new Error(`Uso direto de ip exige nova avaliação: ${path}`);
            }
        }
    };
    for (const directory of ['main', 'electron', 'shared', 'src']) inspect(join(root, directory));
}

function main() {
    const root = resolve(__dirname, '..');
    const output = join(root, '.build-resources/security');
    mkdirSync(output, { recursive: true });
    const file = join(output, 'audit-production.json');
    const reportIndex = process.argv.indexOf('--report');
    let raw;
    if (reportIndex !== -1) {
        if (!process.argv[reportIndex + 1]) throw new Error('Informe o arquivo após --report');
        raw = readFileSync(resolve(process.argv[reportIndex + 1]), 'utf8');
    } else {
        if (!process.env.npm_execpath) throw new Error('Execute npm run security:audit');
        const result = spawnSync(
            process.execPath,
            [process.env.npm_execpath, 'audit', '--omit=dev', '--json'],
            { cwd: root, encoding: 'utf8', timeout: 120_000, windowsHide: true },
        );
        if (result.error || ![0, 1].includes(result.status))
            throw new Error('Não foi possível concluir a consulta ao npm audit');
        raw = result.stdout;
    }
    const report = JSON.parse(raw);
    writeFileSync(file, `${JSON.stringify(report, null, 4)}\n`);
    const policy = require('../security/audit-policy.json');
    const lock = require('../package-lock.json');
    const result = evaluateAudit(report, lock, policy);
    if (result.reviewed) verifyEvidence(root, policy);
    console.log(`Relatório bruto preservado em ${file}`);
    console.log(
        `Auditoria de produção: ${report.metadata.vulnerabilities.high} altos, ` +
            `${report.metadata.vulnerabilities.critical} críticos`,
    );
    console.log(
        result.reviewed
            ? `${result.reviewed} entradas cobertas pela avaliação ${policy.advisory} até ${policy.expiresOn}`
            : 'Nenhuma exceção necessária',
    );
}

module.exports = { evaluateAudit, verifyEvidence };
if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
