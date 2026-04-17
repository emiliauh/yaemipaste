<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { authLogin } from '../lib/api'

const router = useRouter()

// mode: 'account' = username+password, 'token' = raw token (legacy)
const mode = ref<'account' | 'token'>('account')

const username = ref('')
const password = ref('')
const token = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    if (mode.value === 'account') {
      await authLogin(username.value.trim(), password.value)
    } else {
      // Legacy: store token directly, no account needed
      if (!token.value.trim()) throw new Error('Token is required')
      localStorage.setItem('rp_token', token.value.trim())
      localStorage.setItem('rp_username', 'token-user')
    }
    router.push('/files')
  } catch (e: any) {
    error.value = e.message ?? 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <button class="gear-btn" disabled style="opacity:0;pointer-events:none">⚙</button>

    <div class="center">
      <div class="info-box" style="margin-bottom:16px; max-width:400px">
        <span class="icon">ⓘ</span>
        <span>
          Authentication Required<br>
          <span style="color:var(--text3)">Sign in with your account, or enter a token directly.</span>
        </span>
      </div>

      <div class="card" style="width:400px; max-width:calc(100vw - 32px)">
        <div class="tabs" style="margin-bottom:16px">
          <button :class="{ active: mode === 'account' }" @click="mode = 'account'">Account</button>
          <button :class="{ active: mode === 'token' }" @click="mode = 'token'">Token</button>
        </div>

        <form @submit.prevent="submit">
          <template v-if="mode === 'account'">
            <div class="field">
              <label>Username</label>
              <input v-model="username" type="text" autocomplete="username" autofocus placeholder="username" required />
            </div>
            <div class="field">
              <label>Password</label>
              <input v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" required />
            </div>
          </template>

          <template v-else>
            <div class="field">
              <label>Auth Token</label>
              <p class="field-hint">Your token will be stored on your device until you logout.</p>
              <input v-model="token" type="text" autocomplete="off" autofocus placeholder="enter token" required />
            </div>
          </template>

          <div v-if="error" class="error-msg">{{ error }}</div>

          <div class="form-footer">
            <button type="submit" class="btn-primary" :disabled="loading">
              {{ loading ? 'Logging in…' : 'Login' }}
            </button>
            <router-link v-if="mode === 'account'" to="/register" class="link">Register</router-link>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.center { display: flex; flex-direction: column; align-items: center; }
.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.field label { color: var(--text); font-size: 12px; }
.field-hint { color: var(--text3); font-size: 11px; margin-top: -2px; }
.field input { width: 100%; }
.form-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.error-msg { color: var(--red-h); font-size: 12px; margin-bottom: 10px; }
.link { color: var(--text2); font-size: 12px; text-decoration: none; }
.link:hover { color: var(--text); }
</style>
