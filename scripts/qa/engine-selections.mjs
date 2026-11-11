/* global console */
import assert from 'node:assert/strict';
import { Selections } from '../../node_modules/webtorrent/lib/selections.js';

const interval = (from, to, priority) => ({ from, to, priority, offset: 0 });
const selections = new Selections();
selections.insert(interval(0, 0, 0));
selections.insert(interval(1, 1, 10));
assert.equal(selections.length, 1);
assert.deepEqual(
    {
        from: selections.get(0).from,
        to: selections.get(0).to,
        priority: selections.get(0).priority,
    },
    { from: 0, to: 1, priority: 10 },
);
selections.remove({ from: 0, to: 0 });
assert.equal(selections.length, 1);
assert.equal(selections.get(0).from, 1);
assert.equal(selections.get(0).to, 1);
console.log(
    'Seleções adjacentes são unidas e recebem a maior prioridade; remoção separa o intervalo.',
);
