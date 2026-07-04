<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminClaim, adminClaimStatus, type AdminClaimStatus } from '../lib/api'
import { usePublicSettings } from '../lib/publicSettings'
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
const { appName, refreshPublicSettings } = usePublicSettings()

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

onMounted(() => {
  void refreshPublicSettings()
  void loadStatus()
})
</script>

<template>
  <main class="claim-wrap">
    <section class="card claim-card">
      <div class="claim-header">
        <div>
          <p class="eyebrow">{{ appName }} admin</p>
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
        <div v-if="error" class="error-box" role="alert">{{ error }}</div>
        <button class="btn-orange" type="submit" :disabled="busy">{{ busy ? 'Claiming…' : 'Claim admin' }}</button>
      </form>
      <div v-else-if="error" class="error-box" role="alert">{{ error }}</div>
    </section>
  </main>
</template>

<style scoped>
.claim-wrap {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  overflow-y: auto;
}
.claim-card {
  position: relative;
  width: min(560px, 100%);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg1) 92%, transparent), color-mix(in srgb, var(--bg) 88%, transparent));
  box-shadow: 0 20px 48px color-mix(in srgb, var(--shadow) 60%, transparent);
}
.claim-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
  margin-bottom: var(--space-4);
}
.claim-header .btn-ghost {
  border-radius: var(--radius-sm);
  transition: transform var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.claim-header .btn-ghost:hover:not(:disabled) { transform: translateY(-1px); }
.claim-header .btn-ghost:active:not(:disabled) { transform: scale(0.98); }
.eyebrow {
  color: var(--accent);
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--space-1);
}
h1 {
  color: var(--text);
  font-size: var(--fs-h1);
  line-height: var(--lh-tight);
  font-weight: 600;
}
.copy {
  color: var(--text2);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  margin-bottom: var(--space-4);
}
.claim-wrap .info-box {
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.claim-form {
  display: grid;
  gap: var(--space-3);
}
label {
  display: grid;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
}
label span {
  color: var(--text2);
}
.claim-form input {
  border-radius: var(--radius-sm);
}
.claim-form input::placeholder {
  color: var(--text2);
}
.error-box {
  border: 1px solid var(--error-border);
  color: var(--red-h);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.btn-orange {
  border-radius: var(--radius-sm);
  transition: transform var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.btn-orange:hover:not(:disabled) { transform: translateY(-1px); }
.btn-orange:active:not(:disabled) { transform: scale(0.98); }
code {
  color: var(--text);
}

@media (max-width: 600px) {
  .claim-wrap { padding: var(--space-3); }
  .claim-card { padding: var(--space-4); }
  .claim-header { flex-direction: column; align-items: stretch; gap: var(--space-3); }
  .claim-header .btn-ghost { width: 100%; min-height: 40px; }
  .claim-form input,
  .btn-orange {
    min-height: 40px;
  }
}
</style>
