/* global console */
// Fixtures próprias em memória; sem rede ou acesso à biblioteca do usuário.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import bencode from 'bencode';
import parseTorrent from 'parse-torrent';

const payload = Buffer.from('a');
const pieces = createHash('sha1').update(payload).digest();
const v1 = { name: 'fixture.bin', length: 1, 'piece length': 16384, pieces };
const v2 = {
    name: 'fixture.bin',
    'piece length': 16384,
    'meta version': 2,
    'file tree': { 'fixture.bin': { '': { length: 1, 'pieces root': Buffer.alloc(32) } } },
};
const fixtures = {
    v1,
    privado: { ...v1, private: 1 },
    hibrido: { ...v1, 'meta version': 2, 'file tree': v2['file tree'] },
    v2,
};
for (const [name, info] of Object.entries(fixtures)) {
    const input = bencode.encode({ info });
    if (name === 'v2') {
        await assert.rejects(parseTorrent(input), /pieces/);
        console.log(`${name}: rejeitado pelo parser (sem peças v1)`);
    } else {
        const parsed = await parseTorrent(input);
        assert.match(parsed.infoHash, /^[a-f0-9]{40}$/);
        assert.equal(parsed.files.length, 1);
        assert.equal(parsed.files[0].length, 1);
        if (name === 'privado') assert.equal(parsed.private, true);
        console.log(`${name}: parser aceita metadados v1; privado=${!!parsed.private}`);
    }
}
await assert.rejects(parseTorrent(`magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}`));
console.log('magnet v2: rejeitado pelo parser');
