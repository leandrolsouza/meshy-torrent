import { createExternalTorrentInbox } from '../../main/externalTorrents';
import { resolve } from 'path';
const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;

test('encaminha magnet v2 do sistema para exibir o diagnóstico de incompatibilidade', () => {
    const inbox = createExternalTorrentInbox(jest.fn());
    const v2 = `magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}`;
    inbox.enqueueArguments([v2]);
    expect(inbox.getPending()[0]?.source).toEqual({ kind: 'magnet', magnetUri: v2 });
});

test('entrega o magnet do navegador com trackers literais para revisão', () => {
    const show = jest.fn();
    const inbox = createExternalTorrentInbox(show);
    const browserMagnet = `${magnet}&dn=Archive_(2026)&tr=udp://tracker.example.test:6969/announce`;
    inbox.enqueueArguments(['electron.exe', 'C:/Meshy', browserMagnet]);
    expect(inbox.getPending()).toEqual([
        { id: expect.any(String), source: { kind: 'magnet', magnetUri: browserMagnet } },
    ]);
    expect(show).toHaveBeenCalledTimes(1);
});
test('guarda magnets/arquivos de cold start até confirmar ou cancelar, sem iniciar downloads', () => {
    const show = jest.fn();
    const inbox = createExternalTorrentInbox(show);
    inbox.enqueueArguments(
        ['Meshy.exe', '--flag', magnet, 'my download.torrent', magnet],
        process.cwd(),
    );
    expect(inbox.getPending().map((request) => request.source)).toEqual([
        { kind: 'magnet', magnetUri: magnet },
        { kind: 'file', filePath: resolve('my download.torrent') },
    ]);
    expect(show).toHaveBeenCalledTimes(1);
    const requests = inbox.getPending();
    inbox.acknowledge(requests[0]!.id);
    expect(inbox.getPending()).toEqual([requests[1]]);
    inbox.enqueueArguments([magnet]);
    expect(inbox.getPending()).toHaveLength(2);
});
test('ignora protocolos não suportados, argumentos e magnets inválidos', () => {
    const inbox = createExternalTorrentInbox(jest.fn());
    inbox.enqueueArguments([
        'https://evil.test/file.torrent',
        '--config=x.torrent',
        'not a magnet',
        'magnet:?xt=invalid',
        'file://%invalid.torrent',
    ]);
    expect(inbox.getPending()).toEqual([]);
});
test('segunda entrada não substitui a primeira e snapshots não expõem estado mutável', () => {
    const inbox = createExternalTorrentInbox(jest.fn());
    inbox.enqueueArguments([magnet]);
    const first = inbox.getPending()[0]!;
    const snapshot = inbox.getPending();
    snapshot[0]!.id = 'changed';
    inbox.enqueueArguments([`magnet:?xt=urn:btih:${'b'.repeat(40)}`]);
    expect(inbox.getPending()[0]).toEqual(first);
    expect(inbox.getPending()).toHaveLength(2);
});
