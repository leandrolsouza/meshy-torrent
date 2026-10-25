import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('migração e round-trip com o Conf real preservam os dados e nunca gravam passkeys em claro', () => {
    const codecUrl = pathToFileURL(resolve(__dirname, '../../main/storeEncryption.ts')).href;
    const script = `
        import assert from 'node:assert/strict';
        import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join, dirname, basename, resolve } from 'node:path';
        import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
        import Conf from 'conf';
        import { createStoreEncryption } from ${JSON.stringify(codecUrl)};
        const directory = mkdtempSync(join(tmpdir(), 'meshy-protected-store-'));
        const key = randomBytes(32);
        const provider = {
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => 'gnome_libsecret',
            encryptString(value) {
                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', key, iv);
                const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
                return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
            },
            decryptString(value) {
                const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
                cipher.setAuthTag(value.subarray(12, 28));
                return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
            },
        };
        const passkey = 'SYNTHETIC_PRIVATE_PASSKEY';
        const url = 'https://tracker.example.test/' + passkey + '/announce';
        const metadata = Buffer.from('d8:announce' + url.length + ':' + url + 'e').toString('base64');
        const legacy = {
            settings: { schemaVersion: 1, globalTrackers: [url] },
            downloads: { downloadsSchemaVersion: 1, downloads: [{ magnetUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&tr=' + encodeURIComponent(url), torrentFileBase64: metadata }] },
        };
        const open = (name, backend = provider) => {
            const codec = createStoreEncryption(backend, 'win32');
            const store = new Conf({ cwd: directory, configName: name, serialize: codec.serialize, deserialize: codec.deserialize, clearInvalidConfig: false });
            codec.migrate(store);
            return store;
        };
        try {
            for (const [name, contents] of Object.entries(legacy)) {
                const path = join(directory, name + '.json');
                writeFileSync(path, JSON.stringify(contents));
                const store = open(name);
                assert.deepEqual(JSON.parse(JSON.stringify(store.store)), contents);
                const encrypted = readFileSync(path, 'utf8');
                assert(!encrypted.includes(passkey));
                assert(!encrypted.includes(metadata));
                assert.deepEqual(JSON.parse(JSON.stringify(open(name).store)), contents);
                const unavailable = { ...provider, isEncryptionAvailable: () => false };
                assert.throws(() => open(name, unavailable), /unavailable/);
                assert.equal(readFileSync(path, 'utf8'), encrypted);
                const damaged = JSON.parse(encrypted);
                damaged.data = randomBytes(32).toString('base64');
                const corrupted = JSON.stringify(damaged);
                writeFileSync(path, corrupted);
                assert.throws(() => open(name), /unreadable/);
                assert.equal(readFileSync(path, 'utf8'), corrupted);
            }
            process.stdout.write('protected-store-ok');
        } finally {
            assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
            assert(basename(directory).startsWith('meshy-protected-store-'));
            rmSync(directory, { recursive: true, force: true });
        }
    `;
    const output = execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        {
            cwd: resolve(__dirname, '../..'),
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        },
    );
    expect(output).toBe('protected-store-ok');
});
