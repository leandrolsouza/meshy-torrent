import { validatePayload, infoHashHexSchema } from '../../main/payloadValidator';

test('rejeita arrays e campos herdados', () => {
    const hash = 'a'.repeat(40);
    expect(validatePayload(Object.assign([], { infoHash: hash }), infoHashHexSchema).valid).toBe(
        false,
    );
    expect(validatePayload(Object.create({ infoHash: hash }), infoHashHexSchema).valid).toBe(false);
    expect(validatePayload({ infoHash: hash }, infoHashHexSchema).valid).toBe(true);
});

test.each([NaN, Infinity, -Infinity])('rejeita número não finito: %s', (value) => {
    expect(
        validatePayload({ value }, { value: { type: 'number', validate: Number.isFinite } }).valid,
    ).toBe(false);
});
