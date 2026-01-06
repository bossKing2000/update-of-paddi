"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const productScheduleController_1 = require("../controllers/productScheduleController");
const router = express_1.default.Router();
// Vendor-protected endpoints
router.post("/:id/schedule/go-live", auth_middleware_1.authenticate, productScheduleController_1.goLive);
router.post("/:id/schedule/take-down", productScheduleController_1.takeDown);
router.post("/:id/schedule/extend-grace", auth_middleware_1.authenticate, productScheduleController_1.extendGrace);
router.get("/fix-live-statuses", productScheduleController_1.fixLiveStatuses);
exports.default = router;
