import React from 'react';
import { FormattedMessage } from 'react-intl';

// ─── Props & State ────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
    children: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Global error boundary that catches unhandled errors in the React tree.
 * Displays a user-friendly fallback UI instead of a blank screen.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);

        // Reportar erro ao main process para persistência via electron-log
        try {
            window.meshy?.reportError({
                message: error.message,
                source: 'ErrorBoundary',
                ...(error.stack !== undefined ? { stack: error.stack } : {}),
                ...(info.componentStack != null ? { componentStack: info.componentStack } : {}),
            });
        } catch {
            // Silenciar falhas no report — não queremos erros ao reportar erros
        }
    }

    render(): React.ReactNode {
        if (this.state.hasError) {
            return (
                <div
                    role="alert"
                    style={{
                        maxWidth: 520,
                        margin: '80px auto',
                        padding: '32px 24px',
                        textAlign: 'center',
                        fontFamily: 'var(--font-family, system-ui, sans-serif)',
                    }}
                >
                    <h1 style={{ fontSize: 20, marginBottom: 12 }}>
                        <FormattedMessage
                            id="errorBoundary.title"
                            defaultMessage="Algo deu errado"
                        />
                    </h1>
                    <p style={{ color: '#666', marginBottom: 16 }}>
                        <FormattedMessage
                            id="errorBoundary.message"
                            defaultMessage="O Meshy Torrent encontrou um erro inesperado. Tente recarregar a janela."
                        />
                    </p>
                    {this.state.error && (
                        <pre
                            style={{
                                textAlign: 'left',
                                background: '#f5f5f5',
                                padding: 12,
                                borderRadius: 6,
                                fontSize: 12,
                                overflow: 'auto',
                                maxHeight: 200,
                            }}
                        >
                            {this.state.error.message}
                        </pre>
                    )}
                    <button
                        className="btn btn--primary"
                        style={{ marginTop: 16 }}
                        onClick={() => window.location.reload()}
                    >
                        <FormattedMessage id="errorBoundary.reload" defaultMessage="Recarregar" />
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
