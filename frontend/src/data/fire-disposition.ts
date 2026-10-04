import type {
  BatchDispositionRequest,
  CommitPatch,
  EntryRow,
  FireAction,
  FireProgress,
  FireStatus,
  SupplyOccupancy,
  TeamAlert,
} from '@/data/types'

// 火情处置链路：接警归集 → 核实 → 出动（队伍提醒 + 物资占用）→ 扑灭 / 误报（释放占用）。
// 本文件只放纯业务规则，不直接碰 localStorage，方便用内存数据层做并发/事务测试。
// 页面依旧只调 local-service，状态流转不允许写进组件。

export const FIRE_STATUSES: FireStatus[] = ['待核实', '已确认', '已出警', '已扑灭', '误报']

/** 顺序主干：核实 → 出动 → 扑灭，只能逐级推进。 */
const NEXT_STATUS: Record<FireAction, FireStatus> = {
  核实火情: '已确认',
  出动扑救: '已出警',
  确认扑灭: '已扑灭',
  确认误报: '误报',
}

const PROGRESS_SEQ = ['接警归集', '核实', '出动', '扑灭']

// 误报：接警后任一未结环节都可判定为误报；已扑灭的不再改判。
const FALSE_ALARM_FROM: FireStatus[] = ['待核实', '已确认', '已出警']

// 火势等级取值口径。旧单缺「火势等级」字段时，按接警记录（接警初判）兼容。
export const FIRE_LEVELS = ['一般', '较大', '重大', '特别重大'] as const
const LEVEL_KEYWORDS: { level: string; words: string[] }[] = [
  { level: '特别重大', words: ['特别重大', '特大'] },
  { level: '重大', words: ['重大'] },
  { level: '较大', words: ['较大'] },
  { level: '一般', words: ['一般'] },
]

export const MIGRATION_KEY = '迁移版本'
export const MIGRATION_VERSION = 2

export type Clock = () => string

export function defaultClock(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`
}

export type DispositionResult = {
  ok: boolean
  message: string
  patch?: CommitPatch
}

// ---------- 火势等级：缺等级的旧单按接警记录兼容 ----------

/** 从接警记录文本里提取初判等级，识别不出返回空串（显示为未评级）。 */
export function inferLevelFromIntake(intake: unknown): string {
  const text = String(intake ?? '')
  for (const { level, words } of LEVEL_KEYWORDS) {
    if (words.some((word) => text.includes(word))) {
      return level
    }
  }
  return ''
}

/** 报告对外呈现的火势等级：优先显式字段，旧单缺省时按接警记录兼容。 */
export function effectiveFireLevel(row: EntryRow): string {
  const explicit = String(row['火势等级'] ?? '').trim()
  if (explicit && explicit !== '火情报告样例1' && explicit !== '火情报告样例2' && explicit !== '火情报告样例3') {
    return explicit
  }
  return inferLevelFromIntake(row['接警初判'])
}

/** 迁移时是否需要把兼容等级回填进显式字段（幂等，只补空值）。 */
function needsLevelBackfill(row: EntryRow): boolean {
  const explicit = String(row['火势等级'] ?? '').trim()
  return explicit === '' || FIRE_PLACEHOLDER.test(explicit)
}

const FIRE_PLACEHOLDER = /^火情报告样例\d+$/

// ---------- 处置进度（时间线），幂等补建，列表只显示最新一条 ----------

export function parseProgress(row: EntryRow): FireProgress[] {
  const raw = row['处置进度']
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as FireProgress[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function serializeProgress(list: FireProgress[]): string {
  return JSON.stringify(list)
}

function dedupeProgress(list: FireProgress[]): FireProgress[] {
  const seen = new Set<string>()
  const result: FireProgress[] = []
  for (const item of list) {
    const key = `${item.stage}|${item.at}|${item.note}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(item)
    }
  }
  return result
}

/** 最新一条进度（列表页只展示它，不再把旧进度逐条重复摊开）。 */
export function latestProgress(row: EntryRow): FireProgress | null {
  const list = parseProgress(row)
  return list.length ? list[list.length - 1] : null
}

function progressIndex(list: FireProgress[], stage: string): number {
  return list.findIndex((item) => item.stage === stage)
}

/** 追加一次真实处置提交：结论只属于本次节点，不覆盖历史、不残留上次结论。 */
function appendProgress(
  list: FireProgress[],
  stage: string,
  at: string,
  note: string,
): FireProgress[] {
  const next = dedupeProgress(list)
  const item: FireProgress = { stage, at, note: note || '—', source: '处置提交' }
  const existing = progressIndex(next, stage)
  if (existing >= 0) {
    next[existing] = item
  } else {
    next.push(item)
  }
  return next
}

// ---------- 历史旧单兼容：幂等规范化 + 缺失进度补建 ----------

/**
 * 规范化历史火情报告（只补不改）：
 * - 缺「接警时间」用起火时间兜底；
 * - 缺「火势等级」按接警记录兼容（回填，仅空值）；
 * - 缺「版本」初始化为 0；
 * - 缺失的处置进度按当前状态补建一次（标注历史补录），不重复补。
 * 原接警时间在任何后续处置中都保持原样，这里也不会回写它。
 */
export function normalizeReport(row: EntryRow): EntryRow {
  const normalized: EntryRow = { ...row }

  if (String(normalized['接警时间'] ?? '').trim() === '') {
    normalized['接警时间'] = String(normalized['起火时间'] ?? '')
  }

  if (needsLevelBackfill(normalized)) {
    const inferred = inferLevelFromIntake(normalized['接警初判'])
    if (inferred) {
      normalized['火势等级'] = inferred
    } else {
      normalized['火势等级'] = ''
    }
  }

  if (typeof normalized['版本'] !== 'number') {
    normalized['版本'] = 0
  }

  const status = String(normalized.status) as FireStatus
  if (!normalized['处置进度'] || parseProgress(normalized).length === 0) {
    normalized['处置进度'] = serializeProgress(buildLegacyProgress(normalized, status))
  }

  normalized['迁移版本'] = MIGRATION_VERSION
  return normalized
}

function buildLegacyProgress(row: EntryRow, status: FireStatus): FireProgress[] {
  const intakeAt = String(row['接警时间'] ?? row['起火时间'] ?? '')
  const list: FireProgress[] = [
    { stage: '接警归集', at: intakeAt, note: String(row['接警初判'] ?? '历史接警记录归集'), source: '接警记录' },
  ]
  // 按当前状态补齐它应已走过的顺序环节（序号 1=核实 2=出动 3=扑灭）。
  const reached: Record<string, number> = { 已确认: 1, 已出警: 2, 已扑灭: 3 }
  const upto = reached[status] ?? 0
  for (let i = 1; i <= upto; i += 1) {
    list.push({ stage: PROGRESS_SEQ[i], at: intakeAt, note: `历史记录补录：${PROGRESS_SEQ[i]}环节`, source: '历史补录' })
  }
  return list
}

// ---------- 状态标记 ----------

function isTerminal(status: FireStatus): boolean {
  return status === '已扑灭' || status === '误报'
}

function recomputeFlags(row: EntryRow, status: FireStatus): EntryRow {
  return {
    ...row,
    pending: !isTerminal(status),
    abnormal: status === '误报',
  }
}

// ---------- 物资数量解析（历史库存可能是占位文本，按 0 兼容） ----------

function parseStock(value: unknown): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

// ---------- 事务构建：先整组校验，再一次性产出提交快照 ----------

type MutablePatch = {
  firereport: EntryRow[]
  teamAlerts: TeamAlert[]
  supply: EntryRow[]
  occupancy: SupplyOccupancy[]
}

function fail(message: string): DispositionResult {
  return { ok: false, message }
}

/**
 * 整组处置（单条就是一组的特例）。
 * 全有或全无：组内任一条不满足前置态 / 版本冲突 / 库存不足，都整体拒绝，不产生任何落库。
 */
export function buildDispositionPatch(
  base: {
    firereport: EntryRow[]
    teamAlerts: TeamAlert[]
    supplyOccupancy: SupplyOccupancy[]
    supply: EntryRow[]
  },
  req: BatchDispositionRequest,
  now: string,
): DispositionResult {
  const ids = [...new Set(req.reportIds)]
  if (ids.length === 0) {
    return fail('请先勾选要处置的火情报告')
  }

  const patch: MutablePatch = {
    firereport: base.firereport.map((r) => ({ ...r })),
    teamAlerts: base.teamAlerts.map((a) => ({ ...a })),
    supply: base.supply.map((s) => ({ ...s })),
    occupancy: base.supplyOccupancy.map((o) => ({ ...o })),
  }

  const action = req.action
  const target = NEXT_STATUS[action]
  const stage = action === '核实火情' ? '核实' : action === '出动扑救' ? '出动' : action === '确认扑灭' ? '扑灭' : '误报'
  const note = (req.note ?? '').trim()

  // 出动扑救整组调派同一支队伍（批量整组一次提交）。
  if (action === '出动扑救' && !String(req.team ?? '').trim()) {
    return fail('出动扑救必须指定调派队伍')
  }

  // 第一遍：逐条校验前置态与乐观锁版本，任一不过整组退回。
  const targets: { index: number; row: EntryRow; status: FireStatus }[] = []
  for (const reportId of ids) {
    const index = patch.firereport.findIndex((r) => Number(r.id) === reportId)
    if (index < 0) {
      return fail(`没有找到编号为 ${reportId} 的火情报告`)
    }
    const row = patch.firereport[index]
    const status = String(row.status) as FireStatus

    if (typeof row['版本'] === 'number' && row['版本'] !== req.expectedVersion) {
      return fail(
        `报告 ${String(row['报告编号'])} 的进度已被其他处置更新（当前版本 ${Number(
          row['版本'],
        )}），请刷新后重试，已拒绝后到请求`,
      )
    }

    if (action === '确认误报') {
      if (!FALSE_ALARM_FROM.includes(status)) {
        return fail(`报告 ${String(row['报告编号'])} 当前「${status}」，不能再判为误报`)
      }
    } else {
      const expected = PRIOR_STATUS[action]
      if (status !== expected) {
        return fail(
          `报告 ${String(row['报告编号'])} 当前「${status}」，需先处于「${expected}」才能${action}，核实、出动、扑灭只能顺序推进`,
        )
      }
    }
    targets.push({ index, row, status })
  }

  // 出动：先校验整组库存。批量时每支调派单位各携带一份物资，要逐单累计冻结，
  // 任一单在其下单时点可用库存不足，整组都拒绝（失败一起退回，不占用任何物资）。
  if (action === '出动扑救') {
    const perReport = (req.supplies ?? []).filter((item) => item.qty > 0)
    if (perReport.length) {
      // 逐单累计占用：第 n 单要在前面 n-1 单已冻结后仍够用。
      const frozen = new Map<number, number>()
      for (let n = 0; n < ids.length; n += 1) {
        for (const item of perReport) {
          const supplyRow = patch.supply.find((s) => Number(s.id) === item.supplyId)
          if (!supplyRow) {
            return fail(`携带的物资不存在（编号 ${item.supplyId}），整组未提交`)
          }
          const base = parseStock(supplyRow['实际储备量'])
          const alreadyLocked = patch.occupancy
            .filter((o) => o.supplyId === item.supplyId && o.状态 === '占用中')
            .reduce((sum, o) => sum + o.数量, 0)
          const usedByGroup = frozen.get(item.supplyId) ?? 0
          const available = base - alreadyLocked - usedByGroup
          if (item.qty > available) {
            return fail(
              `物资「${String(supplyRow['物资名称'])}」在第 ${n + 1} 单可用库存不足（需 ${item.qty}，可用 ${available}），整组未提交`,
            )
          }
          frozen.set(item.supplyId, usedByGroup + item.qty)
        }
      }
    }
  }

  // 第二遍：全部校验通过后才落变更。
  for (const { index, status } of targets) {
    const row = patch.firereport[index]
    const code = String(row['报告编号'])

    if (action === '确认误报') {
      // 误报：释放这笔报告仍占用的物资（返还库存），撤销未处理的队伍提醒。
      for (const occ of patch.occupancy) {
        if (occ.reportId === Number(row.id) && occ.状态 === '占用中') {
          occ.状态 = '已释放'
          const supplyRow = patch.supply.find((s) => Number(s.id) === occ.supplyId)
          if (supplyRow) {
            supplyRow['实际储备量'] = parseStock(supplyRow['实际储备量']) + occ.数量
          }
        }
      }
      for (const alert of patch.teamAlerts) {
        if (alert.reportId === Number(row.id) && alert.状态 === '待处理') {
          alert.状态 = '已撤销'
        }
      }
      const list = appendProgress(parseProgress(row), '误报', now, note || '核实为误报，释放占用物资并撤销队伍提醒')
      let updated = recomputeFlags({ ...row, status: '误报' }, '误报')
      updated = {
        ...updated,
        处置进度: serializeProgress(list),
        版本: Number(row['版本'] ?? 0) + 1,
      }
      patch.firereport[index] = updated
      continue
    }

    let list = appendProgress(parseProgress(row), stage, now, note)

    if (action === '出动扑救') {
      const team = String(req.team ?? '').trim()
      const level = effectiveFireLevel(row) || '未评级'
      // 队伍提醒与报告同次落库。
      patch.teamAlerts.push({
        id: nextId(patch.teamAlerts),
        reportId: Number(row.id),
        报告编号: code,
        起火地点: String(row['起火地点'] ?? ''),
        火势等级: level,
        队伍: team,
        提醒时间: now,
        状态: '待处理',
      })
      // 物资占用：登记台账（占用中），并从可用库存里冻结。
      for (const item of req.supplies ?? []) {
        if (item.qty <= 0) continue
        const supplyRow = patch.supply.find((s) => Number(s.id) === item.supplyId)
        if (!supplyRow) continue
        patch.occupancy.push({
          id: nextId(patch.occupancy),
          supplyId: item.supplyId,
          reportId: Number(row.id),
          物资名称: String(supplyRow['物资名称'] ?? ''),
          数量: item.qty,
          占用时间: now,
          状态: '占用中',
        })
      }
    }

    let updated = recomputeFlags({ ...row, status: target }, target)
    updated = {
      ...updated,
      处置进度: serializeProgress(list),
      版本: Number(row['版本'] ?? 0) + 1,
    }
    patch.firereport[index] = updated
  }

  return {
    ok: true,
    message: buildSuccessMessage(action, ids.length),
    patch: {
      firereport: patch.firereport,
      teamAlerts: patch.teamAlerts,
      supplyOccupancy: patch.occupancy,
      supply: patch.supply,
    },
  }
}

/** 各顺次动作要求报告所处的前置态。 */
const PRIOR_STATUS: Record<Exclude<FireAction, '确认误报'>, FireStatus> = {
  核实火情: '待核实',
  出动扑救: '已确认',
  确认扑灭: '已出警',
}

function buildSuccessMessage(action: FireAction, count: number): string {
  const tail = action === '出动扑救' ? '，队伍提醒与物资占用已同次落库' : ''
  if (action === '确认误报') {
    return `${count} 条报告已判为误报，占用物资已释放、队伍提醒已撤销（同次退回）`
  }
  return `${count} 条报告已${action}，当前推进到「${NEXT_STATUS[action]}」${tail}`
}
