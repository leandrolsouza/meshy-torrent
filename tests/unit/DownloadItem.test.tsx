/**
 * @jest-environment jsdom
 */

/**
 * Testes de componente para o DownloadItem.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import '@testing-library/jest-dom';
import { DownloadItem } from '../../src/components/DownloadList/DownloadItem';
import type { DownloadItem as DownloadItemType } from '../../shared/types';
import ptBR from '../../src/locales/pt-BR.json';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderWithIntl(ui: React.ReactElement) {
    return render(
        <IntlProvider locale="pt-BR" messages={ptBR}>
            {ui}
        </IntlProvider>,
    );
}

function createItem(overrides: Partial<DownloadItemType> = {}): DownloadItemType {
    return {
        infoHash: 'abc123def456abc123def456abc123def456abc1',
        name: 'Test Torrent',
        totalSize: 1_000_000,
        downloadedSize: 500_000,
        progress: 0.5,
        downloadSpeed: 100_000,
        uploadSpeed: 50_000,
        numPeers: 5,
        numSeeders: 3,
        timeRemaining: 60_000,
        status: 'downloading',
        destinationFolder: '/tmp/downloads',
        addedAt: Date.now(),
        ...overrides,
    };
}

const defaultProps = {
    onPause: jest.fn(),
    onResume: jest.fn(),
    onRemove: jest.fn(),
    queueSize: 0,
    onMoveUp: jest.fn(),
    onMoveDown: jest.fn(),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DownloadItem — renderização básica', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renderiza o nome do torrent', () => {
        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
        expect(screen.getByText('Test Torrent')).toBeInTheDocument();
    });

    it('renderiza o status do torrent', () => {
        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
        expect(screen.getByText('Baixando')).toBeInTheDocument();
    });
});

// ─── Regressão: portal + tratamento de erro de remoção ────────────────────────

describe('DownloadItem — remoção via ConfirmDialog', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function openConfirmDialog(): void {
        // Abre o ActionMenu (botão "⋯")
        fireEvent.click(screen.getByRole('button', { name: 'Mais ações de Test Torrent' }));
        // Clica no botão de remover dentro do menu
        fireEvent.click(screen.getByRole('button', { name: 'Remover Test Torrent' }));
    }

    it('renderiza ConfirmDialog em document.body (portal)', () => {
        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);

        openConfirmDialog();

        const dialog = screen.getByRole('dialog');

        // O dialog deve estar em document.body, não dentro do card
        expect(document.body.contains(dialog)).toBe(true);
        const card = screen.getByRole('listitem');
        expect(card.contains(dialog)).toBe(false);
    });

    it('exibe alerta de erro quando onRemove retorna failure', async () => {
        const onRemove = jest
            .fn()
            .mockResolvedValue({ success: false, error: 'error.engine.restarting' });

        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} onRemove={onRemove} />);

        openConfirmDialog();

        // Confirma mantendo arquivos
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Manter arquivos' }));
        });

        // Deve aparecer um role=alert com a mensagem traduzida
        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent(
                'Motor de torrents está reiniciando. Tente novamente em alguns segundos.',
            );
        });
    });

    it('chama a remoção com exclusão de arquivos quando essa opção é confirmada', async () => {
        const onRemove = jest.fn().mockResolvedValue({ success: true });
        const item = createItem();

        renderWithIntl(<DownloadItem item={item} {...defaultProps} onRemove={onRemove} />);
        openConfirmDialog();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Excluir arquivos' }));
        });

        expect(onRemove).toHaveBeenCalledWith(item.infoHash, true);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('mostra uma mensagem se a chamada de remoção rejeitar', async () => {
        const onRemove = jest.fn().mockRejectedValue(new Error('IPC indisponível'));

        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} onRemove={onRemove} />);
        openConfirmDialog();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Manter arquivos' }));
        });

        expect(onRemove).toHaveBeenCalledWith(createItem().infoHash, false);
        expect(await screen.findByRole('alert')).toHaveTextContent('Ocorreu um erro inesperado.');
    });

    it('não exibe erro quando onRemove retorna success', async () => {
        const onRemove = jest.fn().mockResolvedValue({ success: true });

        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} onRemove={onRemove} />);

        openConfirmDialog();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Manter arquivos' }));
        });

        // Nenhum role=alert de erro deve aparecer
        await waitFor(() => {
            const alerts = screen.queryAllByRole('alert');
            // pode haver role=alert de diskSpace — mas não deve conter mensagem de erro de engine
            alerts.forEach((alert) => {
                expect(alert).not.toHaveTextContent('Motor de torrents está reiniciando');
            });
        });
    });
});

// As respostas confirmadas pelo main atualizam o store; erros permanecem visíveis.
describe('DownloadItem — seeding', () => {
    beforeEach(() => {
        Object.defineProperty(window, 'meshy', {
            configurable: true,
            value: {
                setSeedingEnabled: jest
                    .fn()
                    .mockResolvedValue({ success: false, error: 'error.engine.restarting' }),
            },
        });
    });
    it('exibe status, upload e ação de parar seed', async () => {
        renderWithIntl(
            <DownloadItem
                item={createItem({ status: 'seeding', progress: 1, uploadSpeed: 1024 })}
                {...defaultProps}
            />,
        );
        expect(screen.getByText('Seedando')).toBeInTheDocument();
        expect(screen.getByText('1.00 KB/s')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Parar seed' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Motor de torrents está reiniciando',
        );
        expect(window.meshy.setSeedingEnabled).toHaveBeenCalledWith(createItem().infoHash, false);
    });
    it('identifica seed desativado e solicita explicitamente sua retomada', async () => {
        renderWithIntl(
            <DownloadItem
                item={createItem({ status: 'completed', seedingDisabled: true })}
                {...defaultProps}
            />,
        );
        expect(screen.getByText('Seed desativado')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retomar seed' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Retomar seed' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Motor de torrents está reiniciando',
        );
        expect(window.meshy.setSeedingEnabled).toHaveBeenCalledWith(createItem().infoHash, true);
    });
});
