/**
 * Step 1: Receive and envelope a raw idea.
 */
import { randomUUID } from "node:crypto";
import type { PipelineStep, GenesisPayload } from "../types.js";

export const receiveStep: PipelineStep = {
  name: "receive",

  shouldRun: () => true,

  async execute(payload): Promise<GenesisPayload> {
    return {
      ...payload,
      session_id: payload.session_id || randomUUID(),
      timestamp: payload.timestamp || new Date().toISOString(),
      step: "receive",
    };
  },
};
