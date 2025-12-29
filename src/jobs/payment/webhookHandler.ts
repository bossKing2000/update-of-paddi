import { Request, Response } from "express";
import prisma from "../../lib/prisma";
import { validatePaystackSignature } from "../../utils/paystack";

export const webhookHandler = async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer | string;
  const signature = req.headers['x-paystack-signature'] as string | undefined;

  if (!signature || !validatePaystackSignature(rawBody, signature)) {
    return res.status(401).send('Unauthorized: Invalid signature');
  }

  const eventPayload = typeof rawBody === "string" ? JSON.parse(rawBody) : JSON.parse(rawBody.toString());

  await prisma.webhookEvent.upsert({
    where: { reference_event: { reference: eventPayload.data.reference, event: eventPayload.event } },
    create: { reference: eventPayload.data.reference, event: eventPayload.event, payload: eventPayload },
    update: { payload: eventPayload },
  });

  res.sendStatus(200); // Express Response has sendStatus
};
