/** @jest-environment jsdom */

/**
 * Testes unitários para integração DownloadItem + DetailsPanel.
 *
 * Verifica: botão de expansão visível, expande/colapsa, estado independente
 * entre itens, desabilitado em status inválido.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.7
 */

import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import '@testing-library/jest-dom';
import { DownloadItem } from '../../../src/components/DownloadList/DownloadItem';
import type { DownloadItem as DownloadItemType } from '../../../shared/types';
import ptBR from '../../../src/locales/pt-BR.json';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock window.meshy API (usado pelo DownloadItem e GeneralTab)
const mockMeshy = {
    getFiles: jest.fn().mockResolvedValue({ success: true, data: [] }),
    setFileSelection: jest.fn().mockResolvedValue({ success: true, data: [] }),
    openFolder: jest.fn().mockResolvedValue({ success: true }),
    openFile: jest.fn().mockResolvedValue({ success: true }),
    getMetadata: jest.fn().mockResolvedValue({
        success: true,
        data: {
            infoHash: 'a'.repeat(40),
            creator: null,
            comment: null,
            creationDate: null,
        },
    }),
    getPeers: jest.fn().mockResolvedValue({ success: true, data: [] }),
    getPieces: jest.fn().mockResolvedValue({ success: true, data: [] }),
    getTrackers: jest.fn().mockResolvedValue({ success: true, data: [] }),
};

Object.defineProperty(window, 'meshy', {
    value: mockMeshy,
    writable: true,
});

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    writable: true,
});

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
    onPause: jest.fn().mockResolvedValue(undefined),
    onResume: jest.fn().mockResolvedValue(undefined),
    onRemove: jest.fn().mockResolvedValue({ success: true }),
    queueSize: 0,
    onMoveUp: jest.fn(),
    onMoveDown: jest.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DownloadItem + DetailsPanel — integração', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('carrega arquivos pela aba e mantém um único painel visível ao trocar de aba', async () => {
        mockMeshy.getFiles.mockResolvedValueOnce({
            success: true,
            data: [
                {
                    index: 0,
                    name: 'exemplo.bin',
                    path: 'exemplo.bin',
                    length: 100,
                    downloaded: 25,
                    selected: true,
                },
            ],
        });
        const { container } = renderWithIntl(
            <DownloadItem item={createItem()} {...defaultProps} />,
        );
        fireEvent.click(screen.getByRole('button', { name: /detalhes/i }));
        expect(mockMeshy.getFiles).not.toHaveBeenCalled();
        const filesTab = screen.getByRole('tab', { name: 'Arquivos' });
        fireEvent.click(filesTab);
        await screen.findByText('exemplo.bin');
        expect(mockMeshy.getFiles).toHaveBeenCalledWith(createItem().infoHash);
        expect(filesTab).toHaveAttribute('aria-selected', 'true');
        fireEvent.keyDown(filesTab, { key: 'ArrowRight' });
        const trackersTab = screen.getByRole('tab', { name: 'Trackers' });
        expect(trackersTab).toHaveFocus();
        expect(trackersTab).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(mockMeshy.getTrackers).toHaveBeenCalled());
        const panels = Array.from(container.querySelectorAll('[role="tabpanel"]'));
        expect(panels.filter((panel) => !panel.classList.contains('tabPanelHidden'))).toHaveLength(
            1,
        );
        expect(container.querySelector('[id$="-panel-files"]')).toHaveTextContent('exemplo.bin');
        fireEvent.click(screen.getByRole('button', { name: /detalhes/i }));
        fireEvent.click(screen.getByRole('button', { name: /detalhes/i }));
        expect(screen.getByRole('tab', { name: 'Geral' })).toHaveAttribute('aria-selected', 'true');
    });

    it('remoção no menu exige confirmação e mantém a escolha explícita sobre arquivos', () => {
        const onRemove = jest.fn().mockResolvedValue({ success: true });
        renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} onRemove={onRemove} />);
        expect(
            screen.queryByRole('button', { name: /remover test torrent/i }),
        ).not.toBeInTheDocument();
        const more = screen.getByRole('button', { name: 'Mais ações de Test Torrent' });
        fireEvent.click(more);
        expect(screen.getByRole('button', { name: 'Gerenciar arquivos' })).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: /remover test torrent/i }));
        expect(onRemove).not.toHaveBeenCalled();
        fireEvent.click(
            within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }),
        );
        expect(more).toHaveFocus();
        fireEvent.click(more);
        fireEvent.click(screen.getByRole('button', { name: /remover test torrent/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Manter arquivos' }));
        expect(onRemove).toHaveBeenCalledWith(createItem().infoHash, false);
    });

    describe('Botão de expansão visível (Req 1.1)', () => {
        it('renderiza o botão "Detalhes" com ícone VscInfo', () => {
            renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toBeInTheDocument();
            expect(button).toHaveTextContent('Detalhes');
        });

        it('botão de detalhes está presente para status "downloading"', () => {
            renderWithIntl(
                <DownloadItem item={createItem({ status: 'downloading' })} {...defaultProps} />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toBeInTheDocument();
            expect(button).not.toBeDisabled();
        });

        it('botão de detalhes está presente para status "paused"', () => {
            renderWithIntl(
                <DownloadItem item={createItem({ status: 'paused' })} {...defaultProps} />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toBeInTheDocument();
            expect(button).not.toBeDisabled();
        });

        it('botão de detalhes está presente para status "completed"', () => {
            renderWithIntl(
                <DownloadItem item={createItem({ status: 'completed' })} {...defaultProps} />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toBeInTheDocument();
            expect(button).not.toBeDisabled();
        });
    });

    describe('Expande e colapsa o painel (Req 1.1, 1.2)', () => {
        it('painel inicia colapsado (aria-expanded=false)', () => {
            renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toHaveAttribute('aria-expanded', 'false');
        });

        it('clicar no botão expande o painel (aria-expanded=true)', () => {
            renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
            const button = screen.getByRole('button', { name: /detalhes/i });
            fireEvent.click(button);
            expect(button).toHaveAttribute('aria-expanded', 'true');
        });

        it('clicar novamente colapsa o painel', () => {
            renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
            const button = screen.getByRole('button', { name: /detalhes/i });
            fireEvent.click(button);
            expect(button).toHaveAttribute('aria-expanded', 'true');
            fireEvent.click(button);
            expect(button).toHaveAttribute('aria-expanded', 'false');
        });

        it('ao expandir, o DetailsPanel exibe a TabBar com abas', () => {
            renderWithIntl(<DownloadItem item={createItem()} {...defaultProps} />);
            const button = screen.getByRole('button', { name: /detalhes/i });
            fireEvent.click(button);
            const tabs = screen.getAllByRole('tab');
            expect(tabs.map((tab) => tab.textContent)).toEqual([
                'Geral',
                'Peers',
                'Peças',
                'Velocidade',
                'Arquivos',
                'Trackers',
            ]);
        });
    });

    describe('Estado independente entre itens (Req 1.3)', () => {
        it('expandir um item não afeta o outro', () => {
            const item1 = createItem({
                infoHash: 'a'.repeat(40),
                name: 'Torrent A',
            });
            const item2 = createItem({
                infoHash: 'b'.repeat(40),
                name: 'Torrent B',
            });

            const { container } = render(
                <IntlProvider locale="pt-BR" messages={ptBR}>
                    <div>
                        <DownloadItem item={item1} {...defaultProps} />
                        <DownloadItem item={item2} {...defaultProps} />
                    </div>
                </IntlProvider>,
            );

            // Encontrar os botões de detalhes por aria-label
            const buttons = screen.getAllByRole('button', { name: /detalhes/i });
            expect(buttons).toHaveLength(2);

            // Expandir apenas o primeiro item
            fireEvent.click(buttons[0]);

            // Primeiro item expandido
            expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
            // Segundo item permanece colapsado
            expect(buttons[1]).toHaveAttribute('aria-expanded', 'false');
        });

        it('ambos os itens podem ser expandidos simultaneamente', () => {
            const item1 = createItem({
                infoHash: 'a'.repeat(40),
                name: 'Torrent A',
            });
            const item2 = createItem({
                infoHash: 'b'.repeat(40),
                name: 'Torrent B',
            });

            render(
                <IntlProvider locale="pt-BR" messages={ptBR}>
                    <div>
                        <DownloadItem item={item1} {...defaultProps} />
                        <DownloadItem item={item2} {...defaultProps} />
                    </div>
                </IntlProvider>,
            );

            const buttons = screen.getAllByRole('button', { name: /detalhes/i });

            // Expandir ambos
            fireEvent.click(buttons[0]);
            fireEvent.click(buttons[1]);

            expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
            expect(buttons[1]).toHaveAttribute('aria-expanded', 'true');
        });
    });

    describe('Desabilitado em status inválido (Req 1.7)', () => {
        it('botão está desabilitado quando status é "resolving-metadata"', () => {
            renderWithIntl(
                <DownloadItem
                    item={createItem({ status: 'resolving-metadata' })}
                    {...defaultProps}
                />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toBeDisabled();
        });

        it('botão está desabilitado quando status é "queued"', () => {
            renderWithIntl(
                <DownloadItem
                    item={createItem({ status: 'queued', queuePosition: 1 })}
                    {...defaultProps}
                    queueSize={1}
                />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).toBeDisabled();
        });

        it('clicar no botão desabilitado não expande o painel', () => {
            renderWithIntl(
                <DownloadItem
                    item={createItem({ status: 'resolving-metadata' })}
                    {...defaultProps}
                />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            fireEvent.click(button);
            expect(button).toHaveAttribute('aria-expanded', 'false');
        });

        it('botão está habilitado quando status é "error"', () => {
            renderWithIntl(
                <DownloadItem item={createItem({ status: 'error' })} {...defaultProps} />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).not.toBeDisabled();
        });

        it('botão está habilitado quando status é "metadata-failed"', () => {
            renderWithIntl(
                <DownloadItem item={createItem({ status: 'metadata-failed' })} {...defaultProps} />,
            );
            const button = screen.getByRole('button', { name: /detalhes/i });
            expect(button).not.toBeDisabled();
        });
    });
});
