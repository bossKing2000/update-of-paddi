"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.vendorFollowQueue = exports.productDeactivateQueue = exports.productLiveQueue = void 0;
const bullmq_1 = require("bullmq");
const bullmqConnection_1 = require("../../lib/bullmqConnection");
exports.productLiveQueue = new bullmq_1.Queue("productLiveQueue", { connection: bullmqConnection_1.bullmqConnection });
exports.productDeactivateQueue = new bullmq_1.Queue("productDeactivateQueue", { connection: bullmqConnection_1.bullmqConnection });
exports.vendorFollowQueue = new bullmq_1.Queue("vendorFollowNotifications", { connection: bullmqConnection_1.bullmqConnection });
