<template>
  <section class="page detail-page" data-module="firereport-detail">
    <header class="page-head">
      <div>
        <h2>
          <button class="btn ghost back-btn" type="button" @click="backToList">← 返回列表</button>
          火情处置详情
        </h2>
        <p class="page-desc">核实、出动、扑灭只能顺序推进；每次进入都重新加载最新结果。</p>
      </div>
    </header>

    <div v-if="!detail" class="empty-state">没有找到这条火情报告，<button class="link" type="button" @click="backToList">返回列表</button></div>

    <template v-else>
      <div class="detail-grid">
        <article class="info-card">
          <h3>报告信息</h3>
          <dl>
            <dt>报告编号</dt><dd>{{ detail.row['报告编号'] }}</dd>
            <dt>起火地点</dt><dd>{{ detail.row['起火地点'] }}</dd>
            <dt>当前状态</dt><dd><span :class="['status-pill', statusClass(String(detail.row.status))]">{{ detail.row.status }}</span></dd>
            <dt>火势等级</dt>
            <dd>
              {{ detail.level }}
              <span v-if="detail.levelInferred" class="compat-tag" title="旧单缺火势等级，按接警记录兼容">缺等级·按接警记录兼容</span>
            </dd>
            <dt>过火面积</dt><dd>{{ detail.row['过火面积'] }}</dd>
            <dt>报告人</dt><dd>{{ detail.row['报告人'] }}</dd>
            <dt>起火时间</dt><dd>{{ detail.row['起火时间'] }}</dd>
            <dt>原接警时间</dt>
            <dd class="readonly-field">
              {{ detail.intakeTime }}
              <span class="lock-hint">（原始记录，处置过程保持原样不可改）</span>
            </dd>
            <dt>接警初判</dt><dd>{{ detail.row['接警初判'] }}</dd>
          </dl>
        </article>

        <article class="info-card">
          <h3>处置进度（{{ detail.progress.length }} 个节点）</h3>
          <ol class="timeline">
            <li v-for="(node, idx) in detail.progress" :key="idx" class="timeline-item">
              <div class="timeline-head">
                <strong>{{ node.stage }}</strong>
                <span class="timeline-time">{{ node.at }}</span>
                <span class="timeline-source">{{ node.source }}</span>
              </div>
              <p class="timeline-note">{{ node.note }}</p>
            </li>
          </ol>

          <h3>队伍提醒与物资占用</h3>
          <p v-if="!detail.alerts.length && !detail.occupancy.length" class="muted">尚未出动，暂无队伍提醒与物资占用。</p>
          <ul v-else class="link-list">
            <li v-for="alert in detail.alerts" :key="'a' + alert.id">
              队伍提醒：{{ alert.队伍 }} · {{ alert.火势等级 }} · {{ alert.提醒时间 }} ·
              <span :class="alert.状态 === '待处理' ? 'tag-warn' : 'tag-muted'">{{ alert.状态 }}</span>
            </li>
            <li v-for="occ in detail.occupancy" :key="'o' + occ.id">
              物资占用：{{ occ.物资名称 }} × {{ occ.数量 }} · {{ occ.占用时间 }} ·
              <span :class="occ.状态 === '占用中' ? 'tag-warn' : 'tag-done'">{{ occ.状态 }}</span>
            </li>
          </ul>
        </article>
      </div>

      <article class="info-card action-card">
        <h3>提交处置</h3>
        <div v-if="!detail.actions.length" class="muted">
          本报告已处于终态「{{ detail.row.status }}」，处置链路结束。
        </div>
        <template v-else>
          <div class="action-buttons">
            <button
              v-for="action in detail.actions"
              :key="action"
              class="btn"
              :class="{ primary: action !== '确认误报' }"
              type="button"
              @click="choose(action)"
            >
              {{ action }}
            </button>
          </div>

          <div v-if="form.action" class="disposition-form">
            <p class="form-hint">
              当前动作：<strong>{{ form.action }}</strong>
              <span v-if="form.action === '确认误报'" class="false-hint">（误报将释放占用物资并撤销未处理的队伍提醒）</span>
            </p>

            <label v-if="form.action === '出动扑救'" class="form-item">
              <span>调派队伍 *</span>
              <select v-model="form.team">
                <option value="" disabled>请选择扑火队伍</option>
                <option v-for="team in teams" :key="team.id" :value="team.name">{{ team.name }}（{{ team.status }}）</option>
              </select>
            </label>

            <div v-if="form.action === '出动扑救'" class="form-item">
              <span>携带物资</span>
              <table class="mini-table">
                <thead><tr><th>物资</th><th>可用库存</th><th>数量</th></tr></thead>
                <tbody>
                  <tr v-for="supply in supplies" :key="supply.id">
                    <td>{{ supply.name }}</td>
                    <td>{{ supply.available }}</td>
                    <td><input v-model.number="form.supplyQty[supply.id]" type="number" min="0" class="qty-input" /></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <label class="form-item">
              <span>本次处置结论（仅写入本次节点）</span>
              <textarea v-model="form.note" rows="2" placeholder="请填写本次处置结论；上次结论不会带到这里"></textarea>
            </label>

            <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
            <div class="form-buttons">
              <button class="btn ghost" type="button" @click="resetForm">清空</button>
              <button class="btn primary" type="button" :disabled="submitting" @click="submit">
                {{ submitting ? '提交中…' : '提交本次处置' }}
              </button>
            </div>
          </div>
        </template>
      </article>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'

import {
  getFireReport,
  selectableSupplies,
  selectableTeams,
  submitDisposition,
} from '@/api/local-service'
import type { FireAction } from '@/data/types'

type DetailView = NonNullable<Awaited<ReturnType<typeof getFireReport>>>

const route = useRoute()
const router = useRouter()

const detail = ref<DetailView | null>(null)
const teams = ref<ReturnType<typeof selectableTeams>>([])
const supplies = ref<ReturnType<typeof selectableSupplies>>([])
const errorMessage = ref('')
const submitting = ref(false)

// 表单每次进入详情都重建一份全新对象，从根上避免残留上一条报告的结论。
function emptyForm() {
  return { action: '' as FireAction | '', team: '', note: '', supplyQty: {} as Record<number, number> }
}
const form = reactive(emptyForm())

function statusClass(status: string): string {
  if (status === '已扑灭') return 'st-done'
  if (status === '误报') return 'st-false'
  if (status === '已出警') return 'st-out'
  return 'st-wait'
}

function load(id: number) {
  detail.value = getFireReport(id)
  teams.value = selectableTeams()
  supplies.value = selectableSupplies()
  Object.assign(form, emptyForm())
  errorMessage.value = ''
  submitting.value = false
}

function choose(action: FireAction) {
  // 切换动作只保留动本身，结论/队伍/物资全部重置，不串到别的动作。
  Object.assign(form, emptyForm(), { action })
  errorMessage.value = ''
}

function resetForm() {
  Object.assign(form, emptyForm())
  errorMessage.value = ''
}

function submit() {
  if (!detail.value || !form.action) return
  errorMessage.value = ''

  if (form.action === '出动扑救' && !form.team.trim()) {
    errorMessage.value = '请选择调派队伍'
    return
  }

  const chosenSupplies =
    form.action === '出动扑救'
      ? Object.entries(form.supplyQty)
          .map(([id, qty]) => ({ supplyId: Number(id), qty: Number(qty) || 0 }))
          .filter((item) => item.qty > 0)
      : []

  if (form.action === '出动扑救') {
    const bad = chosenSupplies.find((item) => {
      const supply = supplies.value.find((s) => s.id === item.supplyId)
      return supply ? item.qty > supply.available : true
    })
    if (bad) {
      errorMessage.value = '携带数量超过可用库存，本次提交已拒绝（未占用任何物资）'
      return
    }
  }

  submitting.value = true
  // 携带进入详情时的版本号：两次处置同时提交时，后到请求版本不符会被拒绝。
  const result = submitDisposition({
    reportId: Number(route.params.id),
    action: form.action as FireAction,
    team: form.team || undefined,
    supplies: chosenSupplies,
    note: form.note,
    expectedVersion: detail.value.version,
  })
  submitting.value = false

  if (!result.ok) {
    errorMessage.value = result.message
    return
  }

  // 处置完成后返回列表；重新进入详情时会读取到最新结果。
  router.push({ name: 'firereport' })
}

function backToList() {
  router.push({ name: 'firereport' })
}

// 同组件复用时（理论上详情间直接跳转）也要按新 id 重新加载、清空表单。
onBeforeRouteUpdate((to) => load(Number(to.params.id)))
watch(
  () => route.params.id,
  (id) => {
    if (id) load(Number(id))
  },
)

onMounted(() => load(Number(route.params.id)))
</script>

<style scoped>
.back-btn { margin-right: 8px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.info-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.info-card h3 { margin: 0 0 10px; font-size: 14px; }
dl { display: grid; grid-template-columns: 92px 1fr; gap: 6px 10px; margin: 0; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; }
.readonly-field { color: #334155; }
.lock-hint { color: var(--muted); font-size: 11px; }
.compat-tag { font-size: 11px; color: #92400e; background: #fef3c7; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.st-wait { background: #eef2f7; color: #475569; }
.st-out { background: #fef3c7; color: #92400e; }
.st-done { background: #dcfce7; color: #166534; }
.st-false { background: #fee2e2; color: #991b1b; }
.timeline { list-style: none; margin: 0 0 12px; padding: 0; }
.timeline-item { border-left: 2px solid var(--brand); padding: 0 0 10px 12px; position: relative; }
.timeline-item::before { content: ''; position: absolute; left: -5px; top: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
.timeline-head { display: flex; gap: 8px; align-items: baseline; }
.timeline-time { color: var(--muted); font-size: 12px; }
.timeline-source { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 4px; padding: 0 6px; }
.timeline-note { margin: 2px 0 0; font-size: 13px; }
.link-list { list-style: none; margin: 0; padding: 0; font-size: 13px; display: grid; gap: 4px; }
.tag-warn { color: #92400e; }
.tag-done { color: #166534; }
.tag-muted { color: var(--muted); }
.muted { color: var(--muted); font-size: 13px; }
.action-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.disposition-form { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.form-hint { font-size: 13px; margin: 0 0 10px; }
.false-hint { color: #991b1b; }
.form-item { display: block; margin-bottom: 12px; font-size: 13px; }
.form-item > span { display: block; color: var(--muted); margin-bottom: 4px; }
.form-item select, .form-item textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-family: inherit; }
.mini-table { width: 100%; }
.mini-table th, .mini-table td { padding: 4px 6px; font-size: 12px; }
.qty-input { width: 80px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; }
.form-buttons { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }
</style>
