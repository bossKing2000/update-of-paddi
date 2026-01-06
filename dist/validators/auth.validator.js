"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateProfileValidator = exports.loginValidator = exports.registerValidator = void 0;
const express_validator_1 = require("express-validator");
exports.registerValidator = [
    (0, express_validator_1.body)('username')
        .trim()
        .notEmpty()
        .withMessage('Username is required')
        .isLength({ min: 2 })
        .withMessage('Username must be at least 2 characters')
        .optional(),
    (0, express_validator_1.body)('name')
        .trim()
        .notEmpty()
        .withMessage('Name is required')
        .isLength({ min: 2 })
        .withMessage('Name must be at least 2 characters')
        .optional(),
    (0, express_validator_1.body)('email')
        .isEmail()
        .withMessage('Valid email is required')
        .normalizeEmail(),
    (0, express_validator_1.body)('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters'),
    (0, express_validator_1.body)('role')
        .optional()
        .isIn(['CUSTOMER', 'VENDOR', 'ADMIN', 'DELIVERY'])
        .withMessage('Role must be CUSTOMER or VENDOR or ADMIN or DELIVERY'),
    (0, express_validator_1.body)('phoneNumber')
        .optional()
        .isMobilePhone('any')
        .withMessage('Valid phone number required'),
    (0, express_validator_1.body)('preferences')
        .optional()
        .isArray()
        .withMessage('Preferences must be an array'),
    (0, express_validator_1.body)('preferences.*')
        .optional()
        .isString()
        .withMessage('Each preference must be a string'),
];
exports.loginValidator = [
    (0, express_validator_1.body)('email')
        .isEmail()
        .withMessage('Valid email is required')
        .normalizeEmail(),
    (0, express_validator_1.body)('password')
        .notEmpty()
        .withMessage('Password is required'),
];
exports.updateProfileValidator = [
    (0, express_validator_1.body)('name')
        .optional()
        .isString()
        .withMessage('Name must be a string')
        .isLength({ min: 2 })
        .withMessage('Name must be at least 2 characters'),
    (0, express_validator_1.body)('phoneNumber')
        .optional()
        .isMobilePhone('any')
        .withMessage('Valid phone number required'),
    (0, express_validator_1.body)('avatarUrl')
        .optional()
        .isString()
        .withMessage('Avatar URL must be a string'),
    (0, express_validator_1.body)('bio')
        .optional()
        .isString()
        .withMessage('Bio must be a string')
        .isLength({ max: 300 })
        .withMessage('Bio must be at most 300 characters'),
    (0, express_validator_1.body)('preferences')
        .optional()
        .custom((value) => {
        if (typeof value === 'string')
            return true;
        if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
            return true;
        throw new Error('Preferences must be a string or an array of strings');
    }),
    (0, express_validator_1.body)('address')
        .optional()
        .isString()
        .withMessage('Address must be a string'),
    (0, express_validator_1.body)('brandName')
        .optional()
        .isString()
        .withMessage('Brand name must be a string'),
    (0, express_validator_1.body)('brandLogo')
        .optional()
        .isString()
        .withMessage('Brand logo must be a string'),
];
