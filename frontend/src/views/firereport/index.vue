<template>
  <section class="page" data-module="firereport">
    <header class="page-head">
      <div>
        <h2>火情报告管理</h2>
        <p class="page-desc">接警归集后按「核实 → 出动 → 扑灭」顺序处置；出动同步向扑火队伍下达提醒并占用物资，误报释放占用。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出火情报告清单</button>
      </div>
    </header>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 批量多选：勾选后整组一次提交，全有或全无 -->
    <div class="batch-bar" v-if="selectableItems.length">
      <label class="batch-check">
        <input type="checkbox" :checked="allSelected" @change="toggleAll" />
        全选当前结果（已选 {{ selectedIds.size }} 条）
      </label>
      <button
        v-for="action in batchActions"
        :key="action"
        class="btn"
        type="button"
        :disabled="!canBatch(action)"
        @click="batchSubmit(action)"
      >
        整组{{ action }}
      </button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th style="width: 36px">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>最新进度</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="String(item.row.id)">
          <td>
            <input
              type="checkbox"
              :value="Number(item.row.id)"
              v-model="selection"
              :disabled="!availableFireActions(String(item.row.status)).length"
            />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '火势等级'">
              {{ item.level }}
              <span v-if="!String(item.row['火势等级'] ?? '').trim()" class="compat-tag" title="旧单缺火势等级，按接警记录兼容">兼容</span>
            </template>
            <template v-else>{{ item.row[column] ?? '—' }}</template>
          </td>
          <td><span :class="['status-pill', statusClass(String(item.row.status))]">{{ item.row.status }}</span></td>
          <td>{{ item.lastStage }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(item.row)">处置详情</button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的火情报告</td>
        </tr>
      </tbody>
    </table>

    <!-- 出动扑救整组提交：统一调派队伍、统一携带物资 -->
    <div v-if="batchAction === '出动扑救'" class="modal-mask" @click.self="closeBatch">
      <div class="modal">
        <h3>整组出动扑救（{{ selectedIds.size }} 条）</h3>
        <p class="modal-hint">整组调派同一支队伍；报告与队伍提醒、物资占用同次落库，任一失败整组退回。</p>
        <label class="form-item">
          <span>调派队伍 *</span>
          <select v-model="batchTeam">
            <option value="" disabled>请选择扑火队伍</option>
            <option v-for="team in teams" :key="team.id" :value="team.name">
              {{ team.name }}（{{ team.status }}）
            </option>
          </select>
        </label>
        <div class="form-item">
          <span>携带物资（每单各携带一份，合计＝数量 × {{ selectedIds.size }} 单；任一份不足整组拒绝）</span>
          <table class="mini-table">
            <thead><tr><th>物资</th><th>可用</th><th>每单数量</th></tr></thead>
            <tbody>
              <tr v-for="supply in supplies" :key="supply.id">
                <td>{{ supply.name }}</td>
                <td>{{ supply.available }}</td>
                <td><input v-model.number="batchSupplyQty[supply.id]" type="number" min="0" class="qty-input" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <label class="form-item">
          <span>出动说明（本次结论）</span>
          <input v-model="batchNote" placeholder="如：沿三号沟左翼推进" />
        </label>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeBatch">取消</button>
          <button class="btn primary" type="button" @click="confirmBatch">确认整组出动</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条火情报告记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  availableFireActions,
  downloadEntries,
  listFireReports,
  moduleMeta,
  selectableSupplies,
  selectableTeams,
  submitBatchDisposition,
} from '@/api/local-service'
import type { ReportListView } from '@/api/local-service'
import type { EntryRow, FireAction } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('firereport')
const columns = ['报告编号', '起火地点', '接警时间', '起火时间', '火势等级', '过火面积', '报告人']
const statuses = ['待核实', '已确认', '已出警', '已扑灭', '误报']
const batchActions: FireAction[] = ['核实火情', '出动扑救', '确认扑灭', '确认误报']

const items = ref<ReportListView[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['报告编号', '起火地点', '火势等级']

const selection = ref<number[]>([])
const selectedIds = computed(() => new Set(selection.value))
const selectableItems = computed(() =>
  items.value.filter((item) => availableFireActions(String(item.row.status)).length > 0),
)
const allSelected = computed(
  () => selectableItems.value.length > 0 && selectableItems.value.every((item) => selectedIds.value.has(Number(item.row.id))),
)

const teams = ref<{ id: number; name: string; status: string }[]>([])
const supplies = ref<{ id: number; name: string; available: number }[]>([])
const batchAction = ref<FireAction | ''>('')
const batchTeam = ref('')
const batchNote = ref('')
const batchSupplyQty = ref<Record<number, number>>({})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: items.value.filter((item) => String(item.row.status) === status).length,
  })),
)

function statusClass(status: string): string {
  if (status === '已扑灭') return 'st-done'
  if (status === '误报') return 'st-false'
  if (status === '已出警') return 'st-out'
  return 'st-wait'
}

/** 批量动作要求：勾选的报告必须全部处于该动作要求的同一前置态，否则按钮禁用。 */
function canBatch(action: FireAction): boolean {
  if (selection.value.length === 0) return false
  const prior: Record<string, string> = {
    核实火情: '待核实',
    出动扑救: '已确认',
    确认扑灭: '已出警',
  }
  return selection.value.every((id) => {
    const item = items.value.find((it) => Number(it.row.id) === id)
    if (!item) return false
    const status = String(item.row.status)
    if (action === '确认误报') return ['待核实', '已确认', '已出警'].includes(status)
    return status === prior[action]
  })
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selection.value = checked ? selectableItems.value.map((item) => Number(item.row.id)) : []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDetail(row: EntryRow) {
  router.push({ name: 'firereport-detail', params: { id: String(row.id) } })
}

function batchSubmit(action: FireAction) {
  errorMessage.value = ''
  okMessage.value = ''
  if (!canBatch(action)) {
    errorMessage.value = '所选报告状态不一致，不能跨环节整组提交'
    return
  }
  if (action === '出动扑救') {
    batchAction.value = action
    batchTeam.value = ''
    batchNote.value = ''
    batchSupplyQty.value = {}
    // 现取最新可选队伍与可用库存，避免用旧额度占用。
    teams.value = selectableTeams()
    supplies.value = selectableSupplies()
    return
  }
  dispatchBatch(action)
}

function dispatchBatch(action: FireAction) {
  const result = submitBatchDisposition({
    reportIds: [...selection.value],
    action,
    note: batchNote.value,
    expectedVersion: commonVersion(),
  })
  finishBatch(result)
}

function confirmBatch() {
  if (!batchTeam.value.trim()) {
    errorMessage.value = '请选择调派队伍'
    return
  }
  const chosen = Object.entries(batchSupplyQty.value)
    .map(([id, qty]) => ({ supplyId: Number(id), qty: Number(qty) || 0 }))
    .filter((item) => item.qty > 0)
  const count = selection.value.length
  // 与核心口径一致：每单各带 qty，第 n 单要在前 n-1 单冻结后仍够用，
  // 等价于 qty × 单数 ≤ 当前可用库存。
  const insufficient = chosen.find((item) => {
    const supply = supplies.value.find((s) => s.id === item.supplyId)
    return supply ? item.qty * count > supply.available : true
  })
  if (insufficient) {
    errorMessage.value = `携带数量 × ${count} 单超过可用库存，整组未提交`
    return
  }
  const result = submitBatchDisposition({
    reportIds: [...selection.value],
    action: '出动扑救',
    team: batchTeam.value,
    supplies: chosen,
    note: batchNote.value,
    expectedVersion: commonVersion(),
  })
  finishBatch(result)
}

/** 整组共享一个乐观锁版本：批量列表来自同一读取，版本一致才允许整组提交。 */
function commonVersion(): number {
  const versions = selection.value.map((id) => {
    const item = items.value.find((it) => Number(it.row.id) === id)
    return item ? Number(item.row['版本'] ?? 0) : NaN
  })
  return versions.length ? versions[0] : 0
}

function finishBatch(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  batchAction.value = ''
  selection.value = []
  reload()
}

function closeBatch() {
  batchAction.value = ''
  errorMessage.value = ''
}

function reload() {
  errorMessage.value = ''
  okMessage.value = ''
  try {
    const payload = listFireReports(filters.value)
    items.value = payload.items
    total.value = payload.total
    selection.value = selection.value.filter((id) =>
      payload.items.some((item) => Number(item.row.id) === id),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火情报告列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.batch-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.batch-check { font-size: 13px; display: flex; align-items: center; gap: 6px; margin-right: 8px; }
.batch-bar .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.compat-tag { font-size: 11px; color: #92400e; background: #fef3c7; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.st-wait { background: #eef2f7; color: #475569; }
.st-out { background: #fef3c7; color: #92400e; }
.st-done { background: #dcfce7; color: #166534; }
.st-false { background: #fee2e2; color: #991b1b; }
.ok-text { color: #166534; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: 560px; max-width: 92vw; max-height: 88vh; overflow: auto; }
.modal h3 { margin: 0 0 6px; }
.modal-hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.form-item { display: block; margin-bottom: 12px; font-size: 13px; }
.form-item > span { display: block; color: var(--muted); margin-bottom: 4px; }
.form-item input, .form-item select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.mini-table { width: 100%; }
.mini-table th, .mini-table td { padding: 4px 6px; font-size: 12px; }
.qty-input { width: 80px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
