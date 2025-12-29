import prisma from '../config/prismaClient';
import bcrypt from 'bcryptjs';
import config from '../config/config';
import { Role } from '@prisma/client';

/**
 * Find a user by email
 */
export const findUserByEmail = (email: string) => {
  return prisma.user.findUnique({
    where: { email },
  });
};

/**
 * Find a user by ID
 */
export const findUserById = (id: string) => {
  return prisma.user.findUnique({
    where: { id },
  });
};

/**
 * Create a new user
 */
export const createUser = async (
  username: string,
  name: string,
  email: string,
  password: string,
  role: Role,
  preferences: string[],
  phoneNumber?: string,
  avatarUrl?: string,
  bio?: string
) => {
  const hashedPassword = await bcrypt.hash(password, config.bcryptSaltRounds);

  return prisma.user.create({
    data: {
      username,
      name,
      email,
      password: hashedPassword,
      role,
      preferences,
      phoneNumber,
      avatarUrl,
      bio,
    },
  });
};

/**
 * Compare a plain password with a hashed password
 */
export const comparePasswords = (plain: string, hashed: string) => {
  return bcrypt.compare(plain, hashed);
};
 
/**
 * Invalidate all refresh tokens by incrementing the user's token version
 */
export const incrementTokenVersion = async (userId: string): Promise<void> => {
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
};

/**
 * Update a user's password
 */
export const updateUserPassword = async (
  userId: string,
  newPassword: string
): Promise<void> => {
  const hashed = await bcrypt.hash(newPassword, config.bcryptSaltRounds);
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashed },
  });
}; 
