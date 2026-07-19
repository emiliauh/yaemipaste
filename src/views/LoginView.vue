<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
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
import { credentialToJson, isPasskeySupported, passkeyErrorMessage, toRequestOptions } from '../lib/passkeys'
import { isAuthEnabled } from '../lib/features'
import { usePublicSettings } from '../lib/publicSettings'
import { useTurnstile } from '../lib/turnstile'

const router = useRouter()
const { publicSettings, appName, refreshPublicSettings } = usePublicSettings()
// The backend is the sole source of truth at runtime (see
// /auth/admin/public-settings): TURNSTILE_SECRET_KEY and
// VITE_TURNSTILE_SITE_KEY can both change via `.env` + `docker compose up
// -d` without rebuilding the UI image, and `mount`/`ensureToken` below
// always await this fetch first, so there is no benefit - and a real
// staleness hazard - in ever falling back to the build-time-baked
// `import.meta.env.VITE_TURNSTILE_SITE_KEY`. If the backend says Turnstile
// isn't required, never mount the widget, even if an old bundle has a
// leftover build-time key baked in.
const TURNSTILE_SITE_KEY = computed(() => (
  publicSettings.value.turnstile_required ? (publicSettings.value.turnstile_site_key ?? '') : ''
))
// True when the backend requires a Turnstile token but no site key is
// available - a deployment misconfiguration, not a visitor error.
const turnstileMisconfigured = computed(() => publicSettings.value.turnstile_required && !TURNSTILE_SITE_KEY.value)

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
const passkeySupported = computed(() => isPasskeySupported())
const turnstileContainer = ref<HTMLElement | null>(null)
const turnstile = useTurnstile()

watch(rememberMe, (value) => setRememberPreference(value))
watch(mode, () => {
  error.value = ''
  tokenUsed.value = false
})

function setError(message: string, usedToken = false) {
  error.value = message
  tokenUsed.value = usedToken
}

let turnstileReady: Promise<void> | null = null

function mountTurnstileWhenReady(): Promise<void> {
  turnstileReady = (async () => {
    await refreshPublicSettings()
    if (!TURNSTILE_SITE_KEY.value) return
    await nextTick()
    if (!turnstileContainer.value) return
    try {
      await turnstile.mount(turnstileContainer.value, TURNSTILE_SITE_KEY.value)
    } catch (e: any) {
      setError(e?.message ?? 'Security check failed to load')
    }
  })()
  return turnstileReady
}

function goToAccountLogin() {
  mode.value = 'account'
}

onMounted(() => {
  if (!isAuthEnabled()) {
    router.replace('/files')
    return
  }
  void mountTurnstileWhenReady()
})

async function submit() {
  setError('')
  if (mode.value === 'account') {
    // Close the race between this submit and the async settings fetch that
    // decides whether Turnstile is required (see mountTurnstileWhenReady):
    // an autofill-and-immediate-submit could otherwise read the FALLBACK
    // "not required" default and skip a token the backend actually needs.
    await (turnstileReady ?? mountTurnstileWhenReady())
    if (turnstileMisconfigured.value) {
      setError('Security check is misconfigured on the server (Turnstile is required but no site key is set). Contact the site administrator.')
      return
    }
  }
  loading.value = true
  try {
    if (mode.value === 'account') {
      const captchaToken = await turnstile.ensureToken(TURNSTILE_SITE_KEY.value)
      await authLogin(username.value.trim(), password.value, {
        rememberMe: rememberMe.value,
        turnstileToken: captchaToken,
      })
      turnstile.reset()
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
    turnstile.reset()
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
    setError(passkeyErrorMessage(e))
  } finally {
    passkeyLoading.value = false
  }
}
</script>

<template>
  <div class="page">
    <main class="login-layout" data-testid="login-center">
      <section class="login-intro" aria-label="Welcome">
        <div class="login-brand">
          <span class="login-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M5 7.5h14M7 4.5h10l1 3H6l1-3Z"/>
              <path d="M6.5 7.5 8 20h8l1.5-12.5"/>
              <path d="M10 11v5M14 11v5"/>
            </svg>
          </span>
          <span>{{ appName }}</span>
        </div>
        <h1>Sign in to {{ appName }}.</h1>
        <p>Manage your uploads, links, and account from one place.</p>
      </section>

      <section class="login-surface">
        <div class="login-info">
          <span class="login-info-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="4" y="10" width="16" height="10" rx="2"/>
              <path d="M8 10V7a4 4 0 0 1 8 0v3"/>
            </svg>
          </span>
          <div>
            <strong>Authentication required</strong>
            <p>Use your account, or enter a token directly.</p>
            <p v-if="!publicSettings.registration_enabled" class="registration-notice">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 10v5M12 7h.01"/>
              </svg>
              Registration is disabled.
            </p>
          </div>
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

          <div class="login-options">
            <label class="remember-toggle">
              <input v-model="rememberMe" type="checkbox" />
              <span>remember me</span>
            </label>
            <button
              v-if="mode === 'account'"
              type="button"
              class="passkey-link"
              data-testid="passkey-login-btn"
              :disabled="loading || passkeyLoading || !username.trim() || !passkeySupported"
              :title="!passkeySupported ? 'Passkeys are not supported in this browser' : !username.trim() ? 'Enter your username to use a passkey' : 'Use a passkey instead'"
              @click="loginWithPasskey"
            >
              {{ passkeyLoading ? 'Waiting…' : 'Use passkey' }}
            </button>
          </div>

          <div v-if="TURNSTILE_SITE_KEY" ref="turnstileContainer" class="turnstile-container"></div>

          <div v-if="error" class="error-msg" role="alert">
            <span>{{ error }}</span>
            <button v-if="tokenUsed" type="button" class="inline-link" @click="goToAccountLogin">Do you have an account?</button>
          </div>

          <div class="form-footer">
            <button type="submit" class="btn-primary" :disabled="loading">
              {{ loading ? 'Logging in…' : 'Login' }}
            </button>
            <router-link v-if="mode === 'account' && publicSettings.registration_enabled" to="/register" class="link">Register</router-link>
          </div>
        </form>
      </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: max(100vh, 100dvh);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: clamp(var(--space-4), 5vw, var(--space-8));
  overflow-y: auto;
}
.login-layout {
  width: min(920px, 100%);
  display: grid;
  grid-template-columns: minmax(260px, .85fr) minmax(360px, 420px);
  align-items: center;
  gap: clamp(var(--space-6), 7vw, 88px);
}
.login-intro { max-width: 360px; }
.login-brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text);
  font-size: var(--fs-h2);
  font-weight: 650;
  margin-bottom: var(--space-6);
}
.login-brand-mark {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  color: var(--accent-h);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}
.login-brand-mark svg { width: 19px; height: 19px; }
.login-intro h1 {
  color: var(--text);
  font-size: clamp(26px, 3vw, 34px);
  letter-spacing: -.025em;
  line-height: 1.12;
  font-weight: 580;
}
.login-intro > p {
  max-width: 34ch;
  margin-top: var(--space-3);
  color: var(--text2);
  font-size: var(--fs-body);
  line-height: 1.6;
}
.login-surface { width: 100%; }
.login-info {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.login-info-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  color: var(--accent-h);
  line-height: 1;
}
.login-info-icon svg { display: block; width: 18px; height: 18px; }
.login-info strong { display: block; color: var(--text); font-weight: 580; }
.login-info p { margin-top: 2px; color: var(--text2); }
.login-info .registration-notice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
}
.registration-notice svg {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  color: var(--accent-h);
}
.login-card {
  position: relative;
  width: 100%;
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  background: color-mix(in srgb, var(--surface) 96%, transparent);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--shadow) 30%, transparent);
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
.login-tabs button:hover:not(.active) { background: var(--surface2); }
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
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.password-toggle:hover {
  color: var(--text);
  background: var(--bg2);
  transform: translateY(-50%);
}
.remember-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
  user-select: none;
  cursor: pointer;
}
.remember-toggle input {
  flex-shrink: 0;
}
.login-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-1) 0 var(--space-3);
}
.passkey-link {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--accent-h);
  font-size: var(--fs-sm);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
  text-underline-offset: 3px;
}
.passkey-link:hover:not(:disabled) { color: var(--text); }
.passkey-link:disabled { color: var(--text3); opacity: 1; cursor: not-allowed; text-decoration: none; }
.turnstile-container {
  margin-bottom: var(--space-3);
}
.form-footer {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}
.form-footer button {
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.form-footer .link {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  padding: 5px 10px;
}
.form-footer .link:hover { border-color: var(--text3); background: var(--surface2); color: var(--text); }
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
  transition: color var(--duration-fast) var(--ease-out);
}
.link:hover { color: var(--text); }

@media (max-width: 900px) {
  .page { align-items: flex-start; padding-top: clamp(var(--space-6), 12vh, var(--space-8)); }
  .login-layout { grid-template-columns: minmax(0, 420px); justify-content: center; gap: var(--space-5); }
  .login-intro { max-width: 420px; }
  .login-brand { margin-bottom: var(--space-5); }
}

@media (max-width: 600px) {
  .page { padding: var(--space-5) var(--space-3); }
  .login-intro h1 { font-size: 29px; }
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
  .form-footer { grid-template-columns: 1fr; }
  .form-footer > * { width: 100%; text-align: center; justify-content: center; }
}
</style>
