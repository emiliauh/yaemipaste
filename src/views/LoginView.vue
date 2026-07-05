<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  authLogin,
  authPasskeyLoginBegin,
  authPasskeyLoginFinish,
  authTokenStatus,
  getRememberPreference,
  loginWithToken,
  setRememberPreference,
} from '../lib/api'
import { credentialToJson, isPasskeySupported, toRequestOptions } from '../lib/passkeys'
import { isAuthEnabled } from '../lib/features'

const router = useRouter()
const TURNSTILE_SITE_KEY = (
  import.meta.env.VITE_TURNSTILE_SITE_KEY
  ?? ''
).trim()

// mode: 'account' = username+password, 'token' = raw token (legacy)
const mode = ref<'account' | 'token'>('account')

const username = ref('')
const password = ref('')
const token = ref('')
const error = ref('')
const loading = ref(false)
const passkeyLoading = ref(false)
const rememberMe = ref(getRememberPreference())
const showPassword = ref(false)
const tokenUsed = ref(false)
const turnstileContainer = ref<HTMLElement | null>(null)
const turnstileToken = ref('')
const turnstileWidgetId = ref<string | number | null>(null)
let restoreBodyOverflow = ''
let restoreHtmlOverflow = ''

type TurnstileWidgetId = string | number
interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => TurnstileWidgetId
  execute: (id: TurnstileWidgetId) => void
  reset: (id: TurnstileWidgetId) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

watch(rememberMe, (value) => setRememberPreference(value))
watch(mode, () => {
  error.value = ''
  tokenUsed.value = false
})

function setError(message: string, usedToken = false) {
  error.value = message
  tokenUsed.value = usedToken
}

async function ensureTurnstileToken(): Promise<string> {
  if (!TURNSTILE_SITE_KEY) return ''
  if (!window.turnstile || turnstileWidgetId.value == null) throw new Error('Security check is not ready.')
  if (!turnstileToken.value) throw new Error('Please complete the security check before logging in.')
  return turnstileToken.value
}

function resetTurnstileToken() {
  if (!TURNSTILE_SITE_KEY || !window.turnstile || turnstileWidgetId.value == null) return
  window.turnstile.reset(turnstileWidgetId.value)
  turnstileToken.value = ''
}

async function mountTurnstile() {
  if (!TURNSTILE_SITE_KEY || !turnstileContainer.value) return
  if (!document.querySelector('script[data-turnstile]')) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      script.dataset.turnstile = '1'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Security check failed to load'))
      document.head.appendChild(script)
    })
  } else if (!window.turnstile) {
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (window.turnstile) resolve()
        else if (Date.now() - start > 5_000) reject(new Error('Security check failed to initialize'))
        else setTimeout(check, 50)
      }
      check()
    })
  }
  if (!window.turnstile || turnstileWidgetId.value != null) return
  turnstileWidgetId.value = window.turnstile.render(turnstileContainer.value, {
    sitekey: TURNSTILE_SITE_KEY,
    callback: (tokenValue: string) => {
      turnstileToken.value = tokenValue
    },
    'expired-callback': () => {
      turnstileToken.value = ''
    },
    'error-callback': () => {
      turnstileToken.value = ''
      setError('Security check failed. Reload and try again.')
    },
  })
}

function goToAccountLogin() {
  mode.value = 'account'
}

onMounted(() => {
  if (!isAuthEnabled()) {
    router.replace('/files')
    return
  }
  restoreBodyOverflow = document.body.style.overflow
  restoreHtmlOverflow = document.documentElement.style.overflow
  document.body.style.overflow = 'hidden'
  document.documentElement.style.overflow = 'hidden'
  void mountTurnstile().catch((e: any) => {
    setError(e?.message ?? 'Security check failed to load')
  })
})

onBeforeUnmount(() => {
  document.body.style.overflow = restoreBodyOverflow
  document.documentElement.style.overflow = restoreHtmlOverflow
})

async function submit() {
  setError('')
  loading.value = true
  try {
    if (mode.value === 'account') {
      const captchaToken = await ensureTurnstileToken()
      await authLogin(username.value.trim(), password.value, {
        rememberMe: rememberMe.value,
        turnstileToken: captchaToken,
      })
      resetTurnstileToken()
    } else {
      if (!token.value.trim()) throw new Error('Token is required')
      const status = await authTokenStatus(token.value.trim())
      if (status === 'used') {
        setError('Token already used.', true)
        return
      }
      if (status === 'invalid') throw new Error('Invalid token')
      loginWithToken(token.value.trim(), rememberMe.value)
    }
    router.push('/files')
  } catch (e: any) {
    setError(e.message ?? 'Login failed')
    resetTurnstileToken()
  } finally {
    loading.value = false
  }
}

async function loginWithPasskey() {
  if (mode.value !== 'account') {
    setError('Passkeys are available in Account mode only')
    return
  }
  if (!username.value.trim()) {
    setError('Username is required for passkey login')
    return
  }
  if (!isPasskeySupported()) {
    setError('Passkeys are not supported in this browser')
    return
  }
  setError('')
  passkeyLoading.value = true
  try {
    const options = await authPasskeyLoginBegin(username.value.trim())
    const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
    if (!(credential instanceof PublicKeyCredential)) throw new Error('Could not read passkey credential')
    await authPasskeyLoginFinish(username.value.trim(), credentialToJson(credential), rememberMe.value)
    router.push('/files')
  } catch (e: any) {
    setError(e.message ?? 'Passkey login failed')
  } finally {
    passkeyLoading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="center" data-testid="login-center">
      <div class="info-box login-info">
        <span class="icon">ⓘ</span>
        <span>
          Authentication Required<br>
          <span style="color:var(--text2)">Sign in with your account, or enter a token directly.</span>
        </span>
      </div>

      <div class="card login-card">
        <div class="tabs login-tabs">
          <button :class="{ active: mode === 'account' }" @click="mode = 'account'">Account</button>
          <button :class="{ active: mode === 'token' }" @click="mode = 'token'">Token</button>
        </div>

        <form @submit.prevent="submit">
          <template v-if="mode === 'account'">
            <div class="field">
              <label for="login-username">Username</label>
              <input id="login-username" v-model="username" type="text" autocomplete="username" autofocus placeholder="username" required />
            </div>
            <div class="field">
              <label for="login-password">Password</label>
              <div class="password-wrap">
                <input
                  id="login-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  class="password-toggle"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  :title="showPassword ? 'Hide password' : 'Show password'"
                  @click="showPassword = !showPassword"
                >
                  <svg v-if="showPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M3 3l18 18"/>
                    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>
                    <path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5.3 0 9.5 4.2 10.5 8-.4 1.6-1.5 3.3-3 4.8"/>
                    <path d="M6.2 6.2C4.3 7.7 2.9 9.8 2 12c1 3.8 5.2 8 10 8 1 0 2-.2 2.9-.5"/>
                  </svg>
                  <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M2 12s3.8-8 10-8 10 8 10 8-3.8 8-10 8-10-8-10-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="field">
              <label for="login-token">Auth Token</label>
              <p class="field-hint">Your token will be stored on your device until you logout.</p>
              <input id="login-token" v-model="token" type="text" autocomplete="off" autofocus placeholder="enter token" required />
            </div>
          </template>

          <label class="remember-toggle">
            <input v-model="rememberMe" type="checkbox" />
            <span>remember me</span>
          </label>

          <div v-if="TURNSTILE_SITE_KEY" ref="turnstileContainer" class="turnstile-container"></div>

          <div v-if="error" class="error-msg" role="alert">
            <span>{{ error }}</span>
            <button v-if="tokenUsed" type="button" class="inline-link" @click="goToAccountLogin">Do you have an account?</button>
          </div>

          <div class="form-footer">
            <button type="submit" class="btn-primary" :disabled="loading">
              {{ loading ? 'Logging in…' : 'Login' }}
            </button>
            <button
              v-if="mode === 'account'"
              type="button"
              class="btn-ghost"
              data-testid="passkey-login-btn"
              :disabled="loading || passkeyLoading || !username.trim()"
              @click="loginWithPasskey"
            >
              {{ passkeyLoading ? 'Waiting for passkey…' : 'Use passkey' }}
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
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: var(--space-4);
  overflow-y: auto;
}
.center {
  width: min(400px, 100%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.login-info {
  width: 100%;
  margin-bottom: var(--space-4);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.login-card {
  position: relative;
  width: 100%;
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg1) 92%, transparent), color-mix(in srgb, var(--bg) 88%, transparent));
  box-shadow: 0 20px 48px color-mix(in srgb, var(--shadow) 60%, transparent);
}
.login-tabs {
  width: 100%;
  margin-bottom: var(--space-4);
  border-radius: var(--radius-sm);
}
.login-tabs button {
  position: relative;
  flex: 1;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.login-tabs button.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(var(--space-1) / 2);
  border-radius: var(--radius-full);
  background: var(--accent);
}
.login-tabs button:hover:not(.active) { transform: translateY(-1px); }
.login-tabs button:active { transform: scale(0.98); }
.field { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.field label { color: var(--text); font-size: var(--fs-sm); line-height: var(--lh-tight); }
.field-hint { color: var(--text2); font-size: var(--fs-xs); line-height: var(--lh-body); margin-top: calc(var(--space-1) / -2); }
.field input {
  width: 100%;
  border-radius: var(--radius-sm);
}
.field input::placeholder { color: var(--text2); }
.password-wrap {
  position: relative;
}
.password-wrap input {
  padding-right: calc(var(--space-6) + var(--space-2));
}
.password-toggle {
  position: absolute;
  right: var(--space-1);
  top: 50%;
  transform: translateY(-50%);
  width: var(--space-6);
  height: var(--space-6);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.password-toggle:hover {
  color: var(--text);
  background: var(--bg2);
  transform: translateY(-50%) translateY(-1px);
}
.password-toggle:active {
  transform: translateY(-50%) scale(0.96);
}
.remember-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
  margin: var(--space-1) 0 var(--space-3);
  user-select: none;
  cursor: pointer;
}
.remember-toggle input {
  appearance: none;
  width: var(--space-4);
  height: var(--space-4);
  padding: 0;
  border: 1px solid var(--border2);
  border-radius: calc(var(--radius-sm) / 2);
  background: var(--bg);
  display: inline-block;
  flex-shrink: 0;
  position: relative;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}
.remember-toggle:hover input { border-color: var(--text3); }
.remember-toggle input:checked {
  border-color: var(--accent);
  background: var(--checked-bg);
}
.remember-toggle input:checked::after {
  content: "";
  position: absolute;
  inset: calc(var(--space-1) / 2);
  background: var(--accent);
  border-radius: calc(var(--radius-sm) / 5);
}
.turnstile-container {
  margin-bottom: var(--space-3);
}
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
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text2);
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-xs);
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
  .login-card { padding: var(--space-4); }
  .field input,
  .login-tabs button,
  .form-footer button,
  .inline-link {
    min-height: calc(var(--space-6) + var(--space-2));
  }
  .password-toggle { width: calc(var(--space-6) + var(--space-2)); height: calc(var(--space-6) + var(--space-2)); }
  .password-wrap input { padding-right: var(--space-7); }
  .form-footer { flex-direction: column; align-items: stretch; }
  .form-footer > * { width: 100%; text-align: center; justify-content: center; }
}
</style>
