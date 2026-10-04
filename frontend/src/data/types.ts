/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ===== 火情处置链路（接警归集 → 队伍）的领域类型 =====

/** 火情报告状态机：只能顺序推进，误报为任一未结环节的终止分支。 */
export type FireStatus = '待核实' | '已确认' | '已出警' | '已扑灭' | '误报'

export type FireAction = '核实火情' | '出动扑救' | '确认扑灭' | '确认误报'

/** 一条处置进度（时间线节点）。报告行上以 JSON 字符串数组形式持久化在「处置进度」字段。 */
export type FireProgress = {
  stage: string
  at: string
  note: string
  source: '接警记录' | '处置提交' | '历史补录'
}

/** 队伍提醒：报告出动时与报告同次落库，报告误报则一并撤销。独立集合 teamAlerts。 */
export type TeamAlert = {
  id: number
  reportId: number
  报告编号: string
  起火地点: string
  火势等级: string
  队伍: string
  提醒时间: string
  状态: '待处理' | '已撤销'
}

/** 物资占用台账：出动时占用扣减库存，误报释放返还，扑灭则核销。独立集合 supplyOccupancy。 */
export type SupplyOccupancy = {
  id: number
  supplyId: number
  reportId: number
  物资名称: string
  数量: number
  占用时间: string
  状态: '占用中' | '已释放'
}

/** 单条处置提交：报告与队伍提醒、物资占用在同一事务里落库。 */
export type DispositionRequest = {
  reportId: number
  action: FireAction
  /** 出动扑救必填：调派的队伍名称。 */
  team?: string
  /** 出动扑救可选：携带物资 [{ supplyId, 数量 }]。 */
  supplies?: { supplyId: number; qty: number }[]
  /** 处置结论：只写入本次新进度，不回填、不残留上一次结论。 */
  note?: string
  /** 乐观锁版本：提交方读取到的版本，和库里不一致则拒绝后到请求。 */
  expectedVersion: number
}

export type BatchDispositionRequest = Omit<DispositionRequest, 'reportId'> & {
  reportIds: number[]
}

/** 处置事务一次写入的全部集合：任一集合校验失败则整体退回，不做半写。 */
export type CommitPatch = {
  firereport: EntryRow[]
  teamAlerts: TeamAlert[]
  supplyOccupancy: SupplyOccupancy[]
  supply: EntryRow[]
}
