<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">队伍与火情报告联动：出动时随报告同次收到提醒，扑灭后撤回、休整；提醒与报告结论一起落库。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="alert-panel">
      <header class="alert-head">
        <h3>队伍联动提醒</h3>
        <span class="form-hint">与火情报告同次落库；共 {{ alerts.length }} 条，待收悉 {{ pendingAlerts.length }} 条</span>
      </header>
      <ul v-if="alerts.length" class="alert-list">
        <li v-for="alert in alerts" :key="alert.id" :class="{ 'is-unread': !alert.acknowledged }">
          <span :class="['tag', alertKindClass(alert.kind)]">{{ alert.kind }}</span>
          <div class="alert-main">
            <p>{{ alert.content }}</p>
            <span class="alert-meta">
              报告 {{ alert.reportCode }} · {{ alert.teamName === '—' ? '无需出动' : alert.teamName }} · {{ alert.createdAt }}
            </span>
          </div>
          <button v-if="!alert.acknowledged" class="btn" type="button" @click="ack(alert.id)">收悉</button>
          <span v-else class="tag tag-done">已收悉</span>
        </li>
      </ul>
      <p v-else class="form-hint">暂无联动提醒。</p>
    </section>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td><span :class="['status-tag', teamStatusClass(row.status)]">{{ row.status }}</span></td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row.status)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="availableActions(row.status).length === 0" class="form-hint">终态，需先撤回/休整</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无扑火队伍数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="message" class="error-text">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { acknowledgeAlert, listAlerts } from '@/api/fire-command'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, TeamAlert } from '@/data/types'

const meta = moduleMeta('fireteam')
const columns = ['队伍编号', '队伍名称', '所属林场', '队长姓名', '队员人数', '集结半径', '值班状态', '出动状态']
const statuses = ['在营待命', '已出动', '扑救中', '已撤回', '休整中']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['队伍编号', '队伍名称', '所属林场']
const alerts = ref<TeamAlert[]>([])

// 状态机：只有命中当前状态的动作才展示，旧进度不会被重复推进。
const ACTION_BY_STATUS: Record<string, string[]> = {
  在营待命: ['下达出动'],
  已出动: ['撤回队伍'],
  扑救中: ['撤回队伍'],
  已撤回: ['转入休整'],
  休整中: [],
}

function availableActions(status: string | number): string[] {
  return ACTION_BY_STATUS[String(status)] ?? []
}

const stats = computed(() => [
  { label: '队伍总数', value: rows.value.length },
  { label: '待命队伍', value: rows.value.filter((row) => String(row.status) === '在营待命').length },
  {
    label: '出动队伍',
    value: rows.value.filter((row) => ['已出动', '扑救中'].includes(String(row.status))).length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const pendingAlerts = computed(() => alerts.value.filter((alert) => !alert.acknowledged))

function alertKindClass(kind: string) {
  return { 出动: 'tag-out', 扑灭: 'tag-done', 误报: 'tag-false' }[kind] ?? ''
}

function teamStatusClass(status: string | number) {
  return {
    在营待命: 'st-verified',
    已出动: 'st-dispatched',
    扑救中: 'st-dispatched',
    已撤回: 'st-done',
    休整中: 'st-false',
  }[String(status)] ?? ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    message.value = result.message
    return
  }
  reload()
}

function ack(id: number) {
  const result = acknowledgeAlert(id)
  message.value = result.ok ? '' : result.message
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    alerts.value = listAlerts()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(reload)
</script>
