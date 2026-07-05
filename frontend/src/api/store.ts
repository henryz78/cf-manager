import apiClient from './client';

export const storeApi = {
  // Sources
  getSources: () => apiClient.get('/store/sources'),
  addSource: (url: string, name: string) => apiClient.post('/store/sources', { url, name }),
  updateSource: (id: number, data: any) => apiClient.put(`/store/sources/${id}`, data),
  deleteSource: (id: number) => apiClient.delete(`/store/sources/${id}`),

  // Templates
  getTemplates: () => apiClient.get('/store/templates'),
  refresh: () => apiClient.post('/store/refresh'),
  init: () => apiClient.get('/store/init', { _silent: true }),

  // Deploy
  deploy: (data: {
    accountId: number;
    templateId: string;
    name: string;
    bindingSelections?: Record<string, any>;
    secretValues?: Record<string, string>;
  }) => apiClient.post('/store/deploy', data, { timeout: 120000 }),
};
