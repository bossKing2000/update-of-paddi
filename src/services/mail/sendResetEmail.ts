import nodemailer from 'nodemailer';
import config from '../../config/config';
import { Request } from 'express';
import { generateServerUrl } from '../../utils/generateServerUrl';

export const sendResetEmail = async (req: Request, to: string, code: string) => {
  const serverUrl = generateServerUrl(req); // not used directly now, but useful for future reset-link-based flow

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // TLS (STARTTLS)
    auth: {
      user: config.emailUser,
      pass: config.emailPass,
    },
  });

  const mailOptions = {
    from: `"Food Paddi" <${config.emailUser}>`,
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
