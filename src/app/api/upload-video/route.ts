import { NextResponse } from "next/server";
import { getOutputDir, saveOutputFile } from "@/lib/history-manager";
import fs from "fs";
import path from "path";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | Blob | null;

    if (!file) {
      return NextResponse.json({ success: false, error: "Tidak ada video yang diunggah" }, { status: 400 });
    }

    const chunkIndexStr = formData.get("chunkIndex") as string | null;
    const totalChunksStr = formData.get("totalChunks") as string | null;
    const uploadId = formData.get("uploadId") as string | null;
    const rawName = (formData.get("fileName") as string) || (file instanceof File ? file.name : "video.mp4");

    const ext = rawName.split(".").pop() || "mp4";
    const baseClean = rawName.replace(/\.[^/.]+$/, "").replace(/[^\w-]/g, "_").slice(0, 50);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1. Jalur Chunked Upload (Mendukung file ukuran besar di Serverless Vercel & Lokal)
    if (chunkIndexStr !== null && totalChunksStr !== null && uploadId) {
      const chunkIndex = parseInt(chunkIndexStr, 10);
      const totalChunks = parseInt(totalChunksStr, 10);
      const safeUploadId = uploadId.replace(/[^\w-]/g, "");

      const chunkFileName = `chunk_${safeUploadId}_${chunkIndex}.part`;
      saveOutputFile(chunkFileName, buffer);

      // Jika ini chunk terakhir, gabungkan seluruh chunk menjadi satu file utuh
      if (chunkIndex === totalChunks - 1) {
        const finalFileName = `video_${safeUploadId}_${baseClean}.${ext}`;
        const finalPath = path.join(getOutputDir(), finalFileName);
        const writeStream = fs.createWriteStream(finalPath);

        for (let i = 0; i < totalChunks; i++) {
          const partPath = path.join(getOutputDir(), `chunk_${safeUploadId}_${i}.part`);
          if (fs.existsSync(partPath)) {
            const partBuf = fs.readFileSync(partPath);
            writeStream.write(partBuf);
            try {
              fs.unlinkSync(partPath);
            } catch {
              // ignore
            }
          }
        }
        writeStream.end();

        await new Promise<void>((resolve, reject) => {
          writeStream.on("finish", () => resolve());
          writeStream.on("error", (err) => reject(err));
        });

        const videoUrl = `/api/files/${finalFileName}`;
        return NextResponse.json({
          success: true,
          fileName: rawName,
          safeFileName: finalFileName,
          videoUrl,
          completed: true,
        });
      }

      return NextResponse.json({
        success: true,
        chunkReceived: chunkIndex,
        completed: false,
      });
    }

    // 2. Jalur Single Upload langsung (Untuk file wajar atau server lokal)
    const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (isVercel && buffer.length > 4.5 * 1024 * 1024) {
      return NextResponse.json(
        {
          success: false,
          error: "Ukuran file melebihi batas 4.5MB untuk upload langsung di Vercel. Gunakan pengunggahan terpotong (chunked).",
        },
        { status: 413 }
      );
    }

    const safeFileName = `video_${Date.now()}_${baseClean}.${ext}`;
    saveOutputFile(safeFileName, buffer);
    const videoUrl = `/api/files/${safeFileName}`;

    return NextResponse.json({
      success: true,
      fileName: rawName,
      safeFileName,
      videoUrl,
      sizeBytes: buffer.length,
      completed: true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Gagal mengunggah video";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
