<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">维护扑火队伍，围绕队伍编号、队伍名称、所属林场、队长姓名做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
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

    <section class="alert-panel">
      <header class="alert-head">
        <h3>队伍出动提醒</h3>
        <button class="btn ghost" type="button" @click="reload">刷新提醒</button>
      </header>
      <p v-if="!alerts.length" class="muted-line">暂无出动提醒；火情报告「出动扑救」提交后会与报告同次落库到这里。</p>
      <table v-else class="data-table alert-table">
        <thead>
          <tr><th>提醒时间</th><th>报告编号</th><th>起火地点</th><th>火势等级</th><th>调派队伍</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="alert in alerts" :key="alert.id" :class="{ revoked: alert.状态 === '已撤销' }">
            <td>{{ alert.提醒时间 }}</td>
            <td>{{ alert.报告编号 }}</td>
            <td>{{ alert.起火地点 }}</td>
            <td>{{ alert.火势等级 }}</td>
            <td>{{ alert.队伍 }}</td>
            <td>
              <span :class="['alert-state', alert.状态 === '待处理' ? 'state-wait' : 'state-revoked']">{{ alert.状态 }}</span>
              <span v-if="alert.状态 === '已撤销'" class="revoke-note">报告判为误报，同次撤销</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listAlerts,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, TeamAlert } from '@/data/types'

const meta = moduleMeta('fireteam')
const columns = ["队伍编号", "队伍名称", "所属林场", "队长姓名", "队员人数", "集结半径", "值班状态", "出动状态"]
const actions = ["下达出动", "转入休整", "撤回队伍"]
const statuses = ["在营待命", "已出动", "扑救中", "已撤回", "休整中"]
const stats = [{"label": "队伍总数", "value": 0}, {"label": "待命队伍", "value": 0}, {"label": "出动队伍", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const alerts = ref<TeamAlert[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '扑火队伍登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 最新提醒在前；撤销的保留留痕，便于核对「同次落库、误报同次撤销」。
    alerts.value = [...listAlerts()].sort((a, b) => b.id - a.id)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.alert-panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px 14px; margin-bottom: 12px; }
.alert-head { display: flex; justify-content: space-between; align-items: center; }
.alert-head h3 { margin: 0; font-size: 14px; }
.muted-line { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.alert-table { margin-top: 8px; }
.alert-table tr.revoked { background: #f8fafc; color: var(--muted); }
.alert-state { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.state-wait { background: #fef3c7; color: #92400e; }
.state-revoked { background: #e2e8f0; color: #64748b; }
.revoke-note { font-size: 11px; color: var(--muted); margin-left: 6px; }
</style>
