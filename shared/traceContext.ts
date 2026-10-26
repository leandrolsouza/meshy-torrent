/** Contexto serializável de uma etapa da operação; IDs aleatórios sem dados do usuário. */
export interface TraceContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
}

/** Metadados de observabilidade não são autoridade para autorizar operações IPC. */
export function parseTraceContext(value: unknown): TraceContext | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const { traceId, spanId, parentSpanId } = value as Record<string, unknown>;
    const validId = (id: unknown, length: number): id is string =>
        typeof id === 'string' &&
        id.length === length &&
        /^[a-f0-9]+$/.test(id) &&
        !/^0+$/.test(id);
    if (!validId(traceId, 32) || !validId(spanId, 16)) return undefined;
    if (parentSpanId !== undefined && !validId(parentSpanId, 16)) return undefined;
    return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}) };
}
