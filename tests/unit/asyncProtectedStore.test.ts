import {
    createAsyncProtectedStoreAdapter,
    createAsyncProtectedStoreWriter,
} from '../../main/asyncProtectedStore';

function makeFileSystem() {
    const files = new Map<string, string>();
    const fileSystem = {
        mkdir: jest.fn(async () => undefined),
        readFile: jest.fn(async (path: string) => {
            const data = files.get(path);
            if (data === undefined)
                throw Object.assign(new Error('file missing'), { code: 'ENOENT' });
            return data;
        }),
        writeFile: jest.fn(async (path: string, data: string) => {
            files.set(path, data);
        }),
        rename: jest.fn(async (oldPath: string, newPath: string) => {
            const data = files.get(oldPath);
            if (data === undefined) throw new Error('temporary file missing');
            files.delete(oldPath);
            files.set(newPath, data);
        }),
        unlink: jest.fn(async (path: string) => {
            files.delete(path);
        }),
    };
    return { fileSystem, files };
}

function makeSafeStorage() {
    return {
        isAsyncEncryptionAvailable: jest.fn(async () => true),
        getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
        encryptStringAsync: jest.fn(async (plainText: string) => Buffer.from(`async:${plainText}`)),
        decryptStringAsync: jest.fn(async (encrypted: Buffer) => {
            const contents = encrypted.toString();
            return {
                result: contents.startsWith('sync:')
                    ? contents.slice('sync:'.length)
                    : contents.slice('async:'.length),
                shouldReEncrypt: false,
            };
        }),
    };
}

test('loads the synchronous protected format and keeps it readable after an async write', async () => {
    const path = '/data/downloads.json';
    const { fileSystem, files } = makeFileSystem();
    const safeStorage = makeSafeStorage();
    const initialValue = { downloads: [{ name: 'salvo anteriormente' }] };
    files.set(
        path,
        JSON.stringify({
            format: 'meshy-protected-store',
            version: 1,
            data: Buffer.from(`sync:${JSON.stringify(initialValue)}`).toString('base64'),
        }),
    );

    const store = await createAsyncProtectedStoreAdapter({
        path,
        safeStorage,
        platform: 'win32',
        fileSystem,
    });
    expect(store.get('downloads')).toEqual(initialValue.downloads);

    store.set('downloads', [{ name: 'salvo assincronamente' }]);
    await store.flush();

    const restartedStore = await createAsyncProtectedStoreAdapter({
        path,
        safeStorage,
        platform: 'win32',
        fileSystem,
    });
    expect(restartedStore.get('downloads')).toEqual([{ name: 'salvo assincronamente' }]);
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledTimes(2);
});

test('migrates a legacy plaintext store before returning the session adapter', async () => {
    const path = '/data/downloads.json';
    const { fileSystem, files } = makeFileSystem();
    const safeStorage = makeSafeStorage();
    const legacyValue = { downloads: [{ name: 'legado' }] };
    files.set(path, JSON.stringify(legacyValue));

    const store = await createAsyncProtectedStoreAdapter({
        path,
        safeStorage,
        platform: 'win32',
        fileSystem,
    });

    expect(store.get('downloads')).toEqual(legacyValue.downloads);
    expect(JSON.parse(files.get(path)!)).toMatchObject({
        format: 'meshy-protected-store',
        version: 2,
    });
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
});

test('coalesces key updates and writes the protected envelope asynchronously', async () => {
    const { fileSystem, files } = makeFileSystem();
    const encrypt = jest.fn(async (plainText: string) => Buffer.from(`encrypted:${plainText}`));
    const store = createAsyncProtectedStoreWriter({
        path: '/data/downloads.json',
        initialValue: { existing: true },
        encrypt,
        createTempName: () => 'snapshot',
        fileSystem,
    });

    store.set('downloads', [{ infoHash: 'a'.repeat(40) }]);
    store.set('downloadsSchemaVersion', 1);

    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    await store.flush();

    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(fileSystem.rename).toHaveBeenCalledWith(
        '/data/downloads.json.snapshot.tmp',
        '/data/downloads.json',
    );
    expect(JSON.parse(files.get('/data/downloads.json')!)).toEqual({
        format: 'meshy-protected-store',
        version: 2,
        data: Buffer.from(
            'encrypted:' +
                JSON.stringify({
                    existing: true,
                    downloads: [{ infoHash: 'a'.repeat(40) }],
                    downloadsSchemaVersion: 1,
                }),
        ).toString('base64'),
    });
});

test('flush writes changes that arrive while an earlier snapshot is encrypting', async () => {
    const { fileSystem, files } = makeFileSystem();
    let finishFirstEncryption!: (value: Buffer) => void;
    const encrypt = jest
        .fn<Promise<Buffer>, [plainText: string]>()
        .mockImplementationOnce(() => new Promise((resolve) => (finishFirstEncryption = resolve)))
        .mockImplementation(async (plainText) => Buffer.from(plainText));
    const store = createAsyncProtectedStoreWriter({
        path: '/data/downloads.json',
        initialValue: {},
        encrypt,
        createTempName: (() => {
            let index = 0;
            return () => `snapshot-${index++}`;
        })(),
        fileSystem,
    });

    store.set('downloads', [{ name: 'old' }]);
    const pendingFlush = store.flush();
    store.set('downloads', [{ name: 'latest' }]);
    finishFirstEncryption(Buffer.from('old snapshot'));
    await pendingFlush;

    const envelope = JSON.parse(files.get('/data/downloads.json')!);
    expect(Buffer.from(envelope.data, 'base64').toString()).toBe(
        JSON.stringify({ downloads: [{ name: 'latest' }] }),
    );
    expect(fileSystem.rename).toHaveBeenCalledTimes(2);
});
