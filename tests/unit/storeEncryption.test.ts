import { randomBytes } from 'node:crypto';
import { createStoreEncryption, ProtectedStoreError } from '../../main/storeEncryption';

function provider() {
    const values = new Map<string, string>();
    return {
        isEncryptionAvailable: jest.fn(() => true),
        getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
        encryptString: jest.fn((value: string) => {
            const encrypted = randomBytes(32);
            values.set(encrypted.toString('hex'), value);
            return encrypted;
        }),
        decryptString: jest.fn((value: Buffer) => {
            const plain = values.get(value.toString('hex'));
            if (!plain) throw new Error('Falha no provedor');
            return plain;
        }),
    };
}

const passkey = 'SYNTHETIC_PRIVATE_PASSKEY';
const url = `https://tracker.example.test/${passkey}/announce`;
const contents = {
    globalTrackers: [url],
    downloads: [
        {
            magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}&tr=${encodeURIComponent(url)}`,
            torrentFileBase64: Buffer.from(`d8:announce${url.length}:${url}e`).toString('base64'),
        },
    ],
};

test('protege o documento inteiro, inclusive magnets e metadados base64, sem mudar seus contratos', () => {
    const codec = createStoreEncryption(provider(), 'win32');
    const text = codec.serialize(contents);
    expect(text).not.toContain(passkey);
    expect(text).not.toContain(contents.downloads[0]!.torrentFileBase64);
    expect(codec.deserialize(text)).toEqual(contents);
});

test('migra JSON legado antes de devolver o armazenamento e preserva os dados', () => {
    const codec = createStoreEncryption(provider());
    let disk = JSON.stringify(contents);
    codec.deserialize(disk);
    codec.migrate({
        get store() {
            return codec.deserialize(disk);
        },
        set store(value) {
            disk = codec.serialize(value);
        },
    });
    expect(disk).not.toContain(passkey);
    expect(codec.deserialize(disk)).toEqual(contents);
});

test('indisponibilidade não permite fallback nem altera o JSON legado', () => {
    const backend = provider();
    const codec = createStoreEncryption(backend);
    let disk = JSON.stringify(contents);
    const original = disk;
    codec.deserialize(disk);
    backend.isEncryptionAvailable.mockReturnValue(false);
    const store = {
        get store() {
            return codec.deserialize(disk);
        },
        set store(value) {
            disk = codec.serialize(value);
        },
    };
    expect(() => codec.migrate(store)).toThrow(ProtectedStoreError);
    expect(disk).toBe(original);
    expect(backend.encryptString).not.toHaveBeenCalled();
    backend.isEncryptionAvailable.mockReturnValue(true);
    codec.migrate(store);
    expect(disk).not.toContain(passkey);
});

test.each(['basic_text', 'unknown'])(
    'rejeita %s no Linux mesmo quando Electron reporta criptografia disponível',
    (backendName) => {
        const backend = provider();
        backend.getSelectedStorageBackend.mockReturnValue(backendName);
        const codec = createStoreEncryption(backend, 'linux');
        expect(() => codec.serialize(contents)).toThrow('unavailable');
        expect(backend.encryptString).not.toHaveBeenCalled();
    },
);

test('falhas do provedor não expõem os dados no erro nem usam uma chave alternativa', () => {
    const backend = provider();
    backend.encryptString.mockImplementationOnce(() => {
        throw new Error(passkey);
    });
    const codec = createStoreEncryption(backend);
    expect(() => codec.serialize(contents)).toThrow('write');
    backend.isEncryptionAvailable.mockImplementationOnce(() => {
        throw new Error(passkey);
    });
    expect(() => codec.serialize(contents)).toThrow('unavailable');
});

test('outra conta, ciphertext corrompido e envelope futuro falham sem dados do conteúdo no erro', () => {
    const codec = createStoreEncryption(provider());
    const encrypted = codec.serialize(contents);
    const otherAccount = createStoreEncryption(provider());
    expect(() => otherAccount.deserialize(encrypted)).toThrow('unreadable');
    const envelope = JSON.parse(encrypted);
    for (const text of [
        JSON.stringify({ ...envelope, version: 2 }),
        JSON.stringify({ ...envelope, data: '!!!' }),
        `invalid ${passkey}`,
    ]) {
        expect(() => codec.deserialize(text)).toThrow('unreadable');
        try {
            codec.deserialize(text);
        } catch (error) {
            expect(String(error)).not.toContain(passkey);
        }
    }
});
