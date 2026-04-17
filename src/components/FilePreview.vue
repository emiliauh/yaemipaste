<script setup lang="ts">
import { computed } from 'vue'
import { type PasteFile, fileUrl } from '../lib/api'

const props = defineProps<{ file: PasteFile }>()
const emit = defineEmits<{ close: [] }>()

const url = computed(() => fileUrl(props.file.file_name))
const isImage = computed(() => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(props.file.file_name))
const isVideo = computed(() => /\.(mp4|webm|mov)$/i.test(props.file.file_name))
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">{{ file.file_name }}</span>
        <button class="btn-ghost" style="padding:2px 8px" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <img v-if="isImage" :src="url" class="preview-img" />
        <video v-else-if="isVideo" :src="url" controls class="preview-video" />
      </div>
      <div class="modal-footer">
        <a :href="url" target="_blank" rel="noopener" class="link">Open in tab</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--bg1);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 300px;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text2);
}
.modal-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }
.modal-body {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.preview-img { max-width: 100%; max-height: 70vh; object-fit: contain; }
.preview-video { max-width: 100%; max-height: 70vh; }
.modal-footer {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.link { color: var(--text2); text-decoration: none; }
.link:hover { color: var(--text); }
</style>
