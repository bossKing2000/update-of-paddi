import jwt, { SignOptions } from 'jsonwebtoken';
import config from '../config/config';

const accessTokenOptions: SignOptions = {
  expiresIn: '5h', // 
};

const refreshTokenOptions: SignOptions = {
  expiresIn: '7d', // 7 days
};

// Only include role if it is defined
export const generateAccessToken = (
  userId: string,
  role?: string | null // Allow null
): string => {
  const payload: { id: string; role?: string } = { id: userId };

  if (role != null) payload.role = role;

  return jwt.sign(payload, config.jwtSecret, accessTokenOptions);
};


export const generateRefreshToken = (
  userId: string,
  tokenVersion: number
): string => {
  return jwt.sign({ id: userId, tokenVersion }, config.jwtSecret, refreshTokenOptions);
};
