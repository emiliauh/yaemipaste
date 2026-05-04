<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { defaultExpiryValue, expiryOptions, maxExpiryDays, type ExpiryValue } from '../lib/expiry'

const model = defineModel<ExpiryValue>({ required: true })
const open = ref(false)
const revealNever = ref(false)
const mobileCollapsed = ref(true)
const menuRef = ref<HTMLElement | null>(null)
const selectedValue = computed(() => model.value)
const visibleOptions = computed(() => (revealNever.value ? expiryOptions : expiryOptions.filter((option) => option.value !== 'never')))
const selected = computed(() => expiryOptions.find((option) => option.value === model.value)
  ?? expiryOptions.find((option) => option.value === defaultExpiryValue)
  ?? expiryOptions[0])

function choose(value: ExpiryValue) {
  if (value === 'never' && !revealNever.value) return
  model.value = value
  open.value = false
  if (window.matchMedia('(max-width: 600px)').matches) mobileCollapsed.value = true
}

function expandMobile() {
  mobileCollapsed.value = false
}

function collapseMobile() {
  open.value = false
  mobileCollapsed.value = true
}

function onTriggerClick(event: MouseEvent) {
  if (event.shiftKey) {
    revealNever.value = true
    open.value = true
    return
  }
  open.value = !open.value
}

function onPointerDown(event: PointerEvent) {
  if (!open.value) return
  const target = event.target as Node | null
  if (menuRef.value && target && !menuRef.value.contains(target)) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
})
</script>

<template>
  <div ref="menuRef" class="expiry-menu" :class="{ 'mobile-collapsed': mobileCollapsed }" data-testid="expiry-menu">
    <button
      class="expiry-mobile-toggle"
      type="button"
      aria-label="Show expiry options"
      data-testid="expiry-mobile-toggle"
      @click="expandMobile"
    >
      <span>{{ selected.label }}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="18 15 12 9 6 15"/>
      </svg>
    </button>

    <div class="expiry-panel" data-testid="expiry-panel">
      <div class="expiry-panel-top">
        <div class="expiry-headings">
          <div class="expiry-label">Keep for · max {{ maxExpiryDays }} days</div>
          <div class="expiry-tip">To use Forever, hold <kbd>Shift</kbd> and click.</div>
        </div>
        <button
          class="expiry-collapse"
          type="button"
          aria-label="Hide expiry options"
          data-testid="expiry-collapse"
          @click="collapseMobile"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>
      <button
        class="expiry-trigger"
        type="button"
        aria-haspopup="listbox"
        :aria-expanded="open"
        data-testid="expiry-trigger"
        @click="onTriggerClick"
      >
        <span class="expiry-value">{{ selected.label }}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <div v-if="open" class="expiry-options" role="listbox" data-testid="expiry-options">
        <button
          v-for="option in visibleOptions"
          :key="option.value"
          type="button"
          role="option"
          :aria-selected="option.value === selectedValue"
          :class="{ active: option.value === selectedValue, danger: option.danger }"
          :data-testid="`expiry-option-${option.value}`"
          @click="choose(option.value)"
        >
          <span class="option-dot"></span>
          {{ option.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.expiry-menu {
  position: relative;
  z-index: 20;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 10px 12px;
  box-shadow: none;
}
.expiry-mobile-toggle,
.expiry-collapse {
  display: none;
}
.expiry-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(160px, 190px);
  align-items: center;
  gap: 14px;
}
.expiry-panel-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.expiry-headings {
  display: grid;
  gap: 3px;
}
.expiry-label {
  color: var(--text2);
  font-size: 11px;
  margin-bottom: 2px;
  text-transform: uppercase;
  white-space: nowrap;
}
.expiry-tip {
  color: var(--text3);
  font-size: 10px;
  margin-bottom: 0;
}
.expiry-tip kbd {
  border: 1px solid var(--border2);
  border-radius: 2px;
  background: var(--bg2);
  color: var(--text2);
  font-size: 10px;
  padding: 0 4px;
}
.expiry-trigger {
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--border2);
  background: var(--surface2);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
}
.expiry-value {
  color: var(--accent-h);
  font-size: 13px;
  line-height: 1.2;
}
.expiry-options {
  position: absolute;
  right: 12px;
  top: calc(100% + 6px);
  width: min(190px, calc(100% - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 5px;
}
.expiry-options::before {
  content: "";
  position: absolute;
  left: 16px;
  top: 10px;
  bottom: 10px;
  width: 1px;
  background: var(--border);
}
.expiry-options button {
  position: relative;
  width: 100%;
  background: transparent;
  color: var(--text2);
  text-align: left;
  padding: 6px 8px 6px 24px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.expiry-options button:hover,
.expiry-options button.active {
  background: var(--surface2);
  color: var(--text);
}
.option-dot {
  position: absolute;
  left: 8px;
  width: 7px;
  height: 7px;
  border: 1px solid var(--text3);
  border-radius: 50%;
  background: var(--bg1);
}
.expiry-options button.active .option-dot {
  border-color: var(--accent);
  background: var(--accent);
}
.expiry-options button.danger .option-dot {
  border-color: var(--red);
}
.expiry-options button.danger:hover,
.expiry-options button.danger.active {
  background: var(--danger-bg);
  color: var(--red-h);
}

@media (min-width: 601px) and (max-width: 760px) {
  .expiry-panel {
    grid-template-columns: 1fr;
    align-items: stretch;
    gap: 8px;
  }
  .expiry-panel-top {
    align-items: center;
  }
  .expiry-options {
    left: 12px;
    right: 12px;
    width: auto;
  }
}

@media (max-width: 600px) {
  .expiry-menu {
    position: fixed;
    left: auto;
    right: 10px;
    bottom: 78px;
    width: min(220px, calc(100vw - 20px));
    padding: 8px;
    box-shadow: 0 8px 24px var(--shadow);
  }
  .expiry-menu.mobile-collapsed {
    width: auto;
    padding: 0;
    border-color: var(--border);
    background: transparent;
    box-shadow: none;
  }
  .expiry-mobile-toggle {
    border: 1px solid var(--border2);
    background: var(--bg1);
    color: var(--text2);
    display: none;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 7px 9px;
    box-shadow: 0 8px 24px var(--shadow);
  }
  .expiry-menu.mobile-collapsed .expiry-mobile-toggle {
    display: inline-flex;
  }
  .expiry-panel {
    display: grid;
    grid-template-columns: 1fr;
    align-items: stretch;
    gap: 10px;
  }
  .expiry-menu.mobile-collapsed .expiry-panel {
    display: none;
  }
  .expiry-panel-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 5px;
  }
  .expiry-label {
    margin-bottom: 0;
  }
  .expiry-tip {
    margin-bottom: 0;
    max-width: 140px;
  }
  .expiry-collapse {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text2);
    min-width: 28px;
    min-height: 24px;
    padding: 3px 6px;
  }
  .expiry-options {
    left: 0;
    right: 0;
    top: auto;
    bottom: calc(100% + 6px);
    width: auto;
  }
}
</style>
