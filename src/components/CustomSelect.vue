<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

export interface SelectOption {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

const props = defineProps<{
  modelValue: string
  options: SelectOption[]
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const open = ref(false)
const activeIndex = ref(0)
const menuStyle = ref<Record<string, string>>({})
const typeahead = ref('')
let typeaheadTimer: number | undefined

const selected = computed(() => props.options.find((option) => option.value === props.modelValue) ?? props.options[0])
const enabledIndexes = computed(() => props.options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0))
const listboxId = computed(() => `custom-select-${props.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)

function firstEnabled() { return enabledIndexes.value[0] ?? 0 }
function nextEnabled(index: number, direction: 1 | -1) {
  const indexes = enabledIndexes.value
  if (!indexes.length) return index
  const current = indexes.indexOf(index)
  return indexes[(current + direction + indexes.length) % indexes.length]
}

function syncActive() {
  const selectedIndex = props.options.findIndex((option) => option.value === props.modelValue && !option.disabled)
  activeIndex.value = selectedIndex >= 0 ? selectedIndex : firstEnabled()
}

function positionMenu() {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const viewportPadding = 8
  const width = Math.min(Math.max(rect.width, 220), window.innerWidth - viewportPadding * 2)
  const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding)
  const estimatedHeight = Math.min(320, Math.max(56, props.options.length * 44 + 16))
  const openUp = rect.bottom + estimatedHeight > window.innerHeight - viewportPadding && rect.top > estimatedHeight
  menuStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${openUp ? Math.max(viewportPadding, rect.top - estimatedHeight - 6) : rect.bottom + 6}px`,
    width: `${width}px`,
  }
}

async function openMenu() {
  if (props.disabled || !props.options.length) return
  syncActive()
  open.value = true
  await nextTick()
  positionMenu()
}

function close(returnFocus = false) {
  open.value = false
  if (returnFocus) nextTick(() => triggerRef.value?.focus())
}

function choose(option: SelectOption) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  close(true)
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return
  if (!open.value) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      void openMenu()
    }
    return
  }
  if (event.key === 'Escape') { event.preventDefault(); close(true); return }
  if (event.key === 'Tab') { close(); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex.value = nextEnabled(activeIndex.value, 1); return }
  if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex.value = nextEnabled(activeIndex.value, -1); return }
  if (event.key === 'Home') { event.preventDefault(); activeIndex.value = firstEnabled(); return }
  if (event.key === 'End') { event.preventDefault(); activeIndex.value = enabledIndexes.value.at(-1) ?? activeIndex.value; return }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const option = props.options[activeIndex.value]
    if (option) choose(option)
    return
  }
  if (event.key.length === 1 && /\S/.test(event.key)) {
    typeahead.value += event.key.toLowerCase()
    window.clearTimeout(typeaheadTimer)
    typeaheadTimer = window.setTimeout(() => { typeahead.value = '' }, 500)
    const match = props.options.findIndex((option) => !option.disabled && option.label.toLowerCase().startsWith(typeahead.value))
    if (match >= 0) activeIndex.value = match
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (open.value && rootRef.value && !rootRef.value.contains(target) && menuRef.value && !menuRef.value.contains(target)) close()
}

function onViewportChange() { if (open.value) positionMenu() }

watch(() => props.modelValue, syncActive)
onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  window.clearTimeout(typeaheadTimer)
})
</script>

<template>
  <div ref="rootRef" class="custom-select" :class="{ open, disabled }">
    <button
      ref="triggerRef"
      class="custom-select-trigger"
      type="button"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listboxId"
      @click="open ? close() : void openMenu()"
      @keydown="onKeydown"
    >
      <span class="select-copy"><span class="select-label">{{ label }}</span><span class="select-value">{{ selected?.label ?? 'Select' }}</span></span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menuRef" :id="listboxId" class="custom-select-menu" role="listbox" :aria-label="label" :style="menuStyle">
        <button
          v-for="(option, index) in options"
          :key="option.value"
          type="button"
          role="option"
          :disabled="option.disabled"
          :aria-selected="option.value === modelValue"
          :class="{ active: option.value === modelValue, focused: index === activeIndex }"
          @mouseenter="activeIndex = index"
          @click="choose(option)"
        >
          <span><strong>{{ option.label }}</strong><small v-if="option.hint">{{ option.hint }}</small></span>
          <span v-if="option.value === modelValue" class="select-check" aria-hidden="true">✓</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.custom-select { position: relative; min-width: 190px; }
.custom-select-trigger { width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--border2); border-radius: var(--radius); background: var(--surface2); color: var(--text); text-align: left; }
.custom-select-trigger:hover, .custom-select.open .custom-select-trigger { border-color: var(--accent); background: var(--surface3); }
.select-copy { min-width: 0; display: grid; gap: 3px; }
.select-label { color: var(--text2); font-size: 11px; line-height: 1; }
.select-value { overflow: hidden; color: var(--text); font-size: 13px; font-weight: 600; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.custom-select svg { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; color: var(--text2); transition: transform .15s ease; }
.custom-select.open > .custom-select-trigger svg { transform: rotate(180deg); }
.custom-select-menu { z-index: 1000; display: grid; gap: 3px; max-height: min(320px, calc(100dvh - 16px)); overflow-y: auto; padding: 5px; border: 1px solid var(--border2); border-radius: var(--radius-md); background: var(--surface); box-shadow: 0 16px 32px #0006; }
.custom-select-menu button { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: var(--text2); text-align: left; }
.custom-select-menu button.focused, .custom-select-menu button:hover { background: var(--surface2); color: var(--text); }
.custom-select-menu button.active { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 12%, var(--surface2)); color: var(--text); }
.custom-select-menu button:disabled { opacity: .45; cursor: not-allowed; }
.custom-select-menu strong, .custom-select-menu small { display: block; }
.custom-select-menu strong { font-size: 13px; font-weight: 600; }
.custom-select-menu small { margin-top: 2px; color: var(--text2); font-size: 11px; }
.select-check { color: var(--accent-h); font-size: 14px; }
@media (max-width: 600px) { .custom-select { width: 100%; } .custom-select-menu { max-height: min(360px, calc(100dvh - 24px)); } }
</style>
