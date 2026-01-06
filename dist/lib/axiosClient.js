"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paystack = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = __importDefault(require("../config/config"));
exports.paystack = axios_1.default.create({
    baseURL: 'https://api.paystack.co',
    headers: {
        Authorization: `Bearer ${config_1.default.paystackSecret}`,
        'Content-Type': 'application/json',
    },
});
