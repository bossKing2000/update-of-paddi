"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVerificationEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const config_1 = __importDefault(require("../../config/config"));
const generateServerUrl_1 = require("../../utils/generateServerUrl");
const sendVerificationEmail = async (req, to, token) => {
    const serverUrl = (0, generateServerUrl_1.generateServerUrl)(req);
    const url = `${serverUrl}/api/auth/verify-email?token=${token}`;
    const transporter = nodemailer_1.default.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // TLS
        auth: {
            user: config_1.default.emailUser,
            pass: config_1.default.emailPass,
        },
    });
    const mailOptions = {
        from: `"Food Paddi" <${config_1.default.emailUser}>`,
        to,
        subject: 'Verify Your Email',
        html: `
      <h2>Verify your email address</h2>
      <p>Click the button below to verify your account:</p>
      <a href="${url}" style="padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none;">Verify Email</a>
      <p>This link expires in 30 seconds.</p>
    `,
    };
    await transporter.sendMail(mailOptions);
};
exports.sendVerificationEmail = sendVerificationEmail;
// import nodemailer from 'nodemailer';
// import config from '../config/config';
// export const sendVerificationEmail = async (to: string, token: string) => {
//   const url = `${config.serverUrl}/api/auth/verify-email?token=${token}`;
//   const transporter = nodemailer.createTransport({
//   host: 'smtp.gmail.com',
//   port: 587,
//   secure: false, // TLS (not SSL)
//   auth: {
//     user: config.emailUser,
//     pass: config.emailPass,
//   },
// });
//   const mailOptions = {
//     from: `"Food Paddi" <${config.emailUser}>`,
//     to,
//     subject: 'Verify Your Email',
//     html: `
//       <h2>Verify your email address</h2>
//       <p>Click the button below to verify your account:</p>
//       <a href="${url}" style="padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none;">Verify Email</a>
//       <p>This link expires in 30 sec.</p>
//     `,
//   };
//   await transporter.sendMail(mailOptions);
// };
// services/sendVerificationEmail.ts
