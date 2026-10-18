/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import '@testing-library/jest-dom';

// ─── Mock child components ────────────────────────────────────────────────────
// Mock heavy child components as simple divs with data-testid to isolate
// App layout/navigation logic from child component dependencies.

jest.mock('../../src/components/DownloadList/DownloadList', () => ({
    DownloadList: ({
        children,
        onAddTorrent,
    }: {
        children: React.ReactNode;
        onAddTorrent: () => void;
    }) => (
        <div data-testid="download-list">
            {children}
            <button onClick={onAddTorrent}>Adicionar pelo cabeçalho</button>
        </div>
    ),
}));

jest.mock('../../src/components/AddTorrent/DropZone', () => ({
    DropZone: () => <div data-testid="drop-zone">DropZone</div>,
}));

jest.mock('../../src/components/AddTorrent/AddTorrentModal', () => ({
    AddTorrentModal: () => <div data-testid="add-torrent-modal">AddTorrentModal</div>,
}));

jest.mock('../../src/components/Settings/SettingsPanel', () => ({
    SettingsPanel: () => <div data-testid="settings-panel">SettingsPanel</div>,
}));

jest.mock('../../src/components/common/LightModeButton', () => ({
    LightModeButton: () => <button>Limitar velocidade</button>,
}));

// ─── Mock themeApplier e themeRegistry ────────────────────────────────────────

const mockApplyTheme = jest.fn().mockReturnValue('vs-code-dark');

jest.mock('../../src/themes/themeApplier', () => ({
    applyTheme: (...args: unknown[]) => mockApplyTheme(...args),
}));

jest.mock('../../src/themes/themeRegistry', () => ({
    DEFAULT_THEME_ID: 'vs-code-dark',
}));

// ─── Mock window.meshy ───────────────────────────────────────────────────────

const mockMeshy = {
    getUpdateStatus: jest.fn().mockResolvedValue({
        success: true,
        data: {
            revision: 0,
            currentVersion: '0.1.0-beta.1',
            phase: 'disabled',
            disabledReason: 'development',
        },
    }),
    onUpdateStatus: jest.fn().mockReturnValue(() => {}),
    getAll: jest.fn().mockResolvedValue({ success: true, data: [] }),
    addMagnetLink: jest.fn().mockResolvedValue({ success: true, data: {} }),
    addTorrentFile: jest.fn().mockResolvedValue({ success: true, data: {} }),
    pause: jest.fn().mockResolvedValue({ success: true }),
    resume: jest.fn().mockResolvedValue({ success: true }),
    remove: jest.fn().mockResolvedValue({ success: true }),
    getSettings: jest.fn().mockResolvedValue({ success: true, data: {} }),
    setSettings: jest.fn().mockResolvedValue({ success: true, data: {} }),
    selectFolder: jest.fn().mockResolvedValue({ success: true, data: '' }),
    onProgress: jest.fn().mockReturnValue(() => {}),
    onError: jest.fn().mockReturnValue(() => {}),
};

beforeAll(() => {
    Object.defineProperty(window, 'meshy', {
        value: mockMeshy,
        writable: true,
    });
});

// ─── Import App after mocks are set up ───────────────────────────────────────

import App from '../../src/App';
import ptBR from '../../src/locales/pt-BR.json';

// ─── Helper: wrap App with IntlProvider ──────────────────────────────────────

function renderApp() {
    return render(
        <IntlProvider locale="pt-BR" defaultLocale="pt-BR" messages={ptBR}>
            <App />
        </IntlProvider>,
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────────
// Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5

describe('App — layout structure and Activity Bar navigation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('abre a adição de torrent pelo cabeçalho da lista', () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Adicionar pelo cabeçalho' }));
        expect(screen.getByTestId('add-torrent-modal')).toBeInTheDocument();
        expect(screen.queryByTestId('download-list')).not.toBeInTheDocument();
    });

    // ── Structural elements ───────────────────────────────────────────────

    it('mantém navegação, conteúdo e rodapé sem a faixa de título redundante', () => {
        renderApp();

        expect(screen.queryByRole('banner')).not.toBeInTheDocument();

        // Activity Bar — nav with aria-label
        expect(screen.getByRole('navigation', { name: 'Navegação principal' })).toBeInTheDocument();

        // Editor Area — main element
        expect(screen.getByRole('main')).toBeInTheDocument();

        // Status Bar — footer with download count
        expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    });

    it('mantém o controle de velocidade no rodapé ao trocar de tela', () => {
        renderApp();
        const footer = screen.getByRole('contentinfo');
        const control = within(footer).getByRole('button', { name: 'Limitar velocidade' });

        fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
        expect(within(footer).getByRole('button', { name: 'Limitar velocidade' })).toBe(control);

        fireEvent.click(screen.getByRole('button', { name: 'Adicionar torrent' }));
        expect(within(footer).getByRole('button', { name: 'Limitar velocidade' })).toBe(control);
    });

    // ── Default view ──────────────────────────────────────────────────────

    it('shows downloads view by default (DropZone + DownloadList)', () => {
        renderApp();

        expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
        expect(screen.getByTestId('download-list')).toBeInTheDocument();

        // Other views should not be rendered
        expect(screen.queryByTestId('add-torrent-modal')).not.toBeInTheDocument();
        expect(screen.queryByTestId('settings-panel')).not.toBeInTheDocument();
    });

    // ── Navigation: Adicionar torrent ─────────────────────────────────────

    it('shows AddTorrentModal when clicking "Adicionar torrent" button', () => {
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: 'Adicionar torrent' }));

        expect(screen.getByTestId('add-torrent-modal')).toBeInTheDocument();
        expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
        expect(screen.queryByTestId('download-list')).not.toBeInTheDocument();
    });

    // ── Navigation: Configurações ─────────────────────────────────────────

    it('shows SettingsPanel when clicking "Configurações" button', () => {
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));

        expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
        expect(screen.queryByTestId('download-list')).not.toBeInTheDocument();
    });

    // ── Navigation: back to Downloads ─────────────────────────────────────

    it('returns to downloads view when clicking "Downloads" button after navigating away', () => {
        renderApp();

        // Navigate to settings first
        fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
        expect(screen.getByTestId('settings-panel')).toBeInTheDocument();

        // Navigate back to downloads
        fireEvent.click(screen.getByRole('button', { name: 'Downloads' }));
        expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
        expect(screen.getByTestId('download-list')).toBeInTheDocument();
        expect(screen.queryByTestId('settings-panel')).not.toBeInTheDocument();
    });

    // ── Only one view at a time ───────────────────────────────────────────

    it('renders only one view at a time', () => {
        renderApp();

        // Switch to settings
        fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));

        expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
        expect(screen.queryByTestId('download-list')).not.toBeInTheDocument();
        expect(screen.queryByTestId('add-torrent-modal')).not.toBeInTheDocument();

        // Switch to add-torrent
        fireEvent.click(screen.getByRole('button', { name: 'Adicionar torrent' }));

        expect(screen.getByTestId('add-torrent-modal')).toBeInTheDocument();
        expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
        expect(screen.queryByTestId('download-list')).not.toBeInTheDocument();
        expect(screen.queryByTestId('settings-panel')).not.toBeInTheDocument();
    });
});

// ─── Accessibility Tests ──────────────────────────────────────────────────────
// Requisitos: 1.4, 3.2

describe('App — accessibility', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('Activity Bar nav element has aria-label "Navegação principal"', () => {
        renderApp();

        const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
        expect(nav).toBeInTheDocument();
        expect(nav.tagName).toBe('NAV');
    });

    it('Downloads button has aria-label "Downloads"', () => {
        renderApp();

        const btn = screen.getByRole('button', { name: 'Downloads' });
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveAttribute('aria-label', 'Downloads');
    });

    it('"Adicionar torrent" button has aria-label "Adicionar torrent"', () => {
        renderApp();

        const btn = screen.getByRole('button', { name: 'Adicionar torrent' });
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveAttribute('aria-label', 'Adicionar torrent');
    });

    it('"Configurações" button has aria-label "Configurações"', () => {
        renderApp();

        const btn = screen.getByRole('button', { name: 'Configurações' });
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveAttribute('aria-label', 'Configurações');
    });

    it('all Activity Bar buttons have title attributes matching their aria-labels', () => {
        renderApp();

        const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
        const buttons = nav.querySelectorAll('button');

        expect(buttons.length).toBeGreaterThanOrEqual(3);

        buttons.forEach((button) => {
            const ariaLabel = button.getAttribute('aria-label');
            const title = button.getAttribute('title');

            expect(ariaLabel).toBeTruthy();
            expect(title).toBeTruthy();
            expect(title).toBe(ariaLabel);
        });
    });
});

// ─── Theme Initialization Tests ───────────────────────────────────────────────
// Requisitos: 2.2, 2.3, 2.4, 10.3

describe('App — inicialização de tema', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('aplica o tema salvo quando getSettings retorna um tema válido (Req 2.2)', async () => {
        mockMeshy.getSettings.mockResolvedValueOnce({
            success: true,
            data: { theme: 'dracula' },
        });

        renderApp();

        // Aguarda o efeito assíncrono executar
        await waitFor(() => expect(mockApplyTheme).toHaveBeenCalled());

        expect(mockMeshy.getSettings).toHaveBeenCalled();
        expect(mockApplyTheme).toHaveBeenCalledWith('dracula');
    });

    it('aplica tema padrão na primeira execução sem tema salvo (Req 2.4)', async () => {
        mockMeshy.getSettings.mockResolvedValueOnce({
            success: true,
            data: {},
        });

        renderApp();

        await waitFor(() => expect(mockApplyTheme).toHaveBeenCalled());

        expect(mockApplyTheme).toHaveBeenCalledWith('vs-code-dark');
    });

    it('aplica tema padrão quando getSettings retorna success: false (Req 2.4)', async () => {
        mockMeshy.getSettings.mockResolvedValueOnce({
            success: false,
            error: 'Erro ao ler configurações',
        });

        renderApp();

        await waitFor(() => expect(mockApplyTheme).toHaveBeenCalled());

        expect(mockApplyTheme).toHaveBeenCalledWith('vs-code-dark');
    });

    it('aplica tema padrão e registra erro quando getSettings lança exceção (Req 10.3)', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockMeshy.getSettings.mockRejectedValueOnce(new Error('IPC falhou'));

        renderApp();

        await waitFor(() => expect(mockApplyTheme).toHaveBeenCalled());

        expect(mockApplyTheme).toHaveBeenCalledWith('vs-code-dark');
        expect(consoleSpy).toHaveBeenCalledWith(
            '[App] Falha ao carregar tema salvo, aplicando tema padrão:',
            expect.any(Error),
        );

        consoleSpy.mockRestore();
    });

    it('aplica tema padrão quando settings.theme é string vazia (Req 2.4)', async () => {
        mockMeshy.getSettings.mockResolvedValueOnce({
            success: true,
            data: { theme: '' },
        });

        renderApp();

        await waitFor(() => expect(mockApplyTheme).toHaveBeenCalled());

        expect(mockApplyTheme).toHaveBeenCalledWith('vs-code-dark');
    });
});
