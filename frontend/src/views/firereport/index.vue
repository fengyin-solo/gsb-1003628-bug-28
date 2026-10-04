<template>
  <section class="page" data-module="firereport">
    <header class="page-head">
      <div>
        <h2>火情报告管理</h2>
        <p class="page-desc">报告归集到队伍的处置链路：待核实 → 已确认 → 已出警 → 已扑灭；核实环节可认定误报，误报不出动、不占物资。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="selectedIds.size === 0" @click="openBatch">
          批量核实（{{ selectedIds.size }}）
        </button>
        <button class="btn" type="button" @click="exportRows">导出火情报告清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allPendingChecked"
              :disabled="pendingRows.length === 0"
              @change="toggleAllPending"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>处置</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input
              v-if="String(row.status) === '待核实'"
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              @change="toggleOne(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="['status-tag', statusClass(row.status)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row, '核实火情')" v-if="String(row.status) === '待核实'">核实火情</button>
            <button class="link" type="button" @click="openDetail(row, '确认误报')" v-if="String(row.status) === '待核实'">确认误报</button>
            <button class="link" type="button" @click="openDetail(row, '出动扑救')" v-if="String(row.status) === '已确认'">出动扑救</button>
            <button class="link" type="button" @click="openDetail(row, '确认扑灭')" v-if="String(row.status) === '已出警'">确认扑灭</button>
            <button class="link muted-link" type="button" @click="openDetail(row)">查看详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无火情报告数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火情报告记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 处置详情：v-if 每次打开都重新挂载，结论表单不会残留上一次处置的内容 -->
    <div v-if="detail.open" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>火情报告处置 · {{ detail.snapshot?.row['报告编号'] }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>

        <div v-if="detail.snapshot" class="modal-body">
          <dl class="snapshot-grid">
            <div><dt>起火地点</dt><dd>{{ detail.snapshot.row['起火地点'] }}</dd></div>
            <div><dt>原接警时间</dt><dd>{{ detail.snapshot.row['接警时间'] }}（保持不变）</dd></div>
            <div><dt>起火时间</dt><dd>{{ detail.snapshot.row['起火时间'] }}</dd></div>
            <div>
              <dt>火势等级</dt>
              <dd>
                {{ detail.snapshot.row['火势等级'] }}
                <span v-if="detail.snapshot.row['火势等级来源'] === '接警记录补录'" class="tag tag-warn">
                  旧单缺等级，按接警记录补录
                </span>
              </dd>
            </div>
            <div><dt>报告人</dt><dd>{{ detail.snapshot.row['报告人'] }}</dd></div>
            <div><dt>当前状态</dt><dd>{{ detail.snapshot.row.status }}</dd></div>
          </dl>

          <form v-if="detail.action" class="dispose-form" @submit.prevent="submitDetail">
            <template v-if="detail.action === '出动扑救'">
              <label class="form-item">
                <span>出动队伍（仅列出在营待命）</span>
                <select v-model="detail.form.teamId" required>
                  <option value="" disabled>请选择扑火队伍</option>
                  <option v-for="team in teams" :key="Number(team.id)" :value="Number(team.id)">
                    {{ team['队伍名称'] }}（{{ team['队伍编号'] }}）
                  </option>
                </select>
              </label>
              <fieldset class="form-item">
                <legend>随队物资（多选，出动即占用）</legend>
                <label v-for="supply in supplies" :key="Number(supply.id)" class="check-inline">
                  <input type="checkbox" :value="Number(supply.id)" v-model="detail.form.supplyIds" />
                  {{ supply['物资名称'] }}
                </label>
                <p v-if="supplies.length === 0" class="form-hint">暂无可调配物资（均已被其他火情占用）</p>
              </fieldset>
            </template>

            <label class="form-item">
              <span>{{ detail.action }}结论</span>
              <textarea v-model="detail.form.note" rows="3" :placeholder="notePlaceholder"></textarea>
            </label>

            <p v-if="detail.error" class="error-text">{{ detail.error }}</p>
            <div class="modal-actions">
              <button class="btn ghost" type="button" @click="closeDetail">取消</button>
              <button class="btn primary" type="submit" :disabled="detail.submitting">
                {{ detail.submitting ? '提交中…' : `提交${detail.action}` }}
              </button>
            </div>
            <p class="form-hint">报告状态与队伍提醒同次落库，任一联动失败整组退回。</p>
          </form>

          <div v-else class="timeline">
            <h4>处置时间线</h4>
            <ol v-if="detail.snapshot.dispatch && detail.snapshot.dispatch.timeline.length">
              <li v-for="(item, index) in detail.snapshot.dispatch.timeline" :key="index">
                <span class="timeline-at">{{ item.at }}</span>
                <strong>{{ item.action }}</strong>
                <span class="timeline-note">{{ item.note || '—' }}</span>
                <span class="timeline-by">{{ item.operator }}</span>
              </li>
            </ol>
            <p v-else class="form-hint">暂无处置记录。</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 批量核实：多选待核实报告，整组一次提交 -->
    <div v-if="batch.open" class="modal-mask" @click.self="closeBatch">
      <div class="modal modal-sm">
        <header class="modal-head">
          <h3>批量核实（{{ batch.ids.length }} 条）</h3>
          <button class="link" type="button" @click="closeBatch">关闭</button>
        </header>
        <form class="modal-body" @submit.prevent="submitBatch">
          <p class="form-hint">所选报告将整组推进为「已确认」；其中任意一条已被他人处置，整组退回。</p>
          <label class="form-item">
            <span>批量核实结论</span>
            <textarea v-model="batch.note" rows="3" placeholder="适用于整组的统一核实结论（可留空）"></textarea>
          </label>
          <p v-if="batch.error" class="error-text">{{ batch.error }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeBatch">取消</button>
            <button class="btn primary" type="submit" :disabled="batch.submitting">
              {{ batch.submitting ? '提交中…' : '整组一次提交' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  availableSupplies,
  availableTeams,
  getReportSnapshot,
  submitBatchVerify,
  submitDisposition,
  type ReportSnapshot,
} from '@/api/fire-command'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firereport')
const columns = ['报告编号', '起火地点', '起火时间', '接警时间', '火势等级', '过火面积', '扑救情况', '报告人']
const statuses = ['待核实', '已确认', '已出警', '已扑灭', '误报']

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 2)
const selectedIds = ref<Set<number>>(new Set())

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    {
      label: '今日报告数',
      value: rows.value.filter((row) => String(row['接警时间'] ?? '').startsWith(today)).length,
    },
    {
      label: '已确认火情',
      value: rows.value.filter((row) =>
        ['已确认', '已出警', '已扑灭'].includes(String(row.status)),
      ).length,
    },
    { label: '扑救中火情', value: rows.value.filter((row) => String(row.status) === '已出警').length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const pendingRows = computed(() => rows.value.filter((row) => String(row.status) === '待核实'))
const allPendingChecked = computed(
  () => pendingRows.value.length > 0 && pendingRows.value.every((row) => selectedIds.value.has(Number(row.id))),
)

function flash(text: string, ok = false) {
  message.value = text
  messageOk.value = ok
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function toggleOne(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

function toggleAllPending(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? new Set(pendingRows.value.map((row) => Number(row.id))) : new Set()
}

// —— 处置详情（每次打开基于库内快照重新构建，避免旧进度/旧结论残留） ——

const detail = reactive<{
  open: boolean
  action: string
  snapshot?: ReportSnapshot
  form: { note: string; teamId: number | ''; supplyIds: number[] }
  error: string
  submitting: boolean
}>({
  open: false,
  action: '',
  snapshot: undefined,
  form: { note: '', teamId: '', supplyIds: [] },
  error: '',
  submitting: false,
})

const teams = ref<EntryRow[]>([])
const supplies = ref<EntryRow[]>([])

const notePlaceholder = computed(() => {
  switch (detail.action) {
    case '核实火情':
      return '记录现场核实结论、火势与过火情况'
    case '出动扑救':
      return '记录出动编成、路线与要求'
    case '确认扑灭':
      return '记录扑灭时间、余火清理与移交情况'
    case '确认误报':
      return '记录误报原因'
    default:
      return ''
  }
})

function openDetail(row: EntryRow, action = '') {
  const snapshot = getReportSnapshot(Number(row.id))
  if (!snapshot) {
    flash('该报告已不存在，请刷新列表', false)
    reload()
    return
  }
  detail.open = true
  detail.action = action
  detail.snapshot = snapshot
  // 新快照 → 新表单，不复用任何上一次处置的结论。
  detail.form = { note: '', teamId: '', supplyIds: [] }
  detail.error = ''
  detail.submitting = false
  if (action === '出动扑救') {
    teams.value = availableTeams()
    supplies.value = availableSupplies()
  }
}

function closeDetail() {
  detail.open = false
  detail.snapshot = undefined
  detail.action = ''
}

function submitDetail() {
  if (!detail.snapshot || !detail.action) {
    return
  }
  detail.submitting = true
  detail.error = ''
  const result = submitDisposition(
    Number(detail.snapshot.row.id),
    {
      action: detail.action,
      note: detail.form.note,
      teamId: detail.form.teamId === '' ? undefined : Number(detail.form.teamId),
      supplyIds: detail.form.supplyIds,
      version: detail.snapshot.version,
    },
    session.operator,
  )
  detail.submitting = false
  if (!result.ok) {
    detail.error = result.message
    // 并发的后到请求：关闭详情、返回列表，以列表最新进度为准重新进入。
    if (result.conflict) {
      closeDetail()
      flash(result.message, false)
      reload()
    }
    return
  }
  closeDetail()
  flash(result.message, true)
  reload()
}

// —— 批量核实 ——

const batch = reactive<{
  open: boolean
  ids: number[]
  note: string
  error: string
  submitting: boolean
}>({ open: false, ids: [], note: '', error: '', submitting: false })

function openBatch() {
  batch.open = true
  batch.ids = [...selectedIds.value]
  batch.note = ''
  batch.error = ''
  batch.submitting = false
}

function closeBatch() {
  batch.open = false
}

function submitBatch() {
  // 提交前再次从列表快照取版本基线：勾选后若进度已变化，整组会被拒绝。
  const versions: Record<number, number> = {}
  for (const id of batch.ids) {
    const snapshot = getReportSnapshot(id)
    if (!snapshot) {
      batch.error = `编号 ${id} 的报告已不存在，请刷新列表`
      return
    }
    versions[id] = snapshot.version
  }
  batch.submitting = true
  batch.error = ''
  const result = submitBatchVerify(
    { ids: batch.ids, note: batch.note, versions },
    session.operator,
  )
  batch.submitting = false
  if (!result.ok) {
    batch.error = result.message
    if (result.conflict) {
      closeBatch()
      selectedIds.value = new Set()
      flash(result.message, false)
      reload()
    }
    return
  }
  closeBatch()
  selectedIds.value = new Set()
  flash(result.message, true)
  reload()
}

function statusClass(status: string | number) {
  return {
    待核实: 'st-received',
    已确认: 'st-verified',
    已出警: 'st-dispatched',
    已扑灭: 'st-done',
    误报: 'st-false',
  }[String(status)] ?? ''
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 清掉已不在列表或已推进的勾选项，避免把旧进度带入批量提交。
    const live = new Set(
      rows.value.filter((row) => String(row.status) === '待核实').map((row) => Number(row.id)),
    )
    selectedIds.value = new Set([...selectedIds.value].filter((id) => live.has(id)))
  } catch (error) {
    flash(error instanceof Error ? error.message : '火情报告列表读取失败', false)
  }
}

onMounted(reload)
</script>
