import { constants } from 'fs';
import { access, copyFile, lstat, mkdir, realpath, unlink } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'path';
import type { TorrentFileInfo } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';

export function isSafeTorrentPath(path: string): boolean {
    return (
        typeof path === 'string' &&
        path.length > 0 &&
        !path.includes('\0') &&
        !isAbsolute(path) &&
        !win32.isAbsolute(path) &&
        path.split(/[\\/]/).every((part) => part !== '..' && part !== '' && !part.includes(':'))
    );
}

/** Contenção lexical e física: nenhum componente interno pode ser symlink/junction. */
export async function resolveTorrentFile(folder: string, filePath: string): Promise<string> {
    if (!isSafeTorrentPath(filePath)) throw new Error(ErrorCodes.FILE_PATH_UNSAFE);
    const root = await realpath(folder);
    const fullPath = resolve(root, ...filePath.split(/[\\/]/));
    const rel = relative(root, fullPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error(ErrorCodes.FILE_PATH_UNSAFE);
    let current = root;
    for (const part of rel.split(/[\\/]/)) {
        current = join(current, part);
        try {
            if ((await lstat(current)).isSymbolicLink())
                throw new Error(ErrorCodes.FILE_PATH_UNSAFE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    return fullPath;
}

export interface FileMove {
    commit(): Promise<boolean>; // false: cópia válida, mas algum original foi mantido
    rollback(): Promise<void>;
}
export interface TorrentFilesService {
    existingBytes(folder: string, files: TorrentFileInfo[]): Promise<number>;
    validate(folder: string, files: TorrentFileInfo[]): Promise<void>;
    copy(source: string, destination: string, files: TorrentFileInfo[]): Promise<FileMove>;
    remove(folder: string, files: TorrentFileInfo[]): Promise<void>;
}

export function createTorrentFilesService(): TorrentFilesService {
    const list = async (folder: string, files: TorrentFileInfo[]) => {
        const found: {
            path: string;
            file: TorrentFileInfo;
            size: number;
            mtimeMs: number;
            ino: number;
        }[] = [];
        for (const file of files) {
            const path = await resolveTorrentFile(folder, file.path);
            try {
                const info = await lstat(path);
                if (!info.isFile()) throw new Error(ErrorCodes.FILE_PATH_UNSAFE);
                found.push({ path, file, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        return found;
    };
    return {
        async remove(folder, files) {
            // Valida o catálogo inteiro antes de excluir qualquer arquivo.
            const paths: string[] = [];
            for (const file of files) {
                try {
                    await resolveTorrentFile(folder, file.path);
                    paths.push(file.path);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            for (const path of paths) {
                try {
                    // Revalida contenção e symlinks imediatamente antes de excluir.
                    await unlink(await resolveTorrentFile(folder, path));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
        },
        async validate(folder, files) {
            await access(folder, constants.R_OK | constants.W_OK);
            for (const file of files) await resolveTorrentFile(folder, file.path);
        },
        async existingBytes(folder, files) {
            return (await list(folder, files)).reduce((sum, entry) => sum + entry.size, 0);
        },
        async copy(source, destination, files) {
            const originals = await list(source, files);
            if (!originals.length) throw new Error(ErrorCodes.FILE_SOURCE_MISSING);
            const copied: {
                source: string;
                destination: string;
                size: number;
                mtimeMs: number;
                ino: number;
            }[] = [];
            const rollback = async () => {
                for (const file of copied.slice().reverse()) {
                    // Revalidar ancestrais antes de apagar apenas a cópia criada por esta operação.
                    const safe = await resolveTorrentFile(
                        destination,
                        relative(await realpath(destination), file.destination),
                    );
                    await unlink(safe).catch((error: NodeJS.ErrnoException) => {
                        if (error.code !== 'ENOENT') throw error;
                    });
                }
            };
            try {
                for (const entry of originals) {
                    const target = await resolveTorrentFile(destination, entry.file.path);
                    if (target === entry.path)
                        throw new Error(ErrorCodes.FILE_DESTINATION_CONFLICT);
                    try {
                        await lstat(target);
                        throw new Error(ErrorCodes.FILE_DESTINATION_CONFLICT);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                }
                for (const entry of originals) {
                    const target = await resolveTorrentFile(destination, entry.file.path);
                    await mkdir(dirname(target), { recursive: true });
                    await resolveTorrentFile(destination, entry.file.path);
                    await copyFile(entry.path, target, constants.COPYFILE_EXCL);
                    copied.push({
                        source: entry.path,
                        destination: target,
                        size: entry.size,
                        mtimeMs: entry.mtimeMs,
                        ino: entry.ino,
                    });
                    const after = await lstat(entry.path);
                    if (
                        after.size !== entry.size ||
                        after.mtimeMs !== entry.mtimeMs ||
                        after.ino !== entry.ino
                    )
                        throw new Error(ErrorCodes.FILE_SOURCE_MISSING);
                }
            } catch (error) {
                await rollback();
                if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                    throw Object.assign(new Error(ErrorCodes.FILE_DESTINATION_CONFLICT), {
                        cause: error,
                    });
                throw error;
            }
            return {
                rollback,
                async commit() {
                    let complete = true;
                    for (const file of copied) {
                        try {
                            const safe = await resolveTorrentFile(
                                source,
                                relative(await realpath(source), file.source),
                            );
                            const current = await lstat(safe);
                            if (
                                current.size !== file.size ||
                                current.mtimeMs !== file.mtimeMs ||
                                current.ino !== file.ino
                            ) {
                                complete = false;
                                continue;
                            }
                            await unlink(safe);
                        } catch {
                            complete = false;
                        }
                    }
                    return complete;
                },
            };
        },
    };
}
