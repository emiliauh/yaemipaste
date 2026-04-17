<script setup lang="ts">
import { computed, ref } from 'vue'

export type ExpiryValue = '12h' | '1d' | '3d' | '7d' | '14d'

const options: Array<{ value: ExpiryValue; label: string }> = [
  { value: '12h', label: '12 hours' },
  { value: '1d', label: '1 day' },
  { value: '3d', label: '3 days' },
  { value: '7d', label: '7 days' },
  { value: '14d', label: '14 days' },
]

const model = defineModel<ExpiryValue>({ required: true })
const open = ref(false)
const selectedValue = computed(() => model.value)
const selected = computed(() => options.find((option) => option.value === model.value) ?? options[4])

function choose(value: ExpiryValue) {
  model.value = value
  open.value = false
}
</script>

<template>
  <div class="expiry-menu" data-testid="expiry-menu">
    <div class="expiry-label">Keep for</div>
    <button
      class="expiry-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      data-testid="expiry-trigger"
      @click="open = !open"
    >
      <span class="expiry-value">{{ selected.label }}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>

    <div v-if="open" class="expiry-options" role="listbox" data-testid="expiry-options">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === selectedValue"
        :class="{ active: option.value === selectedValue }"
        :data-testid="`expiry-option-${option.value}`"
        @click="choose(option.value)"
      >
        <span class="option-dot"></span>
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.expiry-menu {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 60;
  width: 178px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 9px;
  box-shadow: 0 8px 24px #00000066;
}
.expiry-label {
  color: var(--text3);
  font-size: 10px;
  margin-bottom: 5px;
  text-transform: uppercase;
}
.expiry-trigger {
  width: 100%;
  border: 1px solid var(--border2);
  background:
    linear-gradient(90deg, #1a1a1a, #111111);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
}
.expiry-value {
  color: var(--accent-h);
}
.expiry-options {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
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
  background: var(--bg2);
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

@media (max-width: 600px) {
  .expiry-menu {
    left: 16px;
    right: 16px;
    width: auto;
  }
}
</style>
