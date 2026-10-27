import {
    isValidMagnetUri,
    normalizeMagnetUri,
    isValidTorrentFile,
    hasTorrentMagicBytes,
    isValidSpeedLimit,
    isValidNetworkToggle,
    isValidMaxConcurrentDownloads,
    isValidThemeId,
    MIN_CONCURRENT_DOWNLOADS,
    MAX_CONCURRENT_DOWNLOADS,
} from '../../main/validators';
import fc from 'fast-check';

// ─── isValidMagnetUri ─────────────────────────────────────────────────────────

describe('isValidMagnetUri', () => {
    const VALID_HASH = 'a'.repeat(40); // 40 hex chars

    it('accepts a minimal valid magnet URI', () => {
        expect(isValidMagnetUri(`magnet:?xt=urn:btih:${VALID_HASH}`)).toBe(true);
    });

    it('accepts a magnet URI with extra query params', () => {
        expect(
            isValidMagnetUri(
                `magnet:?xt=urn:btih:${VALID_HASH}&dn=MyTorrent&tr=udp%3A%2F%2Ftracker.example.com%3A80`,
            ),
        ).toBe(true);
    });

    it('accepts uppercase hex hash', () => {
        expect(isValidMagnetUri(`magnet:?xt=urn:btih:${'A'.repeat(40)}`)).toBe(true);
    });

    it('normaliza Base32 e parâmetros xt em ordens diferentes', () => {
        const magnet = normalizeMagnetUri(
            'MAGNET:?dn=Example&xt=urn:btmh:1220abc&XT=URN:BTIH:VKVKVKVKVKVKVKVKVKVKVKVKVKVKVKVK',
        );
        expect(magnet?.infoHash).toBe(VALID_HASH);
        expect(magnet?.uri).toContain(`xt=urn:btih:${VALID_HASH}`);
    });

    it('aceita identidades equivalentes e rejeita hashes v1 conflitantes', () => {
        expect(
            isValidMagnetUri(`magnet:?xt=urn:btih:${VALID_HASH}&xt=urn:btih:${'A'.repeat(40)}`),
        ).toBe(true);
        expect(
            isValidMagnetUri(`magnet:?xt=urn:btih:${VALID_HASH}&xt=urn:btih:${'b'.repeat(40)}`),
        ).toBe(false);
    });

    it.each([
        '&tr=udp://tracker.example.test:6969/announce',
        '&tr=https://tracker.example.test/announce&tr=udp://other.example.test:80/announce',
        '&dn=Archive_(2026)!&so=0,2-4',
        '&x.pe=[2001:db8::1]:6881',
    ])('aceita parâmetros de URI de magnets recebidos do navegador: %s', (query) => {
        expect(isValidMagnetUri(`magnet:?xt=urn:btih:${VALID_HASH}${query}`)).toBe(true);
    });

    it.each(['\u0000', '\n', '\r', ' ', '"', '<', '>', '#'])(
        'rejeita caracteres inválidos na query: %j',
        (character) => {
            expect(isValidMagnetUri(`magnet:?xt=urn:btih:${VALID_HASH}&dn=a${character}b`)).toBe(
                false,
            );
        },
    );

    it('rejects empty string', () => {
        expect(isValidMagnetUri('')).toBe(false);
    });

    it('rejects URI with hash shorter than 40 chars', () => {
        expect(isValidMagnetUri(`magnet:?xt=urn:btih:${'a'.repeat(39)}`)).toBe(false);
    });

    it('rejects URI with hash longer than 40 chars', () => {
        expect(isValidMagnetUri(`magnet:?xt=urn:btih:${'a'.repeat(41)}`)).toBe(false);
    });

    it('rejects URI with non-hex characters in hash', () => {
        expect(isValidMagnetUri(`magnet:?xt=urn:btih:${'g'.repeat(40)}`)).toBe(false);
    });

    it('rejects plain http URL', () => {
        expect(isValidMagnetUri('http://example.com/file.torrent')).toBe(false);
    });

    it('rejects magnet URI missing xt param', () => {
        expect(isValidMagnetUri('magnet:?dn=SomeName')).toBe(false);
    });

    it('trims leading/trailing whitespace before validating', () => {
        expect(isValidMagnetUri(`  magnet:?xt=urn:btih:${VALID_HASH}  `)).toBe(true);
    });

    // Feature: meshy-torrent-client, Property 4: Validação de Magnet URI
    // **Validates: Requirements 2.1, 2.4**
    describe('property-based tests', () => {
        const MAGNET_PREFIX = 'magnet:?xt=urn:btih:';

        /** Arbitrary that generates exactly 40 hex characters */
        const hexHash40 = fc.string({
            unit: fc.constantFrom(...'0123456789abcdefABCDEF'.split('')),
            minLength: 40,
            maxLength: 40,
        });

        /** Arbitrary that generates valid optional query param suffixes */
        const optionalQueryParams = fc.oneof(
            fc.constant(''),
            fc
                .string({
                    unit: fc.constantFrom(
                        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&=%.+:?_-'.split(
                            '',
                        ),
                    ),
                    minLength: 1,
                    maxLength: 50,
                })
                .map((s) => `&${s}`),
        );

        /** Arbitrary that generates whitespace for padding */
        const whitespace = fc.string({
            unit: fc.constantFrom(' ', '\t', '\n', '\r'),
            minLength: 0,
            maxLength: 5,
        });

        it('returns true for any valid magnet URI (prefix + 40 hex chars + optional query params)', () => {
            fc.assert(
                fc.property(hexHash40, optionalQueryParams, (hash, params) => {
                    const uri = `${MAGNET_PREFIX}${hash}${params}`;
                    expect(isValidMagnetUri(uri)).toBe(true);
                }),
                { numRuns: 100 },
            );
        });

        it('returns true for valid magnet URIs with leading/trailing whitespace', () => {
            fc.assert(
                fc.property(hexHash40, whitespace, whitespace, (hash, leading, trailing) => {
                    const uri = `${leading}${MAGNET_PREFIX}${hash}${trailing}`;
                    expect(isValidMagnetUri(uri)).toBe(true);
                }),
                { numRuns: 100 },
            );
        });

        it('rejeita textos arbitrários e protocolos diferentes de magnet', () => {
            fc.assert(
                fc.property(
                    fc.string().filter((s) => !s.trim().toLowerCase().startsWith('magnet:')),
                    (s) => expect(isValidMagnetUri(s)).toBe(false),
                ),
                { numRuns: 100 },
            );
        });

        it('returns false when hash has fewer than 40 hex characters', () => {
            const shortHash = fc.string({
                unit: fc.constantFrom(...'0123456789abcdef'.split('')),
                minLength: 0,
                maxLength: 39,
            });
            fc.assert(
                fc.property(shortHash, (hash) => {
                    expect(isValidMagnetUri(`${MAGNET_PREFIX}${hash}`)).toBe(false);
                }),
                { numRuns: 100 },
            );
        });

        it('returns false when hash has more than 40 hex characters', () => {
            const longHash = fc.string({
                unit: fc.constantFrom(...'0123456789abcdef'.split('')),
                minLength: 41,
                maxLength: 80,
            });
            fc.assert(
                fc.property(longHash, (hash) => {
                    expect(isValidMagnetUri(`${MAGNET_PREFIX}${hash}`)).toBe(false);
                }),
                { numRuns: 100 },
            );
        });

        it('returns false when hash contains non-hex characters', () => {
            // Generate a 40-char string that has at least one non-hex char
            const nonHexChar = fc.constantFrom(...'ghijklmnopqrstuvwxyz!@#$%^&*()'.split(''));
            const hexChar = fc.constantFrom(...'0123456789abcdef'.split(''));
            const position = fc.integer({ min: 0, max: 39 });

            fc.assert(
                fc.property(
                    fc.array(hexChar, { minLength: 40, maxLength: 40 }),
                    nonHexChar,
                    position,
                    (chars, bad, pos) => {
                        chars[pos] = bad;
                        const hash = chars.join('');
                        expect(isValidMagnetUri(`${MAGNET_PREFIX}${hash}`)).toBe(false);
                    },
                ),
                { numRuns: 100 },
            );
        });
    });
});

// ─── Property 1: Validação de arquivo .torrent (PBT) ──────────────────────────

// Feature: meshy-torrent-client, Property 1: Validação de arquivo .torrent
// **Validates: Requirements 1.1, 1.3**
describe('Property 1: Validação de arquivo .torrent', () => {
    /**
     * Combined validation: returns true iff the file path ends with .torrent
     * AND the buffer starts with 0x64 (bencode dictionary marker).
     */
    function isValidTorrent(filePath: string, buffer: Buffer): boolean {
        return isValidTorrentFile(filePath) && hasTorrentMagicBytes(buffer);
    }

    /** Arbitrary that generates file paths ending with .torrent (case-insensitive) */
    const torrentExtension = fc.constantFrom('.torrent', '.TORRENT', '.Torrent', '.tOrReNt');
    const fileBaseName = fc.string({
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')),
        minLength: 1,
        maxLength: 30,
    });
    const torrentFilePath = fc
        .tuple(fileBaseName, torrentExtension)
        .map(([name, ext]) => name + ext);

    /** Arbitrary that generates file paths NOT ending with .torrent */
    const nonTorrentExtension = fc.constantFrom('.txt', '.zip', '.mp4', '.pdf', '.exe', '.bin', '');
    const nonTorrentFilePath = fc
        .tuple(fileBaseName, nonTorrentExtension)
        .map(([name, ext]) => name + ext);

    /** Arbitrary that generates a buffer starting with 0x64 */
    const validMagicBuffer = fc
        .tuple(
            fc.constant(0x64),
            fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 50 }),
        )
        .map(([magic, rest]) => Buffer.from([magic, ...rest]));

    /** Arbitrary that generates a buffer NOT starting with 0x64 (including empty) */
    const invalidMagicBuffer = fc.oneof(
        fc.constant(Buffer.alloc(0)),
        fc
            .tuple(
                fc.integer({ min: 0, max: 255 }).filter((b) => b !== 0x64),
                fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 50 }),
            )
            .map(([first, rest]) => Buffer.from([first, ...rest])),
    );

    it('returns true when path ends with .torrent AND buffer starts with 0x64', () => {
        fc.assert(
            fc.property(torrentFilePath, validMagicBuffer, (filePath, buffer) => {
                expect(isValidTorrent(filePath, buffer)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it('returns false when path ends with .torrent but buffer does NOT start with 0x64', () => {
        fc.assert(
            fc.property(torrentFilePath, invalidMagicBuffer, (filePath, buffer) => {
                expect(isValidTorrent(filePath, buffer)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('returns false when path does NOT end with .torrent but buffer starts with 0x64', () => {
        fc.assert(
            fc.property(nonTorrentFilePath, validMagicBuffer, (filePath, buffer) => {
                expect(isValidTorrent(filePath, buffer)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('returns false when neither condition is met', () => {
        fc.assert(
            fc.property(nonTorrentFilePath, invalidMagicBuffer, (filePath, buffer) => {
                expect(isValidTorrent(filePath, buffer)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('for any file path and buffer, returns true iff path ends with .torrent AND buffer[0] === 0x64', () => {
        fc.assert(
            fc.property(
                fc.oneof(torrentFilePath, nonTorrentFilePath),
                fc.oneof(validMagicBuffer, invalidMagicBuffer),
                (filePath, buffer) => {
                    const result = isValidTorrent(filePath, buffer);
                    const expectedPath = filePath.toLowerCase().endsWith('.torrent');
                    const expectedMagic = buffer.length > 0 && buffer[0] === 0x64;
                    expect(result).toBe(expectedPath && expectedMagic);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── isValidTorrentFile ───────────────────────────────────────────────────────

describe('isValidTorrentFile', () => {
    it('accepts a path ending with .torrent', () => {
        expect(isValidTorrentFile('/home/user/downloads/file.torrent')).toBe(true);
    });

    it('accepts a path ending with .TORRENT (uppercase)', () => {
        expect(isValidTorrentFile('/home/user/downloads/file.TORRENT')).toBe(true);
    });

    it('accepts a bare filename with .torrent extension', () => {
        expect(isValidTorrentFile('ubuntu.torrent')).toBe(true);
    });

    it('rejects a path ending with .txt', () => {
        expect(isValidTorrentFile('/home/user/file.txt')).toBe(false);
    });

    it('rejects a path ending with .torrent.bak', () => {
        expect(isValidTorrentFile('/home/user/file.torrent.bak')).toBe(false);
    });

    it('rejects an empty string', () => {
        expect(isValidTorrentFile('')).toBe(false);
    });

    it('rejects a path with no extension', () => {
        expect(isValidTorrentFile('/home/user/torrent')).toBe(false);
    });
});

// ─── PBT: Property 1 — isValidTorrentFile rejeita extensões inválidas ────────

// Property 1: Requisito 3.4
describe('[PBT] Property 1: isValidTorrentFile — extensão .torrent (case-insensitive)', () => {
    const fileBaseName = fc.string({
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')),
        minLength: 1,
        maxLength: 30,
    });

    /** Gerador de extensões .torrent com variações de capitalização */
    const torrentExtension = fc.constantFrom('.torrent', '.TORRENT', '.Torrent', '.tOrReNt');

    /** Gerador de extensões que NÃO são .torrent */
    const nonTorrentExtension = fc.constantFrom('.txt', '.zip', '.mp4', '.pdf', '.exe', '.bin', '');

    it('retorna true para qualquer caminho terminando com .torrent (case-insensitive)', () => {
        // Property 1: Requisito 3.4
        fc.assert(
            fc.property(
                fc.tuple(fileBaseName, torrentExtension).map(([name, ext]) => name + ext),
                (filePath) => {
                    expect(isValidTorrentFile(filePath)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer caminho que não termina com .torrent', () => {
        // Property 1: Requisito 3.4
        fc.assert(
            fc.property(
                fc.tuple(fileBaseName, nonTorrentExtension).map(([name, ext]) => name + ext),
                (filePath) => {
                    expect(isValidTorrentFile(filePath)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── hasTorrentMagicBytes ─────────────────────────────────────────────────────

describe('hasTorrentMagicBytes', () => {
    it('returns true for a buffer starting with 0x64 (d)', () => {
        const buf = Buffer.from([0x64, 0x00, 0x01]);
        expect(hasTorrentMagicBytes(buf)).toBe(true);
    });

    it('returns true for a buffer that is exactly [0x64]', () => {
        const buf = Buffer.from([0x64]);
        expect(hasTorrentMagicBytes(buf)).toBe(true);
    });

    it('returns false for a buffer starting with a different byte', () => {
        const buf = Buffer.from([0x65, 0x64]); // starts with 'e', not 'd'
        expect(hasTorrentMagicBytes(buf)).toBe(false);
    });

    it('returns false for an empty buffer', () => {
        const buf = Buffer.alloc(0);
        expect(hasTorrentMagicBytes(buf)).toBe(false);
    });

    it('returns false for a buffer starting with 0x00', () => {
        const buf = Buffer.from([0x00, 0x64]);
        expect(hasTorrentMagicBytes(buf)).toBe(false);
    });
});

// ─── PBT: Property 2 — hasTorrentMagicBytes detecta por primeiro byte ────────

// Property 2: Requisito 3.4
describe('[PBT] Property 2: hasTorrentMagicBytes retorna true sse buffer.length > 0 && buffer[0] === 0x64', () => {
    /** Gerador de buffer não-vazio com primeiro byte exatamente 0x64 */
    const bufferWithMagicByte = fc
        .tuple(
            fc.constant(0x64),
            fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 50 }),
        )
        .map(([magic, rest]) => Buffer.from([magic, ...rest]));

    /** Gerador de buffer não-vazio com primeiro byte diferente de 0x64 */
    const bufferWithoutMagicByte = fc
        .tuple(
            fc.integer({ min: 0, max: 255 }).filter((b) => b !== 0x64),
            fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 50 }),
        )
        .map(([first, rest]) => Buffer.from([first, ...rest]));

    /** Buffer vazio */
    const emptyBuffer = fc.constant(Buffer.alloc(0));

    it('retorna true para qualquer buffer não-vazio com primeiro byte 0x64', () => {
        // Property 2: Requisito 3.4
        fc.assert(
            fc.property(bufferWithMagicByte, (buffer) => {
                expect(hasTorrentMagicBytes(buffer)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer buffer não-vazio com primeiro byte diferente de 0x64', () => {
        // Property 2: Requisito 3.4
        fc.assert(
            fc.property(bufferWithoutMagicByte, (buffer) => {
                expect(hasTorrentMagicBytes(buffer)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para buffer vazio', () => {
        // Property 2: Requisito 3.4
        fc.assert(
            fc.property(emptyBuffer, (buffer) => {
                expect(hasTorrentMagicBytes(buffer)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna true se e somente se buffer.length > 0 && buffer[0] === 0x64 (propriedade completa)', () => {
        // Property 2: Requisito 3.4
        fc.assert(
            fc.property(
                fc.oneof(bufferWithMagicByte, bufferWithoutMagicByte, emptyBuffer),
                (buffer) => {
                    const result = hasTorrentMagicBytes(buffer);
                    const expected = buffer.length > 0 && buffer[0] === 0x64;
                    expect(result).toBe(expected);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── isValidSpeedLimit ────────────────────────────────────────────────────────

describe('isValidSpeedLimit', () => {
    it('accepts 0 (no limit)', () => {
        expect(isValidSpeedLimit(0)).toBe(true);
    });

    it('accepts positive integers', () => {
        expect(isValidSpeedLimit(1)).toBe(true);
        expect(isValidSpeedLimit(512)).toBe(true);
        expect(isValidSpeedLimit(10000)).toBe(true);
    });

    it('rejects negative integers', () => {
        expect(isValidSpeedLimit(-1)).toBe(false);
        expect(isValidSpeedLimit(-100)).toBe(false);
    });

    it('rejects floating-point numbers', () => {
        expect(isValidSpeedLimit(1.5)).toBe(false);
        expect(isValidSpeedLimit(0.1)).toBe(false);
    });

    it('rejects strings', () => {
        expect(isValidSpeedLimit('100')).toBe(false);
        expect(isValidSpeedLimit('0')).toBe(false);
    });

    it('rejects null and undefined', () => {
        expect(isValidSpeedLimit(null)).toBe(false);
        expect(isValidSpeedLimit(undefined)).toBe(false);
    });

    it('rejects NaN', () => {
        expect(isValidSpeedLimit(NaN)).toBe(false);
    });

    it('rejects Infinity', () => {
        expect(isValidSpeedLimit(Infinity)).toBe(false);
    });

    it('rejects objects and arrays', () => {
        expect(isValidSpeedLimit({})).toBe(false);
        expect(isValidSpeedLimit([])).toBe(false);
    });

    // Feature: meshy-torrent-client, Property 14: Rejeição de Speed_Limit inválido
    // **Validates: Requirements 6.6**
    describe('Property 14: Rejeição de Speed_Limit inválido', () => {
        it('rejects negative numbers', () => {
            fc.assert(
                fc.property(fc.integer({ min: -1_000_000, max: -1 }), (n) => {
                    expect(isValidSpeedLimit(n)).toBe(false);
                }),
                { numRuns: 100 },
            );
        });

        it('rejects floating-point numbers (non-integer)', () => {
            fc.assert(
                fc.property(
                    fc
                        .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
                        .filter((n) => !Number.isInteger(n)),
                    (n) => {
                        expect(isValidSpeedLimit(n)).toBe(false);
                    },
                ),
                { numRuns: 100 },
            );
        });

        it('rejects strings', () => {
            fc.assert(
                fc.property(fc.string(), (s) => {
                    expect(isValidSpeedLimit(s)).toBe(false);
                }),
                { numRuns: 100 },
            );
        });

        it('rejects null and undefined', () => {
            expect(isValidSpeedLimit(null)).toBe(false);
            expect(isValidSpeedLimit(undefined)).toBe(false);
        });

        it('rejects NaN and Infinity', () => {
            expect(isValidSpeedLimit(NaN)).toBe(false);
            expect(isValidSpeedLimit(Infinity)).toBe(false);
            expect(isValidSpeedLimit(-Infinity)).toBe(false);
        });

        it('rejects objects, arrays, booleans, and other non-integer types', () => {
            fc.assert(
                fc.property(
                    fc.oneof(
                        fc.object(),
                        fc.array(fc.anything()),
                        fc.boolean(),
                        fc.constant(null),
                        fc.constant(undefined),
                        fc.constant(NaN),
                        fc.constant(Infinity),
                        fc.constant(-Infinity),
                        fc.constant(Symbol('test')),
                    ),
                    (value) => {
                        expect(isValidSpeedLimit(value)).toBe(false);
                    },
                ),
                { numRuns: 100 },
            );
        });

        it('accepts only non-negative integers and rejects everything else', () => {
            fc.assert(
                fc.property(
                    fc.oneof(
                        // Valid: non-negative integers
                        fc.nat().map((n) => ({ value: n, expected: true })),
                        // Invalid: negative integers
                        fc
                            .integer({ min: -1_000_000, max: -1 })
                            .map((n) => ({ value: n, expected: false })),
                        // Invalid: floats
                        fc
                            .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
                            .filter((n) => !Number.isInteger(n))
                            .map((n) => ({ value: n, expected: false })),
                        // Invalid: strings
                        fc.string().map((s) => ({ value: s, expected: false })),
                        // Invalid: null/undefined
                        fc.constant({ value: null, expected: false }),
                        fc.constant({ value: undefined, expected: false }),
                    ),
                    ({ value, expected }) => {
                        expect(isValidSpeedLimit(value)).toBe(expected);
                    },
                ),
                { numRuns: 100 },
            );
        });
    });
});

// ─── Importações para testes de Tracker URL ───────────────────────────────────

import { isValidTrackerUrl, normalizeTrackerUrl } from '../../shared/validators';

// ─── isValidTrackerUrl (testes unitários) ─────────────────────────────────────

describe('isValidTrackerUrl', () => {
    it('aceita URL http com hostname', () => {
        expect(isValidTrackerUrl('http://tracker.example.com:6969/announce')).toBe(true);
    });

    it('aceita URL https com hostname', () => {
        expect(isValidTrackerUrl('https://tracker.example.com/announce')).toBe(true);
    });

    it('aceita URL udp com hostname e porta', () => {
        expect(isValidTrackerUrl('udp://tracker.example.com:6969/announce')).toBe(true);
    });

    it('aceita URL udp sem path', () => {
        expect(isValidTrackerUrl('udp://tracker.example.com:6969')).toBe(true);
    });

    it('aceita URL http sem /announce no path', () => {
        expect(isValidTrackerUrl('http://tracker.example.com:8080')).toBe(true);
    });

    it('rejeita string vazia', () => {
        expect(isValidTrackerUrl('')).toBe(false);
    });

    it('rejeita string com apenas espaços', () => {
        expect(isValidTrackerUrl('   ')).toBe(false);
    });

    it('rejeita protocolo ftp', () => {
        expect(isValidTrackerUrl('ftp://tracker.example.com/announce')).toBe(false);
    });

    it('rejeita protocolo wss', () => {
        expect(isValidTrackerUrl('wss://tracker.example.com/announce')).toBe(false);
    });

    it('rejeita string sem protocolo', () => {
        expect(isValidTrackerUrl('tracker.example.com/announce')).toBe(false);
    });

    it('rejeita URL com protocolo válido mas sem hostname', () => {
        expect(isValidTrackerUrl('http://')).toBe(false);
    });

    it('aceita URL com espaços ao redor (trim)', () => {
        expect(isValidTrackerUrl('  http://tracker.example.com  ')).toBe(true);
    });
});

// ─── normalizeTrackerUrl (testes unitários) ────────────────────────────────────

describe('normalizeTrackerUrl', () => {
    it('remove espaços no início e fim', () => {
        expect(normalizeTrackerUrl('  http://tracker.example.com  ')).toBe(
            'http://tracker.example.com',
        );
    });

    it('converte protocolo para minúsculas', () => {
        expect(normalizeTrackerUrl('HTTP://tracker.example.com')).toBe(
            'http://tracker.example.com',
        );
    });

    it('converte protocolo UDP para minúsculas', () => {
        expect(normalizeTrackerUrl('UDP://tracker.example.com:6969')).toBe(
            'udp://tracker.example.com:6969',
        );
    });

    it('remove barras finais duplicadas', () => {
        expect(normalizeTrackerUrl('http://tracker.example.com/announce///')).toBe(
            'http://tracker.example.com/announce',
        );
    });

    it('remove barra final única', () => {
        expect(normalizeTrackerUrl('http://tracker.example.com/')).toBe(
            'http://tracker.example.com',
        );
    });

    it('não altera URL já normalizada', () => {
        const url = 'http://tracker.example.com/announce';
        expect(normalizeTrackerUrl(url)).toBe(url);
    });

    it('aplica trim e lowercase de protocolo juntos', () => {
        expect(normalizeTrackerUrl('  HTTPS://Tracker.Example.COM/announce/  ')).toBe(
            'https://Tracker.Example.COM/announce',
        );
    });
});

// ─── PBT: Propriedade 1 — URLs válidas aceitas, protocolos inválidos rejeitados ───

// Feature: tracker-management, Propriedade 1: Validação de Tracker URL
// **Validates: Requirements 7.1, 7.2**
describe('[PBT] Propriedade 1: URLs com protocolos válidos são aceitas; protocolos inválidos são rejeitados', () => {
    /** Gerador de hostnames válidos */
    const validHostname = fc
        .string({
            unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
            minLength: 1,
            maxLength: 20,
        })
        .map((s) => s + '.com');

    /** Gerador de portas opcionais */
    const optionalPort = fc.oneof(
        fc.constant(''),
        fc.integer({ min: 1, max: 65535 }).map((p) => `:${p}`),
    );

    /** Gerador de paths opcionais */
    const optionalPath = fc.oneof(
        fc.constant(''),
        fc.constant('/announce'),
        fc.constant('/scrape'),
        fc
            .string({
                unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789/-_'.split('')),
                minLength: 1,
                maxLength: 20,
            })
            .map((s) => '/' + s),
    );

    /** Protocolos válidos */
    const validProtocol = fc.constantFrom('http', 'https', 'udp');

    /** Protocolos inválidos */
    const invalidProtocol = fc.constantFrom('ftp', 'wss', 'ws', 'ssh', 'magnet', 'irc', 'smtp');

    it('aceita URLs com protocolos válidos e hostname não-vazio', () => {
        fc.assert(
            fc.property(
                validProtocol,
                validHostname,
                optionalPort,
                optionalPath,
                (proto, host, port, path) => {
                    const url = `${proto}://${host}${port}${path}`;
                    expect(isValidTrackerUrl(url)).toBe(true);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('rejeita URLs com protocolos inválidos', () => {
        fc.assert(
            fc.property(
                invalidProtocol,
                validHostname,
                optionalPort,
                optionalPath,
                (proto, host, port, path) => {
                    const url = `${proto}://${host}${port}${path}`;
                    expect(isValidTrackerUrl(url)).toBe(false);
                },
            ),
            { numRuns: 200 },
        );
    });
});

// ─── PBT: Propriedade 2 — Normalização é idempotente ──────────────────────────

// Feature: tracker-management, Propriedade 2: Normalização idempotente
// **Validates: Requirements 7.4**
describe('[PBT] Propriedade 2: normalização é idempotente', () => {
    /** Gerador de URLs válidas com variações de casing e espaços */
    const validTrackerUrl = fc
        .tuple(
            fc.constantFrom('http', 'https', 'udp', 'HTTP', 'HTTPS', 'UDP', 'Http', 'Udp'),
            fc
                .string({
                    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
                    minLength: 1,
                    maxLength: 15,
                })
                .map((s) => s + '.com'),
            fc.oneof(
                fc.constant(''),
                fc.integer({ min: 1, max: 65535 }).map((p) => `:${p}`),
            ),
            fc.oneof(fc.constant(''), fc.constant('/announce'), fc.constant('/scrape')),
            fc.oneof(fc.constant(''), fc.constant('/'), fc.constant('//'), fc.constant('///')),
            fc.string({ unit: fc.constant(' '), minLength: 0, maxLength: 3 }),
            fc.string({ unit: fc.constant(' '), minLength: 0, maxLength: 3 }),
        )
        .map(
            ([proto, host, port, path, trailingSlashes, leadingSpaces, trailingSpaces]) =>
                `${leadingSpaces}${proto}://${host}${port}${path}${trailingSlashes}${trailingSpaces}`,
        );

    it('normalizeTrackerUrl(normalizeTrackerUrl(u)) === normalizeTrackerUrl(u) para toda URL válida', () => {
        fc.assert(
            fc.property(validTrackerUrl, (url) => {
                const once = normalizeTrackerUrl(url);
                const twice = normalizeTrackerUrl(once);
                expect(twice).toBe(once);
            }),
            { numRuns: 200 },
        );
    });
});

// ─── PBT: Propriedade 3 — Round-trip ──────────────────────────────────────────

// Feature: tracker-management, Propriedade 3: Round-trip
// **Validates: Requirements 7.4**
describe('[PBT] Propriedade 3: round-trip — isValidTrackerUrl(normalizeTrackerUrl(u)) é true para toda URL válida', () => {
    /** Gerador de URLs válidas com variações */
    const validTrackerUrl = fc
        .tuple(
            fc.constantFrom('http', 'https', 'udp', 'HTTP', 'HTTPS', 'UDP', 'Http', 'Udp'),
            fc
                .string({
                    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
                    minLength: 1,
                    maxLength: 15,
                })
                .map((s) => s + '.com'),
            fc.oneof(
                fc.constant(''),
                fc.integer({ min: 1, max: 65535 }).map((p) => `:${p}`),
            ),
            fc.oneof(fc.constant(''), fc.constant('/announce'), fc.constant('/scrape')),
            fc.string({ unit: fc.constant(' '), minLength: 0, maxLength: 3 }),
            fc.string({ unit: fc.constant(' '), minLength: 0, maxLength: 3 }),
        )
        .map(
            ([proto, host, port, path, leadingSpaces, trailingSpaces]) =>
                `${leadingSpaces}${proto}://${host}${port}${path}${trailingSpaces}`,
        );

    it('isValidTrackerUrl(normalizeTrackerUrl(u)) é true para toda URL válida u', () => {
        fc.assert(
            fc.property(validTrackerUrl, (url) => {
                const normalized = normalizeTrackerUrl(url);
                expect(isValidTrackerUrl(normalized)).toBe(true);
            }),
            { numRuns: 200 },
        );
    });
});

// ─── isValidNetworkToggle (testes unitários) ──────────────────────────────────

describe('isValidNetworkToggle', () => {
    it('aceita true', () => {
        expect(isValidNetworkToggle(true)).toBe(true);
    });

    it('aceita false', () => {
        expect(isValidNetworkToggle(false)).toBe(true);
    });

    it('rejeita null', () => {
        expect(isValidNetworkToggle(null)).toBe(false);
    });

    it('rejeita undefined', () => {
        expect(isValidNetworkToggle(undefined)).toBe(false);
    });

    it('rejeita número', () => {
        expect(isValidNetworkToggle(0)).toBe(false);
        expect(isValidNetworkToggle(1)).toBe(false);
        expect(isValidNetworkToggle(42)).toBe(false);
    });

    it('rejeita string', () => {
        expect(isValidNetworkToggle('')).toBe(false);
        expect(isValidNetworkToggle('true')).toBe(false);
        expect(isValidNetworkToggle('false')).toBe(false);
    });
});

// ─── PBT: Propriedade 1 — Validação rejeita valores não-booleanos ─────────────

// Feature: dht-pex-settings, Property 1: Validação rejeita valores não-booleanos
// **Validates: Requirements 2.1, 2.2**
describe('[PBT] Propriedade 1: Para qualquer não-booleano, isValidNetworkToggle retorna false; para qualquer booleano, retorna true', () => {
    it('retorna true para qualquer valor booleano', () => {
        fc.assert(
            fc.property(fc.boolean(), (value) => {
                expect(isValidNetworkToggle(value)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer valor não-booleano', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.integer(),
                    fc.string(),
                    fc.double({ noNaN: true, noDefaultInfinity: true }),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.object(),
                    fc.array(fc.anything()),
                ),
                (value) => {
                    expect(isValidNetworkToggle(value)).toBe(false);
                },
            ),
            { numRuns: 200 },
        );
    });
});

// ─── isValidMaxConcurrentDownloads ────────────────────────────────────────────

describe('isValidMaxConcurrentDownloads', () => {
    it('aceita o valor mínimo (1)', () => {
        expect(isValidMaxConcurrentDownloads(MIN_CONCURRENT_DOWNLOADS)).toBe(true);
    });

    it('aceita o valor máximo (10)', () => {
        expect(isValidMaxConcurrentDownloads(MAX_CONCURRENT_DOWNLOADS)).toBe(true);
    });

    it('aceita todos os inteiros válidos no intervalo [1, 10]', () => {
        for (let i = 1; i <= 10; i++) {
            expect(isValidMaxConcurrentDownloads(i)).toBe(true);
        }
    });

    it('rejeita 0 (abaixo do mínimo)', () => {
        expect(isValidMaxConcurrentDownloads(0)).toBe(false);
    });

    it('rejeita 11 (acima do máximo)', () => {
        expect(isValidMaxConcurrentDownloads(11)).toBe(false);
    });

    it('rejeita inteiros negativos', () => {
        expect(isValidMaxConcurrentDownloads(-1)).toBe(false);
        expect(isValidMaxConcurrentDownloads(-100)).toBe(false);
    });

    it('rejeita inteiros muito acima do máximo', () => {
        expect(isValidMaxConcurrentDownloads(100)).toBe(false);
        expect(isValidMaxConcurrentDownloads(1000)).toBe(false);
    });

    it('rejeita floats (não-inteiros)', () => {
        expect(isValidMaxConcurrentDownloads(1.5)).toBe(false);
        expect(isValidMaxConcurrentDownloads(5.5)).toBe(false);
        expect(isValidMaxConcurrentDownloads(9.9)).toBe(false);
    });

    it('rejeita strings numéricas', () => {
        expect(isValidMaxConcurrentDownloads('5')).toBe(false);
        expect(isValidMaxConcurrentDownloads('1')).toBe(false);
        expect(isValidMaxConcurrentDownloads('10')).toBe(false);
    });

    it('rejeita null', () => {
        expect(isValidMaxConcurrentDownloads(null)).toBe(false);
    });

    it('rejeita undefined', () => {
        expect(isValidMaxConcurrentDownloads(undefined)).toBe(false);
    });

    it('rejeita NaN', () => {
        expect(isValidMaxConcurrentDownloads(NaN)).toBe(false);
    });

    it('rejeita Infinity', () => {
        expect(isValidMaxConcurrentDownloads(Infinity)).toBe(false);
        expect(isValidMaxConcurrentDownloads(-Infinity)).toBe(false);
    });

    it('rejeita booleanos', () => {
        expect(isValidMaxConcurrentDownloads(true)).toBe(false);
        expect(isValidMaxConcurrentDownloads(false)).toBe(false);
    });

    it('rejeita objetos e arrays', () => {
        expect(isValidMaxConcurrentDownloads({})).toBe(false);
        expect(isValidMaxConcurrentDownloads([])).toBe(false);
        expect(isValidMaxConcurrentDownloads([5])).toBe(false);
    });
});

// ─── PBT: Property 3 — isValidMaxConcurrentDownloads respeita faixa [1, 10] ──

// Property 3: Requisito 3.4
describe('[PBT] Property 3: isValidMaxConcurrentDownloads — faixa válida [1, 10]', () => {
    /** Gerador de inteiros no intervalo válido [1, 10] */
    const validConcurrentDownloads = fc.integer({
        min: MIN_CONCURRENT_DOWNLOADS,
        max: MAX_CONCURRENT_DOWNLOADS,
    });

    /** Gerador de inteiros abaixo do mínimo (< 1) */
    const belowMin = fc.integer({ min: -1_000_000, max: MIN_CONCURRENT_DOWNLOADS - 1 });

    /** Gerador de inteiros acima do máximo (> 10) */
    const aboveMax = fc.integer({ min: MAX_CONCURRENT_DOWNLOADS + 1, max: 1_000_000 });

    /** Gerador de floats não-inteiros */
    const nonIntegerFloat = fc
        .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
        .filter((n) => !Number.isInteger(n));

    it('retorna true para qualquer inteiro no intervalo [1, 10]', () => {
        // Property 3: Requisito 3.4
        fc.assert(
            fc.property(validConcurrentDownloads, (n) => {
                expect(isValidMaxConcurrentDownloads(n)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer inteiro abaixo de 1', () => {
        // Property 3: Requisito 3.4
        fc.assert(
            fc.property(belowMin, (n) => {
                expect(isValidMaxConcurrentDownloads(n)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer inteiro acima de 10', () => {
        // Property 3: Requisito 3.4
        fc.assert(
            fc.property(aboveMax, (n) => {
                expect(isValidMaxConcurrentDownloads(n)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer float não-inteiro', () => {
        // Property 3: Requisito 3.4
        fc.assert(
            fc.property(nonIntegerFloat, (n) => {
                expect(isValidMaxConcurrentDownloads(n)).toBe(false);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para qualquer não-número', () => {
        // Property 3: Requisito 3.4
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.string(),
                    fc.boolean(),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.object(),
                    fc.array(fc.anything()),
                    fc.constant(NaN),
                    fc.constant(Infinity),
                    fc.constant(-Infinity),
                ),
                (value) => {
                    expect(isValidMaxConcurrentDownloads(value)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('retorna true se e somente se o valor é inteiro em [1, 10] (propriedade completa)', () => {
        // Property 3: Requisito 3.4
        fc.assert(
            fc.property(
                fc.oneof(
                    validConcurrentDownloads.map((n) => ({ value: n, expected: true })),
                    belowMin.map((n) => ({ value: n, expected: false })),
                    aboveMax.map((n) => ({ value: n, expected: false })),
                    nonIntegerFloat.map((n) => ({ value: n, expected: false })),
                    fc.string().map((s) => ({ value: s, expected: false })),
                    fc.constant({ value: null, expected: false }),
                    fc.constant({ value: undefined, expected: false }),
                ),
                ({ value, expected }) => {
                    expect(isValidMaxConcurrentDownloads(value)).toBe(expected);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── isValidThemeId ───────────────────────────────────────────────────────────

describe('isValidThemeId', () => {
    it('aceita string não-vazia simples', () => {
        expect(isValidThemeId('dark')).toBe(true);
    });

    it('aceita string não-vazia com hífens e underscores', () => {
        expect(isValidThemeId('dark-theme')).toBe(true);
        expect(isValidThemeId('theme_v2')).toBe(true);
    });

    it('aceita string com um único caractere', () => {
        expect(isValidThemeId('a')).toBe(true);
    });

    it('aceita string com espaços internos (não-vazia)', () => {
        expect(isValidThemeId('my theme')).toBe(true);
    });

    it('aceita string com caracteres especiais', () => {
        expect(isValidThemeId('theme@2025')).toBe(true);
    });

    it('rejeita string vazia', () => {
        expect(isValidThemeId('')).toBe(false);
    });

    it('rejeita número zero', () => {
        expect(isValidThemeId(0)).toBe(false);
    });

    it('rejeita número positivo', () => {
        expect(isValidThemeId(1)).toBe(false);
        expect(isValidThemeId(42)).toBe(false);
    });

    it('rejeita null', () => {
        expect(isValidThemeId(null)).toBe(false);
    });

    it('rejeita undefined', () => {
        expect(isValidThemeId(undefined)).toBe(false);
    });

    it('rejeita booleano true', () => {
        expect(isValidThemeId(true)).toBe(false);
    });

    it('rejeita booleano false', () => {
        expect(isValidThemeId(false)).toBe(false);
    });

    it('rejeita objeto', () => {
        expect(isValidThemeId({})).toBe(false);
        expect(isValidThemeId({ id: 'dark' })).toBe(false);
    });

    it('rejeita array', () => {
        expect(isValidThemeId([])).toBe(false);
        expect(isValidThemeId(['dark'])).toBe(false);
    });
});

// ─── PBT: Property 4 — isValidThemeId rejeita não-strings e strings vazias ───

// Property 4: Requisito 3.4
describe('[PBT] Property 4: isValidThemeId — strings não-vazias são válidas; não-strings e strings vazias são inválidas', () => {
    it('retorna true para qualquer string não-vazia', () => {
        // Property 4: Requisito 3.4
        fc.assert(
            fc.property(fc.string({ minLength: 1 }), (s) => {
                expect(isValidThemeId(s)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it('retorna false para string vazia', () => {
        // Property 4: Requisito 3.4
        expect(isValidThemeId('')).toBe(false);
    });

    it('retorna false para qualquer não-string', () => {
        // Property 4: Requisito 3.4
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.integer(),
                    fc.double({ noNaN: true, noDefaultInfinity: true }),
                    fc.boolean(),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.object(),
                    fc.array(fc.anything()),
                    fc.constant(NaN),
                    fc.constant(Infinity),
                    fc.constant(-Infinity),
                ),
                (value) => {
                    expect(isValidThemeId(value)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('retorna true se e somente se o valor é uma string não-vazia (propriedade completa)', () => {
        // Property 4: Requisito 3.4
        fc.assert(
            fc.property(
                fc.oneof(
                    fc
                        .string({ minLength: 1 })
                        .map((s) => ({ value: s as unknown, expected: true })),
                    fc.constant({ value: '' as unknown, expected: false }),
                    fc.integer().map((n) => ({ value: n as unknown, expected: false })),
                    fc.boolean().map((b) => ({ value: b as unknown, expected: false })),
                    fc.constant({ value: null as unknown, expected: false }),
                    fc.constant({ value: undefined as unknown, expected: false }),
                ),
                ({ value, expected }) => {
                    expect(isValidThemeId(value)).toBe(expected);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── isValidTrackerUrl — IPs privados e reservados ────────────────────────────
//
// Testa a função isPrivateHost indiretamente via isValidTrackerUrl.
// Cobre todas as faixas de IP privado/reservado bloqueadas pela proteção SSRF.

describe('isValidTrackerUrl — rejeição de IPs privados e reservados', () => {
    it('rejeita localhost via http', () => {
        expect(isValidTrackerUrl('http://localhost:6969/announce')).toBe(false);
    });

    it('rejeita localhost via https', () => {
        expect(isValidTrackerUrl('https://localhost:6969/announce')).toBe(false);
    });

    it('rejeita localhost via udp', () => {
        expect(isValidTrackerUrl('udp://localhost:6969/announce')).toBe(false);
    });

    it('rejeita IPv6 loopback [::1] via http', () => {
        expect(isValidTrackerUrl('http://[::1]:6969/announce')).toBe(false);
    });

    it('rejeita IPv6 loopback [::1] via https', () => {
        expect(isValidTrackerUrl('https://[::1]:6969')).toBe(false);
    });

    // faixa 10.0.0.0/8
    it('rejeita 10.0.0.1 (faixa 10.x.x.x) via http', () => {
        expect(isValidTrackerUrl('http://10.0.0.1:6969/announce')).toBe(false);
    });

    it('rejeita 10.255.255.255 (faixa 10.x.x.x) via https', () => {
        expect(isValidTrackerUrl('https://10.255.255.255:6969')).toBe(false);
    });

    it('rejeita 10.128.64.32 (faixa 10.x.x.x) via udp', () => {
        expect(isValidTrackerUrl('udp://10.128.64.32:6969')).toBe(false);
    });

    // faixa 172.16.0.0/12
    it('rejeita 172.16.0.1 (início da faixa privada) via http', () => {
        expect(isValidTrackerUrl('http://172.16.0.1:6969/announce')).toBe(false);
    });

    it('rejeita 172.20.10.5 (meio da faixa 172.16-31) via udp', () => {
        expect(isValidTrackerUrl('udp://172.20.10.5:6969')).toBe(false);
    });

    it('rejeita 172.31.255.255 (fim da faixa privada) via https', () => {
        expect(isValidTrackerUrl('https://172.31.255.255:6969')).toBe(false);
    });

    it('aceita 172.15.0.1 (abaixo da faixa privada) via http', () => {
        expect(isValidTrackerUrl('http://172.15.0.1:6969/announce')).toBe(true);
    });

    it('aceita 172.32.0.1 (acima da faixa privada) via http', () => {
        expect(isValidTrackerUrl('http://172.32.0.1:6969/announce')).toBe(true);
    });

    // faixa 192.168.0.0/16
    it('rejeita 192.168.0.1 (faixa 192.168.x.x) via http', () => {
        expect(isValidTrackerUrl('http://192.168.0.1:6969/announce')).toBe(false);
    });

    it('rejeita 192.168.1.100 (faixa 192.168.x.x) via udp', () => {
        expect(isValidTrackerUrl('udp://192.168.1.100:6969')).toBe(false);
    });

    it('rejeita 192.168.255.255 (faixa 192.168.x.x) via https', () => {
        expect(isValidTrackerUrl('https://192.168.255.255:6969')).toBe(false);
    });

    // faixa 169.254.0.0/16 (link-local)
    it('rejeita 169.254.0.1 (link-local) via http', () => {
        expect(isValidTrackerUrl('http://169.254.0.1:6969/announce')).toBe(false);
    });

    it('rejeita 169.254.169.254 (IMDS AWS link-local) via https', () => {
        expect(isValidTrackerUrl('https://169.254.169.254:80')).toBe(false);
    });

    it('rejeita 169.254.169.254 (IMDS AWS link-local) via udp', () => {
        expect(isValidTrackerUrl('udp://169.254.169.254:6969')).toBe(false);
    });

    // faixa 0.0.0.0/8
    it('rejeita 0.0.0.0 (faixa reservada) via http', () => {
        expect(isValidTrackerUrl('http://0.0.0.0:6969')).toBe(false);
    });

    it('rejeita 0.0.0.0 (faixa reservada) via udp', () => {
        expect(isValidTrackerUrl('udp://0.0.0.0:6969')).toBe(false);
    });

    // faixa 127.0.0.0/8 (loopback)
    it('rejeita 127.0.0.1 (loopback) via http', () => {
        expect(isValidTrackerUrl('http://127.0.0.1:6969/announce')).toBe(false);
    });

    it('rejeita 127.0.0.1 (loopback) via udp', () => {
        expect(isValidTrackerUrl('udp://127.0.0.1:6969')).toBe(false);
    });

    it('rejeita 127.255.255.255 (loopback) via https', () => {
        expect(isValidTrackerUrl('https://127.255.255.255:6969')).toBe(false);
    });

    // IPs públicos válidos — confirmação de não-bloqueio
    it('aceita IP público 8.8.8.8 via http', () => {
        expect(isValidTrackerUrl('http://8.8.8.8:6969/announce')).toBe(true);
    });

    it('aceita IP público 1.1.1.1 via udp', () => {
        expect(isValidTrackerUrl('udp://1.1.1.1:6969')).toBe(true);
    });

    it('rejeita o endereço reservado para documentação 203.0.113.1 via https', () => {
        expect(isValidTrackerUrl('https://203.0.113.1:6969')).toBe(false);
    });
});
