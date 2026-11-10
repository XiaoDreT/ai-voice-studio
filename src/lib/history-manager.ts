import fs from "fs";
import path from "path";
import os from "os";
import { HistoryItem } from "@/types";

export function getOutputDir(): string {
  // Jika berjalan di lingkungan Vercel Serverless / AWS Lambda
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const tmpDir = path.join(os.tmpdir(), "outputs");
    if (!fs.existsSync(tmpDir)) {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    return tmpDir;
  }

  // Lingkungan lokal / Docker / VPS
  const localDir = path.join(process.cwd(), "outputs");
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return localDir;
  } catch {
    // Fallback jika direktori kerja read-only
    const tmpDir = path.join(os.tmpdir(), "outputs");
    if (!fs.existsSync(tmpDir)) {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    return tmpDir;
  }
}

function getHistoryFilePath(): string {
  return path.join(getOutputDir(), "history.json");
}

function ensureOutputDir() {
  getOutputDir();
}

export function getHistory(): HistoryItem[] {
  ensureOutputDir();
  const histFile = getHistoryFilePath();
  const candidates = [
    histFile,
    path.join(process.cwd(), "outputs", "history.json"),
    path.join(os.tmpdir(), "outputs", "history.json"),
  ];

  for (const f of candidates) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ f)) {
        const raw = fs.readFileSync(/*turbopackIgnore: true*/ f, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return data;
      }
    } catch {
      // lanjut ke kandidat berikutnya
    }
  }

  return [];
}

export function saveHistoryItem(item: HistoryItem): void {
  ensureOutputDir();
  const current = getHistory();
  const trimmed = current.slice(0, 100); // retain last 100 items
  try {
    fs.writeFileSync(/*turbopackIgnore: true*/ getHistoryFilePath(), JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (e) {
    console.error("[saveHistoryItem] Error saving history:", e);
  }
}

export function clearHistory(): void {
  ensureOutputDir();
  try {
    const histFile = getHistoryFilePath();
    if (fs.existsSync(/*turbopackIgnore: true*/ histFile)) {
      fs.unlinkSync(/*turbopackIgnore: true*/ histFile);
    }
  } catch (e) {
    console.error("[clearHistory] Error clearing history:", e);
  }
}

export function saveOutputFile(fileName: string, data: Buffer | string): string {
  const dir = getOutputDir();
  const filePath = path.join(/*turbopackIgnore: true*/ dir, fileName);
  fs.writeFileSync(/*turbopackIgnore: true*/ filePath, data);
  return filePath;
}

export function getOutputFilePath(fileName: string): string | null {
  const clean = fileName.split("?")[0];
  const candidates = [
    path.join(/*turbopackIgnore: true*/ getOutputDir(), clean),
    path.join(process.cwd(), "outputs", clean),
    path.join(os.tmpdir(), "outputs", clean),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ c)) {
        return c;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function updateHistoryItem(id: string, updates: Partial<HistoryItem>): void {
  ensureOutputDir();
  const current = getHistory();
  const index = current.findIndex((h) => h.id === id);
  if (index !== -1) {
    current[index] = { ...current[index], ...updates };
    try {
      fs.writeFileSync(/*turbopackIgnore: true*/ getHistoryFilePath(), JSON.stringify(current, null, 2), "utf-8");
    } catch (e) {
      console.error("[updateHistoryItem] Error:", e);
    }
  }
}

