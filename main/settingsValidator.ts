// ─── Validador de payload para settings:set ──────────────────────────────────
//
// Valida cada campo opcional de Partial<AppSettings> com regras específicas.
// Retorna o código de erro apropriado ou null se tudo estiver válido.

import type { AppSettings } from '../shared/types';
import { isValidBandwidthSettings } from '../shared/bandwidth';
import {
    isValidSpeedLimit,
    isValidMaxConcurrentDownloads,
    isValidThemeId,
    isValidNetworkToggle,
    isValidTrackerUrl,
} from './validators';
import { ErrorCodes } from '../shared/errorCodes';

/** Regra de validação para um campo de AppSettings */
interface SettingsFieldRule {
    /** Função que retorna true se o valor é válido */
    validate: (value: unknown) => boolean;
    /** Código de erro retornado quando a validação falha */
    errorCode: string;
}

/**
 * Mapa de regras de validação para cada campo de AppSettings.
 * Toda chave do contrato deve ter uma regra de validação.
 */
const settingsRules = {
    seedingEnabled: { validate: isValidNetworkToggle, errorCode: ErrorCodes.INVALID_SETTINGS },
    maxConcurrentSeeders: {
        validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20,
        errorCode: ErrorCodes.INVALID_SETTINGS,
    },
    globalTrackers: {
        validate: (value) =>
            Array.isArray(value) &&
            Array.from(value).every(
                (url: unknown) => typeof url === 'string' && isValidTrackerUrl(url),
            ),
        errorCode: ErrorCodes.INVALID_TRACKER_URL,
    },
    autoApplyGlobalTrackers: {
        validate: (value) => typeof value === 'boolean',
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    bandwidth: { validate: isValidBandwidthSettings, errorCode: ErrorCodes.INVALID_PARAMS },
    closeToTray: {
        validate: (value) => typeof value === 'boolean',
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    downloadSpeedLimit: {
        validate: isValidSpeedLimit,
        errorCode: ErrorCodes.INVALID_SPEED_LIMIT,
    },
    uploadSpeedLimit: {
        validate: isValidSpeedLimit,
        errorCode: ErrorCodes.INVALID_SPEED_LIMIT,
    },
    destinationFolder: {
        validate: (v) => typeof v === 'string',
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    maxConcurrentDownloads: {
        validate: isValidMaxConcurrentDownloads,
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    notificationsEnabled: {
        validate: (v) => typeof v === 'boolean',
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    theme: {
        validate: isValidThemeId,
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    locale: {
        validate: (v) => typeof v === 'string' && (v as string).trim() !== '',
        errorCode: ErrorCodes.INVALID_LOCALE,
    },
    dhtEnabled: {
        validate: isValidNetworkToggle,
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    pexEnabled: {
        validate: isValidNetworkToggle,
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
    utpEnabled: {
        validate: isValidNetworkToggle,
        errorCode: ErrorCodes.INVALID_PARAMS,
    },
} satisfies Record<keyof AppSettings, SettingsFieldRule>;

/**
 * Valida um payload Partial<AppSettings>.
 * Verifica cada campo presente contra as regras definidas.
 *
 * @returns null se válido, ou o código de erro do primeiro campo inválido.
 */
export function validateSettingsPayload(partial: Partial<AppSettings>): string | null {
    for (const [field, rule] of Object.entries(settingsRules)) {
        const value = (partial as Record<string, unknown>)[field];
        if (value !== undefined && !rule.validate(value)) {
            return rule.errorCode;
        }
    }
    return null;
}
