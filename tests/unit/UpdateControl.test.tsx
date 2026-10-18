/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import '@testing-library/jest-dom';
import { UpdateControl } from '../../src/components/common/UpdateControl';
import type { AppUpdateStatus, IPCResponse } from '../../shared/types';
import ptBR from '../../src/locales/pt-BR.json';
import enUS from '../../src/locales/en-US.json';

const idle: AppUpdateStatus = { revision: 0, currentVersion: '0.1.0-beta.1', phase: 'idle' };
let listener: (status: AppUpdateStatus) => void;
let cleanup: jest.Mock;
let api: {
    getUpdateStatus: jest.Mock<Promise<IPCResponse<AppUpdateStatus>>, []>;
    checkForUpdates: jest.Mock<Promise<IPCResponse<AppUpdateStatus>>, []>;
    installUpdate: jest.Mock<Promise<IPCResponse<AppUpdateStatus>>, []>;
    onUpdateStatus: jest.Mock;
};
beforeEach(() => {
    cleanup = jest.fn();
    api = {
        getUpdateStatus: jest.fn<Promise<IPCResponse<AppUpdateStatus>>, []>(async () => ({
            success: true,
            data: idle,
        })),
        checkForUpdates: jest.fn<Promise<IPCResponse<AppUpdateStatus>>, []>(async () => ({
            success: true,
            data: { ...idle, revision: 1, phase: 'checking' },
        })),
        installUpdate: jest.fn<Promise<IPCResponse<AppUpdateStatus>>, []>(async () => ({
            success: true,
            data: { ...idle, revision: 5, phase: 'installing' },
        })),
        onUpdateStatus: jest.fn((callback) => {
            listener = callback;
            return cleanup;
        }),
    };
    Object.defineProperty(window, 'meshy', { value: api, writable: true });
});
const view = (english = false) =>
    render(
        <IntlProvider locale={english ? 'en-US' : 'pt-BR'} messages={english ? enUS : ptBR}>
            <UpdateControl />
        </IntlProvider>,
    );

test('verifica por botão, anuncia progresso e permite reiniciar quando o download está pronto', async () => {
    const { unmount } = view();
    const check = await screen.findByRole('button', { name: 'Verificar atualizações' });
    check.focus();
    expect(check).toHaveFocus();
    fireEvent.click(check);
    await waitFor(() => expect(check).toBeDisabled());
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    act(() =>
        listener({
            ...idle,
            revision: 2,
            phase: 'downloading',
            percent: 42,
            availableVersion: '0.1.0-beta.2',
        }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('42%');
    act(() =>
        listener({ ...idle, revision: 3, phase: 'downloaded', availableVersion: '0.1.0-beta.2' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar e atualizar' }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledTimes(1));
    await screen.findByText(/Instalando atualização/);
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
});

test('resposta inicial antiga não sobrescreve um evento de atualização mais novo', async () => {
    let resolve!: (response: IPCResponse<AppUpdateStatus>) => void;
    api.getUpdateStatus.mockImplementation(
        () =>
            new Promise((finish) => {
                resolve = finish;
            }),
    );
    view();
    act(() =>
        listener({ ...idle, revision: 10, phase: 'downloaded', availableVersion: '0.1.0-beta.2' }),
    );
    await act(async () => {
        resolve({ success: true, data: idle });
    });
    expect(screen.getByRole('button', { name: 'Reiniciar e atualizar' })).toBeEnabled();
});

test('mantém atualização habilitada e explica a verificação nos builds sem certificado', async () => {
    view();
    expect(await screen.findByRole('status')).toHaveAttribute(
        'title',
        expect.stringContaining('identidade do editor não é validada'),
    );
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeEnabled();
    expect(api.checkForUpdates).not.toHaveBeenCalled();
});

test('traduz erros IPC e permite nova tentativa sem afirmar sucesso', async () => {
    api.checkForUpdates.mockResolvedValue({ success: false, error: 'error.update.failed' });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confira a conexão');
    expect(screen.queryByText('Meshy atualizado')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeEnabled();
});

test('mostra os controles e o estado em inglês', async () => {
    view(true);
    expect(await screen.findByRole('button', { name: 'Check for updates' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Automatic checks enabled');
});

test('remove a assinatura no StrictMode e mantém o estado da assinatura atual', async () => {
    const { unmount } = render(
        <React.StrictMode>
            <IntlProvider locale="pt-BR" messages={ptBR}>
                <UpdateControl />
            </IntlProvider>
        </React.StrictMode>,
    );
    await screen.findByRole('button', { name: 'Verificar atualizações' });
    expect(api.onUpdateStatus).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(2);
});
