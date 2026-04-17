<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import FilesTab from '../components/FilesTab.vue'
import HistoryTab from '../components/HistoryTab.vue'
import SettingsPanel from '../components/SettingsPanel.vue'

const router = useRouter()
const tab = ref<'files' | 'history'>('files')
const showSettings = ref(false)

function toggleSettings() {
  showSettings.value = !showSettings.value
}
</script>

<template>
  <div class="layout">
    <!-- Gear icon top-right -->
    <button class="gear-btn" aria-label="Settings" @click="toggleSettings" title="Settings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>

    <!-- Tab bar -->
    <div class="topbar">
      <div class="tabs">
        <button :class="{ active: tab === 'files' }" @click="tab = 'files'">Files</button>
        <button :class="{ active: tab === 'history' }" @click="tab = 'history'">History</button>
      </div>
    </div>

    <!-- Tab content -->
    <div class="content">
      <FilesTab v-if="tab === 'files'" />
      <HistoryTab v-else />
    </div>

    <!-- Settings panel -->
    <SettingsPanel
      v-if="showSettings"
      @close="showSettings = false"
      @logout="router.push('/login')"
    />
    <!-- Click outside to close settings -->
    <div v-if="showSettings" class="overlay" @click="showSettings = false" />
  </div>
</template>

<style scoped>
.layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
}
.gear-btn {
  position: fixed;
  top: 12px;
  right: 16px;
  background: transparent;
  border: none;
  color: var(--text2);
  padding: 6px;
  cursor: pointer;
  z-index: 50;
  border-radius: var(--radius);
}
.gear-btn:hover { color: var(--text); background: var(--bg1); }
.topbar {
  display: flex;
  justify-content: center;
  padding: 14px 0 0;
}
.content {
  flex: 1;
  padding: 12px 16px 0;
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
}
.overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
}
</style>
