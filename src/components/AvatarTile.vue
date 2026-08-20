<script setup lang="ts">
import { computed } from 'vue'
import { avatarGlyph, type AvatarPrefs } from '../lib/avatar'

const props = withDefaults(defineProps<{
  name: string
  prefs: AvatarPrefs
  /** sm = round tile for sidebars, lg = rounded square for profile cards. */
  size?: 'sm' | 'lg'
}>(), {
  size: 'sm',
})

const showImage = computed(() => !!props.prefs.image)
</script>

<template>
  <span class="avatar-tile" :class="size" :style="{ background: prefs.color }" aria-hidden="true">
    <img v-if="showImage" :src="prefs.image ?? undefined" alt="" />
    <span v-else class="avatar-glyph">{{ avatarGlyph(name) }}</span>
  </span>
</template>

<style scoped>
.avatar-tile {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: none;
  color: #ffffff;
  user-select: none;
}
.avatar-tile.sm {
  width: 28px;
  height: 28px;
  min-height: 28px;
  border-radius: 50%;
}
.avatar-tile.lg {
  width: 64px;
  height: 64px;
  min-height: 64px;
  border-radius: var(--radius-md);
}
.avatar-glyph {
  font-weight: 650;
  letter-spacing: 0.02em;
  line-height: 1;
}
.avatar-tile.sm .avatar-glyph {
  font-size: 11px;
}
.avatar-tile.lg .avatar-glyph {
  font-size: 22px;
}
.avatar-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
