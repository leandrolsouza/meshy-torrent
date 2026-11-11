/* global console, process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import WebTorrent from 'webtorrent';

const output = resolve('.build-resources/qa');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'priority-'));
const source = join(root, 'source');
const destination = join(root, 'download');
mkdirSync(source);
mkdirSync(destination);
const config = {
    dht: false,
    tracker: false,
    lsd: false,
    utPex: false,
    utp: false,
    natUpnp: false,
    natPmp: false,
    webSeeds: false,
};
const seeder = new WebTorrent(config);
const downloader = new WebTorrent({ ...config, downloadLimit: 128 * 1024 });
const clients = [seeder, downloader];
const close = (client) =>
    new Promise((resolveClose, reject) => {
        if (client.destroyed) return resolveClose();
        client.destroy((error) => (error ? reject(error) : resolveClose()));
    });
const timer = setTimeout(() => {
    console.error('Timeout do ensaio de prioridade');
    process.exit(1);
}, 30_000);
let failure;
for (const client of clients)
    client.on('error', (error) => {
        failure = error;
    });

try {
    const files = ['a-normal.bin', 'b-gap.bin', 'c-high.bin'].map((name) => {
        const path = join(source, name);
        writeFileSync(path, randomBytes(256 * 1024));
        return path;
    });
    const seed = await new Promise((resolveSeed) =>
        seeder.seed(
            files,
            {
                name: 'priority-fixture',
                pieceLength: 16384,
                private: true,
                announce: [],
            },
            resolveSeed,
        ),
    );
    if (!seeder.listening) await once(seeder, 'listening');
    const torrent = await new Promise((resolveTorrent) =>
        downloader.add(
            seed.torrentFile,
            {
                path: destination,
                deselect: true,
                strategy: 'sequential',
            },
            resolveTorrent,
        ),
    );
    const normal = torrent.files.find((file) => file.name === 'a-normal.bin');
    const gap = torrent.files.find((file) => file.name === 'b-gap.bin');
    const high = torrent.files.find((file) => file.name === 'c-high.bin');
    assert.ok(normal && gap && high);
    assert.ok(normal._endPiece < gap._startPiece && gap._endPiece < high._startPiece);
    normal.select(0);
    high.select(10);
    const order = [];
    torrent.on('verified', (index) => order.push(index));
    const startedAt = Date.now();
    assert.equal(torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`), true);
    const end = Date.now() + 20_000;
    const complete = (file) => {
        for (let index = file._startPiece; index <= file._endPiece; index++) {
            if (!torrent.bitfield.get(index)) return false;
        }
        return true;
    };
    while (!complete(normal) || !complete(high)) {
        if (failure) throw failure;
        if (Date.now() > end)
            throw new Error(
                `Timeout aguardando arquivos selecionados: normal=${normal.progress}, alta=${high.progress}, peers=${torrent.numPeers}, recebido=${torrent.received}, verificadas=${order.length}`,
            );
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const firstEight = order.slice(0, 8);
    assert.equal(firstEight.length, 8);
    const highFirst = firstEight.filter(
        (index) => index >= high._startPiece && index <= high._endPiece,
    ).length;
    assert.ok(
        highFirst >= 6,
        `Apenas ${highFirst} das primeiras oito peças pertencem ao arquivo prioritário`,
    );
    assert.equal(gap.downloaded, 0);
    const report = {
        ok: true,
        firstEightVerifiedPieces: firstEight,
        priorityPiecesAmongFirstEight: highFirst,
        unselectedBytes: gap.downloaded,
        globalDownloadLimitBytesPerSecond: 128 * 1024,
        elapsedMilliseconds: Date.now() - startedAt,
        verifiedContentBytes: normal.length + high.length,
        scope: 'WebTorrent real, um peer TCP local, arquivos alinhados e separados por arquivo não selecionado; sem descoberta externa.',
    };
    writeFileSync(join(root, 'priority-report.json'), JSON.stringify(report, null, 4));
    console.log(JSON.stringify(report, null, 4));
    console.log(`Evidências preservadas em ${root}`);
} finally {
    await Promise.allSettled(clients.map(close));
    clearTimeout(timer);
}
