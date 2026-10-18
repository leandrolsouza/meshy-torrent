/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { IntlProvider } from 'react-intl';
import { ManageFilesDialog } from '../../src/components/DownloadList/ManageFilesDialog';
import { ExternalTorrentImporter } from '../../src/components/AddTorrent/ExternalTorrentImporter';
import { GeneralSettings } from '../../src/components/Settings/GeneralSettings';
import type { AppSettings, DownloadItem, ExternalTorrentRequest } from '../../shared/types';
import ptBR from '../../src/locales/pt-BR.json';
import enUS from '../../src/locales/en-US.json';
import { useDownloadStore } from '../../src/store/downloadStore';

jest.mock('../../src/components/AddTorrent/AddTorrentModal', () => ({
    AddTorrentModal: ({
        initialSources,
        onClose,
    }: {
        initialSources: { kind: string; magnetUri?: string }[];
        onClose: () => void;
    }) => (
        <div role="dialog">
            <span>{initialSources[0]?.magnetUri}</span>
            <button onClick={onClose}>Cancel review</button>
        </div>
    ),
}));
const item: DownloadItem = {
    infoHash: 'a'.repeat(40),
    name: 'Archive',
    totalSize: 100,
    downloadedSize: 100,
    progress: 1,
    status: 'completed',
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    numSeeders: 0,
    timeRemaining: 0,
    destinationFolder: '/downloads',
    addedAt: 1,
};
const settings: AppSettings = {
    destinationFolder: '/downloads',
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    maxConcurrentDownloads: 3,
    seedingEnabled: false,
    maxConcurrentSeeders: 2,
    notificationsEnabled: true,
    theme: 'vs-code-dark',
    locale: 'pt-BR',
    globalTrackers: [],
    autoApplyGlobalTrackers: false,
    dhtEnabled: true,
    pexEnabled: true,
    utpEnabled: true,
    closeToTray: false,
};
function renderIntl(component: React.ReactNode, english = false) {
    return render(
        <IntlProvider locale={english ? 'en-US' : 'pt-BR'} messages={english ? enUS : ptBR}>
            {component}
        </IntlProvider>,
    );
}
beforeEach(() => {
    window.meshy = {
        manageFiles: jest.fn(async () => ({
            success: true,
            data: { ...item, status: 'paused', progress: 0.5 },
        })),
        selectFolder: jest.fn(async () => ({ success: true, data: '/new-drive' })),
        registerMagnetHandler: jest.fn(async () => ({
            success: true,
            data: {
                isDefault: false,
                canOpenDefaultApps: true,
                applicationName: 'Meshy (Dev)',
            },
        })),
        getMagnetHandlerStatus: jest.fn(async () => ({
            success: true,
            data: {
                isDefault: true,
                canOpenDefaultApps: true,
                applicationName: 'Meshy (Dev)',
            },
        })),
        openMagnetDefaultApps: jest.fn(async () => ({ success: true, data: undefined })),
    } as unknown as Window['meshy'];
});
afterEach(() => useDownloadStore.getState().setItems([]));
test('verificação exige confirmação e mostra conteúdo pendente para retomada', async () => {
    const onClose = jest.fn();
    renderIntl(<ManageFilesDialog item={item} onClose={onClose} />);
    expect(window.meshy.manageFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e verificar' }));
    await screen.findByText(/50% dos dados selecionados/);
    expect(window.meshy.manageFiles).toHaveBeenCalledWith(item.infoHash, 'verify', undefined);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
});
test('localizar usa a pasta escolhida sem alterar a preferência global', async () => {
    renderIntl(<ManageFilesDialog item={item} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Localizar arquivos existentes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar pasta' }));
    await waitFor(() =>
        expect(screen.getByLabelText('Pasta dos arquivos')).toHaveValue('/new-drive'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e verificar' }));
    await waitFor(() =>
        expect(window.meshy.manageFiles).toHaveBeenCalledWith(
            item.infoHash,
            'locate',
            '/new-drive',
        ),
    );
});
test('conflito em movimento mantém o diálogo aberto com erro traduzido', async () => {
    jest.mocked(window.meshy.manageFiles).mockResolvedValueOnce({
        success: false,
        error: 'error.files.destinationConflict',
    });
    renderIntl(<ManageFilesDialog item={item} onClose={jest.fn()} />, true);
    fireEvent.click(screen.getByRole('radio', { name: 'Move to another folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('destination');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
});
test('bloqueia cancelamento e cliques adicionais enquanto verifica', async () => {
    let finish!: (value: Awaited<ReturnType<Window['meshy']['manageFiles']>>) => void;
    jest.mocked(window.meshy.manageFiles).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const onClose = jest.fn();
    renderIntl(<ManageFilesDialog item={item} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e verificar' }));
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ success: true, data: item }));
});
test('entradas externas durante outra revisão esperam sem substituir o lote aberto', async () => {
    const first: ExternalTorrentRequest = {
        id: 'first',
        source: { kind: 'magnet', magnetUri: 'magnet:first' },
    };
    const second: ExternalTorrentRequest = {
        id: 'second',
        source: { kind: 'magnet', magnetUri: 'magnet:second' },
    };
    let pending = [first];
    let receive!: (requests: ExternalTorrentRequest[]) => void;
    const unsubscribe = jest.fn();
    window.meshy.onExternalTorrentRequests = jest.fn((callback) => {
        receive = callback;
        return unsubscribe;
    });
    window.meshy.getExternalTorrentRequests = jest.fn(async () => ({
        success: true as const,
        data: pending,
    }));
    window.meshy.acknowledgeExternalTorrentRequest = jest.fn(async (id) => {
        pending = pending.filter((request) => request.id !== id);
        return { success: true as const, data: undefined };
    });
    const view = renderIntl(<ExternalTorrentImporter />);
    await screen.findByText('magnet:first');
    act(() => {
        pending = [first, second];
        receive(pending);
    });
    expect(screen.queryByText('magnet:second')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
    await screen.findByText('magnet:second');
    expect(window.meshy.acknowledgeExternalTorrentRequest).toHaveBeenCalledWith('first');
    expect(window.meshy.acknowledgeExternalTorrentRequest).not.toHaveBeenCalledWith('second');
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
});
test('preferência de bandeja persiste via settings e registro de magnet é ação explícita', async () => {
    const update = jest.fn(async () => true);
    renderIntl(
        <GeneralSettings
            settings={settings}
            currentThemeId="vs-code-dark"
            notificationsEnabled
            onThemeChange={jest.fn()}
            onSelectFolder={jest.fn()}
            onNotificationsChange={jest.fn()}
            onUpdateSettings={update}
        />,
    );
    fireEvent.click(
        screen.getByRole('checkbox', { name: 'Continuar baixando ao fechar a janela' }),
    );
    expect(update).toHaveBeenCalledWith({ closeToTray: true });
    expect(window.meshy.registerMagnetHandler).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: ptBR['settings.general.registerMagnet'] }));
    await screen.findByText(/outro aplicativo ainda está definido/);
    expect(window.meshy.registerMagnetHandler).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher aplicativo padrão' }));
    await waitFor(() => expect(window.meshy.openMagnetDefaultApps).toHaveBeenCalledTimes(1));
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Conferir associação' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Conferir associação' }));
    await screen.findByText(/Meshy \(Dev\) está definido para abrir magnets/);
    expect(
        screen.queryByRole('button', { name: 'Escolher aplicativo padrão' }),
    ).not.toBeInTheDocument();
});

test('falha de registro permanece legível e não apresenta confirmação de sucesso', async () => {
    jest.mocked(window.meshy.registerMagnetHandler).mockResolvedValueOnce({
        success: false,
        error: 'error.system.protocolRegistration',
    });
    const view = (notificationsEnabled: boolean) => (
        <IntlProvider locale="pt-BR" messages={ptBR}>
            <GeneralSettings
                settings={settings}
                currentThemeId="vs-code-dark"
                notificationsEnabled={notificationsEnabled}
                onThemeChange={jest.fn()}
                onSelectFolder={jest.fn()}
                onNotificationsChange={jest.fn()}
                onUpdateSettings={jest.fn(async () => true)}
            />
        </IntlProvider>
    );
    const rendered = render(view(true));
    fireEvent.click(screen.getByRole('button', { name: ptBR['settings.general.registerMagnet'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
        ptBR['error.system.protocolRegistration'],
    );
    rendered.rerender(view(false));
    expect(screen.getByRole('alert')).toHaveTextContent(ptBR['error.system.protocolRegistration']);
    expect(screen.queryByRole('status')).not.toHaveTextContent(/foi registrado/);
});
