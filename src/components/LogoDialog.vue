<script setup lang="ts">
import { ref, watch } from 'vue'
import { applyLogo, DEFAULT_LOGO_PRESET, presetInnerSvg, PRESET_ICONS, type BrandingLogo } from '../lib/branding'

const props = defineProps<{ open: boolean; initialLogo: BrandingLogo | null }>()
const emit = defineEmits<{ save: [logo: BrandingLogo]; cancel: [] }>()

const MAX_UPLOAD_BYTES = 1_000_000
const presetKeys = Object.keys(PRESET_ICONS)

const mode = ref<'preset' | 'upload'>('preset')
const presetSelected = ref<string>(DEFAULT_LOGO_PRESET)
const uploadDataUrl = ref('')
const fileName = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const error = ref('')

function draft(): BrandingLogo {
  return mode.value === 'upload' && uploadDataUrl.value
    ? { type: 'upload', dataUrl: uploadDataUrl.value }
    : { type: 'preset', preset: presetSelected.value }
}

function applyDraft() {
  applyLogo(draft())
}

function selectPreset(key: string) {
  mode.value = 'preset'
  presetSelected.value = key
  error.value = ''
  applyDraft()
}

function chooseUpload() {
  mode.value = 'upload'
  error.value = ''
  fileInput.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > MAX_UPLOAD_BYTES) {
    error.value = 'Image is too large (max 1 MB).'
    return
  }
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/svg+xml']
  if (!allowed.includes(file.type)) {
    error.value = 'Please choose a PNG, JPEG, WebP, SVG, or ICO image.'
    return
  }
  mode.value = 'upload'
  fileName.value = file.name
  const reader = new FileReader()
  reader.onload = () => {
    uploadDataUrl.value = String(reader.result ?? '')
    error.value = ''
    applyDraft()
  }
  reader.onerror = () => { error.value = 'Could not read the image.' }
  reader.readAsDataURL(file)
}

function cancel() {
  emit('cancel')
}

function save() {
  emit('save', draft())
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') cancel()
}

watch(() => props.open, (open) => {
  if (!open) return
  const start = props.initialLogo ?? { type: 'preset' as const, preset: DEFAULT_LOGO_PRESET }
  mode.value = start.type === 'upload' && start.dataUrl ? 'upload' : 'preset'
  presetSelected.value = start.preset ?? DEFAULT_LOGO_PRESET
  uploadDataUrl.value = start.dataUrl ?? ''
  fileName.value = ''
  error.value = ''
  applyDraft()
}, { immediate: true })
</script>

<template>
  <div v-if="open" class="logo-dialog-backdrop" @click.self="cancel">
    <div
      class="logo-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Choose site logo"
      @keydown="onKeydown"
    >
      <header class="logo-dialog-header">
        <strong>Site logo</strong>
        <button class="btn-ghost logo-dialog-close" type="button" aria-label="Close logo picker" @click="cancel">✕</button>
      </header>

      <div class="logo-mode-toggle" role="group" aria-label="Logo source">
        <button :class="{ selected: mode === 'preset' }" type="button" @click="mode = 'preset'">Preset icon</button>
        <button :class="{ selected: mode === 'upload' }" type="button" @click="mode = 'upload'">Upload image</button>
      </div>

      <div v-if="mode === 'preset'" class="logo-preset-grid">
        <button
          v-for="key in presetKeys"
          :key="key"
          type="button"
          class="logo-preset"
          :class="{ selected: presetSelected === key }"
          :aria-pressed="presetSelected === key"
          :aria-label="'Use ' + key + ' icon'"
          @click="selectPreset(key)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" v-html="presetInnerSvg(key)"></svg>
        </button>
      </div>

      <div v-else class="logo-upload">
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/x-icon,image/svg+xml" hidden @change="onFileChange" />
        <div class="logo-upload-preview">
          <img v-if="uploadDataUrl" :src="uploadDataUrl" alt="Uploaded logo preview" />
          <span v-else class="logo-upload-placeholder">No image selected</span>
        </div>
        <button class="btn-ghost" type="button" @click="chooseUpload">Choose image…</button>
        <p v-if="fileName" class="logo-upload-name">{{ fileName }}</p>
      </div>

      <p v-if="error" class="logo-error">{{ error }}</p>

      <div class="logo-live-row">
        <span class="logo-live-label">Live preview</span>
        <span class="logo-live-mark" aria-hidden="true">
          <svg v-if="draft().type === 'preset'" viewBox="0 0 24 24" v-html="presetInnerSvg(presetSelected)"></svg>
          <img v-else :src="uploadDataUrl" alt="" />
        </span>
      </div>

      <footer class="logo-dialog-actions">
        <button class="btn-ghost" type="button" @click="cancel">Cancel</button>
        <button class="btn-primary" type="button" data-testid="logo-save" @click="save">Save</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.logo-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--modal-bg);
}
.logo-dialog {
  width: min(420px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow: auto;
  padding: var(--space-4);
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.logo-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.logo-dialog-header strong {
  color: var(--text);
  font-size: var(--fs-h2);
}
.logo-dialog-close {
  padding: 4px;
}
.logo-mode-toggle {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg2);
}
.logo-mode-toggle button {
  min-height: 32px;
  padding: 6px;
  color: var(--text2);
  font-size: var(--fs-sm);
  font-weight: 500;
  border: 1px solid transparent;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
}
.logo-mode-toggle button.selected {
  color: var(--text);
  background: var(--bg1);
  box-shadow: var(--shadow-sm);
}
.logo-preset-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}
.logo-preset {
  aspect-ratio: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2);
  color: var(--text2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.logo-preset:hover {
  color: var(--text);
  border-color: var(--border2);
  background: var(--bg2);
}
.logo-preset.selected {
  color: var(--on-accent);
  border-color: var(--accent);
  background: var(--accent);
}
.logo-preset svg {
  width: 22px;
  height: 22px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8px;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.logo-upload {
  display: grid;
  gap: var(--space-3);
  justify-items: center;
}
.logo-upload-preview {
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg2);
}
.logo-upload-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.logo-upload-placeholder {
  color: var(--text3);
  font-size: var(--fs-xs);
  text-align: center;
  line-height: 1.35;
  padding: var(--space-2);
}
.logo-upload-name {
  max-width: 100%;
  overflow: hidden;
  color: var(--text2);
  font-size: var(--fs-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.logo-error {
  color: var(--red);
  font-size: var(--fs-xs);
}
.logo-live-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.logo-live-label {
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.logo-live-mark {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg2);
}
.logo-live-mark svg {
  width: 23px;
  height: 23px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8px;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.logo-live-mark img {
  max-width: 80%;
  max-height: 80%;
  object-fit: contain;
}
.logo-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.logo-dialog-actions .btn-primary {
  min-width: 88px;
}

@media (max-width: 480px) {
  .logo-preset-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
