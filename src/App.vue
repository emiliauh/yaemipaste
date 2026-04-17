<script setup lang="ts">
import NotificationStack from './components/NotificationStack.vue'

const repoUrl = (import.meta.env.VITE_REPOSITORY_URL ?? 'https://github.com/emiliauh/yaemipaste').trim()
</script>

<template>
  <router-view />
  <a
    v-if="repoUrl"
    class="github-link"
    :href="repoUrl"
    target="_blank"
    rel="noopener"
    aria-label="Project repository on GitHub"
    title="GitHub"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .5A11.5 11.5 0 0 0 .5 12.22a11.73 11.73 0 0 0 7.86 11.18c.58.11.79-.25.79-.56v-2.01c-3.2.71-3.88-1.58-3.88-1.58-.52-1.36-1.28-1.72-1.28-1.72-1.05-.73.08-.71.08-.71 1.16.08 1.77 1.22 1.77 1.22 1.03 1.81 2.7 1.29 3.36.99.1-.77.4-1.29.72-1.58-2.55-.3-5.23-1.31-5.23-5.84 0-1.29.45-2.34 1.19-3.17-.12-.3-.52-1.5.11-3.14 0 0 .97-.32 3.19 1.21a10.9 10.9 0 0 1 5.81 0c2.22-1.53 3.19-1.21 3.19-1.21.63 1.64.23 2.84.11 3.14.74.83 1.19 1.88 1.19 3.17 0 4.54-2.68 5.54-5.24 5.84.41.36.78 1.06.78 2.13v3.16c0 .31.21.68.8.56a11.73 11.73 0 0 0 7.85-11.18A11.5 11.5 0 0 0 12 .5Z"
      />
    </svg>
  </a>
  <NotificationStack />
</template>

<style scoped>
.github-link {
  position: fixed;
  left: 14px;
  bottom: 12px;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  background: var(--bg1);
  box-shadow: 0 2px 10px var(--shadow);
  z-index: 60;
}

.github-link:hover {
  color: var(--accent-h);
  border-color: var(--accent);
}

.github-link svg {
  width: 16px;
  height: 16px;
}
</style>
