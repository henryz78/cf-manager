import { defineStore } from 'pinia';
import { ref } from 'vue';
import { accountsApi } from '../api/accounts';

export const useAccountStore = defineStore('accounts', () => {
  const accounts = ref<any[]>([]);
  const quota = ref<any[]>([]);
  const loading = ref(false);

  async function fetchAccounts() {
    loading.value = true;
    try {
      const { data } = await accountsApi.getAll();
      accounts.value = data.accounts;
      quota.value = data.quota;
    } catch {
      accounts.value = [];
      quota.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function createAccount(input: any) {
    await accountsApi.create(input);
    await fetchAccounts();
  }

  async function deleteAccount(id: number) {
    await accountsApi.delete(id);
    await fetchAccounts();
  }

  async function testAccount(id: number) {
    const { data } = await accountsApi.test(id);
    return data;
  }

  async function updateFeatures(id: number, enabled_features: string) {
    await accountsApi.updateFeatures(id, enabled_features);
    await fetchAccounts();
  }

  async function updateAccount(id: number, input: any) {
    await accountsApi.update(id, input);
    await fetchAccounts();
  }

  return { accounts, quota, loading, fetchAccounts, createAccount, deleteAccount, testAccount, updateFeatures, updateAccount };
});
