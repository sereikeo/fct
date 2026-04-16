import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.API_TOKEN}`
  }
});

export const cashflowApi = {
  getToday: () => api.get('/api/cashflow'),
  getDate: (date: string) => api.get(`/api/cashflow/${date}`),
};

export default api;