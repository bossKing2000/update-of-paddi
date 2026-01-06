"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookHandler = void 0;
const prisma_1 = __importDefault(require("../../lib/prisma"));
const paystack_1 = require("../../utils/paystack");
const webhookHandler = async (req, res) => {
    const rawBody = req.body;
    const signature = req.headers['x-paystack-signature'];
    if (!signature || !(0, paystack_1.validatePaystackSignature)(rawBody, signature)) {
        return res.status(401).send('Unauthorized: Invalid signature');
    }
    const eventPayload = typeof rawBody === "string" ? JSON.parse(rawBody) : JSON.parse(rawBody.toString());
    await prisma_1.default.webhookEvent.upsert({
        where: { reference_event: { reference: eventPayload.data.reference, event: eventPayload.event } },
        create: { reference: eventPayload.data.reference, event: eventPayload.event, payload: eventPayload },
        update: { payload: eventPayload },
    });
    res.sendStatus(200); // Express Response has sendStatus
};
exports.webhookHandler = webhookHandler;
