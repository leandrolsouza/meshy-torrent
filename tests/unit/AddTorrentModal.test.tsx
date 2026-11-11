/**
 * @jest-environment jsdom
 *
 * Testes de acessibilidade para AddTorrentModal.
 * Requisito 8.7 (Requisitos 8.2, 8.3):
 *  - Foco inicial ao abrir o modal (textarea com autoFocus)
 *  - Fechamento por Escape
 *  - Ciclo de foco restrito aos elementos internos (focus trap)
 *  - Comportamentos se aplicam à etapa inicial e à etapa de seleção de arquivos
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import '@testing-library/jest-dom';
import { AddTorrentModal } from '../../src/components/AddTorrent/AddTorrentModal';
import ptBR from '../../src/locales/pt-BR.json';

// ─── Seletor de elementos focalizáveis (mesma constante interna do componente) ─

const FOCUSABLE_SEL =
    'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ─── Mock window.meshy ───────────────────────────────────────────────────────

const mockMeshy = {
    getSettings: jest
        .fn()
        .mockResolvedValue({ success: true, data: { destinationFolder: '/downloads' } }),
    selectFolder: jest.fn().mockResolvedValue({ success: false }),
    prepareTorrent: jest.fn().mockImplementation((requestId: string) =>
        Promise.resolve({
            success: true,
            data: {
                requestId,
                infoHash: 'a'.repeat(40),
                name: 'Video',
                files: [
                    {
                        index: 0,
                        name: 'video.mp4',
                        path: 'video.mp4',
                        length: 1048576,
                        downloaded: 0,
                        selected: true,
                    },
                ],
            },
        }),
    ),
    cancelTorrentPreparation: jest.fn().mockResolvedValue({ success: true }),
    getDiskSpace: jest.fn().mockResolvedValue({
        success: true,
        data: {
            freeBytes: 1000000000,
            selectedBytes: 1048576,
            reservedBytes: 0,
            safetyMarginBytes: 67108864,
            sufficient: true,
        },
    }),
    confirmTorrent: jest.fn().mockResolvedValue({ success: true, data: {} }),
    addMagnetLink: jest.fn().mockResolvedValue({ success: true, data: {} }),
    addTorrentFile: jest.fn().mockResolvedValue({
        success: true,
        data: { infoHash: 'abc123def456abc1' },
    }),
    selectTorrentFile: jest.fn().mockResolvedValue({ success: false }),
    getFiles: jest.fn().mockResolvedValue({
        success: true,
        data: [
            {
                index: 0,
                name: 'video.mp4',
                path: 'video.mp4',
                length: 1024 * 1024,
                downloaded: 0,
                selected: true,
            },
        ],
    }),
    setFileSelection: jest.fn().mockResolvedValue({ success: true }),
};

beforeAll(() => {
    Object.defineProperty(window, 'meshy', {
        value: mockMeshy,
        writable: true,
        configurable: true,
    });
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderModal(overrides: { isOpen?: boolean; onClose?: () => void } = {}) {
    const onClose = overrides.onClose ?? jest.fn();
    const result = render(
        <IntlProvider locale="pt-BR" defaultLocale="pt-BR" messages={ptBR}>
            <AddTorrentModal isOpen={overrides.isOpen ?? true} onClose={onClose} inline={false} />
        </IntlProvider>,
    );
    return { ...result, onClose };
}

test('informa magnet apenas v2 antes de preparar ou adicionar', () => {
    renderModal();
    fireEvent.change(screen.getByRole('textbox'), {
        target: { value: `magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}` },
    });
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    expect(screen.getByText(/Linha 1: torrents apenas v2/)).toBeInTheDocument();
    expect(mockMeshy.prepareTorrent).not.toHaveBeenCalled();
});

/**
 * Avança para a etapa de seleção de arquivos do modal.
 * Requer que `renderModal()` já tenha sido chamado no teste.
 *
 * A função executa dois `act` em sequência:
 *  1. Flush da cadeia de Promises (3 chamadas IPC encadeadas com await).
 *  2. Flush do requestAnimationFrame registrado pelo useEffect de foco após o
 *     state de fileSelection ser atualizado.
 */
async function advanceToFilePickerStep(): Promise<void> {
    mockMeshy.selectTorrentFile.mockResolvedValueOnce({
        success: true,
        data: '/home/user/archive.torrent',
    });

    const fileButton = screen.getByRole('button', {
        name: /selecionar arquivo \.torrent/i,
    });
    fireEvent.click(fileButton);

    // 1) Flush da cadeia de Promises que ocorre dentro de handleTorrentFileSelect.
    //    Cada `await Promise.resolve()` avança um nível de microtask na cadeia.
    await act(async () => {
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
    });

    // 2) Após o state de fileSelection mudar, o useEffect agenda um requestAnimationFrame.
    //    Agora que os efeitos foram processados pelo act acima, podemos disparar os timers.
    await act(async () => {
        jest.runOnlyPendingTimers();
    });
}

// ─── ARIA attributes ──────────────────────────────────────────────────────────
// Requisito 8.2

describe('AddTorrentModal — atributos ARIA', () => {
    it('possui role="dialog"', () => {
        renderModal();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('possui aria-modal="true"', () => {
        renderModal();
        expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('possui aria-labelledby apontando para o título "Adicionar Torrent"', () => {
        renderModal();
        const dialog = screen.getByRole('dialog');
        const labelledById = dialog.getAttribute('aria-labelledby');
        expect(labelledById).toBeTruthy();
        const heading = document.getElementById(labelledById!);
        expect(heading).toBeInTheDocument();
        expect(heading?.textContent).toBe('Adicionar Torrent');
    });

    it('não renderiza quando isOpen=false', () => {
        renderModal({ isOpen: false });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});

// ─── Foco inicial ─────────────────────────────────────────────────────────────
// Requisito 8.2: foco movido para o primeiro elemento focalizável ao abrir

describe('AddTorrentModal — foco inicial', () => {
    it('textarea de magnet link é o primeiro elemento focalizável do dialog', () => {
        renderModal();
        const dialog = screen.getByRole('dialog');
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        // A textarea deve ser o primeiro elemento focalizável — confirma a intenção do autoFocus
        expect(elements[0]).toBe(screen.getByRole('textbox'));
    });

    it('textarea está focada imediatamente após o modal ser aberto', () => {
        renderModal();
        const textarea = screen.getByRole('textbox');
        // React chama element.focus() para props autoFocus ao montar o componente
        expect(textarea).toHaveFocus();
    });
});

// ─── Fechamento por Escape ────────────────────────────────────────────────────
// Requisito 8.2: Escape fecha o modal em qualquer etapa

describe('AddTorrentModal — fechamento por Escape', () => {
    it('chama onClose ao pressionar Escape', () => {
        const { onClose } = renderModal();
        const dialog = screen.getByRole('dialog');

        fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('não chama onClose ao pressionar outras teclas', () => {
        const { onClose } = renderModal();
        const dialog = screen.getByRole('dialog');

        fireEvent.keyDown(dialog, { key: 'Enter', code: 'Enter' });
        fireEvent.keyDown(dialog, { key: 'a', code: 'KeyA' });
        fireEvent.keyDown(dialog, { key: ' ', code: 'Space' });

        expect(onClose).not.toHaveBeenCalled();
    });

    it('chama onClose ao pressionar Escape na etapa de seleção de arquivos', async () => {
        const { onClose } = renderModal();

        await advanceToFilePickerStep();

        const dialog = screen.getByRole('dialog');
        fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ─── Focus trap — etapa de magnet link ───────────────────────────────────────
// Requisito 8.3: Tab e Shift+Tab ciclam apenas dentro do modal

describe('AddTorrentModal — focus trap (etapa de magnet link)', () => {
    it('Tab no último elemento focalizável move foco para o primeiro', () => {
        renderModal();
        const dialog = screen.getByRole('dialog');

        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        expect(elements.length).toBeGreaterThanOrEqual(2);

        const first = elements[0]!;
        const last = elements[elements.length - 1]!;

        // Foca o último elemento explicitamente
        last.focus();
        expect(document.activeElement).toBe(last);

        // Tab no último deve ciclar para o primeiro
        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: false });

        expect(document.activeElement).toBe(first);
    });

    it('Shift+Tab no primeiro elemento focalizável move foco para o último', () => {
        renderModal();
        const dialog = screen.getByRole('dialog');

        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        expect(elements.length).toBeGreaterThanOrEqual(2);

        const first = elements[0]!;
        const last = elements[elements.length - 1]!;

        // Foca o primeiro elemento explicitamente
        first.focus();
        expect(document.activeElement).toBe(first);

        // Shift+Tab no primeiro deve ciclar para o último
        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });

        expect(document.activeElement).toBe(last);
    });

    it('Tab em elemento intermediário não aciona o ciclo de foco', () => {
        renderModal();
        const dialog = screen.getByRole('dialog');

        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        if (elements.length < 3) {
            // Pula o teste se não há elemento intermediário suficiente
            return;
        }

        const middle = elements[1]!;

        middle.focus();
        expect(document.activeElement).toBe(middle);

        // Tab em elemento intermediário não deve acionar o ciclo
        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: false });

        // O foco permanece inalterado pelo handler — apenas Tab no último elemento é interceptado
        expect(document.activeElement).toBe(middle);
    });
});

// ─── Focus trap — etapa de seleção de arquivos ───────────────────────────────
// Requisito 8.3: focus trap aplica-se em todas as etapas do fluxo

describe('AddTorrentModal — focus trap (etapa de seleção de arquivos)', () => {
    it('Tab no último elemento cicla para o primeiro na etapa de seleção', async () => {
        renderModal();

        await advanceToFilePickerStep();

        const dialog = screen.getByRole('dialog');
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        expect(elements.length).toBeGreaterThanOrEqual(2);

        const first = elements[0]!;
        const last = elements[elements.length - 1]!;

        last.focus();
        expect(document.activeElement).toBe(last);

        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: false });

        expect(document.activeElement).toBe(first);
    });

    it('Shift+Tab no primeiro elemento cicla para o último na etapa de seleção', async () => {
        renderModal();

        await advanceToFilePickerStep();

        const dialog = screen.getByRole('dialog');
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        expect(elements.length).toBeGreaterThanOrEqual(2);

        const first = elements[0]!;
        const last = elements[elements.length - 1]!;

        first.focus();
        expect(document.activeElement).toBe(first);

        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });

        expect(document.activeElement).toBe(last);
    });

    it('move foco para o primeiro elemento focalizável ao entrar na etapa de seleção', async () => {
        renderModal();

        await advanceToFilePickerStep();

        const dialog = screen.getByRole('dialog');
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
        expect(elements.length).toBeGreaterThan(0);

        // O useEffect chama requestAnimationFrame(() => el.focus())
        // O advanceToFilePickerStep já incluiu runAllTimersAsync() para processar esse callback
        expect(document.activeElement).toBe(elements[0]);
    });
});
