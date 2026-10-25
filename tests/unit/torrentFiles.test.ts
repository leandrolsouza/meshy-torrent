import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTorrentFilesService, resolveTorrentFile } from '../../main/torrentFiles';
import type { TorrentFileInfo } from '../../shared/types';

let root: string;
let source: string;
let destination: string;
const files: TorrentFileInfo[] = [
    { index: 0, name: 'a.bin', path: 'Archive/a.bin', length: 5, downloaded: 5, selected: true },
    { index: 1, name: 'b.bin', path: 'Archive/b.bin', length: 5, downloaded: 0, selected: false },
];
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'meshy-files-test-'));
    source = join(root, 'source');
    destination = join(root, 'destination');
    await mkdir(join(source, 'Archive'), { recursive: true });
    await mkdir(destination);
    await writeFile(join(source, 'Archive/a.bin'), 'hello');
});
afterEach(async () => {
    // O alvo veio exclusivamente de mkdtemp neste teste, dentro do diretório temporário.
    if (!root.startsWith(join(tmpdir(), 'meshy-files-test-'))) throw new Error('Alvo inesperado');
    await rm(root, { recursive: true, force: true });
});
test('copiar mantém originais até commit e ignora arquivos ausentes sem perder a seleção', async () => {
    const service = createTorrentFilesService();
    expect(await service.existingBytes(source, files)).toBe(5);
    const move = await service.copy(source, destination, files);
    expect(await readFile(join(source, 'Archive/a.bin'), 'utf8')).toBe('hello');
    expect(await readFile(join(destination, 'Archive/a.bin'), 'utf8')).toBe('hello');
    expect(await move.commit()).toBe(true);
    expect(await readdir(join(source, 'Archive'))).toEqual([]);
});

test('excluir usa apenas o catálogo, preserva arquivos alheios e permite repetição', async () => {
    await writeFile(join(source, 'Archive/b.bin'), 'other');
    await writeFile(join(source, 'keep.txt'), 'keep');
    const service = createTorrentFilesService();

    await service.remove(source, files);
    await service.remove(source, files);

    expect(await readdir(join(source, 'Archive'))).toEqual([]);
    expect(await readFile(join(source, 'keep.txt'), 'utf8')).toBe('keep');
});

test('uma falha parcial de exclusão é comunicada e permite nova tentativa', async () => {
    // Um diretório no lugar do segundo arquivo faz unlink falhar após excluir o primeiro.
    await mkdir(join(source, 'Archive/b.bin'));
    const service = createTorrentFilesService();

    await expect(service.remove(source, files)).rejects.toThrow();
    expect(await readdir(join(source, 'Archive'))).toEqual(['b.bin']);
    await rmdir(join(source, 'Archive/b.bin'));
    await writeFile(join(source, 'Archive/b.bin'), 'other');
    await expect(service.remove(source, files)).resolves.toBeUndefined();
    expect(await readdir(join(source, 'Archive'))).toEqual([]);
});
test('rollback remove apenas as cópias criadas e preserva arquivos alheios', async () => {
    const service = createTorrentFilesService();
    await writeFile(join(destination, 'other.txt'), 'keep');
    const move = await service.copy(source, destination, files);
    await move.rollback();
    expect(await readFile(join(source, 'Archive/a.bin'), 'utf8')).toBe('hello');
    expect(await readFile(join(destination, 'other.txt'), 'utf8')).toBe('keep');
    expect(await readdir(join(destination, 'Archive'))).toEqual([]);
});
test('conflito nunca sobrescreve o destino nem remove originais', async () => {
    await mkdir(join(destination, 'Archive'));
    await writeFile(join(destination, 'Archive/a.bin'), 'other');
    await expect(createTorrentFilesService().copy(source, destination, files)).rejects.toThrow(
        'destinationConflict',
    );
    expect(await readFile(join(destination, 'Archive/a.bin'), 'utf8')).toBe('other');
    expect(await readFile(join(source, 'Archive/a.bin'), 'utf8')).toBe('hello');
});
test('um original modificado por outro programa depois da cópia é mantido', async () => {
    const move = await createTorrentFilesService().copy(source, destination, files);
    await writeFile(join(source, 'Archive/a.bin'), 'new external content');
    expect(await move.commit()).toBe(false);
    expect(await readFile(join(source, 'Archive/a.bin'), 'utf8')).toBe('new external content');
});
test.each([
    '../outside.bin',
    '/outside.bin',
    'C:\\outside.bin',
    'Archive/../../outside.bin',
    'Archive/../outside.bin',
    'a:stream',
])('rejeita caminho fora da pasta: %s', async (path) => {
    await expect(resolveTorrentFile(destination, path)).rejects.toThrow('unsafePath');
});

test('um caminho inválido no catálogo impede excluir até mesmo os arquivos válidos', async () => {
    const invalid = { ...files[1]!, path: '../outside.bin' };
    await expect(createTorrentFilesService().remove(source, [files[0]!, invalid])).rejects.toThrow(
        'unsafePath',
    );
    expect(await readFile(join(source, 'Archive/a.bin'), 'utf8')).toBe('hello');
});
test('rejeita symlink/junction no destino antes de copiar ou excluir arquivos', async () => {
    // Junction no Windows dispensa privilégios para criar symlinks. Tanto o alvo
    // quanto o link pertencem exclusivamente ao diretório temporário deste teste.
    const redirected = join(root, 'redirected');
    await mkdir(redirected);
    await writeFile(join(redirected, 'a.bin'), 'keep');
    await symlink(
        redirected,
        join(destination, 'Archive'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(resolveTorrentFile(destination, 'Archive/a.bin')).rejects.toThrow('unsafePath');
    await expect(createTorrentFilesService().copy(source, destination, files)).rejects.toThrow(
        'unsafePath',
    );
    await expect(createTorrentFilesService().remove(destination, files)).rejects.toThrow(
        'unsafePath',
    );
    expect(await readFile(join(source, 'Archive/a.bin'), 'utf8')).toBe('hello');
    expect(await readFile(join(redirected, 'a.bin'), 'utf8')).toBe('keep');
});
