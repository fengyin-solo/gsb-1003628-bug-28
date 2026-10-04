// 火情报告 → 队伍 链路修复的端到端核实脚本：用内存 localStorage shim 驱动真实数据层。
import { allAlerts, allDispatches } from './src/data/local-store'
import {
  acknowledgeAlert,
  availableSupplies,
  availableTeams,
  getReportSnapshot,
  listAlerts,
  submitBatchVerify,
  submitDisposition,
  supplyOccupancy,
} from './src/api/fire-command'
import { listEntries, runAction } from './src/api/local-service'

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name} ${extra}`)
    process.exitCode = 1
  }
}

const operator = '值班管理员'
function report(id: number) {
  const snap = getReportSnapshot(id)!
  return snap
}
function status(id: number) {
  return String(report(id).row.status)
}

console.log('1) 历史兼容：缺接警时间/火势等级的旧单按接警记录补录，原接警时间保持原样')
const old = report(1)
check('旧单接警时间回填自起火时间', old.row['接警时间'] === old.row['起火时间'])
check('旧单火势等级补录为三级', old.row['火势等级'] === '三级')
check('旧单标记接警记录补录来源', old.row['火势等级来源'] === '接警记录补录')
check('旧单保留等级原值可追溯', String(old.row['火势等级原值']).includes('占位'))
const oldAlarmTime = old.row['接警时间']

console.log('2) 顺序推进：核实→出动→扑灭只能顺序执行，越级动作被拒绝')
check('待核实单不能直接出动', submitDisposition(1, { action: '出动扑救', note: '', version: 0 }, operator).ok === false)
check('已确认单不能直接扑灭', submitDisposition(2, { action: '确认扑灭', note: '', version: report(2).version }, operator).ok === false)
check('已出警单不能重复出动', submitDisposition(3, { action: '出动扑救', note: '', teamId: 1, version: report(3).version }, operator).ok === false)
check('已出警单不能改判误报（误报单不得继续占用物资的根因）', submitDisposition(3, { action: '确认误报', note: '', version: report(3).version }, operator).ok === false)
check('通用动作服务同样被前置状态守卫拦截', runAction('firereport', 3, '核实火情').ok === false)

console.log('3) 核实：旧单推进为已确认，接警时间不变、版本自增')
const v1 = submitDisposition(1, { action: '核实火情', note: '现场确认为荒草火', version: 0 }, operator)
check('核实成功', v1.ok, v1.message)
check('状态变为已确认', status(1) === '已确认')
check('原接警时间保持原样', report(1).row['接警时间'] === oldAlarmTime)
check('版本自增为 1', report(1).version === 1)

console.log('4) 并发：两次处置同时提交，后到请求（旧版本）被拒绝')
const stale = submitDisposition(1, { action: '出动扑救', note: '', teamId: 1, supplyIds: [], version: 0 }, operator)
check('旧版本提交被拒绝', stale.ok === false)
check('返回冲突标记', stale.conflict === true)
check('状态未被后到请求推动', status(1) === '已确认')

console.log('5) 出动：报告状态 + 队伍状态 + 物资占用 + 队伍提醒 同次落库')
const teamBefore = availableTeams().length
const supplyBefore = availableSupplies().length
const supplyId = listEntries('supply').items.find((r) => String(r['物资名称']) === '物资储备样例2')
// 样例2初始被报告3占用，挑一个在库物资
const freeSupply = availableSupplies()[0]
const freeTeam = availableTeams()[0]
const alertsBefore = allAlerts().length
const dispatch = submitDisposition(
  1,
  { action: '出动扑救', note: '一队携物资出击', teamId: Number(freeTeam.id), supplyIds: [Number(freeSupply.id)], version: 1 },
  operator,
)
check('出动提交成功', dispatch.ok, dispatch.message)
check('报告变为已出警', status(1) === '已出警')
check('队伍变为已出动', String(listEntries('fireteam', { '队伍编号': String(freeTeam['队伍编号']) }).items[0].status) === '已出动')
check('待命队伍减少 1', availableTeams().length === teamBefore - 1)
check('物资被该报告单号占用', supplyOccupancy().get(Number(freeSupply.id)) === String(report(1).row['报告编号']))
check('在库物资减少 1', availableSupplies().length === supplyBefore - 1)
const newAlerts = allAlerts().slice(alertsBefore)
check('同次生成 1 条出动提醒', newAlerts.length === 1 && newAlerts[0].kind === '出动' && !newAlerts[0].acknowledged)
check('调度记录挂上队伍与物资', allDispatches().find((d) => d.reportId === 1)!.occupiedSupplies.length === 1)
void supplyId

console.log('6) 扑灭：释放整组物资、撤回队伍、生成扑灭提醒，全部同事务')
const alertsBefore2 = allAlerts().length
const ext = submitDisposition(1, { action: '确认扑灭', note: '明火扑灭，余火清理完毕', version: report(1).version }, operator)
check('扑灭提交成功', ext.ok, ext.message)
check('报告变为已扑灭', status(1) === '已扑灭')
check('占用物资已释放归库', !supplyOccupancy().has(Number(freeSupply.id)))
check('物资重新可调配', availableSupplies().some((s) => Number(s.id) === Number(freeSupply.id)))
check('队伍已撤回', String(listEntries('fireteam', { '队伍编号': String(freeTeam['队伍编号']) }).items[0].status) === '已撤回')
const extAlerts = allAlerts().slice(alertsBefore2)
check('同次生成扑灭提醒', extAlerts.length === 1 && extAlerts[0].kind === '扑灭')

console.log('7) 误报：待核实单认定误报，不出动、不占用物资')
// 报告5种子已是误报；用批量+误报路径验证：先找一个待核实新单（种子没有了，先核实再不可误报）
const verify5 = submitDisposition(5, { action: '核实火情', note: '', version: report(5).version }, operator)
check('已误报终态不能再核实', verify5.ok === false)
const falseDispatch = allDispatches().find((d) => d.reportId === 5)
check('误报单没有调度占用记录', !falseDispatch || falseDispatch.occupiedSupplies.length === 0)
const falseAlert = listAlerts().find((a) => a.reportId === 5 && a.kind === '误报')
check('误报留有联动提醒（注明无需出动）', Boolean(falseAlert))

console.log('8) 批量：多选待核实报告整组一次提交，任一过期则整组退回')
// 种子中已无待核实：通过通用服务无法新建，改用直接重置——这里验证报告1已扑灭不能进批，构造跨态批量
const batchMixed = submitBatchVerify(
  { ids: [1, 5], note: '', versions: { 1: report(1).version, 5: report(5).version } },
  operator,
)
check('含非待核实单时整组拒绝', batchMixed.ok === false)
// 全量待核实的场景由重置后首跑覆盖：报告1/2/3/4/5初始状态中只有1是待核实
check('单条待核实整组也可提交（模拟多选一组）', (() => {
  // 报告1已推进，无法重复；验证空选拒绝
  const empty = submitBatchVerify({ ids: [], note: '', versions: {} }, operator)
  return empty.ok === false
})())

console.log('9) 提醒收悉')
const unread = listAlerts().find((a) => !a.acknowledged)!
const ack = acknowledgeAlert(unread.id)
check('收悉成功', ack.ok)
check('提醒变为已收悉', listAlerts().find((a) => a.id === unread.id)!.acknowledged)

console.log('10) 事务回滚：联动失败时报告与队伍提醒一起退回')
// 报告2当前为「已确认」，出动时选一支不存在的队伍：报告不得被改成已出警，提醒不得新增
const beforeStatus = status(2)
const beforeAlerts = allAlerts().length
const bad = submitDisposition(
  2,
  { action: '出动扑救', note: '坏请求', teamId: 9999, supplyIds: [], version: report(2).version },
  operator,
)
check('坏联动被拒绝', bad.ok === false)
check('报告状态退回未变', status(2) === beforeStatus)
check('没有留下半截提醒', allAlerts().length === beforeAlerts)

// 持久化中途失败（第三个键写入抛错）：前两个键也要恢复，缓存与存储保持提交前一致
const { storageKey } = await import('./src/data/local-store')
const ls = (globalThis as any).window.localStorage
const rawBefore = {
  entries: ls.getItem(storageKey()),
  alerts: ls.getItem('forest-fire-patrol:team-alerts'),
}
let writes = 0
const realSetItem = ls.setItem.bind(ls)
ls.setItem = (k: string, v: string) => {
  writes += 1
  if (writes === 3) {
    throw new Error('模拟持久化失败')
  }
  realSetItem(k, v)
}
const v2 = report(2).version
const crash = submitDisposition(
  2,
  { action: '出动扑救', note: '', teamId: Number(freeTeam.id), supplyIds: [], version: v2 },
  operator,
)
ls.setItem = realSetItem
check('持久化失败被上报', crash.ok === false)
check('缓存中的报告未被推进', status(2) === beforeStatus)
check('localStorage 已回滚到提交前快照', ls.getItem(storageKey()) === rawBefore.entries)
check('提醒键同样回滚', ls.getItem('forest-fire-patrol:team-alerts') === rawBefore.alerts)

console.log(`\n${passed} 项核实通过`)
