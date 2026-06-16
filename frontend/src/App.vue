<template>
  <n-config-provider :theme="theme">
    <n-dialog-provider>
      <n-message-provider>
        <n-notification-provider>
          <n-loading-bar-provider>
            <!-- 初始加载 -->
            <div v-if="authChecking" style="display: flex; justify-content: center; align-items: center; height: 100vh">
              <n-spin size="large" />
            </div>

            <!-- 登录界面 -->
            <div v-else-if="showLogin" style="display: flex; justify-content: center; align-items: center; height: 100vh">
              <n-card title="CF Manager" style="width: 400px">
                <n-form @submit.prevent="handleLogin">
                  <n-form-item label="API Secret">
                    <n-input v-model:value="loginSecret" type="password" placeholder="输入 API Secret" show-password-on="click" @keyup.enter="handleLogin" />
                  </n-form-item>
                  <n-button type="primary" block :loading="loginLoading" @click="handleLogin">登录</n-button>
                </n-form>
              </n-card>
            </div>

            <n-layout v-else has-sider style="height: 100vh">
              <n-layout-sider bordered :width="220" :collapsed-width="64" collapse-mode="width" :collapsed="collapsed">
                <div style="padding: 16px; text-align: center; font-weight: bold; font-size: 18px">
                  {{ collapsed ? 'CF' : 'CF Manager' }}
                </div>
                <n-menu v-model:value="activeMenuKey" :options="menuOptions" :collapsed="collapsed" @update:value="handleMenuClick" />
              </n-layout-sider>
              <n-layout>
                <n-layout-header bordered style="height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px">
                  <n-button quaternary circle @click="collapsed = !collapsed">
                    <template #icon><n-icon :component="MenuOutline" /></template>
                  </n-button>
                  <n-space>
                    <n-button quaternary circle @click="toggleTheme">
                      <template #icon><n-icon :component="isDark ? SunnyOutline : MoonOutline" /></template>
                    </n-button>
                    <n-button v-if="isAuthenticated" quaternary size="small" @click="handleLogout">退出</n-button>
                  </n-space>
                </n-layout-header>
                <n-layout-content content-style="padding: 24px;" style="height: calc(100vh - 48px); overflow-y: auto">
                  <router-view />
                </n-layout-content>
              </n-layout>
            </n-layout>
          </n-loading-bar-provider>
        </n-notification-provider>
      </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref, computed, h, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { darkTheme } from 'naive-ui';
import type { Component } from 'vue';
import { NIcon } from 'naive-ui';
import {
  SpeedometerOutline, PeopleOutline, GlobeOutline, ConstructOutline,
  SparklesOutline, ImageOutline, SettingsOutline,
  MenuOutline, SunnyOutline, MoonOutline, ServerOutline,
} from '@vicons/ionicons5';
import apiClient from './api/client';
import { message as globalMessage } from './utils/discreteApi';

const router = useRouter();
const route = useRoute();
const collapsed = ref(false);
const isDark = ref(false);
const activeMenuKey = ref(route.name as string);
const theme = computed(() => isDark.value ? darkTheme : null);

const isAuthenticated = ref(!!localStorage.getItem('api_token'));
const showLogin = ref(false);
const authChecking = ref(true);
const loginSecret = ref('');
const loginLoading = ref(false);

onMounted(async () => {
  window.addEventListener('auth-expired', () => {
    isAuthenticated.value = false;
    showLogin.value = true;
  });
  try {
    await apiClient.get('/settings', { _silent: true });
    showLogin.value = false;
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      showLogin.value = true;
    }
  } finally {
    authChecking.value = false;
  }
});

async function handleLogin() {
  if (!loginSecret.value) return;
  loginLoading.value = true;
  try {
    localStorage.setItem('api_token', loginSecret.value);
    await apiClient.get('/settings', { _silent: true });
    isAuthenticated.value = true;
    showLogin.value = false;
  } catch {
    localStorage.removeItem('api_token');
    isAuthenticated.value = false;
    globalMessage.error('API Secret 不正确');
  } finally {
    loginLoading.value = false;
  }
}

function handleLogout() {
  localStorage.removeItem('api_token');
  isAuthenticated.value = false;
  showLogin.value = true;
  loginSecret.value = '';
}

// Sync menu key with route changes
watch(() => route.name, (newName) => {
  if (newName) {
    activeMenuKey.value = newName as string;
  }
});

function renderIcon(icon: Component) {
  return () => h(NIcon, null, { default: () => h(icon) });
}

const menuOptions = [
  { label: '仪表盘', key: 'dashboard', icon: renderIcon(SpeedometerOutline) },
  { label: '账号管理', key: 'accounts', icon: renderIcon(PeopleOutline) },
  { label: 'DNS 管理', key: 'dns', icon: renderIcon(GlobeOutline) },
  { label: 'Workers', key: 'workers', icon: renderIcon(ConstructOutline) },
  { label: '存储管理', key: 'storage', icon: renderIcon(ServerOutline) },
  { label: 'AI 推理', key: 'ai', icon: renderIcon(SparklesOutline) },
  { label: '浏览器渲染', key: 'browser-render', icon: renderIcon(ImageOutline) },
  { label: '设置', key: 'settings', icon: renderIcon(SettingsOutline) },
];

function handleMenuClick(key: string) {
  router.push({ name: key }).catch(() => {});
}

function toggleTheme() {
  isDark.value = !isDark.value;
}
</script>
