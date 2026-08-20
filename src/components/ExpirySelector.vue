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
let openedAt = 0

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

defineExpose({ collapse: collapseMobile })

function onTriggerClick(event: MouseEvent) {
  if (event.shiftKey) {
    revealNever.value = true
    open.value = true
    openedAt = performance.now()
    return
  }
  open.value = !open.value
  if (open.value) openedAt = performance.now()
}

function onPointerDown(event: PointerEvent) {
  if (!open.value) return
  const target = event.target as Node | null
  if (menuRef.value && target && !menuRef.value.contains(target)) {
    open.value = false
  }
}

function onUserScroll(event: Event) {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && menuRef.value?.contains(target)) return
  if (performance.now() - openedAt < 300) return
  open.value = false
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    open.value = false
    mobileCollapsed.value = true
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('wheel', onUserScroll, { passive: true, capture: true })
  window.addEventListener('touchmove', onUserScroll, { passive: true, capture: true })
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('wheel', onUserScroll, { capture: true })
  window.removeEventListener('touchmove', onUserScroll, { capture: true })
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
        @click.stop="onTriggerClick"
      >
        <span class="expiry-value">{{ selected.label }}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <Transition name="expiry-options-fade">
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
      </Transition>
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
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  min-height: 58px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  box-shadow: var(--shadow-sm);
  animation: expiry-panel-in 260ms var(--ease-out) both;
}
@keyframes expiry-panel-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
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
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: var(--lh-tight);
  text-transform: none;
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
  flex: 0 0 184px;
  min-height: 40px;
  border: 1px solid color-mix(in srgb, var(--border2) 90%, transparent);
  border-radius: var(--radius-sm);
  background: var(--bg2);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-3) 0 var(--space-4);
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.expiry-trigger:hover,
.expiry-trigger[aria-expanded="true"] {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--border2));
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
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.expiry-options {
  position: absolute;
  /* Anchor to the trigger row, rather than the full panel.  The panel also
     contains the helper copy, so using 100% left an unnecessary visual gap. */
  top: 60px;
  right: 12px;
  z-index: 70;
  width: 184px;
  border: 1px solid color-mix(in srgb, var(--border2) 88%, transparent);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: var(--space-2);
  box-shadow: var(--shadow-md);
}
.expiry-options-fade-enter-active {
  transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out);
}
.expiry-options-fade-leave-active {
  transition: none;
}
.expiry-options-fade-enter-from,
.expiry-options-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
@media (prefers-reduced-motion: reduce) {
  .expiry-panel,
  .expiry-options-fade-enter-active {
    transition: none;
  }
}
.expiry-options button {
  position: relative;
  width: 100%;
  min-height: 34px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
  padding: var(--space-2) var(--space-3);
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
.option-dot {
  display: none;
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
.expiry-options button.active::after {
  content: "✓";
  margin-left: auto;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
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
    width: 100%;
  }
  .expiry-menu.mobile-collapsed {
    width: auto;
    align-self: flex-start;
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
  .expiry-menu.mobile-collapsed .expiry-mobile-toggle {
    display: inline-flex;
  }
  .expiry-panel {
    display: block;
    min-height: auto;
    max-height: 220px;
    /* Keep the listbox reachable below the trigger on touch screens.  The
       old clipped panel made the control look like it did nothing when the
       options were actually rendered outside the panel's bounds. */
    overflow: visible;
    border-radius: var(--radius-md);
    background: var(--bg1);
    padding: var(--space-2);
    box-shadow: 0 8px 24px var(--shadow);
    backdrop-filter: none;
    opacity: 1;
    transition: max-height 220ms var(--ease-out), opacity 180ms var(--ease-out), padding 220ms var(--ease-out), border-color 220ms var(--ease-out);
  }
  .expiry-menu.mobile-collapsed .expiry-panel {
    display: none;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-width: 0;
    border-color: transparent;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
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
    top: calc(100% + 4px);
    left: 0;
    right: 0;
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
@media (prefers-reduced-motion: reduce) {
  .expiry-panel {
    transition: none;
  }
}
@media (min-width: 601px) {
  .expiry-panel {
    align-items: center;
    min-height: 84px;
  }
  .expiry-label {
    font-size: var(--fs-sm);
    letter-spacing: 0.15em;
  }
  .expiry-tip {
    font-size: var(--fs-sm);
  }
  .expiry-tip kbd {
    font-size: var(--fs-xs);
    padding: 2px 6px 3px;
  }
}
</style>
