import { spawn } from 'child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { env } from '../../config/env';

const FFPROBE_BIN = env.FFPROBE_PATH ?? ffprobeInstaller.path;

export interface VideoInfo {
  durationSec: number;
  codec: string;
  container: string;
}

export function probeVideo(filePath: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ];
    const proc = spawn(FFPROBE_BIN, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffprobe exited ${code}: ${stderr}`)); return; }
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: { codec_type?: string; codec_name?: string }[];
          format?: { duration?: string; format_name?: string };
        };
        const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
        const durationSec = parseFloat(parsed.format?.duration ?? '0');
        resolve({
          durationSec,
          codec: videoStream?.codec_name ?? 'unknown',
          container: parsed.format?.format_name ?? 'unknown',
        });
      } catch (e) {
        reject(e);
      }
    });
    proc.on('error', reject);
  });
}
