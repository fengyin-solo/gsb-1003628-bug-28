import { normalizeReport } from './fire-disposition'
import { SEED_ROWS } from './seed'
import type { EntryRow, SupplyOccupancy, TeamAlert } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 火情处置链路新增的集合（与通用业务模块同库存放，但由领域服务单独读写）。
export const TEAM_ALERTS_KEY = 'teamAlerts'
export const SUPPLY_OCCUPANCY_KEY = 'supplyOccupancy'
const DOMAIN_COLLECTIONS = [TEAM_ALERTS_KEY, SUPPLY_OCCUPANCY_KEY] as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type DataMap = Record<string, EntryRow[]>

/** 兼容历史记录：旧缓存缺新集合时补空、火情报告逐条规范化（只补不改）。 */
function migrate(raw: Record<string, EntryRow[]>): { data: DataMap; changed: boolean } {
  const data: DataMap = { ...raw }
  let changed = false
  for (const key of DOMAIN_COLLECTIONS) {
    if (!Array.isArray(data[key])) {
      data[key] = []
      changed = true
    }
  }
  if (Array.isArray(data.firereport)) {
    data.firereport = data.firereport.map((row) => {
      const before = JSON.stringify(row)
      const after = normalizeReport(row)
      if (JSON.stringify(after) !== before) {
        changed = true
      }
      return after
    })
  }
  return { data, changed }
}

function readStorage(): DataMap {
  const seed = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrate(seed).data
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = migrate(seed)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback.data))
    return fallback.data
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 旧缓存里的改动优先，但用种子兜底缺失模块，再统一做一次历史兼容迁移。
    const { data, changed } = migrate({ ...clone(SEED_ROWS), ...clone(parsed) })
    // 老缓存一旦需要补集合/补进度，立即把升级后的结构回写一次（幂等，后续不再触发）。
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    }
    return data
  } catch {
    const fallback = migrate(seed)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback.data))
    return fallback.data
  }
}

let cache: DataMap | null = null

export function allRows(): DataMap {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listTeamAlerts(): TeamAlert[] {
  return (allRows()[TEAM_ALERTS_KEY] ?? []) as unknown as TeamAlert[]
}

export function listSupplyOccupancy(): SupplyOccupancy[] {
  return (allRows()[SUPPLY_OCCUPANCY_KEY] ?? []) as unknown as SupplyOccupancy[]
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  persist(next)
}

export type AtomicPatch = {
  firereport: EntryRow[]
  teamAlerts: TeamAlert[]
  supplyOccupancy: SupplyOccupancy[]
  supply: EntryRow[]
}

/**
 * 多集合原子提交：火情报告、队伍提醒、物资占用/库存一次性整体写入。
 * 调用方在构建 patch 时已完成整组校验；这里要么全写要么不写，绝不半落库。
 */
export function commitAtomic(patch: AtomicPatch): void {
  const next: DataMap = {
    ...allRows(),
    firereport: patch.firereport,
    [TEAM_ALERTS_KEY]: patch.teamAlerts as unknown as EntryRow[],
    [SUPPLY_OCCUPANCY_KEY]: patch.supplyOccupancy as unknown as EntryRow[],
    supply: patch.supply,
  }
  persist(next)
}

function persist(next: DataMap): void {
  // 先序列化做一次「落库前自检」：失败就抛错，保留原 cache，等于整笔退回。
  const serialized = JSON.stringify(next)
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized)
    } catch (error) {
      // 写入失败：回滚内存缓存并上抛，由服务层返回失败，报告与提醒一起退回。
      cache = readStorage()
      throw error
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
