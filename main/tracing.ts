import { performance } from 'node:perf_hooks';
import type { TraceContext } from '../shared/traceContext';
import {
    createOperationContext,
    getOperationContext,
    runWithOperationContext,
} from './operationContext';
import { logger } from './logger';

/** Spans locais persistidos pelo logger; preserva retornos síncronos e promises. */
export function traceOperation<T>(
    operation: string,
    callback: () => T,
    parent: TraceContext | undefined = getOperationContext(),
): T {
    const context = createOperationContext(operation, parent);
    return runWithOperationContext(context, () => {
        const startedAt = performance.now();
        const finish = (success: boolean): void => {
            const fields = {
                event: 'span.end',
                durationMs: Math.round(performance.now() - startedAt),
                success,
            };
            if (success) logger.info('[Trace] Operação concluída', fields);
            else logger.warn('[Trace] Operação falhou', fields);
        };
        const succeeded = (result: unknown): boolean =>
            !result ||
            typeof result !== 'object' ||
            !('success' in result) ||
            result.success !== false;
        logger.debug('[Trace] Operação iniciada', { event: 'span.start' });
        try {
            const result = callback();
            if (result instanceof Promise) {
                return result.then(
                    (value) => {
                        finish(succeeded(value));
                        return value;
                    },
                    (error: unknown) => {
                        logger.error('[Trace] Exceção na operação', {
                            event: 'trace.exception',
                            error,
                        });
                        finish(false);
                        throw error;
                    },
                ) as T;
            }
            finish(succeeded(result));
            return result;
        } catch (error) {
            logger.error('[Trace] Exceção na operação', { event: 'trace.exception', error });
            finish(false);
            throw error;
        }
    });
}
