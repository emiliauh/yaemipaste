<script setup lang="ts">
defineProps<{ message: string; type?: 'success' | 'error' }>()
</script>

<template>
  <Transition name="toast-pop" appear>
    <div class="toast" :class="type ?? 'success'" role="status" :aria-live="type === 'error' ? 'assertive' : 'polite'">{{ message }}</div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: var(--space-5);
  right: var(--space-5);
  background: var(--bg1);
  border: 1px solid var(--border2);
  border-left: 3px solid var(--border2);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  color: var(--text);
  box-shadow: 0 8px 20px var(--shadow);
  z-index: 1000;
  max-width: min(320px, calc(100vw - var(--space-6)));
}

.toast.success { border-left-color: var(--green); }
.toast.error   { border-left-color: var(--red-h); }

.toast-pop-enter-active,
.toast-pop-leave-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.toast-pop-enter-from,
.toast-pop-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 600px) {
  .toast {
    left: var(--space-3);
    right: var(--space-3);
    bottom: var(--space-3);
    max-width: none;
  }
}
</style>
