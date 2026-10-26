// ─── Global test setup ────────────────────────────────────────────────────────
// Mocks for modules that require Electron runtime and are not available in Jest.

jest.mock('fs/promises', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
    return {
        ...actual,
        // Wrap as jest.fn() so individual tests can spy on or override these
        // without changing the default behaviour (real Node.js implementations).
        stat: jest.fn().mockImplementation(actual.stat),
        access: jest.fn().mockImplementation(actual.access),
    };
});

jest.mock('electron-log', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('electron-store', () => {
    return {
        __esModule: true,
        default: jest.fn().mockImplementation(() => {
            const data = new Map<string, unknown>();
            return {
                get: jest.fn((key: string) => data.get(key)),
                set: jest.fn((key: string | Record<string, unknown>, value?: unknown) => {
                    if (typeof key === 'string') data.set(key, value);
                    else for (const [name, entry] of Object.entries(key)) data.set(name, entry);
                }),
            };
        }),
    };
});
