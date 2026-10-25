const OMITTED_URL = '[URL omitida]';
const SENSITIVE_FIELD =
    /password|passwd|secret|token|passkey|authorization|cookie|api.?key|torrentFileBase64/i;

/** Omite a URL inteira: passkeys podem estar em qualquer segmento do path ou query. */
export function redactSensitiveText(text: string): string {
    // Não tente adivinhar onde a URL acaba: mensagens externas podem incluir
    // espaços, aspas e quebras de linha em um path/query ainda não normalizado.
    return text.replace(/\b(?:https?|udp|wss?|magnet)(?::|%(?:25)*3a)[\s\S]*/i, OMITTED_URL);
}

/** Cria valores próprios para logs, sem repassar objetos/Errors com dados originais. */
export function redactLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    if (typeof value === 'string') return redactSensitiveText(value);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= 6 || seen.has(value)) return '[objeto omitido]';
    seen.add(value);
    try {
        if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
            return '[dados binários omitidos]';
        if (value instanceof URL) return OMITTED_URL;
        if (value instanceof String) return redactSensitiveText(String(value));
        if (value instanceof Error) {
            return {
                name: redactSensitiveText(value.name),
                message: redactSensitiveText(value.message),
                stack: value.stack ? redactSensitiveText(value.stack) : undefined,
                ...('cause' in value
                    ? { cause: redactLogValue(value.cause, seen, depth + 1) }
                    : {}),
            };
        }
        if (Array.isArray(value))
            return value.map((entry) => redactLogValue(entry, seen, depth + 1));
        const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).map(
            ([key, descriptor]) => [
                redactSensitiveText(key),
                SENSITIVE_FIELD.test(key)
                    ? '[segredo omitido]'
                    : 'value' in descriptor
                      ? redactLogValue(descriptor.value, seen, depth + 1)
                      : '[acessor omitido]',
            ],
        );
        return Object.fromEntries(entries);
    } catch {
        return '[objeto omitido]';
    }
}
