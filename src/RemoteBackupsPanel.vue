<template>
  <section class="panel list-panel backup-list remote-backup-list">
    <div class="panel-heading">
      <div><h2>阿里云 OSS 云端备份</h2><p>从配置的备份前缀读取快照，可直接下载到本机并恢复</p></div>
      <span class="panel-count">{{ remote.backups?.length || 0 }}</span>
    </div>
    <div v-if="remote.error" class="integration-callout integration-error remote-backup-error"><CircleAlert :size="16"/><span>{{ remote.error }}</span></div>
    <div v-else-if="remote.backups?.length" class="table-wrap">
      <table class="data-table">
        <thead><tr><th>OSS 备份对象</th><th>最后修改</th><th>大小</th><th>恢复</th></tr></thead>
        <tbody>
          <tr v-for="backup in remote.backups" :key="backup.name">
            <td class="mono">{{ backup.name }}</td>
            <td>{{ formatDate(backup.createdAt) }}</td>
            <td>{{ formatBytes(backup.size) }}</td>
            <td><button class="table-action reject-action" :disabled="busy" @click="$emit('restore',backup.name)">下载并恢复</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state compact"><Database :size="25"/><b>OSS 前缀下还没有备份</b><span>创建一份新备份并确认上传成功后，它会显示在这里。</span></div>
    <p class="inventory-footnote remote-backup-footnote"><Info :size="14"/>恢复前会先校验 SQLite 完整性和应用数据表，并在本机保存当前数据库安全副本；成功后需要重新登录。</p>
  </section>
</template>

<script setup>
import { CircleAlert, Database, Info } from 'lucide-vue-next'

defineProps({
  remote: { type: Object, default: () => ({ backups: [] }) },
  busy: { type: Boolean, default: false },
})
defineEmits(['restore'])

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
</script>
