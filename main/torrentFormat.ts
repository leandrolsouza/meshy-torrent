/** Reconhece um dicionário info exclusivamente v2 sem interpretar dados dos arquivos. */
export function isV2OnlyTorrent(data: Buffer): boolean {
    let position = 0;
    const readString = (): Buffer => {
        const start = position;
        while (position < data.length && data[position]! >= 48 && data[position]! <= 57) position++;
        if (position === start || data[position] !== 58) throw new Error('bencode inválido');
        const length = Number(data.toString('ascii', start, position));
        position++;
        if (!Number.isSafeInteger(length) || length > data.length - position)
            throw new Error('bencode inválido');
        const result = data.subarray(position, position + length);
        position += length;
        return result;
    };
    const skip = (depth: number): void => {
        if (depth > 64 || position >= data.length) throw new Error('bencode inválido');
        const token = data[position];
        if (token === 105) {
            position++;
            const end = data.indexOf(101, position);
            if (end < 0 || !/^-?\d+$/.test(data.toString('ascii', position, end)))
                throw new Error('bencode inválido');
            position = end + 1;
        } else if (token === 100 || token === 108) {
            position++;
            while (position < data.length && data[position] !== 101) {
                if (token === 100) readString();
                skip(depth + 1);
            }
            if (data[position++] !== 101) throw new Error('bencode inválido');
        } else {
            readString();
        }
    };
    try {
        if (data[position++] !== 100) return false;
        let v2Only = false;
        while (position < data.length && data[position] !== 101) {
            const key = readString().toString('utf8');
            if (key !== 'info' || data[position] !== 100) {
                skip(1);
                continue;
            }
            position++;
            let v2 = false;
            let pieces = false;
            while (position < data.length && data[position] !== 101) {
                const infoKey = readString().toString('utf8');
                if (
                    infoKey === 'meta version' &&
                    data.subarray(position, position + 3).equals(Buffer.from('i2e'))
                )
                    v2 = true;
                if (infoKey === 'pieces') pieces = true;
                skip(2);
            }
            if (data[position++] !== 101) return false;
            v2Only = v2 && !pieces;
        }
        return data[position++] === 101 && position === data.length && v2Only;
    } catch {
        return false;
    }
}
