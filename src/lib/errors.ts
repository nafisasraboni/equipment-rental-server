import type { ErrorRequestHandler, Response } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export function success<T>(res: Response, data: T, status = 200, message?: string) {
  return res.status(status).json({ success: true, data, ...(message ? { message } : {}) });
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Please check the submitted fields.", details: error.flatten() } });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({ success: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }
  const bodyErrorType = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
  if (bodyErrorType === "entity.too.large") {
    res.status(413).json({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "The uploaded file or request is too large." } });
    return;
  }
  if (bodyErrorType === "entity.parse.failed") {
    res.status(400).json({ success: false, error: { code: "INVALID_JSON", message: "The request body must contain valid JSON." } });
    return;
  }
  console.error("API request failed", { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, "[redacted connection]") : "Unknown error" });
  res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again shortly." } });
};
