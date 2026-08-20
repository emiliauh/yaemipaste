<script setup lang="ts">
defineProps<{
  active: boolean
  /** 1 = ascending, -1 = descending. */
  dir: 1 | -1
}>()
</script>

<template>
  <svg
    class="sort-arrow"
    :class="{ active, desc: dir === -1 }"
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path class="sort-up" d="m5.5 6.2 2.5-2.7 2.5 2.7" />
    <path class="sort-down" d="m5.5 9.8 2.5 2.7 2.5-2.7" />
  </svg>
</template>

<style scoped>
.sort-arrow {
  width: 12px;
  height: 12px;
  flex: none;
  margin-left: 2px;
  vertical-align: -1px;
  fill: none;
  stroke: var(--text3);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sort-arrow .sort-up,
.sort-arrow .sort-down {
  opacity: 0.4;
}
.sort-arrow.active {
  stroke: var(--accent);
}
.sort-arrow.active .sort-up,
.sort-arrow.active .sort-down {
  opacity: 0.3;
}
.sort-arrow.active:not(.desc) .sort-up,
.sort-arrow.active.desc .sort-down {
  opacity: 1;
}
</style>
