import { isIP } from 'node:net';

const OMITTED_URL = '[URL omitida]';
const SENSITIVE_FIELD =
    /password|passwd|secret|token|passkey|authorization|cookie|api.?key|torrentFileBase64/i;
const PERSONAL_FIELD =
    /^(?:name|full[_-]?name|user(?:[_-]?(?:name|id))?|e[_-]?mail|ip(?:v[46])?(?:[_-]?address)?|peer(?:[_-]?(?:id|address))?|address|phone(?:[_-]?number)?|cpf|cnpj)$/i;
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;

/** Campos próprios de diagnóstico; type evita confundir Error.name com um nome pessoal. */
export interface SerializedLogError extends Record<string, unknown> {
    type: string;
    message: string;
}

function readErrorProperty(error: object, key: string, allowNativeStack = false): unknown {
    let current: object | null = error;
    for (let depth = 0; current && depth < 6; depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) {
            if ('value' in descriptor) return descriptor.value;
            // V8 pode materializar a stack por um accessor nativo. Não executar
            // getters substituídos pelo objeto, inclusive em code/message/cause.
            if (
                key === 'stack' &&
                allowNativeStack &&
                descriptor.get &&
                descriptor.get === nativeStackGetter
            )
                return descriptor.get.call(error);
            return '[acessor omitido]';
        }
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}

/** Normaliza valores lançados sem executar String(objeto) ou expor o original. */
export function serializeLogError(error: unknown): SerializedLogError {
    const safe = redactLogValue(error);
    if (Array.isArray(safe))
        return { type: 'NonError', message: 'Valor lançado sem mensagem', value: safe };
    if (safe && typeof safe === 'object') {
        const fields = safe as Record<string, unknown>;
        return {
            type: typeof fields.type === 'string' ? fields.type : 'NonError',
            message:
                typeof fields.message === 'string' ? fields.message : 'Valor lançado sem mensagem',
            ...Object.fromEntries(
                ['stack', 'code', 'errno', 'syscall', 'cause', 'errors']
                    .filter((key) => fields[key] !== undefined)
                    .map((key) => [key, fields[key]]),
            ),
        };
    }
    return { type: 'NonError', message: redactSensitiveText(String(safe)) };
}

/** Omite a URL inteira: passkeys podem estar em qualquer segmento do path ou query. */
export function redactSensitiveText(text: string): string {
    // Não tente adivinhar onde a URL acaba: mensagens externas podem incluir
    // espaços, aspas e quebras de linha em um path/query ainda não normalizado.
    return (
        text
            .replace(/\b(?:https?|udp|wss?|magnet)(?::|%(?:25)*3a)[\s\S]*/i, OMITTED_URL)
            // Caminhos podem conter espaços e aspas: omitir até o fim da linha.
            // Preservar linhas seguintes mantém os demais frames da stack disponíveis.
            .replace(
                /(?:\bfile:|\b[a-z]:[\\/]|\\\\|(?<![\w:/])\/{1,2}(?=[^\s/]))[^\r\n]*/gi,
                '[caminho omitido]',
            )
            .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[e-mail omitido]')
            .replace(/(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*(?:%[a-z\d_.~-]+)?/gi, (address) =>
                isIP(address) === 6 ? '[IP omitido]' : address,
            )
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (address) =>
                isIP(address) === 4 ? '[IP omitido]' : address,
            )
    );
}

/** Cria valores próprios para logs, sem repassar objetos/Errors com dados originais. */
export function redactLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    if (typeof value === 'string') return redactSensitiveText(value);
    if (typeof value === 'function') return '[função omitida]';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= 6 || seen.has(value)) return '[objeto omitido]';
    seen.add(value);
    try {
        if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
            return '[dados binários omitidos]';
        if (value instanceof URL) return OMITTED_URL;
        if (value instanceof String)
            return redactSensitiveText(String.prototype.valueOf.call(value));
        if (value instanceof Error) {
            const name = readErrorProperty(value, 'name');
            const message = readErrorProperty(value, 'message');
            // O formatador nativo de stack lê name/message. Se esses campos não
            // forem strings próprias de diagnóstico, não disparar essa formatação.
            const allowNativeStack =
                typeof name === 'string' &&
                name !== '[acessor omitido]' &&
                typeof message === 'string' &&
                message !== '[acessor omitido]';
            const fields: Record<string, unknown> = {
                type: typeof name === 'string' ? name : 'Error',
                message: typeof message === 'string' ? message : '[mensagem inválida]',
            };
            for (const key of ['stack', 'code', 'errno', 'syscall', 'cause', 'errors']) {
                const field = readErrorProperty(value, key, allowNativeStack);
                if (field !== undefined) fields[key] = field;
            }
            return Object.fromEntries(
                Object.entries(fields).map(([key, field]) => [
                    key,
                    redactLogValue(field, seen, depth + 1),
                ]),
            );
        }
        if (Array.isArray(value)) {
            const descriptors: Record<string, PropertyDescriptor> =
                Object.getOwnPropertyDescriptors(value);
            const result: unknown[] = [];
            result.length = descriptors['length']!.value as number;
            for (const [key, descriptor] of Object.entries(descriptors)) {
                // Preservar posições/lacunas sem chamar map ou getters de índices.
                if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= result.length) continue;
                result[Number(key)] =
                    'value' in descriptor
                        ? redactLogValue(descriptor.value, seen, depth + 1)
                        : '[acessor omitido]';
            }
            return result;
        }
        const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).map(
            ([key, descriptor]) => [
                redactSensitiveText(key),
                SENSITIVE_FIELD.test(key)
                    ? '[segredo omitido]'
                    : PERSONAL_FIELD.test(key)
                      ? '[dado pessoal omitido]'
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
