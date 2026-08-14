<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import FilesTab from '../components/FilesTab.vue'
import HistoryTab from '../components/HistoryTab.vue'
import { isAuthEnabled } from '../lib/features'

const route = useRoute()
const authEnabled = isAuthEnabled()
const tab = computed<'files' | 'history'>(() => (
  authEnabled && route.path === '/history' ? 'history' : 'files'
))
</script>

<template>
  <div class="dashboard-view">
    <FilesTab v-if="tab === 'files' || !authEnabled" />
    <HistoryTab v-else />
  </div>
</template>

<style scoped>
.dashboard-view {
  width: 100%;
}
</style>
