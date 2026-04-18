<script setup lang="ts">
import { useRoute } from 'vue-router'
import { decodeFileToken, publicFileUrl } from '../lib/api'

const route = useRoute()
const filePart = String(route.params.filekey ?? '').split('+')[0]
window.location.replace(`${publicFileUrl(decodeFileToken(filePart))}?raw=1`)
</script>

<template></template>
