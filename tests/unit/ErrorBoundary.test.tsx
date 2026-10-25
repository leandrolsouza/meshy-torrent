/** @jest-environment jsdom */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ErrorBoundary } from '../../src/components/common/ErrorBoundary';
import { IntlWrapper } from '../../src/i18n/IntlWrapper';
import { useLocaleStore } from '../../src/i18n/useLocale';

function Broken(): React.ReactNode {
    throw new Error('Falha original');
}

const reportError = jest.fn();
const originalMeshy = Object.getOwnPropertyDescriptor(window, 'meshy');

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    reportError.mockReset();
    useLocaleStore.getState().setLocale('pt-BR');
    Object.defineProperty(window, 'meshy', {
        configurable: true,
        value: { reportError },
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    useLocaleStore.getState().setLocale('pt-BR');
    if (originalMeshy) Object.defineProperty(window, 'meshy', originalMeshy);
    else Reflect.deleteProperty(window, 'meshy');
});

test('mantém os filhos visíveis enquanto não ocorre um erro', () => {
    render(
        <ErrorBoundary>
            <p>Aplicativo funcionando</p>
        </ErrorBoundary>,
    );
    expect(screen.getByText('Aplicativo funcionando')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(reportError).not.toHaveBeenCalled();
});

test.each([
    ['pt-BR', 'Algo deu errado', 'Recarregar'],
    ['en-US', 'Something went wrong', 'Reload'],
])('exibe recuperação em %s com a hierarquia usada na inicialização', (locale, title, reload) => {
    useLocaleStore.getState().setLocale(locale);
    render(
        <React.StrictMode>
            <ErrorBoundary>
                <IntlWrapper>
                    <Broken />
                </IntlWrapper>
            </ErrorBoundary>
        </React.StrictMode>,
    );
    const alert = within(screen.getByRole('alert'));
    expect(alert.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(alert.getByText('Falha original')).toBeInTheDocument();
    const button = alert.getByRole('button', { name: reload });
    expect(button).toBeEnabled();
    button.focus();
    expect(button).toHaveFocus();
    expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Falha original', source: 'ErrorBoundary' }),
    );
});

test('recupera também quando a falha ocorre antes de qualquer provedor de tradução', () => {
    render(
        <ErrorBoundary>
            <Broken />
        </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeInTheDocument();
});

test('a tela continua disponível se o envio do relatório falhar', () => {
    reportError.mockImplementation(() => {
        throw new Error('IPC indisponível');
    });
    render(
        <ErrorBoundary>
            <Broken />
        </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeEnabled();
    expect(screen.getByText('Falha original')).toBeInTheDocument();
});

test('a tela continua disponível sem a ponte preload', () => {
    Reflect.deleteProperty(window, 'meshy');
    render(
        <ErrorBoundary>
            <Broken />
        </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeEnabled();
});
