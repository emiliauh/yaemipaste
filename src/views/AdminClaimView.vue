<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminClaim, adminClaimStatus, type AdminClaimStatus } from '../lib/api'
import { useNotificationStore } from '../stores/notifications'

const router = useRouter()
const notifications = useNotificationStore()
const status = ref<AdminClaimStatus | null>(null)
const loading = ref(true)
const busy = ref(false)
const claimToken = ref('')
const username = ref('')
const password = ref('')
const uploadToken = ref('')
const error = ref('')

async function loadStatus() {
  loading.value = true
  error.value = ''
  try {
    status.value = await adminClaimStatus()
  } catch (e: any) {
    error.value = e.message ?? 'Could not load claim status'
  } finally {
    loading.value = false
  }
}

async function submitClaim() {
  if (!claimToken.value.trim() || !username.value.trim() || !password.value) {
    error.value = 'Claim token, username, and password are required'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await adminClaim(claimToken.value.trim(), username.value.trim(), password.value, uploadToken.value.trim())
    notifications.push('Admin access claimed', 'success')
    router.push('/admin')
  } catch (e: any) {
    error.value = e.message ?? 'Admin claim failed'
  } finally {
    busy.value = false
  }
}

onMounted(loadStatus)
</script>

<template>
  <main class="claim-wrap">
    <section class="card claim-card">
      <div class="claim-header">
        <div>
          <p class="eyebrow">yaemipaste admin</p>
          <h1>Claim administrator access</h1>
        </div>
        <button class="btn-ghost" type="button" @click="router.push('/login')">Login</button>
      </div>

      <p class="copy">
        Use the one-time claim token printed by <code>install.sh</code>. The token is validated server-side,
        consumed after a successful claim, and never stored in plaintext.
      </p>

      <div v-if="loading" class="info-box">Loading claim status…</div>
      <div v-else-if="status?.admin_exists" class="info-box">
        Admin access has already been claimed. Sign in with an administrator account.
      </div>
      <div v-else-if="!status?.claim_available" class="info-box">
        No active claim token exists. Run <code>./install.sh --action admin-claim</code> on the server.
      </div>

      <form v-if="status?.claim_available" class="claim-form" @submit.prevent="submitClaim">
        <label>
          Claim token
          <input v-model="claimToken" autocomplete="one-time-code" placeholder="Paste the one-time claim token" />
        </label>
        <label>
          Admin username
          <input v-model="username" autocomplete="username" placeholder="admin" />
        </label>
        <label>
          Admin password
          <input v-model="password" autocomplete="new-password" type="password" placeholder="At least 6 characters" />
        </label>
        <label>
          Custom upload token <span>(optional)</span>
          <input v-model="uploadToken" autocomplete="off" placeholder="Leave blank to generate" />
        </label>
        <div v-if="error" class="error-box">{{ error }}</div>
        <button class="btn-orange" type="submit" :disabled="busy">{{ busy ? 'Claiming…' : 'Claim admin' }}</button>
      </form>
      <div v-else-if="error" class="error-box">{{ error }}</div>
    </section>
  </main>
</template>

<style scoped>
.claim-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.claim-card {
  width: min(560px, 100%);
}
.claim-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}
.eyebrow {
  color: var(--accent);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
}
h1 {
  color: var(--text);
  font-size: 18px;
  font-weight: 400;
}
.copy {
  color: var(--text2);
  margin-bottom: 16px;
}
.claim-form {
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 5px;
  color: var(--text2);
  font-size: 11px;
}
label span {
  color: var(--text3);
}
.error-box {
  border: 1px solid var(--error-border);
  background: var(--danger-bg);
  color: var(--red-h);
  border-radius: var(--radius);
  padding: 10px 12px;
  font-size: 12px;
}
code {
  color: var(--text);
}
</style>
