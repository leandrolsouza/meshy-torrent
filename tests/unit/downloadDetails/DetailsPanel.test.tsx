/** @jest-environment jsdom */

/**
 * Testes unitários para o componente DetailsPanel.
 *
 * Verifica: expansão/colapso, aba padrão "Geral", auto-colapso em status inválido,
 * botão desabilitado, painéis inativos montados.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DetailsPanel, isExpandable } from '../../../src/components/DownloadDetails/DetailsPanel';

describe('DetailsPanel', () => {
    const defaultProps = {
        infoHash: 'a'.repeat(40),
        status: 'downloading' as const,
        isExpanded: false,
        onToggle: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renderiza o painel colapsado por padrão', () => {
        const { container } = render(<DetailsPanel {...defaultProps} />);
        const panel = container.querySelector('[data-testid="details-panel"]');
        expect(panel).toHaveClass('panelCollapsed');
        expect(panel).not.toHaveClass('panelExpanded');
    });

    it('renderiza o painel expandido quando isExpanded é true', () => {
        const { container } = render(<DetailsPanel {...defaultProps} isExpanded={true} />);
        const panel = container.querySelector('[data-testid="details-panel"]');
        expect(panel).toHaveClass('panelExpanded');
        expect(panel).not.toHaveClass('panelCollapsed');
    });

    it('exibe a aba "Geral" como ativa ao expandir', () => {
        render(<DetailsPanel {...defaultProps} isExpanded={true} />);
        const generalTab = screen.getByRole('tab', { name: 'Geral' });
        expect(generalTab).toHaveAttribute('aria-selected', 'true');
    });

    it('renderiza as 4 abas na TabBar', () => {
        render(<DetailsPanel {...defaultProps} isExpanded={true} />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(4);
        expect(tabs[0]).toHaveTextContent('Geral');
        expect(tabs[1]).toHaveTextContent('Peers');
        expect(tabs[2]).toHaveTextContent('Peças');
        expect(tabs[3]).toHaveTextContent('Velocidade');
    });

    it('renderiza todos os 4 tabpanels (montados)', () => {
        render(<DetailsPanel {...defaultProps} isExpanded={true} />);
        const panels = screen.getAllByRole('tabpanel');
        expect(panels).toHaveLength(4);
    });

    it('painéis inativos estão ocultos via CSS (classe tabPanelHidden)', () => {
        const { container } = render(<DetailsPanel {...defaultProps} isExpanded={true} />);
        const panels = container.querySelectorAll('[role="tabpanel"]');
        // Apenas o painel "Geral" (primeiro) deve estar visível
        expect(panels[0]).not.toHaveClass('tabPanelHidden');
        expect(panels[1]).toHaveClass('tabPanelHidden');
        expect(panels[2]).toHaveClass('tabPanelHidden');
        expect(panels[3]).toHaveClass('tabPanelHidden');
    });

    it('consulta peers e peças apenas enquanto cada aba está visível', async () => {
        const getPeers = jest.fn().mockResolvedValue({ success: true, data: [] });
        const getPieces = jest.fn().mockResolvedValue({ success: true, data: [] });
        Object.defineProperty(window, 'meshy', {
            configurable: true,
            value: {
                getMetadata: jest.fn().mockResolvedValue({ success: true, data: {} }),
                getPeers,
                getPieces,
            },
        });

        render(<DetailsPanel {...defaultProps} isExpanded={true} />);
        expect(getPeers).not.toHaveBeenCalled();
        expect(getPieces).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('tab', { name: 'Peers' }));
        await waitFor(() => expect(getPeers).toHaveBeenCalledTimes(1));
        expect(getPieces).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('tab', { name: 'Peças' }));
        await waitFor(() => expect(getPieces).toHaveBeenCalledTimes(1));
        expect(getPeers).toHaveBeenCalledTimes(1);
    });

    it('reseta aba para "Geral" ao expandir novamente', () => {
        const { rerender } = render(<DetailsPanel {...defaultProps} isExpanded={true} />);

        // Simula colapso
        rerender(<DetailsPanel {...defaultProps} isExpanded={false} />);

        // Expande novamente
        rerender(<DetailsPanel {...defaultProps} isExpanded={true} />);

        const generalTab = screen.getByRole('tab', { name: 'Geral' });
        expect(generalTab).toHaveAttribute('aria-selected', 'true');
    });

    it('auto-colapsa quando status muda para "resolving-metadata"', () => {
        const onToggle = jest.fn();
        const { rerender } = render(
            <DetailsPanel {...defaultProps} isExpanded={true} onToggle={onToggle} />,
        );

        // Transiciona para status não-expansível
        rerender(
            <DetailsPanel
                {...defaultProps}
                isExpanded={true}
                status="resolving-metadata"
                onToggle={onToggle}
            />,
        );

        expect(onToggle).toHaveBeenCalled();
    });

    it('auto-colapsa quando status muda para "queued"', () => {
        const onToggle = jest.fn();
        const { rerender } = render(
            <DetailsPanel {...defaultProps} isExpanded={true} onToggle={onToggle} />,
        );

        // Transiciona para status não-expansível
        rerender(
            <DetailsPanel
                {...defaultProps}
                isExpanded={true}
                status="queued"
                onToggle={onToggle}
            />,
        );

        expect(onToggle).toHaveBeenCalled();
    });

    it('não auto-colapsa quando status é válido para expansão', () => {
        const onToggle = jest.fn();
        const { rerender } = render(
            <DetailsPanel {...defaultProps} isExpanded={true} onToggle={onToggle} />,
        );

        rerender(
            <DetailsPanel
                {...defaultProps}
                isExpanded={true}
                status="paused"
                onToggle={onToggle}
            />,
        );

        expect(onToggle).not.toHaveBeenCalled();
    });

    it('tabpanels possuem aria-labelledby correto', () => {
        const infoHash = 'b'.repeat(40);
        render(<DetailsPanel {...defaultProps} infoHash={infoHash} isExpanded={true} />);

        const panels = screen.getAllByRole('tabpanel');
        expect(panels[0]).toHaveAttribute('aria-labelledby', `details-${infoHash}-tab-general`);
        expect(panels[1]).toHaveAttribute('aria-labelledby', `details-${infoHash}-tab-peers`);
        expect(panels[2]).toHaveAttribute('aria-labelledby', `details-${infoHash}-tab-pieces`);
        expect(panels[3]).toHaveAttribute('aria-labelledby', `details-${infoHash}-tab-speed`);
    });
});

describe('isExpandable', () => {
    it('retorna false para "resolving-metadata"', () => {
        expect(isExpandable('resolving-metadata')).toBe(false);
    });

    it('retorna false para "queued"', () => {
        expect(isExpandable('queued')).toBe(false);
    });

    it('retorna true para "downloading"', () => {
        expect(isExpandable('downloading')).toBe(true);
    });

    it('retorna true para "paused"', () => {
        expect(isExpandable('paused')).toBe(true);
    });

    it('retorna true para "completed"', () => {
        expect(isExpandable('completed')).toBe(true);
    });

    it('retorna true para "error"', () => {
        expect(isExpandable('error')).toBe(true);
    });
});
