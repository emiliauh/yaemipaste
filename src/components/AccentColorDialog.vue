<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { applyAccent, DEFAULT_ACCENT, hexToHsl, hslToHex, hslToRgb, normalizeHex } from '../lib/branding'

const props = defineProps<{ open: boolean; initialHex: string | null }>()
const emit = defineEmits<{ save: [hex: string]; cancel: [] }>()

const wheelCanvas = ref<HTMLCanvasElement | null>(null)
const dragging = ref(false)
const hue = ref(40)
const sat = ref(0.85)
const light = ref(0.55)
const hexText = ref(DEFAULT_ACCENT)
const hexValid = ref(true)

function currentHex(): string {
  return hslToHex(hue.value, sat.value, light.value)
}

function syncFromHex(hex: string) {
  const [h, s, l] = hexToHsl(hex)
  hue.value = h
  sat.value = s
  light.value = l
}

function applyDraft() {
  const hex = currentHex()
  hexText.value = hex
  hexValid.value = true
  applyAccent(hex)
}

function drawWheel() {
  const canvas = wheelCanvas.value
  if (!canvas) return
  const size = canvas.width
  if (size === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const radius = size / 2
  const image = ctx.createImageData(size, size)
  const data = image.data
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - radius
      const dy = y - radius
      const dist = Math.hypot(dx, dy)
      if (dist > radius) continue
      let h = Math.atan2(dy, dx) * 180 / Math.PI
      if (h < 0) h += 360
      const s = Math.min(1, dist / radius)
      const [r, g, b] = hslToRgb(h, s, light.value)
      const idx = (y * size + x) * 4
      data[idx] = r
      data[idx + 1] = g
      data[idx + 2] = b
      data[idx + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  drawHandle()
}

function drawHandle() {
  const canvas = wheelCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const radius = canvas.width / 2
  const angle = hue.value * Math.PI / 180
  const r = sat.value * radius
  const x = radius + Math.cos(angle) * r
  const y = radius + Math.sin(angle) * r
  ctx.beginPath()
  ctx.arc(x, y, 6, 0, Math.PI * 2)
  ctx.lineWidth = 2.5
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, 3, 0, Math.PI * 2)
  ctx.fillStyle = '#000000'
  ctx.fill()
}

function positionFromEvent(event: PointerEvent) {
  const canvas = wheelCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const radius = rect.width / 2
  const dx = event.clientX - rect.left - radius
  const dy = event.clientY - rect.top - radius
  const dist = Math.min(radius, Math.hypot(dx, dy))
  let h = Math.atan2(dy, dx) * 180 / Math.PI
  if (h < 0) h += 360
  hue.value = h
  sat.value = Math.max(0, Math.min(1, dist / radius))
  applyDraft()
  drawWheel()
}

function onPointerDown(event: PointerEvent) {
  dragging.value = true
  const canvas = wheelCanvas.value
  if (canvas) canvas.setPointerCapture(event.pointerId)
  positionFromEvent(event)
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return
  positionFromEvent(event)
}

function onPointerUp() {
  dragging.value = false
}

function onLightChange(event: Event) {
  light.value = Number((event.target as HTMLInputElement).value) / 100
  applyDraft()
  drawWheel()
}

function onHexInput() {
  const normalized = normalizeHex(hexText.value)
  if (!normalized) {
    hexValid.value = false
    return
  }
  hexValid.value = true
  syncFromHex(normalized)
  applyAccent(normalized)
  drawWheel()
}

function cancel() {
  dragging.value = false
  emit('cancel')
}

function save() {
  const normalized = normalizeHex(hexText.value) ?? currentHex()
  hexText.value = normalized
  applyAccent(normalized)
  emit('save', normalized)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') cancel()
}

watch(() => props.open, (open) => {
  if (!open) return
  const start = props.initialHex ?? DEFAULT_ACCENT
  syncFromHex(start)
  hexText.value = start
  hexValid.value = true
  applyAccent(start)
  void nextTick(() => { drawWheel() })
}, { immediate: true })
</script>

<template>
  <div v-if="open" class="accent-dialog-backdrop" @click.self="cancel">
    <div
      class="accent-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Choose accent color"
      @keydown="onKeydown"
    >
      <header class="accent-dialog-header">
        <strong>Accent color</strong>
        <button class="btn-ghost icon-close" type="button" aria-label="Close color picker" @click="cancel">✕</button>
      </header>

      <div class="accent-dialog-body">
        <div class="accent-wheel-wrap">
          <canvas
            ref="wheelCanvas"
            class="accent-wheel"
            width="180"
            height="180"
            role="application"
            aria-label="Color wheel"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          ></canvas>
        </div>
        <div class="accent-controls">
          <label class="accent-lightness">
            <span>Lightness</span>
            <input type="range" min="0" max="100" :value="Math.round(light * 100)" aria-label="Lightness" @input="onLightChange" />
          </label>
          <label class="accent-hex">
            <span>Hex</span>
            <input
              v-model="hexText"
              inputmode="text"
              spellcheck="false"
              aria-label="Hex color"
              :class="{ 'is-invalid': !hexValid }"
              @input="onHexInput"
            />
          </label>
          <div class="accent-preview-row">
            <span class="accent-preview-label">Preview</span>
            <span class="accent-swatch" :style="{ background: hexText }"></span>
          </div>
        </div>
      </div>

      <footer class="accent-dialog-actions">
        <button class="btn-ghost" type="button" @click="cancel">Cancel</button>
        <button class="btn-primary" type="button" data-testid="accent-save" @click="save">Save</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.accent-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--modal-bg);
}
.accent-dialog {
  width: min(400px, calc(100vw - 24px));
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
.accent-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.accent-dialog-header strong {
  color: var(--text);
  font-size: var(--fs-h2);
}
.accent-dialog-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
}
.accent-wheel-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}
.accent-wheel {
  width: 100%;
  max-width: 180px;
  aspect-ratio: 1;
  border-radius: 50%;
  touch-action: none;
  cursor: crosshair;
  border: 1px solid var(--border);
}
.accent-controls {
  display: grid;
  gap: var(--space-3);
  align-content: start;
}
.accent-lightness,
.accent-hex {
  display: grid;
  gap: 4px;
}
.accent-controls label > span,
.accent-preview-label {
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.accent-lightness input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}
.accent-hex input {
  width: 100%;
  min-height: 38px;
  padding: 6px 10px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  background: var(--bg1);
}
.accent-hex input.is-invalid {
  border-color: var(--red);
}
.accent-preview-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.accent-swatch {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.accent-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.accent-dialog-actions .btn-primary {
  min-width: 88px;
}

@media (max-width: 480px) {
  .accent-dialog-body {
    grid-template-columns: 1fr;
  }
  .accent-wheel {
    max-width: 160px;
  }
  .accent-controls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .accent-preview-row {
    grid-column: 1 / -1;
  }
}
</style>
