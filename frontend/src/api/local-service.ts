import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitAtomic,
  listRows,
  listSupplyOccupancy,
  listTeamAlerts,
  resetRows,
  saveRows,
} from '@/data/local-store'
import {
  buildDispositionPatch,
  defaultClock,
  effectiveFireLevel,
  latestProgress,
  parseProgress,
} from '@/data/fire-disposition'
import type {
  ActionResult,
  BatchDispositionRequest,
  DispositionRequest,
  EntryRow,
  FireAction,
  FireStatus,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ===== 火情处置链路服务（页面只通过这些接口读写，状态判断不进组件）=====

/** 列表行上的火势等级：缺等级的旧单按接警记录兼容。 */
export function displayFireLevel(row: EntryRow): string {
  return effectiveFireLevel(row) || '未评级'
}

export type ReportListView = {
  row: EntryRow
  level: string
  lastStage: string
  version: number
}

/** 火情报告列表：只展示最新一条进度，旧进度不重复摊开。 */
export function listFireReports(filters: Record<string, string> = {}): {
  items: ReportListView[]
  total: number
} {
  const matched = filterRows(listRows('firereport'), filters)
  const items = matched.map((row) => {
    const progress = latestProgress(row)
    return {
      row,
      level: displayFireLevel(row),
      lastStage: progress ? `${progress.stage}（${progress.at}）` : '接警归集',
      version: Number(row['版本'] ?? 0),
    }
  })
  return { items, total: items.length }
}

/** 当前状态允许的下一步动作：核实→出动→扑灭 顺序推进，另加未结环节的误报分支。 */
export function availableFireActions(status: string): FireAction[] {
  switch (status as FireStatus) {
    case '待核实':
      return ['核实火情', '确认误报']
    case '已确认':
      return ['出动扑救', '确认误报']
    case '已出警':
      return ['确认扑灭', '确认误报']
    default:
      return []
  }
}

export type ReportDetail = {
  row: EntryRow
  level: string
  levelInferred: boolean
  intakeTime: string
  progress: ReturnType<typeof parseProgress>
  actions: FireAction[]
  version: number
  occupancy: ReturnType<typeof listSupplyOccupancy>
  alerts: ReturnType<typeof listTeamAlerts>
}

/** 处置详情：每次进入都现取现算，返回全新对象，表单结论不残留上次内容。 */
export function getFireReport(id: number): ReportDetail | null {
  const row = listRows('firereport').find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  const level = effectiveFireLevel(row)
  return {
    row,
    level: level || '未评级',
    // 显式等级为空、靠接警记录兼容出来时，页面给出兼容说明。
    levelInferred: String(row['火势等级'] ?? '').trim() === '',
    intakeTime: String(row['接警时间'] ?? row['起火时间'] ?? ''),
    progress: parseProgress(row),
    actions: availableFireActions(String(row.status)),
    version: Number(row['版本'] ?? 0),
    occupancy: listSupplyOccupancy().filter((o) => o.reportId === id),
    alerts: listTeamAlerts().filter((a) => a.reportId === id),
  }
}

/** 出动时可选队伍（在营待命优先）。 */
export function selectableTeams(): { id: number; name: string; status: string }[] {
  return listRows('fireteam').map((row) => ({
    id: Number(row.id),
    name: String(row['队伍名称'] ?? ''),
    status: String(row.status ?? ''),
  }))
}

/** 出动时可携带物资及其当前可用库存（扣除在途占用）。 */
export function selectableSupplies(): {
  id: number
  name: string
  stock: number
  locked: number
  available: number
}[] {
  const occupancy = listSupplyOccupancy()
  return listRows('supply').map((row) => {
    const stock = Number(String(row['实际储备量'] ?? '').trim()) || 0
    const locked = occupancy
      .filter((o) => o.supplyId === Number(row.id) && o.状态 === '占用中')
      .reduce((sum, o) => sum + o.数量, 0)
    return {
      id: Number(row.id),
      name: String(row['物资名称'] ?? ''),
      stock,
      locked,
      available: stock - locked,
    }
  })
}

export function listAlerts() {
  return listTeamAlerts()
}

/**
 * 提交一次处置（单条）。报告与队伍提醒、物资占用在同一事务落库：
 * 构建 patch 时整组校验（前置态 + 乐观锁 + 库存），任一失败都不写库。
 */
export function submitDisposition(req: DispositionRequest): ActionResult {
  return commitBatch({ ...req, reportIds: [req.reportId] })
}

/** 批量多选后整组一次提交：全有或全无，失败一起退回。 */
export function submitBatchDisposition(req: BatchDispositionRequest): ActionResult {
  return commitBatch(req)
}

function commitBatch(req: BatchDispositionRequest): ActionResult {
  const base = {
    firereport: listRows('firereport'),
    teamAlerts: listTeamAlerts(),
    supplyOccupancy: listSupplyOccupancy(),
    supply: listRows('supply'),
  }
  const result = buildDispositionPatch(base, req, defaultClock())
  if (!result.ok || !result.patch) {
    return { ok: false, message: result.message }
  }
  try {
    commitAtomic(result.patch)
  } catch {
    return { ok: false, message: '处置落库失败，报告与队伍提醒已一起退回，请重试' }
  }
  return { ok: true, message: result.message }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
