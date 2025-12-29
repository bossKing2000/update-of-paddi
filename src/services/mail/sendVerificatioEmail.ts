import nodemailer from 'nodemailer';
import config from '../../config/config';
import { Request } from 'express';
import { generateServerUrl } from '../../utils/generateServerUrl';

export const sendVerificationEmail = async (req: Request, to: string, token: string) => {
  const serverUrl = generateServerUrl(req);
  const url = `${serverUrl}/api/auth/verify-email?token=${token}`;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // TLS
    auth: {
      user: config.emailUser,
      pass: config.emailPass,
    },
  });

  const mailOptions = {
    from: `"Food Paddi" <${config.emailUser}>`,
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