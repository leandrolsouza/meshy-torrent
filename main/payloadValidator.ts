// ─── Validador de payload IPC ─────────────────────────────────────────────────
//
// Substitui a validação manual repetitiva nos handlers IPC por um sistema
// declarativo baseado em schemas. Cada schema descreve os campos esperados
// e suas regras de validação.

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Tipos primitivos suportados pelo validador */
type FieldType = 'string' | 'number' | 'boolean';

/** Regra de validação para um campo do payload */
interface FieldRule {
    /** Tipo esperado do campo */
    type: FieldType;
    /** Se true, o campo não pode ser string vazia (apenas para type: 'string') */
    nonEmpty?: boolean;
    /** Função de validação customizada (ex: isValidSpeedLimit) */
    validate?: (value: unknown) => boolean;
}

/** Schema de validação: mapa de nome do campo → regra */
export type PayloadSchema = Record<string, FieldRule>;

/** Resultado da validação */
export type ValidationResult<T> = { valid: true; data: T } | { valid: false };

// ─── Validador ────────────────────────────────────────────────────────────────

/**
 * Valida um payload IPC contra um schema declarativo.
 *
 * Verifica que o payload é um objeto não-nulo e que cada campo definido
 * no schema possui o tipo correto e passa nas validações customizadas.
 *
 * @returns `{ valid: true, data }` com o payload tipado, ou `{ valid: false }`.
 *
 * @example
 * const result = validatePayload<{ infoHash: string }>(payload, {
 *     infoHash: { type: 'string', nonEmpty: true },
 * });
 * if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);
 * const { infoHash } = result.data;
 */
export function validatePayload<T>(payload: unknown, schema: PayloadSchema): ValidationResult<T> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { valid: false };
    }

    const obj = payload as Record<string, unknown>;

    for (const [key, rule] of Object.entries(schema)) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) return { valid: false };
        const value = obj[key];

        // Verificar tipo
        if (typeof value !== rule.type) {
            return { valid: false };
        }
        // Verificar string não-vazia
        if (rule.nonEmpty && rule.type === 'string' && (value as string) === '') {
            return { valid: false };
        }

        // Validação customizada
        if (rule.validate && !rule.validate(value)) {
            return { valid: false };
        }
    }

    return { valid: true, data: payload as T };
}

// ─── Schemas reutilizáveis ────────────────────────────────────────────────────

/** Schema para payloads que contêm apenas { infoHash: string } */
export const infoHashSchema: PayloadSchema = {
    infoHash: { type: 'string', nonEmpty: true },
};

/** Regex para validar infoHash: exatamente 40 caracteres hexadecimais */
const INFO_HASH_HEX_REGEX = /^[0-9a-fA-F]{40}$/;

/** Schema para payloads que contêm { infoHash: string } com validação de 40 hex chars */
export const infoHashHexSchema: PayloadSchema = {
    infoHash: {
        type: 'string',
        nonEmpty: true,
        validate: (v) => INFO_HASH_HEX_REGEX.test(v as string),
    },
};

/** Schema para payloads que contêm { infoHash: string, url: string } */
export const infoHashUrlSchema: PayloadSchema = {
    infoHash: { type: 'string', nonEmpty: true },
    url: { type: 'string', nonEmpty: true },
};

/** Schema para payloads que contêm apenas { url: string } */
export const urlSchema: PayloadSchema = {
    url: { type: 'string', nonEmpty: true },
};
