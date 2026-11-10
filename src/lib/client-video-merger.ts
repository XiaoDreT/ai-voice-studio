import { StoryboardSegment, SubtitleStyle } from "@/types";
import { parseTimeRangeStr } from "./timeline-utils";

export interface MergeOptions {
  videoUrl: string;
  audioUrl: string;
  segments: StoryboardSegment[];
  subtitleFontSize: number;
  subtitleYpad: number;
  subtitleStyle: SubtitleStyle;
  onProgress?: (percent: number, statusText: string) => void;
  signal?: AbortSignal;
}

/**
 * Membungkus teks agar tidak melebihi lebar maksimum pada kanvas
 */
function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = ctx.measureText(testLine).width;
    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines.length > 0 ? lines : [text];
}

/**
 * Menggambar rounded rectangle pada kanvas
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Menggabungkan Video Acuan + Audio Voice Over AI ElevenLabs + Subtitle Permanen
 * ke dalam SATU frame video murni di browser (1280x720 HD) dan menghasilkan file .MP4 utuh.
 * Bekerja 100% di browser tanpa batasan payload Vercel serverless.
 */
export async function mergeVideoVoiceoverSubtitle(options: MergeOptions): Promise<Blob> {
  const {
    videoUrl,
    audioUrl,
    segments,
    subtitleFontSize,
    subtitleYpad,
    subtitleStyle,
    onProgress,
    signal,
  } = options;

  onProgress?.(5, "Memuat aset audio dan video...");

  // 1. Siapkan elemen Video off-screen
  const video = document.createElement("video");
  video.src = videoUrl;
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Gagal memuat video acuan"));
  });

  // 2. Siapkan Audio Context & decode audio ElevenLabs
  const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtxClass();

  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    throw new Error("Gagal mengunduh audio voice over ElevenLabs");
  }
  const audioArrayBuffer = await audioRes.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer);

  const audioDest = audioCtx.createMediaStreamDestination();
  const audioSource = audioCtx.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.connect(audioDest);

  // 3. Tentukan durasi total video hasil muxing
  let maxScriptEnd = 0;
  for (const seg of segments) {
    const [, end] = parseTimeRangeStr(seg.time_range);
    if (end > maxScriptEnd) maxScriptEnd = end;
  }
  const totalDuration = Math.max(
    1,
    audioBuffer.duration,
    maxScriptEnd,
    video.duration > 0 ? video.duration : 1
  );

  // 4. Buat Kanvas Rendering 1280x720 HD
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Gagal menginisialisasi kanvas 2D");
  }

  // 5. Gabungkan video track dari kanvas + audio track dari ElevenLabs
  const canvasStream = canvas.captureStream(30);
  const combinedStream = new MediaStream([
    canvasStream.getVideoTracks()[0],
    audioDest.stream.getAudioTracks()[0],
  ]);

  // 6. Pilih format kontainer perekaman (Prioritaskan MP4 jika didukung browser)
  let mimeType = "video/webm; codecs=vp9,opus";
  const preferredMimes = [
    'video/mp4; codecs="avc1.424028, mp4a.40.2"',
    "video/mp4; codecs=avc1",
    "video/mp4",
    'video/webm; codecs="vp9,opus"',
    'video/webm; codecs="vp8,opus"',
    "video/webm",
  ];
  for (const candidate of preferredMimes) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      mimeType = candidate;
      break;
    }
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: 4000000, // 4 Mbps kualitas HD jernih
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  const recordPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      try {
        const finalBlob = new Blob(chunks, { type: mimeType.includes("mp4") ? "video/mp4" : "video/webm" });
        resolve(finalBlob);
      } catch (e) {
        reject(e);
      }
    };
    recorder.onerror = (e) => reject(e);
  });

  // 7. Mulai perekaman & sinkronisasi pemutaran
  recorder.start(100);
  audioSource.start(0);
  await video.play();

  onProgress?.(10, "Sedang menggabungkan video, suara AI, dan subtitle ke 1 frame...");

  // 8. Render loop: gambar frame video + bakar subtitle langsung ke piksel kanvas
  let isRunning = true;

  const renderFrame = () => {
    if (!isRunning) return;

    if (signal?.aborted) {
      isRunning = false;
      try {
        recorder.stop();
        video.pause();
        audioSource.stop();
        audioCtx.close();
      } catch {}
      return;
    }

    const curTime = video.currentTime;

    // Bersihkan kanvas
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 1280, 720);

    // Gambar video acuan dengan aspect ratio proporsional
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const vRatio = video.videoWidth / video.videoHeight;
      const cRatio = 1280 / 720;
      let dw = 1280;
      let dh = 720;
      let dx = 0;
      let dy = 0;

      if (vRatio > cRatio) {
        dw = 1280;
        dh = 1280 / vRatio;
        dy = (720 - dh) / 2;
      } else {
        dh = 720;
        dw = 720 * vRatio;
        dx = (1280 - dw) / 2;
      }

      ctx.drawImage(video, dx, dy, dw, dh);
    }

    // Cari teks subtitle yang aktif pada timestamp detik ini
    let activeText = "";
    for (const seg of segments) {
      const [start, end] = parseTimeRangeStr(seg.time_range);
      if (curTime >= start && curTime <= end) {
        activeText = (seg.text || "").trim();
        break;
      }
    }

    // Gambar teks subtitle di Bawah Tengah kanvas
    if (activeText) {
      ctx.font = `bold ${subtitleFontSize}px 'Inter', system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";

      const maxWidth = 1140; // margin kanan-kiri 70px
      const lines = wrapCanvasText(ctx, activeText, maxWidth);
      const lineHeight = subtitleFontSize * 1.3;
      const totalTextHeight = lines.length * lineHeight;
      const startY = 720 - subtitleYpad - (lines.length - 1) * lineHeight;

      if (subtitleStyle === "shaded_box") {
        let maxLineWidth = 0;
        for (const line of lines) {
          const w = ctx.measureText(line).width;
          if (w > maxLineWidth) maxLineWidth = w;
        }
        const boxPaddingX = 24;
        const boxPaddingY = 10;
        const boxWidth = maxLineWidth + boxPaddingX * 2;
        const boxHeight = totalTextHeight + boxPaddingY * 2;
        const boxX = (1280 - boxWidth) / 2;
        const boxY = 720 - subtitleYpad - totalTextHeight - boxPaddingY + 4;

        ctx.fillStyle = "rgba(11, 19, 43, 0.92)";
        drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 8);
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        lines.forEach((line, i) => {
          ctx.fillText(line, 640, startY + i * lineHeight);
        });
      } else if (subtitleStyle === "yellow_outline") {
        ctx.lineWidth = Math.max(4, Math.round(subtitleFontSize * 0.12));
        ctx.strokeStyle = "#000000";
        ctx.fillStyle = "#ffff00";
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        lines.forEach((line, i) => {
          ctx.strokeText(line, 640, startY + i * lineHeight);
          ctx.fillText(line, 640, startY + i * lineHeight);
        });
      } else {
        // Outline Hitam (default)
        ctx.lineWidth = Math.max(4, Math.round(subtitleFontSize * 0.12));
        ctx.strokeStyle = "#000000";
        ctx.fillStyle = "#ffffff";
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        lines.forEach((line, i) => {
          ctx.strokeText(line, 640, startY + i * lineHeight);
          ctx.fillText(line, 640, startY + i * lineHeight);
        });
      }
    }

    // Hitung progress
    const progress = Math.min(99, Math.round((curTime / totalDuration) * 90) + 10);
    onProgress?.(progress, `Sedang merekam frame (${Math.round(curTime)}s / ${Math.round(totalDuration)}s)...`);

    // Periksa apakah sudah selesai
    if (curTime >= totalDuration || (video.ended && curTime >= totalDuration - 0.5)) {
      isRunning = false;
      onProgress?.(99, "Menyelesaikan file MP4...");
      try {
        recorder.stop();
        video.pause();
        audioSource.stop();
        audioCtx.close();
      } catch {}
      return;
    }

    // Lanjut ke frame berikutnya
    requestAnimationFrame(renderFrame);
  };

  requestAnimationFrame(renderFrame);

  const resultBlob = await recordPromise;
  onProgress?.(100, "Selesai! Video siap diunduh.");
  return resultBlob;
}
