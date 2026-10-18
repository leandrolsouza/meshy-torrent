/* global process, setTimeout, clearTimeout, console */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import WebTorrent from 'webtorrent';
import log from 'electron-log';
import { createTorrentEngine } from '../../main/torrentEngine';
import { createDownloadManager } from '../../main/downloadManager';
import { createSettingsManager } from '../../main/settingsManager';

const root = resolve(process.env.MESHY_QA_ROOT);
const destination = join(root, 'downloads');
mkdirSync(destination, { recursive: true });
// Nenhum log/sessão padrão do usuário deve ser acessado por este processo.
log.transports.file.level = false;
const config = {
    dht: false,
    tracker: false,
    lsd: false,
    utPex: false,
    utp: false,
    natUpnp: false,
    natPmp: false,
};
const seedClient = new WebTorrent(config);
const clients = [seedClient];
const findings = [];
let failed;
const deadline = setTimeout(() => {
    console.error('Timeout da homologação de transferência');
    process.exit(1);
}, 100_000);
const waitUntil = async (predicate, label, timeout = 20_000) => {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (failed) throw failed;
        if (Date.now() > end) throw new Error(`Timeout: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};
const newManager = () => {
    const client = new WebTorrent(config);
    clients.push(client);
    const engine = createTorrentEngine(
        {
            downloadPath: destination,
            downloadSpeedLimit: 256,
            uploadSpeedLimit: 0,
            dhtEnabled: false,
            pexEnabled: false,
            utpEnabled: false,
        },
        client,
    );
    engine.on('error', (_hash, error) => {
        failed = error;
    });
    const stateFile = join(root, 'session.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    const store = {
        get: (key) => state[key],
        set: (key, value) => {
            state[key] = value;
            writeFileSync(stateFile, JSON.stringify(state));
        },
    };
    const settingsData = new Map([
        ['destinationFolder', destination],
        ['schemaVersion', 1],
        ['downloadSpeedLimit', 256],
        ['uploadSpeedLimit', 0],
        ['dhtEnabled', false],
        ['pexEnabled', false],
        ['utpEnabled', false],
    ]);
    const settings = createSettingsManager({
        store: {
            get: (key) => settingsData.get(key),
            set: (key, value) => settingsData.set(key, value),
        },
        getDownloadsPath: () => destination,
    });
    const manager = createDownloadManager(engine, settings, store, undefined, {
        disableCleanupTimer: true,
    });
    return { client, engine, manager };
};
const connect = (client, hash) => {
    const torrent = client.torrents.find((item) => item.infoHash === hash);
    assert.ok(torrent, 'Torrent real presente no cliente');
    torrent.addPeer(`127.0.0.1:${seedClient.torrentPort}`);
    return torrent;
};
const closeClient = (client) =>
    new Promise((resolve, reject) => {
        if (client.destroyed) return resolve();
        client.destroy((error) => (error ? reject(error) : resolve()));
    });

try {
    seedClient.on('error', (error) => {
        failed = error;
    });
    // Conteúdo próprio aleatório: sem trackers, DHT, multicast, UPnP ou peers externos.
    const source = join(root, 'payload.bin');
    const content = randomBytes(4 * 1024 * 1024);
    writeFileSync(source, content);
    const seed = await new Promise((resolve) =>
        seedClient.seed(source, { announce: [], private: true }, resolve),
    );
    if (!seedClient.listening) await once(seedClient, 'listening');
    const hash = seed.infoHash;
    const torrentPath = join(root, 'fixture.torrent');
    writeFileSync(torrentPath, seed.torrentFile);
    let current = newManager();
    const item = await current.manager.addTorrentFile(torrentPath);
    assert.equal(item.infoHash, hash);
    let torrent = connect(current.client, hash);
    await waitUntil(() => torrent.downloaded > 0 && !torrent.done, 'receber dados reais');
    await current.manager.pause(hash);
    assert.equal(current.manager.getAll()[0].status, 'paused');
    assert.equal(torrent.wires.length, 0, 'Pausa encerra as conexões');
    findings.push('transferência TCP local iniciada e pausa encerrou os peers');
    const pausedBytes = torrent.downloaded;
    await current.manager.resume(hash);
    torrent = connect(current.client, hash);
    await waitUntil(
        () => torrent.downloaded > pausedBytes + 64 * 1024 && !torrent.done,
        'retomar transferência',
    );
    current.manager.persistSession();
    const saved = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8'));
    assert.equal(saved.downloads[0].infoHash, hash);
    await closeClient(current.client);
    current = newManager();
    await current.manager.restoreSession();
    torrent = connect(current.client, hash);
    await waitUntil(() => torrent.done, 'concluir depois de restaurar sessão', 40_000);
    await waitUntil(() => current.manager.getAll()[0].status === 'seeding', 'registrar conclusão');
    const received = readFileSync(join(destination, 'payload.bin'));
    assert.equal(
        createHash('sha256').update(received).digest('hex'),
        createHash('sha256').update(content).digest('hex'),
    );
    findings.push(
        'sessão salva em disco, cliente recriado e download concluído com SHA-256 idêntico',
    );
    await current.manager.toggleSeed(hash);
    assert.equal(current.manager.getAll()[0].status, 'completed');
    assert.equal(torrent.wires.length, 0, 'Parar seed encerra os peers');
    await current.manager.toggleSeed(hash);
    assert.equal(current.manager.getAll()[0].status, 'seeding');
    current.manager.persistSession();
    await closeClient(current.client);
    current = newManager();
    await current.manager.restoreSession();
    assert.equal(current.manager.getAll()[0].status, 'seeding', 'Sessão completa retoma seed');
    torrent = current.client.torrents.find((item) => item.infoHash === hash);
    // O novo receptor só conhece o peer Meshy Torrent, sem conexão ao seeder original.
    await closeClient(seedClient);
    const receiver = new WebTorrent(config);
    clients.push(receiver);
    receiver.on('error', (error) => {
        failed = error;
    });
    const uploadDestination = join(root, 'upload-check');
    mkdirSync(uploadDestination, { recursive: true });
    const receiving = await new Promise((resolve) =>
        receiver.add(readFileSync(torrentPath), { path: uploadDestination, announce: [] }, resolve),
    );
    if (!current.client.listening) await once(current.client, 'listening');
    receiving.addPeer('127.0.0.1:' + current.client.torrentPort);
    await waitUntil(
        () => receiving.done,
        'Meshy Torrent enviar dados reais para novo peer',
        20_000,
    );
    assert.equal(
        createHash('sha256')
            .update(readFileSync(join(uploadDestination, 'payload.bin')))
            .digest('hex'),
        createHash('sha256').update(content).digest('hex'),
    );
    assert.ok(torrent.uploaded > 0, 'Meshy Torrent reporta bytes enviados');
    findings.push(
        'seeding automático, stop/resume, restauração de seed e upload TCP real com SHA-256 idêntico',
    );
    await current.manager.remove(hash, false);
    assert.ok(
        existsSync(join(destination, 'payload.bin')),
        'Remover mantendo arquivos preserva conteúdo',
    );
    findings.push('remoção sem exclusão preservou o arquivo baixado');
    const report = {
        ok: true,
        bytes: content.length,
        findings,
        scope: 'Serviços reais do main com WebTorrent real e peer TCP em 127.0.0.1; sem instalação desktop ou swarm público',
    };
    writeFileSync(join(root, 'transfer-report.json'), JSON.stringify(report, null, 4));
    console.log(JSON.stringify(report, null, 4));
} finally {
    await Promise.allSettled(clients.map(closeClient));
    clearTimeout(deadline);
}
