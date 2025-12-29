import { body } from 'express-validator';

export const registerValidator = [
  body('username')
    .trim()
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ min: 2 })
    .withMessage('Username must be at least 2 characters')
    .optional(),
    
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2 })
    .withMessage('Name must be at least 2 characters')
    .optional(),
     
    
  body('email')
    .isEmail()
    .withMessage('Valid email is required')
    .normalizeEmail(),

  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),

  body('role')
    .optional()
    .isIn(['CUSTOMER', 'VENDOR', 'ADMIN', 'DELIVERY'])
    .withMessage('Role must be CUSTOMER or VENDOR or ADMIN or DELIVERY'),

  body('phoneNumber')
    .optional()
    .isMobilePhone('any')
    .withMessage('Valid phone number required'),

  body('preferences')
    .optional()
    .isArray()
    .withMessage('Preferences must be an array'),

  body('preferences.*')
    .optional()
    .isString()
    .withMessage('Each preference must be a string'),

  
  ];

export const loginValidator = [
  body('email')
    .isEmail()
    .withMessage('Valid email is required')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];


export const updateProfileValidator = [
  body('name')
    .optional()
    .isString()
    .withMessage('Name must be a string')
    .isLength({ min: 2 })
    .withMessage('Name must be at least 2 characters'),

  body('phoneNumber')
    .optional()
    .isMobilePhone('any')
    .withMessage('Valid phone number required'),

  body('avatarUrl')
    .optional()
    .isString()
    .withMessage('Avatar URL must be a string'),

  body('bio')
    .optional()
    .isString()
    .withMessage('Bio must be a string')
    .isLength({ max: 300 })
    .withMessage('Bio must be at most 300 characters'),

  body('preferences')
    .optional()
    .custom((value) => {
      if (typeof value === 'string') return true;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return true;
      throw new Error('Preferences must be a string or an array of strings');
    }),

  body('address')
    .optional()
    .isString()
    .withMessage('Address must be a string'),

  body('brandName')
    .optional()
    .isString()
    .withMessage('Brand name must be a string'),

  body('brandLogo')
    .optional()
    .isString()
    .withMessage('Brand logo must be a string'),
];
