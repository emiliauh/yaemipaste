<script setup lang="ts">
import { ref } from 'vue'
import { getShareXConfig } from '../lib/api'

const emit = defineEmits<{ close: [] }>()

const apiBase = ref(localStorage.getItem('rp_api_base') ?? 'https://api.example.invalid/')
const username = localStorage.getItem('rp_username') ?? ''
const hasAccount = !!localStorage.getItem('rp_jwt')
const downloading = ref(false)
const saved = ref(false)

function save() {
  localStorage.setItem('rp_api_base', apiBase.value)
  saved.value = true
  setTimeout(() => { saved.value = false; emit('close') }, 800)
}

async function downloadShareX() {
  downloading.value = true
  try {
    const blob = await getShareXConfig()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'rustypaste.sxcu'
    a.click()
  } catch (e: any) {
    alert(e.message)
  } finally {
    downloading.value = false
  }
}

</script>

<template>
  <div class="settings-panel">
    <div style="margin-bottom:12px; font-size:13px; color:var(--text)">Settings</div>

    <div class="field">
      <label>API Base URL</label>
      <input v-model="apiBase" type="text" />
    </div>

    <div class="row" style="margin-bottom:12px">
      <button class="btn-ghost" style="font-size:11px" @click="emit('close')">Cancel</button>
      <button class="btn-primary" style="font-size:11px" @click="save">{{ saved ? 'Saved' : 'Save' }}</button>
    </div>

    <div v-if="hasAccount" class="field">
      <label>ShareX Config</label>
      <p style="color:var(--text3); font-size:11px; margin-bottom:6px">Download pre-configured .sxcu for your account.</p>
      <button class="btn-primary" style="font-size:11px; width:100%" :disabled="downloading" @click="downloadShareX">
        {{ downloading ? 'Generating…' : 'Download .sxcu' }}
      </button>
    </div>

    <div v-if="username" style="margin-top:4px; color:var(--text3); font-size:11px; margin-bottom:8px">
      Signed in as <span style="color:var(--text2)">{{ username }}</span>
    </div>

    <div style="margin-top:8px; color:var(--text3); font-size:10px; text-align:center">
      ♥ rustypaste (-ui) as the base
    </div>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.field label { color: var(--text2); font-size: 11px; }
.field input { width: 100%; font-size: 12px; }
.row { display: flex; gap: 8px; justify-content: flex-end; }
</style>
