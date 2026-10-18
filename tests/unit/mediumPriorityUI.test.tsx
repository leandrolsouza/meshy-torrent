/** @jest-environment jsdom */
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { IntlProvider } from 'react-intl';
import { BatchActions } from '../../src/components/DownloadList/BatchActions';
import { AddTorrentModal } from '../../src/components/AddTorrent/AddTorrentModal';
import { BandwidthSettings } from '../../src/components/Settings/BandwidthSettings';
import { LightModeButton } from '../../src/components/common/LightModeButton';
import { SettingsPanel } from '../../src/components/Settings/SettingsPanel';
import { DownloadItem as DownloadCard } from '../../src/components/DownloadList/DownloadItem';
import { createDefaultBandwidthSettings } from '../../shared/bandwidth';
import { useDownloadStore } from '../../src/store/downloadStore';
import type { AppSettings, DownloadItem, TorrentSource } from '../../shared/types';
import ptBR from '../../src/locales/pt-BR.json';
import enUS from '../../src/locales/en-US.json';

jest.mock('../../src/components/TrackerPanel/TrackerPanel', () => ({
    TrackerPanel: () => <div>Tracker details</div>,
}));
jest.mock('../../src/components/DownloadDetails/DetailsPanel', () => ({
    DetailsPanel: ({
        selectedTab,
        isExpanded,
        additionalTabs,
    }: {
        selectedTab: string;
        isExpanded: boolean;
        additionalTabs: { id: string; content: React.ReactNode }[];
    }) =>
        isExpanded ? (
            <div>{additionalTabs.find((tab) => tab.id === selectedTab)?.content}</div>
        ) : null,
    isExpandable: () => true,
}));
const active: DownloadItem = {
    infoHash: 'a'.repeat(40),
    name: 'First',
    totalSize: 100,
    downloadedSize: 0,
    progress: 0,
    status: 'downloading',
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    numSeeders: 0,
    timeRemaining: 0,
    destinationFolder: '/downloads',
    addedAt: 1,
};
const paused = { ...active, infoHash: 'b'.repeat(40), name: 'Second', status: 'paused' as const };
const hidden = { ...active, infoHash: 'c'.repeat(40), name: 'Hidden' };
function renderIntl(content: React.ReactNode, english = false) {
    return render(
        <IntlProvider locale={english ? 'en-US' : 'pt-BR'} messages={english ? enUS : ptBR}>
            {content}
        </IntlProvider>,
    );
}
beforeEach(() => {
    window.meshy = {
        batchAction: jest.fn(async (hashes: string[]) => ({
            success: true,
            data: hashes.map((infoHash) => ({ infoHash, name: 'First', success: true })),
        })),
        getAll: jest.fn(async () => ({ success: true, data: [{ ...active, status: 'queued' }] })),
        getSettings: jest.fn(async () => ({
            success: true,
            data: { destinationFolder: '/downloads' },
        })),
        getBandwidthStatus: jest.fn(async () => ({
            success: true,
            data: { mode: 'normal', manualEnabled: false, downloadLimit: 0, uploadLimit: 0 },
        })),
        setLightMode: jest.fn(async () => ({
            success: true,
            data: { mode: 'manual', manualEnabled: true, downloadLimit: 128, uploadLimit: 32 },
        })),
        prepareTorrent: jest.fn(async (requestId: string, source: TorrentSource) => ({
            success: true,
            data: {
                requestId,
                infoHash: active.infoHash,
                name: source.kind === 'file' ? source.filePath.split('/').pop() : 'First',
                files: [
                    {
                        index: 0,
                        path: 'file.bin',
                        name: 'file.bin',
                        length: 100,
                        downloaded: 0,
                        selected: true,
                    },
                ],
            },
        })),
        cancelTorrentPreparation: jest.fn(async () => ({ success: true })),
        getDiskSpace: jest.fn(async () => ({
            success: true,
            data: {
                sufficient: true,
                freeBytes: 1_000_000_000,
                reservedBytes: 0,
                safetyMarginBytes: 64,
                selectedBytes: 100,
            },
        })),
        confirmTorrent: jest.fn(async () => ({
            success: true,
            data: { ...active, name: 'good.torrent' },
        })),
        selectTorrentFiles: jest.fn(async () => ({
            success: true,
            data: ['/first.torrent', '/second.torrent'],
        })),
        getFiles: jest.fn(async () => ({ success: true, data: [] })),
    } as unknown as Window['meshy'];
});
afterEach(() => useDownloadStore.getState().setItems([]));

test('lote atua somente nos selecionados visíveis e usa snapshot confirmado da fila', async () => {
    const onSelect = jest.fn();
    renderIntl(
        <BatchActions
            visibleItems={[active, paused]}
            selectedHashes={new Set([active.infoHash, paused.infoHash, hidden.infoHash])}
            onSelect={onSelect}
            onClear={jest.fn()}
            onBusy={jest.fn()}
        />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pausar selecionados' }));
    await screen.findByText('1 de 1 operações concluídas.');
    expect(window.meshy.batchAction).toHaveBeenCalledWith([active.infoHash], 'pause', false);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith([paused.infoHash]));
    expect(useDownloadStore.getState().items[0]!.status).toBe('queued');
});
test('remoção em lote exige confirmação, admite cancelar e mantém arquivos quando solicitado', async () => {
    renderIntl(
        <BatchActions
            visibleItems={[active]}
            selectedHashes={new Set([active.infoHash])}
            onSelect={jest.fn()}
            onClear={jest.fn()}
            onBusy={jest.fn()}
        />,
    );
    const button = screen.getByRole('button', { name: 'Remover selecionados' });
    fireEvent.click(button);
    expect(window.meshy.batchAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Excluir arquivos' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Manter arquivos' }));
    await waitFor(() =>
        expect(window.meshy.batchAction).toHaveBeenCalledWith([active.infoHash], 'remove', false),
    );
});
test('falhas parciais mantêm torrent selecionado e exibem nome e motivo', async () => {
    (window.meshy.batchAction as jest.Mock).mockResolvedValueOnce({
        success: true,
        data: [
            {
                infoHash: paused.infoHash,
                name: 'Second',
                success: false,
                error: 'error.destination.diskSpaceLow',
            },
        ],
    });
    const onSelect = jest.fn();
    renderIntl(
        <BatchActions
            visibleItems={[paused]}
            selectedHashes={new Set([paused.infoHash])}
            onSelect={onSelect}
            onClear={jest.fn()}
            onBusy={jest.fn()}
        />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retomar selecionados' }));
    await screen.findByText(/Second:.*espaço/i);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith([paused.infoHash]));
});
test('modo leve só exibe sucesso confirmado e trata falha sem ativar', async () => {
    (window.meshy.setLightMode as jest.Mock).mockResolvedValueOnce({
        success: false,
        error: 'error.operation.failed',
    });
    renderIntl(<LightModeButton appearance="statusbar" />);
    const button = screen.getByRole('button', { name: 'Limitar velocidade' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    await screen.findByText('Manual ativo');
    expect(button).toHaveAttribute('aria-pressed', 'true');
});
test('horários e limites são controles acessíveis em inglês e aceitam intervalo noturno', () => {
    function Form() {
        const [value, setValue] = useState(createDefaultBandwidthSettings);
        return <BandwidthSettings value={value} onChange={setValue} error={null} />;
    }
    renderIntl(<Form />, true);
    expect(screen.getByLabelText('Start')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable light mode at scheduled times' }));
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '06:00' } });
    expect(screen.getByLabelText('Start')).toHaveValue('22:00');
    expect(screen.getByLabelText('End')).toHaveValue('06:00');
});

test('salvar horários preserva ativação manual ocorrida depois da abertura das configurações', async () => {
    const config: AppSettings = {
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
        bandwidth: createDefaultBandwidthSettings(),
    };
    (window.meshy.getSettings as jest.Mock)
        .mockResolvedValueOnce({ success: true, data: config })
        .mockResolvedValueOnce({
            success: true,
            data: { ...config, bandwidth: { ...config.bandwidth, manualEnabled: true } },
        });
    window.meshy.setSettings = jest.fn(async (partial) => ({
        success: true as const,
        data: { ...config, ...partial },
    }));
    renderIntl(<SettingsPanel isOpen onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Transferências' }));
    fireEvent.change(screen.getByLabelText('Download no modo leve (KB/s)'), {
        target: { value: '96' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
        expect(window.meshy.setSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                bandwidth: expect.objectContaining({ manualEnabled: true, downloadLimit: 96 }),
            }),
        ),
    );
});
test('importação permite pular falha e revisar próximo sem iniciar automaticamente; resumo individual permanece', async () => {
    (window.meshy.prepareTorrent as jest.Mock).mockResolvedValueOnce({
        success: false,
        error: 'error.torrent.metadataTimeout',
    });
    const onClose = jest.fn();
    const sources: TorrentSource[] = [
        { kind: 'file', filePath: '/bad.torrent' },
        { kind: 'file', filePath: '/good.torrent' },
    ];
    renderIntl(<AddTorrentModal isOpen onClose={onClose} initialSources={sources} />);
    await screen.findByRole('alert');
    expect(window.meshy.confirmTorrent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pular este torrent' }));
    await screen.findByRole('heading', { name: 'good.torrent' });
    const confirm = screen.getByRole('button', { name: /iniciar download/i });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText('good.torrent: Adicionado');
    expect(screen.getByText(/bad.torrent: Falhou/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
});
test('seletor múltiplo prepara somente primeiro arquivo e mantém os outros para revisão', async () => {
    renderIntl(<AddTorrentModal isOpen onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /selecionar arquivo \.torrent/i }));
    await screen.findByRole('heading', { name: 'first.torrent' });
    expect(window.meshy.prepareTorrent).toHaveBeenCalledTimes(1);
    expect(window.meshy.confirmTorrent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pular este torrent' }));
    await screen.findByRole('heading', { name: 'second.torrent' });
});
test('diagnóstico aponta trackers e checkbox identifica torrent sem abrir arquivo', async () => {
    const toggle = jest.fn();
    renderIntl(
        <DownloadCard
            item={{ ...active, diagnostic: 'no-peers' }}
            selected={false}
            onSelectionToggle={toggle}
            queueSize={0}
            onPause={jest.fn()}
            onResume={jest.fn()}
            onRemove={jest.fn()}
            onMoveUp={jest.fn()}
            onMoveDown={jest.fn()}
        />,
    );
    expect(screen.getByText(/isso não comprova ausência de seeders/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar First' }));
    expect(toggle).toHaveBeenCalledWith(active.infoHash);
    fireEvent.click(screen.getByRole('button', { name: 'Conferir trackers' }));
    expect(await screen.findByText('Tracker details')).toBeInTheDocument();
});
