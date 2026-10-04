/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
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
  /**
   * 动作前置状态：只有当前状态命中白名单才允许执行，保证状态只能沿规定链路顺序推进。
   * 未登记的模块沿用旧行为（只禁止重复目标态），兼容既有历史页面。
   */
  actionSources?: Record<string, string[]>
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
  /** 并发冲突：提交携带的版本已过期，属于「后到请求」，调用方应刷新列表。 */
  conflict?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// —— 火情处置链路专用类型 ——

/** 接警记录：报告归集时形成，原接警时间一旦写入不再变更。 */
export type FireDispatch = {
  reportId: number
  teamId: number
  teamName: string
  /** 出动时占用的物资：扑灭/误报后整组释放。 */
  occupiedSupplies: { supplyId: number; supplyName: string }[]
  /** 处置时间线，按时间顺序记录核实、出动、扑灭、误报等节点。 */
  timeline: { at: string; action: string; note: string; operator: string }[]
}

/** 报告与队伍的联动提醒：报告状态推进与提醒必须同次落库。 */
export type TeamAlert = {
  id: number
  reportId: number
  reportCode: string
  teamId: number
  teamName: string
  kind: '出动' | '扑灭' | '误报'
  content: string
  createdAt: string
  acknowledged: boolean
}

/** 处置提交载荷：表单结论 + 乐观锁版本。 */
export type DispositionInput = {
  action: string
  note: string
  teamId?: number
  supplyIds?: number[]
  /** 打开详情时看到的版本；提交时与库内版本不一致即拒绝（两次处置并发的后到请求）。 */
  version: number
}

export type BatchDispositionInput = {
  ids: number[]
  note: string
  /** 勾选项各自的版本基线：任意一条与库内不一致，整组拒绝。 */
  versions: Record<number, number>
}
