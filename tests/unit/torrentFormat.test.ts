import { isV2OnlyTorrent } from '../../main/torrentFormat';

describe('identificação de metadados exclusivamente v2', () => {
    const v2 = Buffer.from(
        'd4:infod9:file treede12:meta versioni2e4:name4:test12:piece lengthi16384eee',
    );
    const hybrid = Buffer.from(
        'd4:infod6:lengthi0e12:meta versioni2e4:name4:test12:piece lengthi16384e6:pieces0:ee',
    );
    test('distingue v2 de v1 e híbrido', () => {
        expect(isV2OnlyTorrent(v2)).toBe(true);
        expect(isV2OnlyTorrent(hybrid)).toBe(false);
        expect(
            isV2OnlyTorrent(
                Buffer.from('d4:infod6:lengthi0e4:name4:test12:piece lengthi16384e6:pieces0:ee'),
            ),
        ).toBe(false);
    });
    test('não classifica dados truncados, marcadores em strings ou estruturas profundas', () => {
        expect(isV2OnlyTorrent(v2.subarray(0, -1))).toBe(false);
        expect(isV2OnlyTorrent(Buffer.from('d4:info17:12:meta versionee'))).toBe(false);
        expect(isV2OnlyTorrent(Buffer.from(`d4:info${'l'.repeat(70)}${'e'.repeat(71)}e`))).toBe(
            false,
        );
    });
});
