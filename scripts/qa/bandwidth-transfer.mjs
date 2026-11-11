/* global console, process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import WebTorrent from 'webtorrent';

const output = resolve('.build-resources/qa');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'bandwidth-'));
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
const limit = 128 * 1024;
const attemptedPerTorrentLimit = 2 * 1024;
const seeder = new WebTorrent(config);
const downloader = new WebTorrent({ ...config, downloadLimit: limit });
const clients = [seeder, downloader];
const close = (client) =>
    new Promise((resolveClose, reject) => {
        if (client.destroyed) return resolveClose();
        client.destroy((error) => (error ? reject(error) : resolveClose()));
    });
const timer = setTimeout(() => {
    console.error('Timeout do ensaio de banda');
    process.exit(1);
}, 30_000);
let failure;
for (const client of clients)
    client.on('error', (error) => {
        failure = error;
    });
try {
    const seeds = [];
    for (const name of ['first.bin', 'second.bin']) {
        const file = join(source, name);
        writeFileSync(file, randomBytes(256 * 1024));
        seeds.push(
            await new Promise((resolveSeed) =>
                seeder.seed(
                    file,
                    {
                        pieceLength: 16384,
                        private: true,
                        announce: [],
                    },
                    resolveSeed,
                ),
            ),
        );
    }
    if (!seeder.listening) await once(seeder, 'listening');
    const torrents = [];
    for (const [index, seed] of seeds.entries()) {
        // Esta opção é intencionalmente não documentada em TorrentOptions; o ensaio
        // verifica se passá-la silenciosamente cria um limite individual.
        torrents.push(
            await new Promise((resolveTorrent) =>
                downloader.add(
                    seed.torrentFile,
                    {
                        path: destination,
                        ...(index === 0 ? { downloadLimit: attemptedPerTorrentLimit } : {}),
                    },
                    resolveTorrent,
                ),
            ),
        );
    }
    const start = Date.now();
    const outboundAddresses = [];
    for (const torrent of torrents) {
        torrent.on('wire', () => {
            const address = [...torrent._peers.values()].find((peer) => peer.conn?.localAddress)
                ?.conn.localAddress;
            if (address) outboundAddresses.push(address);
        });
        assert.equal(torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`), true);
    }
    const end = start + 20_000;
    while (!torrents.every((torrent) => torrent.done)) {
        if (failure) throw failure;
        if (Date.now() > end) throw new Error('Timeout aguardando os torrents');
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const elapsedMilliseconds = Date.now() - start;
    assert.ok(elapsedMilliseconds < 20_000);
    // 256 KiB a 2 KiB/s demoraria ao menos 128 s, sem contar protocolo.
    const verifiedBytes = torrents.map((torrent) => torrent.downloaded);
    assert.deepEqual(verifiedBytes, [256 * 1024, 256 * 1024]);
    assert.deepEqual(outboundAddresses, ['127.0.0.1', '127.0.0.1']);
    const report = {
        ok: true,
        clientLimitBytesPerSecond: limit,
        unsupportedPerTorrentOptionBytesPerSecond: attemptedPerTorrentLimit,
        elapsedMilliseconds,
        verifiedBytes,
        listeningAddress: downloader._connPool.tcpServer.address().address,
        outboundAddresses,
        scope: 'Dois torrents privados próprios em um cliente, peers TCP locais; opção individual não faz parte da API documentada.',
    };
    writeFileSync(join(root, 'bandwidth-report.json'), JSON.stringify(report, null, 4));
    console.log(JSON.stringify(report, null, 4));
    console.log(`Evidências preservadas em ${root}`);
} finally {
    await Promise.allSettled(clients.map(close));
    clearTimeout(timer);
}
