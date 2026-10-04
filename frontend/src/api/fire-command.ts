import {
  allAlerts,
  allDispatches,
  allRows,
  commitTransaction,
  listRows,
} from '@/data/local-store'
import type {
  ActionResult,
  BatchDispositionInput,
  DispositionInput,
  EntryRow,
  FireDispatch,
  TeamAlert,
} from '@/data/types'

// 火情报告沿「待核实 → 已确认 → 已出警 → 已扑灭」推进；误报是接警核实环节的分支结论。
const REPORT_STATUS = {
  received: '待核实',
  verified: '已确认',
  dispatched: '已出警',
  extinguished: '已扑灭',
  falseAlarm: '误报',
} as const

const ACTION_TARGET: Record<string, string> = {
  核实火情: REPORT_STATUS.verified,
  出动扑救: REPORT_STATUS.dispatched,
  确认扑灭: REPORT_STATUS.extinguished,
  确认误报: REPORT_STATUS.falseAlarm,
}

const ACTION_SOURCE: Record<string, string[]> = {
  核实火情: [REPORT_STATUS.received],
  出动扑救: [REPORT_STATUS.verified],
  确认扑灭: [REPORT_STATUS.dispatched],
  确认误报: [REPORT_STATUS.received],
}

const TERMINAL_STATUSES: string[] = [REPORT_STATUS.extinguished, REPORT_STATUS.falseAlarm]

function nowText(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function rowVersion(row: EntryRow): number {
  return typeof row['版本'] === 'number' ? Number(row['版本']) : 0
}

export type ReportSnapshot = {
  row: EntryRow
  version: number
  dispatch?: FireDispatch
}

/** 打开处置详情时取一份快照：每次进入都从库里重新读取，结论表单不沿用上一次的残留。 */
export function getReportSnapshot(id: number): ReportSnapshot | undefined {
  const row = listRows('firereport').find((item) => Number(item.id) === id)
  if (!row) {
    return undefined
  }
  return {
    row,
    version: rowVersion(row),
    dispatch: allDispatches().find((item) => item.reportId === id),
  }
}

function ensureDispatch(draft: { dispatches: FireDispatch[] }, reportId: number): FireDispatch {
  let dispatch = draft.dispatches.find((item) => item.reportId === reportId)
  if (!dispatch) {
    dispatch = { reportId, teamId: 0, teamName: '—', occupiedSupplies: [], timeline: [] }
    draft.dispatches.push(dispatch)
  }
  return dispatch
}

function nextAlertId(alerts: TeamAlert[]): number {
  return alerts.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function releaseSupplies(
  entries: Record<string, EntryRow[]>,
  dispatch: FireDispatch,
): EntryRow[] {
  const supplies = entries.supply ?? []
  const occupiedIds = new Set(dispatch.occupiedSupplies.map((item) => item.supplyId))
  if (occupiedIds.size === 0) {
    return supplies
  }
  return supplies.map((supply) =>
    occupiedIds.has(Number(supply.id))
      ? { ...supply, 占用单号: '' }
      : supply,
  )
}

/**
 * 单条处置提交：
 * - 状态机守卫保证核实/出动/扑灭只能顺序推进，误报单不可能再出动；
 * - 乐观锁（版本号）拒绝两次处置同时提交时的后到请求；
 * - 报告状态与队伍提醒在同一事务内落库，队伍、物资联动失败则整组退回；
 * - 全程不改写「接警时间」，原接警时间保持原样。
 */
export function submitDisposition(
  id: number,
  input: DispositionInput,
  operator: string,
): ActionResult {
  const target = ACTION_TARGET[input.action]
  if (!target) {
    return { ok: false, message: `火情报告没有登记「${input.action}」这个处置动作` }
  }
  try {
    commitTransaction((draft) => {
      const reports = draft.entries.firereport ?? []
      const index = reports.findIndex((item) => Number(item.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的火情报告`)
      }
      const current = reports[index]
      const status = String(current.status)

      if (rowVersion(current) !== input.version) {
        // 后到请求：详情打开后这条报告已被另一次处置推进过。
        const conflict = new Error(
          `该报告已被其他处置推进（当前为「${status}」），请返回列表刷新后重新进入`,
        )
        conflict.name = 'VersionConflict'
        throw conflict
      }
      const sources = ACTION_SOURCE[input.action]
      if (!sources.includes(status)) {
        throw new Error(
          `报告当前为「${status}」，不能执行「${input.action}」（需先处于「${sources.join('、')}」）`,
        )
      }

      const at = nowText()
      const dispatch = ensureDispatch(draft, id)
      const reportCode = String(current['报告编号'] ?? id)

      if (input.action === '出动扑救') {
        const teamId = Number(input.teamId ?? 0)
        const team = (draft.entries.fireteam ?? []).find((item) => Number(item.id) === teamId)
        if (!team) {
          throw new Error('请选择一支在营待命的扑火队伍再出动')
        }
        if (!['在营待命'].includes(String(team.status))) {
          throw new Error(`所选队伍当前为「${team.status}」，无法出动，请改选待命队伍`)
        }
        const supplies = draft.entries.supply ?? []
        const chosen = (input.supplyIds ?? []).map((supplyId) =>
          supplies.find((item) => Number(item.id) === Number(supplyId)),
        )
        if (chosen.some((item) => !item)) {
          throw new Error('所选物资中有已不存在的记录，请刷新后重选')
        }
        const occupied = chosen
          .filter((item): item is EntryRow => Boolean(item))
          .map((item) => ({ supplyId: Number(item.id), supplyName: String(item['物资名称']) }))

        // 报告与队伍状态、物资占用、出动提醒必须同次落库。
        draft.entries.fireteam = (draft.entries.fireteam ?? []).map((item) =>
          Number(item.id) === teamId ? { ...item, status: '已出动', pending: true } : item,
        )
        const occupiedIds = new Set(occupied.map((item) => item.supplyId))
        draft.entries.supply = supplies.map((item) =>
          occupiedIds.has(Number(item.id))
            ? { ...item, 占用单号: reportCode }
            : item,
        )
        dispatch.teamId = teamId
        dispatch.teamName = String(team['队伍名称'])
        dispatch.occupiedSupplies = occupied
        draft.alerts.push({
          id: nextAlertId(draft.alerts),
          reportId: id,
          reportCode,
          teamId,
          teamName: dispatch.teamName,
          kind: '出动',
          content: `${current['起火地点']} 出现${current['火势等级']}火情，立即出动并携带已登记物资`,
          createdAt: at,
          acknowledged: false,
        })
      }

      if (input.action === '确认扑灭') {
        // 扑灭后释放出动时占用的整组物资、撤回队伍，与报告结论、提醒一起落库。
        draft.entries.supply = releaseSupplies(draft.entries, dispatch)
        if (dispatch.teamId > 0) {
          draft.entries.fireteam = (draft.entries.fireteam ?? []).map((item) =>
            Number(item.id) === dispatch.teamId
              ? { ...item, status: '已撤回', pending: false }
              : item,
          )
        }
        draft.alerts.push({
          id: nextAlertId(draft.alerts),
          reportId: id,
          reportCode,
          teamId: dispatch.teamId,
          teamName: dispatch.teamName,
          kind: '扑灭',
          content: '明火已扑灭，请撤回队伍并归还出动物资',
          createdAt: at,
          acknowledged: false,
        })
      }

      if (input.action === '确认误报') {
        // 误报只能发生在出动之前：没有占用物资、没有队伍出动，提醒中同样注明无需出动。
        if (dispatch.occupiedSupplies.length > 0) {
          throw new Error('该报告已出动并占用物资，不能改判误报')
        }
        draft.alerts.push({
          id: nextAlertId(draft.alerts),
          reportId: id,
          reportCode,
          teamId: 0,
          teamName: '—',
          kind: '误报',
          content: `${current['起火地点']} 警情核实为误报，不出动、不占用物资`,
          createdAt: at,
          acknowledged: false,
        })
      }

      dispatch.timeline.push({ at, action: input.action, note: input.note.trim(), operator })

      reports[index] = {
        ...current,
        status: target,
        pending: !TERMINAL_STATUSES.includes(target),
        abnormal: false,
        扑救情况: summarize(input.action, input.note, dispatch),
        版本: rowVersion(current) + 1,
      }
      draft.entries.firereport = reports
    })
    return { ok: true, message: `已${input.action}，报告当前状态「${target}」` }
  } catch (error) {
    if (error instanceof Error && error.name === 'VersionConflict') {
      return { ok: false, message: error.message, conflict: true }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${input.action}提交失败，已整组退回`,
    }
  }
}

function summarize(action: string, note: string, dispatch: FireDispatch): string {
  const text = note.trim()
  if (action === '出动扑救') {
    const supplyText = dispatch.occupiedSupplies.length
      ? `，已占用物资 ${dispatch.occupiedSupplies.length} 项`
      : ''
    return text
      ? `${text}（队伍：${dispatch.teamName}${supplyText}）`
      : `已由${dispatch.teamName}出动${supplyText}`
  }
  if (action === '确认扑灭') {
    return text || '明火已扑灭，队伍撤回、物资归库'
  }
  if (action === '确认误报') {
    return text || '核实为误报，未出动、未占用物资'
  }
  return text || '火情已核实，等待出动'
}

/**
 * 批量核实：多选的待核实报告整组一次提交。
 * 任意一条已被他人处置（版本过期）或状态不符，整组拒绝，不产生半批成功。
 */
export function submitBatchVerify(
  input: BatchDispositionInput,
  operator: string,
): ActionResult & { processed?: number } {
  const ids = [...new Set(input.ids.map(Number))]
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选需要整组核实的报告' }
  }
  try {
    commitTransaction((draft) => {
      const reports = draft.entries.firereport ?? []
      const at = nowText()
      const targets = ids.map((id) => {
        const index = reports.findIndex((item) => Number(item.id) === id)
        if (index < 0) {
          throw new Error(`编号为 ${id} 的报告不存在，整组已退回`)
        }
        return { id, index, current: reports[index] }
      })
      for (const { id, current } of targets) {
        if (rowVersion(current) !== input.versions[id]) {
          const conflict = new Error(
            `报告 ${current['报告编号'] ?? id} 已被其他处置推进，请刷新列表后重新勾选`,
          )
          conflict.name = 'VersionConflict'
          throw conflict
        }
        if (String(current.status) !== REPORT_STATUS.received) {
          throw new Error(
            `报告 ${current['报告编号'] ?? id} 当前为「${current.status}」，只能整组核实「待核实」报告`,
          )
        }
      }
      for (const { id, index, current } of targets) {
        const dispatch = ensureDispatch(draft, id)
        dispatch.timeline.push({
          at,
          action: '核实火情',
          note: input.note.trim() || '批量核实通过',
          operator,
        })
        reports[index] = {
          ...current,
          status: REPORT_STATUS.verified,
          pending: true,
          abnormal: false,
          扑救情况: input.note.trim() || '火情已核实（批量），等待出动',
          版本: rowVersion(current) + 1,
        }
      }
      draft.entries.firereport = reports
    })
    return { ok: true, message: `整组核实完成，共 ${ids.length} 条`, processed: ids.length }
  } catch (error) {
    if (error instanceof Error && error.name === 'VersionConflict') {
      return { ok: false, message: error.message, conflict: true }
    }
    return { ok: false, message: error instanceof Error ? error.message : '批量核实失败，已整组退回' }
  }
}

export function listAlerts(): TeamAlert[] {
  return [...allAlerts()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function acknowledgeAlert(id: number): ActionResult {
  try {
    commitTransaction((draft) => {
      const index = draft.alerts.findIndex((item) => item.id === id)
      if (index < 0) {
        throw new Error('提醒不存在或已被清理')
      }
      draft.alerts[index] = { ...draft.alerts[index], acknowledged: true }
    })
    return { ok: true, message: '提醒已收悉' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '收悉失败' }
  }
}

/** 物资当前占用情况：由调度记录里尚未释放的出动占用汇总，扑灭/误报后自动清空。 */
export function supplyOccupancy(): Map<number, string> {
  const occupancy = new Map<number, string>()
  for (const dispatch of allDispatches()) {
    const report = (allRows().firereport ?? []).find(
      (item) => Number(item.id) === dispatch.reportId,
    )
    if (!report || TERMINAL_STATUSES.includes(String(report.status))) {
      continue
    }
    for (const supply of dispatch.occupiedSupplies) {
      occupancy.set(supply.supplyId, String(report['报告编号'] ?? dispatch.reportId))
    }
  }
  return occupancy
}

export function availableTeams(): EntryRow[] {
  return listRows('fireteam').filter((item) => String(item.status) === '在营待命')
}

export function availableSupplies(): EntryRow[] {
  const occupied = supplyOccupancy()
  return listRows('supply').filter((item) => !occupied.has(Number(item.id)))
}
