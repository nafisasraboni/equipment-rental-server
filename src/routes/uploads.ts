import { Router, raw } from "express";
import { z } from "zod";
import { verifyToken } from "../middleware/auth";
import { ApiError, success } from "../lib/errors";

const uploadResponseSchema = z.object({ success: z.literal(true), data: z.object({ url: z.string().url().refine((value) => value.startsWith("https://")), width: z.coerce.number().nonnegative().default(0), height: z.coerce.number().nonnegative().default(0) }) });

export function uploadRoutes() {
  const router = Router();
  router.post("/uploads", verifyToken, raw({ type: "multipart/form-data", limit: "9mb" }), async (req, res) => {
    if (!req.context.env.IMGBB_API_KEY) throw new ApiError(503, "UPLOADS_UNAVAILABLE", "Image uploads are not configured yet.");
    const contentType = req.get("content-type");
    if (!contentType?.startsWith("multipart/form-data") || !Buffer.isBuffer(req.body)) throw new ApiError(400, "INVALID_UPLOAD", "Select an image file to upload.");
    const request = new Request("https://upload.local.invalid", { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(req.body) });
    let form: FormData;
    try { form = await request.formData(); }
    catch { throw new ApiError(400, "INVALID_UPLOAD", "The image upload form is malformed."); }
    const file = form.get("image");
    if (!(file instanceof File)) throw new ApiError(400, "IMAGE_REQUIRED", "Select an image file to upload.");
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) throw new ApiError(400, "UNSUPPORTED_IMAGE", "Use a JPEG, PNG, WebP, or GIF image.");
    if (!file.size || file.size > 8 * 1024 * 1024) throw new ApiError(400, "INVALID_IMAGE_SIZE", "Images must be smaller than 8 MiB.");
    const upload = new FormData();
    upload.append("image", Buffer.from(await file.arrayBuffer()).toString("base64"));
    let response: globalThis.Response;
    try { response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(req.context.env.IMGBB_API_KEY)}`, { method: "POST", body: upload, signal: AbortSignal.timeout(25_000) }); }
    catch { throw new ApiError(502, "IMAGE_HOST_UNAVAILABLE", "The image host could not be reached. Please retry."); }
    const payload = uploadResponseSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !payload.success) throw new ApiError(502, "IMAGE_UPLOAD_FAILED", "The image host could not accept this image. Please retry with a different file.");
    success(res, payload.data.data, 201);
  });
  return router;
}
