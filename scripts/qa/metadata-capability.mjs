/* global process, console, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebTorrent from 'webtorrent';
import { createTorrentPreparation } from '../../main/torrentPreparation';

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
const seedClient = new WebTorrent(config);
const clients = [seedClient];
const close = (client) =>
    new Promise((resolve, reject) => {
        if (client.destroyed) return resolve();
        client.destroy((error) => (error ? reject(error) : resolve()));
    });
const timeout = setTimeout(() => {
    console.error('Timeout do ensaio de metadados');
    process.exit(1);
}, 30_000);
let temporary;
let transportBytes = 0;
let contentBytes = 0;
let listenAddress;
let outboundAddress;
try {
    const source = join(process.env.MESHY_QA_ROOT, 'metadata-payload.bin');
    writeFileSync(source, randomBytes(256 * 1024));
    const seed = await new Promise((resolve) =>
        seedClient.seed(source, { announce: [], private: true }, resolve),
    );
    if (!seedClient.listening) await once(seedClient, 'listening');
    const preparation = createTorrentPreparation({
        createClient: () => {
            temporary = new WebTorrent(config);
            clients.push(temporary);
            const add = temporary.add.bind(temporary);
            temporary.add = (...args) => {
                const torrent = add(...args);
                torrent.on('download', (bytes) => {
                    transportBytes += bytes;
                });
                torrent.on('wire', (wire) => {
                    listenAddress = temporary._connPool.tcpServer.address()?.address;
                    outboundAddress = [...torrent._peers.values()].find(
                        (peer) => peer.conn?.localAddress,
                    )?.conn.localAddress;
                    wire.on('download', (bytes) => {
                        contentBytes += bytes;
                    });
                });
                torrent.once('infoHash', () => {
                    assert.equal(torrent.addPeer(`127.0.0.1:${seedClient.torrentPort}`), true);
                });
                return torrent;
            };
            return temporary;
        },
        metadataTimeoutMs: 15_000,
    });
    try {
        const preview = await preparation.prepare('local-metadata', {
            kind: 'magnet',
            magnetUri: `magnet:?xt=urn:btih:${seed.infoHash}`,
        });
        assert.equal(preview.infoHash, seed.infoHash);
        assert.equal(preview.files.length, 1);
        assert.equal(preview.files[0].length, 256 * 1024);
        assert.ok(transportBytes > 0);
        assert.equal(contentBytes, 0);
        assert.ok(listenAddress);
        assert.equal(outboundAddress, '127.0.0.1');
        assert.equal(temporary.destroyed, true);
        assert.ok(preparation.get('local-metadata').buffer.length > 0);
        const report = {
            ok: true,
            metadataFiles: preview.files.length,
            transportBytesReceived: transportBytes,
            contentBytesDownloaded: contentBytes,
            listeningAddress: listenAddress,
            outboundAddress,
            temporaryClientDestroyed: temporary.destroyed,
            scope: 'Cliente temporário real, um peer TCP local explícito; descoberta e transportes externos desabilitados.',
        };
        writeFileSync(
            join(process.env.MESHY_QA_ROOT, 'metadata-report.json'),
            JSON.stringify(report, null, 4),
        );
        console.log(JSON.stringify(report, null, 4));
    } finally {
        preparation.dispose();
    }
} finally {
    await Promise.allSettled(clients.map(close));
    clearTimeout(timeout);
}
