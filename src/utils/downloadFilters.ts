import type { DownloadItem, TorrentStatus } from '../../shared/types';

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Campos disponíveis para ordenação da lista de downloads */
export type SortField = 'addedAt' | 'progress' | 'downloadSpeed' | 'uploadSpeed' | 'name';

/** Direção de ordenação */
export type SortDirection = 'asc' | 'desc';

/** Identificadores dos grupos de status */
export type StatusGroup = 'downloading' | 'waiting' | 'paused' | 'completed' | 'error';

/** Um grupo com seus itens */
export interface DownloadGroup {
    id: StatusGroup;
    labelKey: string;
    items: DownloadItem[];
}

// ─── Mapeamento de status → grupo ─────────────────────────────────────────────

const STATUS_TO_GROUP: Record<TorrentStatus, StatusGroup> = {
    downloading: 'downloading',
    queued: 'waiting',
    'resolving-metadata': 'waiting',
    paused: 'paused',
    completed: 'completed',
    seeding: 'completed',
    error: 'error',
    'metadata-failed': 'error',
    'files-not-found': 'error',
};

/** Ordem de exibição dos grupos */
const GROUP_ORDER: StatusGroup[] = ['downloading', 'waiting', 'paused', 'completed', 'error'];

/** Chave i18n para cada grupo */
const GROUP_LABEL_KEYS: Record<StatusGroup, string> = {
    downloading: 'downloads.group.downloading',
    waiting: 'downloads.group.waiting',
    paused: 'downloads.group.paused',
    completed: 'downloads.group.completed',
    error: 'downloads.group.error',
};

// ─── Filtragem por nome ───────────────────────────────────────────────────────

/**
 * Retorna os itens cujo nome contém o termo de busca (case-insensitive).
 * Se o termo estiver vazio, retorna todos os itens sem alteração na ordem.
 * Não modifica o array original.
 */
export function filterByName(items: DownloadItem[], searchTerm: string): DownloadItem[] {
    const trimmed = searchTerm.trim();
    if (trimmed === '') {
        return [...items];
    }
    const lowerTerm = trimmed.toLowerCase();
    return items.filter((item) => item.name.toLowerCase().includes(lowerTerm));
}

// ─── Filtragem por status ─────────────────────────────────────────────────────

/**
 * Retorna os itens cujo status está no conjunto de status selecionados.
 * Se o conjunto estiver vazio (representando "Todos"), retorna todos os itens.
 * Não modifica o array original.
 */
export function filterByStatus(
    items: DownloadItem[],
    selectedStatuses: TorrentStatus[],
): DownloadItem[] {
    if (selectedStatuses.length === 0) {
        return [...items];
    }
    const statusSet = new Set(selectedStatuses);
    return items.filter((item) => statusSet.has(item.status));
}

// ─── Ordenação ────────────────────────────────────────────────────────────────

/**
 * Retorna um novo array ordenado pelo critério e direção especificados.
 * Não modifica o array original.
 */
export function sortItems(
    items: DownloadItem[],
    sortField: SortField,
    sortDirection: SortDirection,
): DownloadItem[] {
    const sorted = [...items];
    const direction = sortDirection === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];

        // Comparação de strings (campo 'name')
        if (typeof valA === 'string' && typeof valB === 'string') {
            return direction * valA.localeCompare(valB);
        }

        // Comparação numérica para os demais campos
        return direction * ((valA as number) - (valB as number));
    });

    return sorted;
}

// ─── Pipeline completo ────────────────────────────────────────────────────────

/**
 * Aplica filtragem por nome, filtragem por status e ordenação em sequência.
 * Conveniência para uso no componente DownloadList.
 */
export function applyFilters(
    items: DownloadItem[],
    searchTerm: string,
    selectedStatuses: TorrentStatus[],
    sortField: SortField,
    sortDirection: SortDirection,
): DownloadItem[] {
    const byName = filterByName(items, searchTerm);
    const byStatus = filterByStatus(byName, selectedStatuses);
    return sortItems(byStatus, sortField, sortDirection);
}

// ─── Agrupamento por status ───────────────────────────────────────────────────

/**
 * Agrupa os itens por categoria de status, mantendo a ordem interna de cada grupo.
 * Grupos vazios são omitidos do resultado.
 */
export function groupByStatus(items: DownloadItem[]): DownloadGroup[] {
    const buckets = new Map<StatusGroup, DownloadItem[]>();

    for (const item of items) {
        const group = STATUS_TO_GROUP[item.status];
        const bucket = buckets.get(group);
        if (bucket) {
            bucket.push(item);
        } else {
            buckets.set(group, [item]);
        }
    }

    const groups: DownloadGroup[] = [];
    for (const id of GROUP_ORDER) {
        const groupItems = buckets.get(id);
        if (groupItems && groupItems.length > 0) {
            // Itens enfileirados devem respeitar a ordem da fila (queuePosition ascendente)
            if (id === 'waiting') {
                groupItems.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
            }
            groups.push({
                id,
                labelKey: GROUP_LABEL_KEYS[id],
                items: groupItems,
            });
        }
    }

    return groups;
}
