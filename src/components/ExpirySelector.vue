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
const selected = computed(() => options.find((option) => option.value === model.value) ?? options[4])

function choose(value: ExpiryValue) {
  model.value = value
  open.value = false
}
</script>

<template>
  <div class="expiry-menu" data-testid="expiry-menu">
    <div class="expiry-label">Expires</div>
    <button
      class="expiry-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      data-testid="expiry-trigger"
      @click="open = !open"
    >
      <span>{{ selected.label }}</span>
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
        :aria-selected="option.value === model"
        :class="{ active: option.value === model }"
        :data-testid="`expiry-option-${option.value}`"
        @click="choose(option.value)"
      >
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
  width: 170px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 10px;
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
  background: var(--bg2);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
.expiry-options button {
  width: 100%;
  background: transparent;
  color: var(--text2);
  text-align: left;
  padding: 6px 8px;
}
.expiry-options button:hover,
.expiry-options button.active {
  background: var(--bg2);
  color: var(--text);
}

@media (max-width: 600px) {
  .expiry-menu {
    left: 16px;
    right: 16px;
    width: auto;
  }
}
</style>
