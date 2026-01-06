"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendResetEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const config_1 = __importDefault(require("../../config/config"));
const generateServerUrl_1 = require("../../utils/generateServerUrl");
const sendResetEmail = async (req, to, code) => {
    const serverUrl = (0, generateServerUrl_1.generateServerUrl)(req); // not used directly now, but useful for future reset-link-based flow
    const transporter = nodemailer_1.default.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // TLS (STARTTLS)
        auth: {
            user: config_1.default.emailUser,
            pass: config_1.default.emailPass,
        },
    });
    const mailOptions = {
        from: `"Food Paddi" <${config_1.default.emailUser}>`,
        to,
        subject: 'Your Password Reset Code',
        html: `
      <div style="font-family: Arial, sans-serif;">
        <h2>Password Reset Code</h2>
        <p>Your code to reset your Food Paddi password is:</p>
        <h1 style="color: #4CAF50;">${code}</h1>
        <p>This code will expire in 30 seconds.</p>
      </div>
    `,
    };
    await transporter.sendMail(mailOptions);
};
exports.sendResetEmail = sendResetEmail;
