<script setup lang="ts">
defineProps<{
  open: boolean
  appName: string
}>()

const emit = defineEmits<{ close: [], confirm: [] }>()
</script>

<template>
  <div v-if="open" class="confirm-backdrop" data-testid="account-logout-confirm" @click.self="emit('close')">
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="account-logout-title">
      <div class="confirm-icon" aria-hidden="true">!</div>
      <div class="confirm-header">
        <strong id="account-logout-title">Log out of {{ appName }}?</strong>
        <button class="btn-ghost confirm-close" type="button" aria-label="Close confirmation" @click="emit('close')">✕</button>
      </div>
      <p class="confirm-message">You'll need to sign in again to upload files and manage your account.</p>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" data-testid="account-logout-confirm-cancel" @click="emit('close')">Cancel</button>
        <button class="btn-red" type="button" data-testid="account-logout-confirm-submit" @click="emit('confirm')">Log out</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--modal-bg);
}
.confirm-dialog {
  position: relative;
  width: min(440px, calc(100vw - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  padding: var(--space-5);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 90%, transparent);
}
.confirm-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--red) 55%, var(--border));
  border-radius: var(--radius-full);
  color: var(--red-h);
  background: var(--danger-bg);
  font-weight: 700;
}
.confirm-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding-right: var(--space-6);
}
.confirm-header strong {
  color: var(--text);
  font-size: var(--fs-h2);
  font-weight: 600;
  line-height: var(--lh-tight);
}
.confirm-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  font-size: var(--fs-sm);
  border: 0;
  background: transparent;
  color: var(--text3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
}
.confirm-close:hover {
  background: var(--bg2);
  color: var(--text);
}
.confirm-message {
  margin-top: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
