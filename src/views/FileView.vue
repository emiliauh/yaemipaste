<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { decodeFileToken } from '../lib/api'
import EncryptedFileView from './EncryptedFileView.vue'
import PasswordFileView from './PasswordFileView.vue'
import PublicFilePreviewView from './PublicFilePreviewView.vue'

const route = useRoute()
const filekey = computed(() => String(route.params.filekey ?? ''))
const keyPart = computed(() => filekey.value.includes('+') ? filekey.value.split('+').slice(1).join('+') : '')
const isPasswordEncrypted = computed(() => keyPart.value.startsWith('pw:'))
const isKeyEncrypted = computed(() => !!keyPart.value && !isPasswordEncrypted.value)

const decodedName = computed(() => {
  try { return decodeFileToken(filekey.value.split('+')[0]) } catch { return '' }
})
const isEncryptedNoKey = computed(() => !keyPart.value && decodedName.value.endsWith('.rpenc'))
</script>

<template>
  <main v-if="isEncryptedNoKey" class="error-page">
    <section class="error-card">
      <div class="lock-mark">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h1>Decryption key missing</h1>
      <p>This file is encrypted but the link doesn't include a decryption key. Ask whoever shared this file for the full link.</p>
    </section>
  </main>
  <PasswordFileView v-else-if="isPasswordEncrypted" />
  <EncryptedFileView v-else-if="isKeyEncrypted" />
  <PublicFilePreviewView v-else />
</template>

<style scoped>
.error-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.error-card {
  width: min(460px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
}
.lock-mark {
  width: 42px;
  height: 42px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg2);
  color: var(--red-h);
  display: flex;
  align-items: center;
  justify-content: center;
}
h1 {
  color: var(--text);
  font-size: 15px;
}
p {
  color: var(--text3);
  font-size: 12px;
  line-height: 1.6;
}
</style>
