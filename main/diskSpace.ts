import { stat, statfs } from 'fs/promises';
import { resolve } from 'path';
import type { DiskSpaceInfo, DownloadItem } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';

export const DISK_SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;
export interface VolumeSpace {
    volumeId: string;
    freeBytes: number;
}
export interface DiskSpaceService {
    inspect(
        destinationFolder: string,
        selectedBytes: number,
        items: DownloadItem[],
        excludeHash?: string,
    ): Promise<DiskSpaceInfo>;
}

export function createDiskSpaceService(
    options: {
        readVolume?: (folder: string) => Promise<VolumeSpace>;
        safetyMarginBytes?: number;
    } = {},
): DiskSpaceService {
    const readVolume =
        options.readVolume ??
        (async (folder: string): Promise<VolumeSpace> => {
            const [directory, space] = await Promise.all([
                stat(folder, { bigint: true }),
                statfs(folder, { bigint: true }),
            ]);
            if (!directory.isDirectory()) throw new Error(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
            return {
                volumeId: String(directory.dev),
                freeBytes: Number(space.bavail * space.bsize),
            };
        });
    const safetyMarginBytes = options.safetyMarginBytes ?? DISK_SAFETY_MARGIN_BYTES;
    return {
        async inspect(destinationFolder, selectedBytes, items, excludeHash) {
            try {
                const destinationPath = resolve(destinationFolder);
                const destination = await readVolume(destinationPath);
                const volumes = new Map<string, Promise<VolumeSpace | undefined>>([
                    [destinationPath, Promise.resolve(destination)],
                ]);
                let reservedBytes = 0;
                for (const item of items) {
                    if (
                        item.infoHash === excludeHash ||
                        !['downloading', 'resolving-metadata', 'queued'].includes(item.status)
                    )
                        continue;
                    const folder = resolve(item.destinationFolder);
                    let volume = volumes.get(folder);
                    if (!volume) {
                        // Um destino inacessível será bloqueado na sua própria
                        // consulta; não deve impedir operações em volumes saudáveis.
                        volume = Promise.resolve()
                            .then(() => readVolume(folder))
                            .catch(() => undefined);
                        volumes.set(folder, volume);
                    }
                    if ((await volume)?.volumeId === destination.volumeId) {
                        reservedBytes += Math.max(0, item.totalSize - item.downloadedSize);
                    }
                }
                return {
                    freeBytes: destination.freeBytes,
                    selectedBytes,
                    reservedBytes,
                    safetyMarginBytes,
                    sufficient:
                        selectedBytes + reservedBytes + safetyMarginBytes <= destination.freeBytes,
                };
            } catch {
                throw new Error(ErrorCodes.DISK_SPACE_UNAVAILABLE);
            }
        },
    };
}
