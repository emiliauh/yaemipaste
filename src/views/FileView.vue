<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import EncryptedFileView from './EncryptedFileView.vue'
import PublicFilePreviewView from './PublicFilePreviewView.vue'

const route = useRoute()
const isEncrypted = computed(() => String(route.params.filekey ?? '').includes('+'))
</script>

<template>
  <EncryptedFileView v-if="isEncrypted" />
  <PublicFilePreviewView v-else />
</template>
