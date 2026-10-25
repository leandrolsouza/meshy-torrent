import { isPublicIpAddress, isValidTrackerUrl } from '../../shared/validators';

const blockedHosts = [
    '.',
    'localhost.',
    'LOCALHOST.',
    'sub.localhost',
    'printer.local',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '[::]',
    '[::1]',
    '[fc00::1]',
    '[fdff::1]',
    '[fe80::1]',
    '[fec0::1]',
    '[ff02::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:10.0.0.1]',
    '[::ffff:7f00:1]',
    '[::127.0.0.1]',
    '[64:ff9b::7f00:1]',
    '[2002:7f00:1::]',
    '[2001:db8::1]',
];

describe.each(['http', 'https', 'udp'])('validação de destino %s', (protocol) => {
    test.each(blockedHosts)('bloqueia %s', (host) => {
        expect(isValidTrackerUrl(`${protocol}://${host}:6969/announce`)).toBe(false);
    });
    test.each(['tracker.example.com', '8.8.8.8', '[2606:4700:4700::1111]', '[::ffff:8.8.8.8]'])(
        'preserva destinos públicos %s',
        (host) => {
            expect(isValidTrackerUrl(`${protocol}://${host}:6969/announce`)).toBe(true);
        },
    );
    test('rejeita autoridade com credenciais em vez de confundir usuário com hostname', () => {
        expect(isValidTrackerUrl(`${protocol}://public.example@127.0.0.1:6969/announce`)).toBe(
            false,
        );
        expect(isValidTrackerUrl(`${protocol}://user:password@tracker.example.com/announce`)).toBe(
            false,
        );
    });
});

test.each(['invalid', '8.8.8.999', 'fe80::1%eth0', 'localhost', '::ffff:192.168.1.1'])(
    'a classificação usada no DNS rejeita %s',
    (address) => {
        expect(isPublicIpAddress(address)).toBe(false);
    },
);
