import { open } from 'fs/promises';
import { readTorrentFile } from '../../main/torrentInput';
import { MAX_TORRENT_BYTES } from '../../shared/validators';
import { ErrorCodes } from '../../shared/errorCodes';

jest.mock('fs/promises', () => ({ open: jest.fn() }));

function fixture(data: Buffer, size = data.length, isFile = true) {
    let position = 0;
    const file = {
        stat: jest.fn(async () => ({ size, isFile: () => isFile })),
        read: jest.fn(async (buffer: Buffer, offset: number, length: number) => {
            const bytesRead = data.copy(buffer, offset, position, position + length);
            position += bytesRead;
            return { bytesRead };
        }),
        close: jest.fn(async () => {}),
    };
    jest.mocked(open).mockResolvedValue(file as unknown as Awaited<ReturnType<typeof open>>);
    return file;
}

beforeEach(() => jest.clearAllMocks());

test('lê torrent válido e fecha o descritor', async () => {
    const data = Buffer.from('d4:test4:datae');
    const file = fixture(data);
    expect(await readTorrentFile('/fixture/input.torrent')).toEqual(data);
    expect(open).toHaveBeenCalledWith('/fixture/input.torrent', 'r');
    expect(file.close).toHaveBeenCalledTimes(1);
});

test.each([0, MAX_TORRENT_BYTES + 1])('rejeita tamanho inválido: %s', async (size) => {
    const file = fixture(Buffer.alloc(0), size);
    await expect(readTorrentFile('/fixture/input.torrent')).rejects.toThrow(
        ErrorCodes.INVALID_FILE_PATH,
    );
    if (size > MAX_TORRENT_BYTES) expect(file.read).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledTimes(1);
});

test('rejeita diretórios sem ler seu conteúdo', async () => {
    const file = fixture(Buffer.from('de'), 2, false);
    await expect(readTorrentFile('/fixture/folder.torrent')).rejects.toThrow(
        ErrorCodes.INVALID_FILE_PATH,
    );
    expect(file.read).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledTimes(1);
});

test('limita a leitura quando o arquivo cresce depois do stat', async () => {
    const data = Buffer.alloc(MAX_TORRENT_BYTES + 1024, 100);
    const file = fixture(data, 2);
    await expect(readTorrentFile('/fixture/input.torrent')).rejects.toThrow(
        ErrorCodes.INVALID_FILE_PATH,
    );
    expect(file.read).toHaveBeenCalledTimes(1);
    expect(file.read.mock.calls[0]?.[2]).toBe(MAX_TORRENT_BYTES + 1);
    expect(file.close).toHaveBeenCalledTimes(1);
});

test('aceita exatamente o limite e rejeita conteúdo inválido', async () => {
    fixture(Buffer.alloc(MAX_TORRENT_BYTES, 100));
    expect((await readTorrentFile('/fixture/input.torrent')).length).toBe(MAX_TORRENT_BYTES);
    fixture(Buffer.from('invalid'));
    await expect(readTorrentFile('/fixture/input.torrent')).rejects.toThrow(
        ErrorCodes.INVALID_FILE_PATH,
    );
});

test('fecha o descritor mesmo quando a leitura falha', async () => {
    const file = fixture(Buffer.from('de'));
    file.read.mockRejectedValueOnce(new Error('read failed'));
    await expect(readTorrentFile('/fixture/input.torrent')).rejects.toThrow('read failed');
    expect(file.close).toHaveBeenCalledTimes(1);
});
