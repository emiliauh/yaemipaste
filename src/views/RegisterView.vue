<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { authRegister, authLogin } from '../lib/api'

const router = useRouter()

const username = ref('')
const password = ref('')
const confirm = ref('')
const token = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match'
    return
  }
  if (password.value.length < 6) {
    error.value = 'Password must be at least 6 characters'
    return
  }
  loading.value = true
  try {
    await authRegister(username.value.trim(), password.value, token.value.trim())
    // Auto-login after register
    await authLogin(username.value.trim(), password.value)
    router.push('/files')
  } catch (e: any) {
    error.value = e.message ?? 'Registration failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="center">
      <div class="card" style="width:400px; max-width:calc(100vw - 32px)">
        <h2 style="font-size:14px; font-weight:normal; margin-bottom:16px; color:var(--text)">Create Account</h2>

        <form @submit.prevent="submit">
          <div class="field">
            <label>Username</label>
            <input v-model="username" type="text" autocomplete="username" autofocus placeholder="username" required />
          </div>

          <div class="field">
            <label>Password</label>
            <input v-model="password" type="password" autocomplete="new-password" placeholder="••••••••" required />
          </div>

          <div class="field">
            <label>Confirm Password</label>
            <input v-model="confirm" type="password" autocomplete="new-password" placeholder="••••••••" required />
          </div>

          <div class="field">
            <label>Auth Token</label>
            <p class="field-hint">Enter a valid token to register. It will be associated with your account.</p>
            <input v-model="token" type="text" autocomplete="off" placeholder="your-token" required />
          </div>

          <div v-if="error" class="error-msg">{{ error }}</div>

          <div class="form-footer">
            <button type="submit" class="btn-primary" :disabled="loading">
              {{ loading ? 'Creating…' : 'Create Account' }}
            </button>
            <router-link to="/login" class="link">Back to login</router-link>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.center { display: flex; flex-direction: column; align-items: center; }
.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.field label { color: var(--text); font-size: 12px; }
.field-hint { color: var(--text3); font-size: 11px; }
.field input { width: 100%; }
.form-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.error-msg { color: var(--red-h); font-size: 12px; margin-bottom: 10px; }
.link { color: var(--text2); font-size: 12px; text-decoration: none; }
.link:hover { color: var(--text); }
</style>
