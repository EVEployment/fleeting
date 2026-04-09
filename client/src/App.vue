<template>
  <!-- Backend not yet ready — show a full-screen waiting state -->
  <div v-if="!backendReady" class="health-screen">
    <div class="health-card">
      <span class="health-logo">PELD Online</span>
      <div class="health-spinner" />
      <p class="health-msg">{{ healthMsg }}</p>
      <p class="health-sub">Retrying every {{ RETRY_INTERVAL_S }}s…</p>
    </div>
  </div>

  <RouterView v-else />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { getMe } from '@/api/client';
import { useCharacterStatus } from '@/composables/useCharacterStatus';

const RETRY_INTERVAL_S = 3;

const backendReady = ref(false);
const healthMsg    = ref('Connecting to server…');

let timer: ReturnType<typeof setInterval> | null = null;

const { start: startCharacterStatus, stop: stopCharacterStatus } = useCharacterStatus();

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch('/health', { credentials: 'include' });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryStartCharacterPolling() {
  try {
    const me = await getMe();
    if (me) startCharacterStatus(me);
  } catch {
    // Not authenticated — individual pages handle the redirect.
  }
}

async function poll() {
  const ok = await checkHealth();
  if (ok) {
    backendReady.value = true;
    if (timer) { clearInterval(timer); timer = null; }
    await tryStartCharacterPolling();
  } else {
    healthMsg.value = 'Server not reachable — waiting…';
  }
}

onMounted(async () => {
  // First check immediately
  await poll();
  if (!backendReady.value) {
    timer = setInterval(poll, RETRY_INTERVAL_S * 1000);
  }
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  stopCharacterStatus();
});
</script>

<style>
/* Global resets */
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: #0d0f14; color: #cfd9ee; }
</style>

<style scoped>
.health-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #0d0f14;
}
.health-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  padding: 3rem 3.5rem;
  background: #13181f;
  border: 1px solid #8a6e2e;
  border-radius: 4px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.7);
  text-align: center;
}
.health-logo {
  font-size: 1.8rem;
  font-weight: 700;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: #c8a84b;
}
.health-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid #253048;
  border-top-color: #c8a84b;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.health-msg { margin: 0; color: #cfd9ee; font-size: 0.9rem; }
.health-sub { margin: 0; color: #5b6f8e; font-size: 0.78rem; }
</style>
