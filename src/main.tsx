import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/global.css';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { IntlWrapper } from './i18n/IntlWrapper';
import App from './App';

// Guard: ensure the Meshy API is available via contextBridge.
// In development without Electron, this prevents cryptic runtime errors.
if (typeof window.meshy === 'undefined') {
    console.warn(
        '[Meshy Torrent] window.meshy is not available. ' +
        'The app must run inside Electron with the preload script configured.',
    );
}

// ─── Global error handlers do renderer ────────────────────────────────────────
// Capturam erros que escapam do React ErrorBoundary (ex: erros em event handlers
// assíncronos, timers, promises) e os reportam ao main process via IPC.

window.onerror = (message, source, lineno, colno, error) => {
    const msg = typeof message === 'string' ? message : 'Erro desconhecido';
    console.error('[Global] Erro não capturado:', msg, source, lineno, colno);

    try {
        window.meshy?.reportError({
            message: msg,
            source: `window.onerror (${source ?? 'unknown'}:${lineno ?? 0}:${colno ?? 0})`,
            ...(error?.stack !== undefined ? { stack: error.stack } : {}),
        });
    } catch {
        // Silenciar falhas no report
    }
};

window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('[Global] Rejeição não tratada:', message);

    try {
        window.meshy?.reportError({
            message,
            source: 'window.onunhandledrejection',
            ...(reason instanceof Error && reason.stack !== undefined
                ? { stack: reason.stack }
                : {}),
        });
    } catch {
        // Silenciar falhas no report
    }
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <ErrorBoundary>
            <IntlWrapper>
                <App />
            </IntlWrapper>
        </ErrorBoundary>
    </React.StrictMode>,
);
