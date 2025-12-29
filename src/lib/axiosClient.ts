import axios from 'axios';
import config from '../config/config';

export const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${config.paystackSecret}`,
    'Content-Type': 'application/json',
  },
});