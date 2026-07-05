<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authRegister, authLogin } from '../lib/api'
import { isAuthEnabled } from '../lib/features'

const router = useRouter()

const username = ref('')
const password = ref('')
const confirm = ref('')
const token = ref('')
const error = ref('')
const loading = ref(false)
const tokenUsed = ref(false)
let restoreBodyOverflow = ''
let restoreHtmlOverflow = ''

onMounted(() => {
  if (!isAuthEnabled()) {
    router.replace('/files')
    return
  }
  restoreBodyOverflow = document.body.style.overflow
  restoreHtmlOverflow = document.documentElement.style.overflow
  document.body.style.overflow = 'hidden'
  document.documentElement.style.overflow = 'hidden'
})

onBeforeUnmount(() => {
  document.body.style.overflow = restoreBodyOverflow
  document.documentElement.style.overflow = restoreHtmlOverflow
})

async function submit() {
  error.value = ''
  tokenUsed.value = false
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
    const message = e.message ?? 'Registration failed'
    if (message.toLowerCase().includes('token already')) {
      error.value = 'Token already used.'
      tokenUsed.value = true
    } else {
      error.value = message
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="center" data-testid="register-center">
      <div class="card register-card">
        <h2 class="register-title">Create Account</h2>

        <form @submit.prevent="submit">
          <div class="field">
            <label for="register-username">Username</label>
            <input id="register-username" v-model="username" type="text" autocomplete="username" autofocus placeholder="username" required />
          </div>

          <div class="field">
            <label for="register-password">Password</label>
            <input id="register-password" v-model="password" type="password" autocomplete="new-password" placeholder="••••••••" required />
          </div>

          <div class="field">
            <label for="register-confirm">Confirm Password</label>
            <input id="register-confirm" v-model="confirm" type="password" autocomplete="new-password" placeholder="••••••••" required />
          </div>

          <div class="field">
            <label for="register-token">Auth Token</label>
            <p class="field-hint">Enter a valid token to register. It will be associated with your account.</p>
            <input id="register-token" v-model="token" type="text" autocomplete="off" placeholder="your-token" required />
          </div>

          <div v-if="error" class="error-msg" role="alert">
            <span>{{ error }}</span>
            <router-link v-if="tokenUsed" to="/login" class="inline-link">Do you have an account?</router-link>
          </div>

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
.page {
  height: 100dvh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  overflow-y: auto;
}
.center {
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.register-card {
  position: relative;
  width: 100%;
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg1) 92%, transparent), color-mix(in srgb, var(--bg) 88%, transparent));
  box-shadow: 0 20px 48px color-mix(in srgb, var(--shadow) 60%, transparent);
}
.register-title {
  font-size: var(--fs-h1);
  line-height: var(--lh-tight);
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--space-4);
}
.field { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.field label { color: var(--text); font-size: var(--fs-sm); line-height: var(--lh-tight); }
.field-hint { color: var(--text2); font-size: var(--fs-xs); line-height: var(--lh-body); }
.field input {
  width: 100%;
  border-radius: var(--radius-sm);
}
.field input::placeholder { color: var(--text2); }
.form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}
.form-footer button {
  border-radius: var(--radius-sm);
  transition: transform var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.form-footer button:hover:not(:disabled) { transform: translateY(-1px); }
.form-footer button:active:not(:disabled) { transform: scale(0.98); }
.error-msg {
  color: var(--red-h);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin-bottom: var(--space-3);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.inline-link {
  color: var(--text2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-xs);
  text-decoration: none;
  transition: border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.inline-link:hover {
  border-color: var(--text3);
  color: var(--text);
}
.inline-link:active { transform: scale(0.98); }
.link {
  color: var(--text2);
  font-size: var(--fs-sm);
  text-decoration: none;
  display: inline-block;
  transition: color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.link:hover { color: var(--text); transform: translateY(-1px); }
.link:active { transform: scale(0.98); }

@media (max-width: 600px) {
  .page { padding: var(--space-3); }
  .register-card { padding: var(--space-4); }
  .field input,
  .form-footer button,
  .inline-link {
    min-height: calc(var(--space-6) + var(--space-2));
  }
  .form-footer { flex-direction: column; align-items: stretch; }
  .form-footer > * { width: 100%; text-align: center; justify-content: center; }
}
</style>
