import { SEED_ALERTS, SEED_DISPATCHES, SEED_ROWS } from './seed'
import type { EntryRow, FireDispatch, TeamAlert } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const DISPATCH_KEY = 'forest-fire-patrol:fire-dispatch'
const ALERT_KEY = 'forest-fire-patrol:team-alerts'

// 缺火势等级的旧单按接警记录兼容：补一个「一般」等级并标明来源，页面上能看出是历史补录。
const FIRE_LEVELS = ['一级', '二级', '三级', '四级', '五级']
const LEGACY_FALLBACK_LEVEL = '三级'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 兼容历史火情报告：
 * - 老单据没有「接警时间」字段，用接警时登记的「起火时间」回填，回填后任何处置都不再改动它；
 * - 老单据火势等级缺失或是占位文本，按接警记录补成默认等级并打上「接警记录补录」标记；
 * - 补充乐观锁版本号，初始为 0。
 */
function migrateFireReport(row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }
  if (next['接警时间'] === undefined || String(next['接警时间']).trim() === '') {
    next['接警时间'] = String(next['起火时间'] ?? '')
  }
  const level = String(next['火势等级'] ?? '').trim()
  if (!FIRE_LEVELS.includes(level)) {
    next['火势等级原值'] = level
    next['火势等级'] = LEGACY_FALLBACK_LEVEL
    next['火势等级来源'] = '接警记录补录'
  } else if (next['火势等级来源'] === undefined) {
    next['火势等级来源'] = '接警登记'
  }
  if (typeof next['版本'] !== 'number') {
    next['版本'] = 0
  }
  return next
}

function readEntries(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalize(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalize(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 历史库做兼容化处理；老库里没有的新模块仍由种子补齐。
    return normalize({ ...fallback, ...parsed })
  } catch {
    const seeded = normalize(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

function normalize(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const reports = data.firereport
  if (Array.isArray(reports)) {
    data.firereport = reports.map(migrateFireReport)
  }
  return data
}

function readSideCollection<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

interface DataState {
  entries: Record<string, EntryRow[]>
  dispatches: FireDispatch[]
  alerts: TeamAlert[]
}

let cache: DataState | null = null

function state(): DataState {
  if (cache === null) {
    cache = {
      entries: readEntries(),
      dispatches: readSideCollection(DISPATCH_KEY, SEED_DISPATCHES),
      alerts: readSideCollection(ALERT_KEY, SEED_ALERTS),
    }
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return state().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function allDispatches(): FireDispatch[] {
  return state().dispatches
}

export function allAlerts(): TeamAlert[] {
  return state().alerts
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = { ...state(), entries: next }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 跨集合事务：报告状态、队伍状态、物资占用、联动提醒在同一次提交内修改，
 * 全部成功才一起落库；任一步骤失败或持久化抛错，整组退回提交前快照。
 */
export function commitTransaction(
  mutator: (draft: {
    entries: Record<string, EntryRow[]>
    dispatches: FireDispatch[]
    alerts: TeamAlert[]
  }) => void,
): void {
  const current = state()
  const snapshot = clone(current)
  const draft = clone(current)
  // 业务校验失败时抛错，下面捕获后整体回滚。
  mutator(draft)
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = draft
    return
  }
  const storage = window.localStorage
  const rawEntries = storage.getItem(STORAGE_KEY)
  const rawDispatch = storage.getItem(DISPATCH_KEY)
  const rawAlerts = storage.getItem(ALERT_KEY)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(draft.entries))
    storage.setItem(DISPATCH_KEY, JSON.stringify(draft.dispatches))
    storage.setItem(ALERT_KEY, JSON.stringify(draft.alerts))
    cache = draft
  } catch (error) {
    // 落库失败：能恢复的键逐一恢复，保证不出现「报告改了、提醒没写」的半截提交。
    restore(storage, STORAGE_KEY, rawEntries)
    restore(storage, DISPATCH_KEY, rawDispatch)
    restore(storage, ALERT_KEY, rawAlerts)
    cache = snapshot
    throw error
  }
}

function restore(storage: Storage, key: string, raw: string | null): void {
  try {
    if (raw === null) {
      storage.removeItem(key)
    } else {
      storage.setItem(key, raw)
    }
  } catch {
    // 恢复本身失败时保留缓存快照，至少页面内数据仍然一致。
  }
}

export function resetSideCollections(): void {
  const current = state()
  cache = {
    ...current,
    dispatches: clone(SEED_DISPATCHES),
    alerts: clone(SEED_ALERTS),
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DISPATCH_KEY, JSON.stringify(SEED_DISPATCHES))
    window.localStorage.setItem(ALERT_KEY, JSON.stringify(SEED_ALERTS))
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
