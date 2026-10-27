// Re-export all validators from the shared module.
// This file exists for backward compatibility with existing imports in main/.
export {
    isValidMagnetUri,
    normalizeMagnetUri,
    isValidTorrentFile,
    hasTorrentMagicBytes,
    isValidSpeedLimit,
    isValidMaxConcurrentDownloads,
    isValidThemeId,
    isValidTrackerUrl,
    normalizeTrackerUrl,
    isValidNetworkToggle,
    MIN_CONCURRENT_DOWNLOADS,
    MAX_CONCURRENT_DOWNLOADS,
    DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    MAX_TORRENT_BYTES,
} from '../shared/validators';
