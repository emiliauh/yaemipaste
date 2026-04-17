<script setup lang="ts">
defineProps<{ message: string; type?: 'success' | 'error' }>()
</script>

<template>
  <div class="toast" :class="type ?? 'success'">{{ message }}</div>
</template>
