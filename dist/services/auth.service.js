"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateUserPassword = exports.incrementTokenVersion = exports.comparePasswords = exports.createUser = exports.findUserById = exports.findUserByEmail = void 0;
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const config_1 = __importDefault(require("../config/config"));
/**
 * Find a user by email
 */
const findUserByEmail = (email) => {
    return prismaClient_1.default.user.findUnique({
        where: { email },
    });
};
exports.findUserByEmail = findUserByEmail;
/**
 * Find a user by ID
 */
const findUserById = (id) => {
    return prismaClient_1.default.user.findUnique({
        where: { id },
    });
};
exports.findUserById = findUserById;
/**
 * Create a new user
 */
const createUser = async (username, name, email, password, role, preferences, phoneNumber, avatarUrl, bio) => {
    const hashedPassword = await bcryptjs_1.default.hash(password, config_1.default.bcryptSaltRounds);
    return prismaClient_1.default.user.create({
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
exports.createUser = createUser;
/**
 * Compare a plain password with a hashed password
 */
const comparePasswords = (plain, hashed) => {
    return bcryptjs_1.default.compare(plain, hashed);
};
exports.comparePasswords = comparePasswords;
/**
 * Invalidate all refresh tokens by incrementing the user's token version
 */
const incrementTokenVersion = async (userId) => {
    await prismaClient_1.default.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
    });
};
exports.incrementTokenVersion = incrementTokenVersion;
/**
 * Update a user's password
 */
const updateUserPassword = async (userId, newPassword) => {
    const hashed = await bcryptjs_1.default.hash(newPassword, config_1.default.bcryptSaltRounds);
    await prismaClient_1.default.user.update({
        where: { id: userId },
        data: { password: hashed },
    });
};
exports.updateUserPassword = updateUserPassword;
