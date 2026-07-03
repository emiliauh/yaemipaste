<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

const props = defineProps<{
  modelValue: string
  options: SelectOption[]
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const activeIndex = ref(0)
const selected = computed(() => props.options.find((option) => option.value === props.modelValue) ?? props.options[0])
const listboxId = computed(() => `custom-select-${props.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)

function close() {
  open.value = false
}

function choose(value: string) {
  emit('update:modelValue', value)
  close()
}

function setActiveFromValue() {
  const index = props.options.findIndex((option) => option.value === props.modelValue)
  activeIndex.value = Math.max(0, index)
}

function toggle() {
  if (props.disabled) return
  setActiveFromValue()
  open.value = !open.value
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return
  if (!open.value && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    setActiveFromValue()
    open.value = true
    return
  }
  if (!open.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    activeIndex.value = (activeIndex.value + direction + props.options.length) % props.options.length
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const option = props.options[activeIndex.value]
    if (option) choose(option.value)
  }
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (rootRef.value && target && !rootRef.value.contains(target)) close()
}

onMounted(() => document.addEventListener('pointerdown', onPointerDown, true))
onUnmounted(() => document.removeEventListener('pointerdown', onPointerDown, true))
</script>

<template>
  <div ref="rootRef" class="custom-select" :class="{ open, disabled }">
    <button
      class="custom-select-trigger"
      type="button"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="listboxId"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="select-copy">
        <span class="select-label">{{ label }}</span>
        <span class="select-value">{{ selected?.label ?? 'Select' }}</span>
      </span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    <Transition name="select-menu">
      <div v-if="open" :id="listboxId" class="custom-select-menu" role="listbox" :aria-label="label">
        <button
          v-for="(option, index) in options"
          :key="option.value"
          type="button"
          role="option"
          :aria-selected="option.value === modelValue ? 'true' : 'false'"
          :class="{ active: option.value === modelValue, focused: index === activeIndex }"
          @mouseenter="activeIndex = index"
          @click="choose(option.value)"
        >
          <span>
            <strong>{{ option.label }}</strong>
            <small v-if="option.hint">{{ option.hint }}</small>
          </span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.custom-select {
  position: relative;
  min-width: 190px;
}
.custom-select-trigger {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border2) 84%, transparent);
  border-radius: var(--radius-sm);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg2) 78%, transparent), color-mix(in srgb, var(--bg1) 92%, transparent));
  color: var(--text);
  text-align: left;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 5%, transparent);
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.custom-select-trigger:hover,
.custom-select.open .custom-select-trigger {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border2));
  background: color-mix(in srgb, var(--bg2) 88%, transparent);
}
.custom-select-trigger:active {
  transform: scale(0.98);
}
.select-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.select-label {
  color: var(--text2);
  font-size: var(--fs-xs);
  line-height: var(--lh-tight);
}
.select-value {
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 650;
  line-height: var(--lh-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.custom-select svg {
  width: 15px;
  height: 15px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  color: var(--text2);
  transition: transform var(--duration-fast) var(--ease-out);
}
.custom-select.open svg {
  transform: rotate(180deg);
}
.custom-select-menu {
  position: absolute;
  z-index: 85;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid color-mix(in srgb, var(--border2) 88%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg1) 96%, transparent);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--shadow) 76%, transparent);
  backdrop-filter: blur(18px);
}
.custom-select-menu button {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.custom-select-menu button.focused,
.custom-select-menu button:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--bg2) 78%, transparent);
}
.custom-select-menu button.active {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 36%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg2));
}
.custom-select-menu strong {
  display: block;
  font-size: var(--fs-sm);
  font-weight: 650;
}
.custom-select-menu small {
  display: block;
  margin-top: 2px;
  color: var(--text2);
  font-size: var(--fs-xs);
}
.select-menu-enter-active,
.select-menu-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  transform-origin: top;
}
.select-menu-enter-from,
.select-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
@media (max-width: 600px) {
  .custom-select {
    width: 100%;
  }
}
</style>
