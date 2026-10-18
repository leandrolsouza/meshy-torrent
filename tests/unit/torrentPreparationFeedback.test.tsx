/** @jest-environment jsdom */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { IntlProvider } from 'react-intl';
import type { IPCResponse, TorrentPreview, TorrentSource } from '../../shared/types';
import { AddTorrentModal } from '../../src/components/AddTorrent/AddTorrentModal';
import { ExternalTorrentImporter } from '../../src/components/AddTorrent/ExternalTorrentImporter';
import ptBR from '../../src/locales/pt-BR.json';
import enUS from '../../src/locales/en-US.json';

const magnet: TorrentSource = {
    kind: 'magnet',
    magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Ubuntu%20Desktop`,
};
let finishPreparation: (response: IPCResponse<TorrentPreview>) => void;

beforeEach(() => {
    window.meshy = {
        getSettings: jest.fn().mockResolvedValue({
            success: true,
            data: { destinationFolder: '/downloads' },
        }),
        prepareTorrent: jest.fn().mockImplementation(
            () =>
                new Promise<IPCResponse<TorrentPreview>>((resolve) => {
                    finishPreparation = resolve;
                }),
        ),
        cancelTorrentPreparation: jest.fn().mockResolvedValue({ success: true }),
        getDiskSpace: jest.fn().mockResolvedValue({
            success: true,
            data: {
                freeBytes: 1_000_000,
                reservedBytes: 0,
                safetyMarginBytes: 0,
                sufficient: true,
            },
        }),
        confirmTorrent: jest.fn(),
        onExternalTorrentRequests: jest.fn().mockReturnValue(jest.fn()),
        getExternalTorrentRequests: jest.fn().mockResolvedValue({
            success: true,
            data: [{ id: 'external-magnet', source: magnet }],
        }),
    } as unknown as Window['meshy'];
});

function renderModal(source?: TorrentSource, english = false) {
    const onClose = jest.fn();
    const view = render(
        <IntlProvider locale={english ? 'en-US' : 'pt-BR'} messages={english ? enUS : ptBR}>
            <AddTorrentModal
                isOpen
                onClose={onClose}
                initialSources={source ? [source] : undefined}
            />
        </IntlProvider>,
    );
    return { ...view, onClose };
}

async function resolvePreview() {
    const requestId = (window.meshy.prepareTorrent as jest.Mock).mock.calls[0][0] as string;
    await act(async () => {
        finishPreparation({
            success: true,
            data: {
                requestId,
                infoHash: 'a'.repeat(40),
                name: 'Ubuntu Desktop',
                files: [
                    {
                        index: 0,
                        name: 'ubuntu.iso',
                        path: 'ubuntu.iso',
                        length: 100,
                        selected: true,
                        downloaded: 0,
                    },
                ],
            },
        });
    });
}

test('link externo exibe carregamento e nome recebido enquanto aguarda os metadados', async () => {
    render(
        <IntlProvider locale="pt-BR" messages={ptBR}>
            <ExternalTorrentImporter />
        </IntlProvider>,
    );
    await screen.findByRole('heading', { name: ptBR['addTorrent.preparingTitle'] });
    expect(screen.getByRole('status')).toHaveTextContent('Ubuntu Desktop');
    expect(screen.getByRole('status')).toHaveTextContent(ptBR['addTorrent.preparing']);
    expect(screen.getByRole('status')).toHaveTextContent(ptBR['addTorrent.preparingMagnetHint']);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
        screen.queryByRole('button', { name: ptBR['addTorrent.review'] }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    expect(window.meshy.confirmTorrent).not.toHaveBeenCalled();
});

test('após buscar arquivos, remove carregamento e permite revisar antes de baixar', async () => {
    renderModal(magnet);
    await resolvePreview();
    expect(
        screen.queryByRole('heading', { name: ptBR['addTorrent.preparingTitle'] }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /ubuntu.iso/ })).toBeInTheDocument();
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Iniciar download' })).toBeEnabled(),
    );
    expect(window.meshy.confirmTorrent).not.toHaveBeenCalled();
});

test.each(['button', 'escape'])(
    'cancelar durante a busca por %s ignora resposta tardia',
    async (method) => {
        const { onClose } = renderModal(magnet);
        const requestId = (window.meshy.prepareTorrent as jest.Mock).mock.calls[0][0];
        if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
        else fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(window.meshy.cancelTorrentPreparation).toHaveBeenCalledWith(requestId);
        expect(onClose).toHaveBeenCalledTimes(1);
        await resolvePreview();
        expect(screen.queryByRole('button', { name: 'Iniciar download' })).not.toBeInTheDocument();
    },
);

test('falha encerra o carregamento e permite tentar a busca novamente', async () => {
    renderModal(magnet);
    await act(async () => {
        finishPreparation({ success: false, error: 'error.torrent.metadataTimeout' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(ptBR['error.torrent.metadataTimeout']);
    expect(
        screen.queryByRole('heading', { name: ptBR['addTorrent.preparingTitle'] }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: ptBR['addTorrent.retryPreparation'] }));
    expect(screen.getByRole('status')).toHaveTextContent(ptBR['addTorrent.preparingTitle']);
    expect(window.meshy.prepareTorrent).toHaveBeenCalledTimes(2);
});

test('link colado manualmente também exibe a busca e mantém Cancelar acessível por teclado', async () => {
    renderModal();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: magnet.magnetUri } });
    fireEvent.click(screen.getByRole('button', { name: ptBR['addTorrent.review'] }));
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Ubuntu Desktop');
    await act(async () => {});
});

test.each<TorrentSource>([
    { kind: 'file', filePath: 'C:\\Downloads\\Ubuntu.torrent' },
    { kind: 'buffer', name: 'Ubuntu.torrent', buffer: new Uint8Array([1]) },
])('arquivo $kind exibe seu nome sem a dica de rede dos magnets', async (source) => {
    renderModal(source);
    expect(screen.getByRole('status')).toHaveTextContent('Ubuntu.torrent');
    expect(screen.queryByText(ptBR['addTorrent.preparingMagnetHint'])).not.toBeInTheDocument();
    await act(async () => {});
});

test('magnet sem nome mantém feedback traduzido em inglês', async () => {
    renderModal({ kind: 'magnet', magnetUri: `magnet:?xt=urn:btih:${'b'.repeat(40)}` }, true);
    expect(screen.getByRole('status')).toHaveTextContent(enUS['addTorrent.preparingTitle']);
    expect(screen.getByRole('status')).toHaveTextContent(enUS['addTorrent.preparingMagnetHint']);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await act(async () => {});
});
