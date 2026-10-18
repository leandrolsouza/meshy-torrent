// shared/errorCodes.ts — constantes de códigos de erro estruturados
//
// O processo principal retorna estes códigos em vez de strings em português.
// O renderer resolve cada código para a string localizada via intl.formatMessage().

export const ErrorCodes = {
    // Torrent
    INVALID_FILE_PATH: 'error.torrent.invalidFilePath',
    INVALID_MAGNET_URI: 'error.torrent.invalidMagnetUri',
    TORRENT_DUPLICATE: 'error.torrent.duplicate',
    TORRENT_NOT_FOUND: 'error.torrent.notFound',

    // Engine
    ENGINE_RESTARTING: 'error.engine.restarting',
    ENGINE_NOT_AVAILABLE: 'error.engine.notAvailable',

    // Parâmetros / validação
    INVALID_PARAMS: 'error.params.invalid',
    INVALID_SPEED_LIMIT: 'error.params.invalidSpeedLimit',

    // Tracker
    INVALID_TRACKER_URL: 'error.tracker.invalidUrl',
    TRACKER_DUPLICATE: 'error.tracker.duplicate',
    TRACKER_NOT_FOUND: 'error.tracker.notFound',

    // Settings
    NO_FOLDER_SELECTED: 'error.settings.noFolderSelected',
    INVALID_SETTINGS_PAYLOAD: 'error.settings.invalidPayload',
    INVALID_LOCALE: 'error.settings.invalidLocale',

    // Seleção de arquivos
    FILE_SELECTION_EMPTY: 'error.files.selectionEmpty',
    FILE_INDEX_INVALID: 'error.files.indexInvalid',
    NO_FILE_SELECTED: 'error.files.noFileSelected',

    // Fila de downloads
    QUEUE_NOT_FOUND: 'error.queue.notFound',
    QUEUE_INVALID_INDEX: 'error.queue.invalidIndex',

    // Destino (pasta/arquivo)
    DESTINATION_FOLDER_NOT_FOUND: 'error.destination.folderNotFound',
    DESTINATION_FILE_NOT_FOUND: 'error.destination.fileNotFound',
    DESTINATION_OPEN_FAILED: 'error.destination.openFailed',
    DESTINATION_NOT_COMPLETED: 'error.destination.notCompleted',
    DISK_SPACE_LOW: 'error.destination.diskSpaceLow',
    DISK_SPACE_UNAVAILABLE: 'error.destination.diskSpaceUnavailable',
    PREPARATION_CANCELLED: 'error.torrent.preparationCancelled',
    PREPARATION_EXPIRED: 'error.torrent.preparationExpired',
    METADATA_TIMEOUT: 'error.torrent.metadataTimeout',
    FILE_OPERATION_BUSY: 'error.files.busy',
    FILE_METADATA_UNAVAILABLE: 'error.files.metadataUnavailable',
    FILE_PATH_UNSAFE: 'error.files.unsafePath',
    FILE_DESTINATION_CONFLICT: 'error.files.destinationConflict',
    FILE_SOURCE_MISSING: 'error.files.sourceMissing',
    FILE_MOVE_SOURCE_RETAINED: 'error.files.sourceRetained',
    PROTOCOL_REGISTRATION_FAILED: 'error.system.protocolRegistration',
    UPDATE_UNAVAILABLE: 'error.update.unavailable',
    UPDATE_FAILED: 'error.update.failed',
    UPDATE_NOT_READY: 'error.update.notReady',
    UPDATE_SESSION_FAILED: 'error.update.sessionFailed',

    // Rate limiting
    RATE_LIMITED: 'error.rateLimit',

    // Falha de operação genérica (erro inesperado em catch)
    OPERATION_FAILED: 'error.operation.failed',
} as const;
