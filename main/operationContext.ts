import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { TraceContext } from '../shared/traceContext';

export interface OperationContext extends TraceContext {
    /** Alias para correlação de logs legíveis. */
    cid: string;
    operation: string;
}

const storage = new AsyncLocalStorage<OperationContext | undefined>();

export function getOperationContext(): OperationContext | undefined {
    return storage.getStore();
}

export function createOperationContext(operation: string, parent?: TraceContext): OperationContext {
    const traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    return {
        traceId,
        cid: traceId,
        spanId: randomBytes(8).toString('hex'),
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        operation,
    };
}

export function runWithOperationContext<T>(
    context: OperationContext | undefined,
    callback: () => T,
): T {
    // undefined também isola eventos sem origem do contexto do emissor atual.
    return storage.run(context, callback);
}
