import { open } from 'fs/promises';
import { MAX_TORRENT_BYTES, hasTorrentMagicBytes } from './validators';
import { ErrorCodes } from '../shared/errorCodes';

/** Lê no máximo o limite + 1 byte, mesmo se o arquivo crescer após o stat. */
export async function readTorrentFile(filePath: string): Promise<Buffer> {
    const file = await open(filePath, 'r');
    try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_TORRENT_BYTES)
            throw new Error(ErrorCodes.INVALID_FILE_PATH);
        const buffer = Buffer.alloc(MAX_TORRENT_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        const data = buffer.subarray(0, length);
        if (length > MAX_TORRENT_BYTES || !hasTorrentMagicBytes(data))
            throw new Error(ErrorCodes.INVALID_FILE_PATH);
        return Buffer.from(data);
    } finally {
        await file.close();
    }
}
