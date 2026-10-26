import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { IPCResponse } from '../shared/types';
import { metrics } from './metrics';
import type { IpcOutcome } from './metrics';
import { classifyErrorCause } from './metricErrorCause';
import type { ErrorCause } from './metricErrorCause';

interface CallOutcome {
    failure?: Exclude<IpcOutcome, 'success' | 'error'>;
    cause?: ErrorCause;
}

const calls = new AsyncLocalStorage<CallOutcome>();

/** Permite classificar exceções tratadas pelos handlers sem expor estado no IPC. */
export function markIpcOutcome(
    failure: NonNullable<CallOutcome['failure']>,
    error?: unknown,
): void {
    const call = calls.getStore();
    if (call) {
        call.failure = failure;
        if (error !== undefined) call.cause = classifyErrorCause(error);
    }
}

/** Registra exatamente um desfecho, inclusive se o callback lançar ou rejeitar. */
export function withIpcMetrics<T>(
    channel: string,
    handler: () => IPCResponse<T> | Promise<IPCResponse<T>>,
): Promise<IPCResponse<T>> {
    const call: CallOutcome = {};
    return calls.run(call, async () => {
        const startedAt = performance.now();
        let outcome: IpcOutcome = 'exception';
        let cause: ErrorCause = 'unknown';
        try {
            const result = await handler();
            outcome = result.success ? 'success' : 'error';
            if (!result.success) cause = classifyErrorCause(result.error);
            return result;
        } catch (error) {
            cause = classifyErrorCause(error);
            throw error;
        } finally {
            metrics.recordIpcCall(
                channel,
                Math.max(0, performance.now() - startedAt),
                call.failure ?? outcome,
                call.cause ?? cause,
            );
        }
    });
}
