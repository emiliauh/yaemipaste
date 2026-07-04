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
          <div class="expiry-label">KEEP FOR · MAX {{ maxExpiryDays }} DAYS</div>
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
  z-index: 60;
  width: 100%;
}
.expiry-mobile-toggle,
.expiry-collapse {
  display: none;
}
.expiry-panel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  min-height: 76px;
  border: 1px solid color-mix(in srgb, var(--border2) 82%, transparent);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--bg1) 86%, transparent), color-mix(in srgb, var(--subtle-grad-end) 88%, transparent)),
    color-mix(in srgb, var(--bg) 72%, transparent);
  padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  box-shadow: 0 18px 46px color-mix(in srgb, var(--shadow) 72%, transparent);
  backdrop-filter: blur(16px);
}
.expiry-panel-top {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 1 1 auto;
}
.expiry-headings {
  min-width: 0;
  display: grid;
  gap: var(--space-1);
}
.expiry-label {
  color: var(--accent-h);
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.18em;
  line-height: var(--lh-tight);
  text-transform: uppercase;
}
.expiry-tip {
  color: var(--text2);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}
.expiry-tip kbd {
  border: 1px solid color-mix(in srgb, var(--border2) 84%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg2) 78%, transparent);
  color: var(--text2);
  font-size: 10px;
  line-height: 1;
  padding: 1px 5px 2px;
}
.expiry-trigger {
  flex: 0 0 204px;
  min-height: 44px;
  border: 1px solid color-mix(in srgb, var(--border2) 90%, transparent);
  border-radius: var(--radius-sm);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--bg2) 86%, transparent), color-mix(in srgb, var(--subtle-grad-end) 92%, transparent)),
    var(--bg1);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-3) 0 var(--space-4);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent);
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.expiry-trigger:hover,
.expiry-trigger[aria-expanded="true"] {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--border2));
}
.expiry-trigger:active {
  transform: scale(0.98);
}
.expiry-trigger svg {
  flex: 0 0 auto;
  color: var(--text2);
}
.expiry-value {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.expiry-options {
  position: absolute;
  top: calc(100% + 8px);
  right: 16px;
  z-index: 70;
  width: 204px;
  border: 1px solid color-mix(in srgb, var(--border2) 88%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg1) 94%, transparent);
  padding: var(--space-2);
  box-shadow: 0 18px 40px color-mix(in srgb, var(--shadow) 82%, transparent);
  backdrop-filter: blur(16px);
}
.expiry-options::before {
  content: "";
  position: absolute;
  left: 18px;
  top: 12px;
  bottom: 12px;
  width: 1px;
  background: color-mix(in srgb, var(--border) 82%, transparent);
}
.expiry-options button {
  position: relative;
  width: 100%;
  min-height: 34px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
  padding: var(--space-2) var(--space-2) var(--space-2) 28px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-sm);
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.expiry-options button:hover,
.expiry-options button.active {
  background: color-mix(in srgb, var(--bg2) 86%, transparent);
  color: var(--text);
}
.expiry-options button:active {
  transform: scale(0.98);
}
.option-dot {
  position: absolute;
  left: 10px;
  width: 7px;
  height: 7px;
  border: 1px solid var(--text2);
  border-radius: 50%;
  background: var(--bg1);
}
.expiry-options button.active .option-dot {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
}
.expiry-options button.danger .option-dot {
  border-color: var(--red);
}
.expiry-options button.danger:hover,
.expiry-options button.danger.active {
  background: var(--danger-bg);
  color: var(--red-h);
}
@media (max-width: 600px) {
  .expiry-menu {
    position: fixed;
    z-index: 120;
    left: auto;
    right: 10px;
    bottom: 10px;
    width: min(220px, calc(100vw - 20px));
    padding: 0;
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
    gap: var(--space-2);
    min-height: 34px;
    padding: var(--space-2);
    box-shadow: 0 8px 24px var(--shadow);
    transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  }
  .expiry-mobile-toggle:hover {
    color: var(--text);
    border-color: var(--border2);
  }
  .expiry-mobile-toggle:active {
    transform: scale(0.97);
  }
  .expiry-menu.mobile-collapsed .expiry-mobile-toggle {
    display: inline-flex;
  }
  .expiry-panel {
    display: block;
    min-height: auto;
    border-radius: var(--radius-md);
    background: var(--bg1);
    padding: var(--space-2);
    box-shadow: 0 8px 24px var(--shadow);
    backdrop-filter: none;
  }
  .expiry-menu.mobile-collapsed .expiry-panel {
    display: none;
  }
  .expiry-panel-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: 5px;
  }
  .expiry-trigger {
    width: 100%;
    min-height: auto;
    flex: 0 1 auto;
    border-radius: var(--radius-sm);
    padding: var(--space-2);
  }
  .expiry-options {
    left: 0;
    right: 0;
    top: auto;
    bottom: calc(100% + 6px);
    width: auto;
    border-radius: var(--radius-md);
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
    padding: var(--space-1) var(--space-2);
    transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  }
  .expiry-collapse:hover {
    color: var(--text);
    border-color: var(--border2);
  }
  .expiry-collapse:active {
    transform: scale(0.92);
  }
}
</style>
