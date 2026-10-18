import { extname } from 'path';

// Todo formato desconhecido (inclusive executáveis sem extensão) é apenas revelado.
const DIRECT_OPEN_EXTENSIONS = new Set([
    '.txt',
    '.log',
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.ico',
    '.mp3',
    '.wav',
    '.flac',
    '.ogg',
    '.aac',
    '.m4a',
    '.mp4',
    '.mkv',
    '.avi',
    '.mov',
    '.webm',
    '.m4v',
    '.mpeg',
    '.mpg',
    '.srt',
    '.vtt',
    '.zip',
    '.7z',
    '.rar',
    '.tar',
    '.gz',
]);

export function canOpenDownloadedFile(filePath: string): boolean {
    return DIRECT_OPEN_EXTENSIONS.has(extname(filePath).toLowerCase());
}
