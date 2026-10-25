import { createDiskSpaceService } from '../../main/diskSpace';
import type { DownloadItem } from '../../shared/types';
import { resolve } from 'path';

const item = (
    hash: string,
    folder: string,
    status: DownloadItem['status'],
    totalSize = 400,
): DownloadItem => ({
    infoHash: hash,
    name: hash,
    destinationFolder: folder,
    status,
    totalSize,
    downloadedSize: 100,
    progress: 0.25,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    numSeeders: 0,
    timeRemaining: 0,
    addedAt: 1,
});
test('considera os bytes restantes de ativos e fila no mesmo volume, incluindo pastas distintas', async () => {
    const disk = createDiskSpaceService({
        safetyMarginBytes: 50,
        readVolume: async (folder) => ({
            volumeId: folder.includes('other-volume') ? 'B' : 'A',
            freeBytes: 1000,
        }),
    });
    const result = await disk.inspect('/destination', 350, [
        item('1', '/sibling', 'downloading'),
        item('2', '/destination', 'queued'),
        item('3', '/other-volume', 'downloading'),
        item('4', '/destination', 'paused'),
        item('5', '/destination', 'completed'),
    ]);
    expect(result).toEqual({
        freeBytes: 1000,
        selectedBytes: 350,
        reservedBytes: 600,
        safetyMarginBytes: 50,
        sufficient: true,
    });
    expect(
        (
            await disk.inspect('/destination', 351, [
                item('1', '/sibling', 'downloading'),
                item('2', '/destination', 'queued'),
            ])
        ).sufficient,
    ).toBe(false);
});
test('exclui o próprio torrent ao verificar retomada e limita reservas negativas a zero', async () => {
    const disk = createDiskSpaceService({
        safetyMarginBytes: 0,
        readVolume: async () => ({ volumeId: 'A', freeBytes: 350 }),
    });
    expect(
        (
            await disk.inspect(
                '/destination',
                300,
                [item('1', '/destination', 'queued'), item('2', '/destination', 'downloading', 50)],
                '1',
            )
        ).reservedBytes,
    ).toBe(0);
});
test('não informa espaço suficiente quando a consulta ao volume falha', async () => {
    const disk = createDiskSpaceService({
        readVolume: async () => {
            throw new Error('disco desconectado');
        },
    });
    await expect(disk.inspect('/missing', 10, [])).rejects.toThrow(
        'error.destination.diskSpaceUnavailable',
    );
});

test.each(['downloading', 'resolving-metadata', 'queued'] as const)(
    'um destino %s inacessível não impede consultar outro volume nem contar suas reservas',
    async (status) => {
        const readVolume = jest.fn(async (folder: string) => {
            if (folder === resolve('/unavailable')) throw new Error('ENODEV');
            return { volumeId: 'A', freeBytes: 1000 };
        });
        const disk = createDiskSpaceService({ safetyMarginBytes: 50, readVolume });
        const downloads = [
            item('1', '/unavailable', status),
            item('2', '/sibling', 'downloading'),
            item('3', '/unavailable', 'queued'),
            item('4', '/destination', 'queued'),
        ];
        await expect(disk.inspect('/destination', 350, downloads)).resolves.toEqual({
            freeBytes: 1000,
            selectedBytes: 350,
            reservedBytes: 600,
            safetyMarginBytes: 50,
            sufficient: true,
        });
        expect(
            readVolume.mock.calls.filter(([folder]) => folder === resolve('/unavailable')),
        ).toHaveLength(1);
        await expect(disk.inspect('/destination', 351, downloads)).resolves.toMatchObject({
            reservedBytes: 600,
            sufficient: false,
        });
        await expect(disk.inspect('/unavailable', 10, downloads)).rejects.toThrow(
            'diskSpaceUnavailable',
        );
    },
);

test('reutiliza a consulta do próprio destino para contar reservas sem uma segunda leitura', async () => {
    const readVolume = jest
        .fn()
        .mockResolvedValueOnce({ volumeId: 'A', freeBytes: 1000 })
        .mockRejectedValue(new Error('falha transitória'));
    const disk = createDiskSpaceService({ safetyMarginBytes: 0, readVolume });
    await expect(
        disk.inspect('/destination', 701, [item('1', '/destination', 'downloading')]),
    ).resolves.toMatchObject({ reservedBytes: 300, sufficient: false });
    expect(readVolume).toHaveBeenCalledTimes(1);
});
