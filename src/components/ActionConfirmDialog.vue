<script setup lang="ts">
defineProps<{
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  acknowledgement?: string
  busy?: boolean
  danger?: boolean
}>()

const acknowledged = defineModel<boolean>('acknowledged', { default: false })
const emit = defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <div class="action-confirm-backdrop" @click.self="emit('close')">
    <div class="action-confirm" role="dialog" aria-modal="true" aria-labelledby="action-confirm-title">
      <div class="action-confirm-icon" :class="{ danger }" aria-hidden="true">!</div>
      <div class="action-confirm-header">
        <strong id="action-confirm-title">{{ title }}</strong>
        <button class="btn-ghost action-confirm-close" :disabled="busy" aria-label="Close confirmation" @click="emit('close')">✕</button>
      </div>
      <p class="action-confirm-message">{{ message }}</p>
      <div v-if="detail" class="action-confirm-detail">{{ detail }}</div>
      <label class="action-confirm-ack">
        <input v-model="acknowledged" type="checkbox" :disabled="busy" />
        <span>{{ acknowledgement ?? 'I understand that this action cannot be undone.' }}</span>
      </label>
      <div class="action-confirm-actions">
        <button class="btn-ghost" :disabled="busy" @click="emit('close')">Cancel</button>
        <button
          :class="danger ? 'btn-red' : 'btn-primary'"
          :disabled="busy || !acknowledged"
          @click="emit('confirm')"
        >
          <span v-if="busy" class="action-confirm-busy">Working…</span>
          <span v-else>{{ confirmLabel ?? 'Confirm' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.action-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--modal-bg);
}
.action-confirm {
  width: min(460px, calc(100vw - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  padding: var(--space-5);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 90%, transparent);
}
.action-confirm-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text);
  background: var(--bg);
  font-weight: 700;
}
.action-confirm-icon.danger {
  border-color: color-mix(in srgb, var(--red) 55%, var(--border));
  color: var(--red-h);
  background: var(--danger-bg);
}
.action-confirm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}
.action-confirm-header strong {
  color: var(--text);
  font-size: var(--fs-h2);
}
.action-confirm-close {
  min-width: 30px;
  min-height: 30px;
  padding: var(--space-1) var(--space-2);
}
.action-confirm-message,
.action-confirm-detail {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.action-confirm-detail {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.action-confirm-ack {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-4);
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  cursor: pointer;
}
.action-confirm-ack input {
  flex: 0 0 auto;
  margin-top: 2px;
}
.action-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
}
.action-confirm-busy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
@media (max-width: 600px) {
  .action-confirm {
    padding: var(--space-4);
  }
  .action-confirm-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .action-confirm-actions button {
    width: 100%;
  }
}
</style>
