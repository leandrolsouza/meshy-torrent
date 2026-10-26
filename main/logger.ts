import log from 'electron-log';
import { redactLogValue, redactSensitiveText } from './logRedaction';
import { getOperationContext } from './operationContext';

// FileTransport é síncrono por padrão e consulta tamanho/rotação em cada log.
// Desabilitamos a rotação interna para evitar stat/rename síncronos no processo principal.
const fileTransport = log?.transports?.file;
if (fileTransport) {
    fileTransport.sync = false;
    fileTransport.maxSize = 0;
}

// ─── Logger ───────────────────────────────────────────────────────────────────
//
// Wrapper around electron-log for the main process com suporte a contexto
// estruturado. Cada mensagem pode incluir campos adicionais (channel, infoHash,
// durationMs, etc.) que são serializados junto ao log para facilitar debugging.
//
// Logs are written to:
//   Windows: %APPDATA%/Meshy/logs/
//   macOS:   ~/Library/Logs/Meshy/
//   Linux:   ~/.config/Meshy/logs/

/** Campos de contexto opcionais para enriquecer mensagens de log */
export interface LogContext {
    /** Nome estável do evento; não deve conter dados da operação. */
    event?: string;
    /** Diagnóstico serializado e sanitizado antes de chegar ao destino do log. */
    error?: unknown;
    /** Canal IPC que originou a operação */
    channel?: string;
    /** InfoHash do torrent relacionado */
    infoHash?: string;
    /** Duração da operação em milissegundos */
    durationMs?: number;
    /** Código de erro estruturado */
    errorCode?: string;
    /** Origem do erro (módulo/componente) */
    source?: string;
    /** Campos adicionais livres */
    [key: string]: unknown;
}

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

/**
 * Flag global para habilitar/desabilitar logs de debug.
 * Ativado via variável de ambiente MESHY_DEBUG=1 ou programaticamente.
 */
let debugEnabled = process.env['MESHY_DEBUG'] === '1';

/** Habilita ou desabilita logs de debug em runtime */
export function setDebugEnabled(enabled: boolean): void {
    debugEnabled = enabled;
}

/** Retorna se o modo debug está ativo */
export function isDebugEnabled(): boolean {
    return debugEnabled;
}

function sanitizeContext(ctx: LogContext): LogContext {
    const safe = redactLogValue(ctx);
    return typeof safe === 'object' && safe !== null ? (safe as LogContext) : { context: safe };
}

function enrichContext(ctx: LogContext): LogContext {
    return {
        ...ctx,
        schemaVersion: 1,
        event: typeof ctx.event === 'string' && ctx.event ? ctx.event : 'application.log',
        // IDs ativos são autoritativos: campos livres não substituem a correlação.
        ...getOperationContext(),
    };
}

/**
 * Default logger backed by electron-log.
 * Can be replaced with a mock in tests via dependency injection.
 */
export const logger: Logger = {
    info(message: string, ...args: unknown[]): void {
        log.info(redactSensitiveText(message), ...logArguments(args));
    },
    warn(message: string, ...args: unknown[]): void {
        log.warn(redactSensitiveText(message), ...logArguments(args));
    },
    error(message: string, ...args: unknown[]): void {
        log.error(redactSensitiveText(message), ...logArguments(args));
    },
    debug(message: string, ...args: unknown[]): void {
        if (debugEnabled) {
            log.info(redactSensitiveText(`[DEBUG] ${message}`), ...logArguments(args));
        }
    },
};

function logArguments(args: unknown[]): unknown[] {
    const safe = args.map((arg) => redactLogValue(arg));
    const first = safe[0];
    if (safe.length === 1 && first && typeof first === 'object' && !Array.isArray(first))
        return [enrichContext(first as LogContext)];
    const context = getOperationContext();
    return [...safe, ...(context ? [enrichContext({})] : [])];
}

// ─── Scoped logger ────────────────────────────────────────────────────────────

/**
 * Cria um logger com contexto fixo (ex: módulo, canal IPC).
 * Cada chamada de log inclui automaticamente os campos do contexto base,
 * podendo ser enriquecido com campos adicionais por chamada.
 *
 * @example
 * const log = createScopedLogger(logger, { channel: 'torrent:pause' });
 * log.info('Operação iniciada', { infoHash: 'abc123' });
 * // => mensagem "[torrent:pause] Operação iniciada" + objeto { channel, infoHash, ... }
 *
 * log.error('Falha na operação', { infoHash: 'abc123', durationMs: 150 });
 * // => mensagem + objeto { channel, infoHash, durationMs, schemaVersion, event, ... }
 */
export interface ScopedLogger {
    info(message: string, ctx?: LogContext): void;
    warn(message: string, ctx?: LogContext): void;
    error(message: string, ctx?: LogContext): void;
    debug(message: string, ctx?: LogContext): void;
}

export function createScopedLogger(base: Logger, baseCtx: LogContext): ScopedLogger {
    // Sanitizar antes de acessar/mesclar campos: spreads e String(objeto) podem
    // executar accessors e perder os nomes usados para identificar segredos.
    const safeBaseCtx = sanitizeContext(baseCtx);
    const write = (level: keyof Logger, message: string, ctx?: LogContext): void => {
        const merged = enrichContext({ ...safeBaseCtx, ...(ctx ? sanitizeContext(ctx) : {}) });
        const prefix =
            typeof merged.channel === 'string' && merged.channel
                ? `[${merged.channel}]`
                : '[Meshy Torrent]';
        base[level](`${prefix} ${redactSensitiveText(message)}`, merged);
    };

    return {
        info(message: string, ctx?: LogContext): void {
            write('info', message, ctx);
        },
        warn(message: string, ctx?: LogContext): void {
            write('warn', message, ctx);
        },
        error(message: string, ctx?: LogContext): void {
            write('error', message, ctx);
        },
        debug(message: string, ctx?: LogContext): void {
            write('debug', message, ctx);
        },
    };
}
