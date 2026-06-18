import { NodeSSH } from "node-ssh";
import type { Channel as SSHChannel } from "ssh2";
import { createCanvas } from "canvas";
import QRCode from "qrcode";
import { logger } from "../utils/logger.js";
import { decrypt } from "../utils/encryption.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

// ============================================================
// QR Relay Service
//
// This is the trickiest part of the whole system.
//
// Problem: WhatsApp Web (via Baileys, which OpenClaw uses internally)
// outputs a QR code to the terminal. We need to capture that QR
// and show it in the user's browser so they can scan it.
//
// Flow:
//   Browser ←WebSocket→ Backend ←SSH PTY→ VPS (OpenClaw)
//
// The QR code comes through as:
//   1. Raw terminal characters (block chars: █ ▀ ▄ ▐ etc.)
//   2. Or as a data string that we can re-encode client-side
//
// OpenClaw's `channels login` command outputs QR data.
// We need to detect it, extract it, and relay it.
// ============================================================

/**
 * QR code data extracted from terminal output.
 */
export interface QRPayload {
  type: "qr_data";          // Raw QR data string (can be rendered by qrcode.js on client)
  data: string;
  attempt: number;           // QR codes refresh every ~20 seconds, this tracks which one
  timestamp: number;
}

export interface QRStatusPayload {
  type: "status";
  status: "connecting" | "waiting_for_qr" | "qr_expired" | "connected" | "error" | "timeout";
  message: string;
  timestamp: number;
}

export type QRRelayMessage = QRPayload | QRStatusPayload;

/**
 * Start the QR relay for an instance.
 *
 * Opens an SSH connection, runs the WhatsApp login command in a PTY,
 * and yields QR data + status messages as they appear.
 *
 * The caller (WebSocket route) forwards these to the browser.
 */
export async function* relayQR(
  instanceId: string
): AsyncGenerator<QRRelayMessage, void, unknown> {
  const [instance] = await db
    .select()
    .from(schema.instances)
    .where(eq(schema.instances.id, instanceId));

  if (!instance) {
    yield status("error", "Instance not found");
    return;
  }

  if (!instance.ssh_private_key_enc) {
    yield status("error", "No SSH key available for this instance");
    return;
  }

  const ssh = new NodeSSH();
  let channel: SSHChannel | null = null;

  try {
    // ---- Connect ----
    yield status("connecting", "Connecting to your server...");

    const privateKey = decrypt(instance.ssh_private_key_enc);

    await ssh.connect({
      host: instance.ip_address,
      port: 22,
      username: "root",
      privateKey,
      readyTimeout: 15_000,
    });

    yield status("waiting_for_qr", "Starting WhatsApp login...");

    // ---- Open PTY and run login command ----
    // We use requestShell (PTY) instead of exec because Baileys
    // needs a TTY to render the QR code properly.
    channel = await requestShellWithPTY(ssh);

    // Run the OpenClaw WhatsApp login command
    channel.write(
      "sudo -u openclaw openclaw channels login --channel whatsapp 2>&1\n"
    );

    // ---- Parse output for QR data ----
    yield* parseChannelOutput(channel, instanceId);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ instanceId, error: msg }, "QR relay error");
    yield status("error", `Connection error: ${msg}`);

  } finally {
    if (channel) {
      try {
        channel.write("exit\n");
        channel.close();
      } catch {}
    }
    try { ssh.dispose(); } catch {}
  }
}

/**
 * Request an interactive shell with a pseudo-terminal.
 * Baileys needs a TTY to output the QR code.
 */
function requestShellWithPTY(ssh: NodeSSH): Promise<SSHChannel> {
  return new Promise((resolve, reject) => {
    const conn = (ssh as any).connection;

    if (!conn) {
      reject(new Error("SSH connection not established"));
      return;
    }

    conn.shell(
      {
        term: "xterm-256color",
        cols: 120,
        rows: 40,
      },
      (err: Error | undefined, stream: SSHChannel) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stream);
      }
    );
  });
}

/**
 * Parse the PTY output stream looking for QR data.
 *
 * Baileys QR codes appear in the terminal in several possible formats:
 *
 * 1. Raw QR string: A line starting with a known QR prefix
 *    (the actual data that encodes the WhatsApp Web authentication)
 *
 * 2. Terminal block characters: Lines with █ ▀ ▄ forming a visual QR
 *    (we can't use these directly — we need the data string)
 *
 * 3. JSON output: If OpenClaw supports --json flag, clean data
 *
 * Strategy:
 *   - Buffer incoming data
 *   - Look for QR data patterns
 *   - Also detect "connected" / "authenticated" messages
 *   - Timeout after 2 minutes (QR codes expire)
 */
async function* parseChannelOutput(
  channel: SSHChannel,
  instanceId: string
): AsyncGenerator<QRRelayMessage, void, unknown> {
  let buffer = "";
  let qrAttempt = 0;
  let connected = false;
  let qrLines: string[] = [];
  let collectingQR = false;

  const TIMEOUT = 120_000; // 2 minutes total
  const startTime = Date.now();

  // Create an async iterator from the stream
  const dataQueue: string[] = [];
  let resolveWaiting: (() => void) | null = null;
  let streamEnded = false;

  channel.on("data", (data: Buffer) => {
    dataQueue.push(data.toString("utf-8"));
    if (resolveWaiting) {
      resolveWaiting();
      resolveWaiting = null;
    }
  });

  channel.on("close", () => {
    streamEnded = true;
    if (resolveWaiting) {
      resolveWaiting();
      resolveWaiting = null;
    }
  });

  channel.on("error", (err: Error) => {
    logger.error({ instanceId, error: err.message }, "Channel error");
    streamEnded = true;
    if (resolveWaiting) {
      resolveWaiting();
      resolveWaiting = null;
    }
  });

  while (!connected && !streamEnded) {
    // Check timeout
    if (Date.now() - startTime > TIMEOUT) {
      yield status("timeout", "QR code session timed out. Please try again.");
      return;
    }

    // Wait for data if queue is empty
    if (dataQueue.length === 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          resolveWaiting = resolve;
        }),
        sleep(1000), // Wake up every second to check timeout
      ]);
      continue;
    }

    // Process all queued data
    while (dataQueue.length > 0) {
      const chunk = dataQueue.shift()!;
      buffer += chunk;

      // Process complete lines in the buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete last line in buffer

      for (const rawLine of lines) {
        // Strip ANSI escape codes
        const line = stripAnsi(rawLine).trim();
        if (!line) continue;

        // ---- Detection: Block character QR code ----
        // OpenClaw outputs QR as Unicode block chars: █ ▄ ▀ ▐ ░ etc.
        const isQRLine = /[▄▀█▐░▌▖▗▘▙▚▛▜▝▞▟\s]{10,}/.test(line);
        
        if (isQRLine) {
          if (!collectingQR) {
            collectingQR = true;
            qrLines = [];
          }
          qrLines.push(line);
          continue;
        }
        
        // If we were collecting QR lines and hit a non-QR line, emit the QR
        if (collectingQR && qrLines.length > 5) {
          qrAttempt++;
          const qrText = qrLines.join("\n");
          logger.info({ instanceId, attempt: qrAttempt, lines: qrLines.length }, "QR code detected (block chars)");
          
          // Convert block characters to PNG image
          try {
            const matrix = blockCharsToMatrix(qrText);
            const pngBase64 = matrixToPngBase64(matrix);
            yield {
              type: "qr_data" as const,
              data: pngBase64,
              format: "png_base64",
              attempt: qrAttempt,
              timestamp: Date.now(),
            } as any;
          } catch (err) {
            logger.error({ instanceId, error: err instanceof Error ? err.message : String(err) }, "QR PNG conversion failed, sending raw blocks");
            yield {
              type: "qr_data" as const,
              data: qrText,
              format: "blocks",
              attempt: qrAttempt,
              timestamp: Date.now(),
            } as any;
          }
          
          collectingQR = false;
          qrLines = [];
        } else if (collectingQR) {
          collectingQR = false;
          qrLines = [];
        }

        // ---- Detection: QR data string ----
        const qrMatch = extractQRData(line);
        if (qrMatch) {
          qrAttempt++;
          logger.info({ instanceId, attempt: qrAttempt }, "QR code detected (raw string)");
          // Convert raw QR string to PNG base64 for reliable rendering
          try {
            const pngDataUrl = await QRCode.toDataURL(qrMatch, { width: 256, margin: 2, errorCorrectionLevel: "L" });
            const pngBase64 = pngDataUrl.replace(/^data:image\/png;base64,/, "");
            yield {
              type: "qr_data" as const,
              data: pngBase64,
              format: "png_base64",
              attempt: qrAttempt,
              timestamp: Date.now(),
            } as any;
          } catch (qrErr) {
            logger.warn({ instanceId, error: String(qrErr) }, "QR PNG generation failed, sending raw string");
            yield {
              type: "qr_data" as const,
              data: qrMatch,
              format: "raw",
              attempt: qrAttempt,
              timestamp: Date.now(),
            } as any;
          }
          continue;
        }

        // ---- Detection: JSON QR output ----
        const jsonQR = tryParseJSONQR(line);
        if (jsonQR) {
          qrAttempt++;
          logger.info({ instanceId, attempt: qrAttempt }, "QR code detected (JSON)");
          try {
            const pngDataUrl = await QRCode.toDataURL(jsonQR, { width: 256, margin: 2, errorCorrectionLevel: "L" });
            const pngBase64 = pngDataUrl.replace(/^data:image\/png;base64,/, "");
            yield {
              type: "qr_data" as const,
              data: pngBase64,
              format: "png_base64",
              attempt: qrAttempt,
              timestamp: Date.now(),
            } as any;
          } catch {
            yield {
              type: "qr_data" as const,
              data: jsonQR,
              format: "raw",
              attempt: qrAttempt,
              timestamp: Date.now(),
            } as any;
          }
          continue;
        }

        // ---- Detection: Connection success ----
        if (isConnectionSuccess(line)) {
          connected = true;
          logger.info({ instanceId }, "WhatsApp connected!");

          // Update instance status
          await db
            .update(schema.instances)
            .set({ status: "active" })
            .where(eq(schema.instances.id, instanceId));

          yield status("connected", "WhatsApp connected successfully! 🎉");
          return;
        }

        // ---- Detection: QR expired / refresh ----
        if (isQRExpired(line)) {
          yield status("qr_expired", "QR code expired, generating a new one...");
          continue;
        }

        // ---- Detection: Error ----
        if (isErrorMessage(line)) {
          yield status("error", `WhatsApp error: ${line.substring(0, 200)}`);
        }

        // Debug log interesting lines
        if (line.length > 5 && !isNoiseOutput(line)) {
          logger.debug({ instanceId, line: line.substring(0, 150) }, "PTY output");
        }
      }
    }
    
    // Check if we have a complete QR in the buffer (end of stream case)
    if (collectingQR && qrLines.length > 5) {
      qrAttempt++;
      const qrText = qrLines.join("\n");
      logger.info({ instanceId, attempt: qrAttempt, lines: qrLines.length }, "QR code detected (block chars, flush)");
      
      try {
        const matrix = blockCharsToMatrix(qrText);
        const pngBase64 = matrixToPngBase64(matrix);
        yield {
          type: "qr_data" as const,
          data: pngBase64,
          format: "png_base64",
          attempt: qrAttempt,
          timestamp: Date.now(),
        } as any;
      } catch {
        yield {
          type: "qr_data" as const,
          data: qrText,
          format: "blocks",
          attempt: qrAttempt,
          timestamp: Date.now(),
        } as any;
      }
      
      collectingQR = false;
      qrLines = [];
    }
  }

  if (!connected && streamEnded) {
    yield status("error", "Connection closed before WhatsApp was linked");
  }
}

// ============================================================
// Pattern Detection
// ============================================================

/**
 * Extract QR data string from a line.
 *
 * Baileys QR strings look like:
 *   "2@abc123..."   (starts with digit, contains @)
 *
 * OpenClaw may also output it as:
 *   "QR: 2@abc123..."
 *   "qr_code=2@abc123..."
 */
function extractQRData(line: string): string | null {
  // Pattern 1: Direct QR string (Baileys format)
  // Typically: digit(s) + @ + base64-ish characters, 50+ chars long
  const directMatch = line.match(/^(\d+@[A-Za-z0-9+/=,._-]{30,})$/);
  if (directMatch) return directMatch[1];

  // Pattern 2: Prefixed with "QR:" or "qr:" or "QR Code:"
  const prefixMatch = line.match(/(?:QR(?:\s*Code)?|qr(?:_code)?)\s*[:=]\s*(\d+@[A-Za-z0-9+/=,._-]{30,})/i);
  if (prefixMatch) return prefixMatch[1];

  // Pattern 3: OpenClaw specific format
  const clawMatch = line.match(/\bqr\b.*?(\d+@\S{30,})/i);
  if (clawMatch) return clawMatch[1];

  return null;
}

/**
 * Try to parse a line as JSON containing QR data.
 */
function tryParseJSONQR(line: string): string | null {
  if (!line.startsWith("{")) return null;

  try {
    const obj = JSON.parse(line);
    return obj.qr || obj.qr_data || obj.qrCode || obj.qr_code || null;
  } catch {
    return null;
  }
}

/**
 * Detect successful WhatsApp connection.
 */
function isConnectionSuccess(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes("connected successfully") ||
    lower.includes("authenticated") ||
    lower.includes("login successful") ||
    lower.includes("whatsapp is ready") ||
    lower.includes("connection open") ||
    (lower.includes("connected") && lower.includes("whatsapp"))
  );
}

/**
 * Detect QR code expiration / refresh.
 */
function isQRExpired(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes("qr expired") ||
    lower.includes("qr timeout") ||
    lower.includes("generating new qr") ||
    lower.includes("scan timeout")
  );
}

/**
 * Detect error messages.
 */
function isErrorMessage(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    (lower.includes("error") || lower.includes("failed") || lower.includes("exception")) &&
    !lower.includes("qr") &&     // "QR error" is handled separately
    !lower.includes("retry")     // Retries are normal
  );
}

/**
 * Filter out noise (prompts, MOTD, etc).
 */
function isNoiseOutput(line: string): boolean {
  return (
    line.startsWith("root@") ||
    line.startsWith("$") ||
    line.startsWith("#") ||
    line.startsWith("Welcome") ||
    line.startsWith("Last login") ||
    line.startsWith("The programs") ||
    line.includes("openclaw@") ||
    line.match(/^\s*$/) !== null
  );
}

// ============================================================
// Utilities
// ============================================================

/**
 * Strip ANSI escape codes from terminal output.
 * These come from the PTY and include colors, cursor movement, etc.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
            .replace(/\r/g, "");
}

function status(
  s: QRStatusPayload["status"],
  message: string
): QRStatusPayload {
  return { type: "status", status: s, message, timestamp: Date.now() };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Block Character → PNG Conversion
//
// Unicode block chars encode a 2-row-per-character QR pattern:
//   █ (U+2588) = top BLACK, bottom BLACK
//   ▀ (U+2580) = top BLACK, bottom WHITE
//   ▄ (U+2584) = top WHITE, bottom BLACK
//   ▐ (U+2590) = right half (treated as black)
//   (space)    = top WHITE, bottom WHITE
//
// We parse these into a binary matrix and render to a PNG.
// ============================================================

function blockCharsToMatrix(qrText: string): number[][] {
  const lines = qrText.split("\n").filter(l => l.length > 0);
  const matrix: number[][] = [];

  for (const line of lines) {
    const topRow: number[] = [];
    const bottomRow: number[] = [];

    for (const ch of line) {
      switch (ch) {
        case "█":
        case "▐":
        case "▌":
          topRow.push(1);
          bottomRow.push(1);
          break;
        case "▀":
          topRow.push(1);
          bottomRow.push(0);
          break;
        case "▄":
          topRow.push(0);
          bottomRow.push(1);
          break;
        case " ":
          topRow.push(0);
          bottomRow.push(0);
          break;
        default:
          // Unknown char — treat as black if it's a block-like char
          if (ch.charCodeAt(0) > 0x2580 && ch.charCodeAt(0) < 0x25A0) {
            topRow.push(1);
            bottomRow.push(1);
          } else {
            topRow.push(0);
            bottomRow.push(0);
          }
      }
    }

    matrix.push(topRow);
    matrix.push(bottomRow);
  }

  return matrix;
}

function matrixToPngBase64(matrix: number[][]): string {
  if (matrix.length === 0) return "";

  const moduleSize = 8; // pixels per QR module
  const border = moduleSize * 2; // quiet zone
  const height = matrix.length;
  const width = Math.max(...matrix.map(r => r.length));

  const canvasWidth = width * moduleSize + border * 2;
  const canvasHeight = height * moduleSize + border * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // White background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw black modules
  ctx.fillStyle = "#000000";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < (matrix[y]?.length || 0); x++) {
      if (matrix[y][x] === 1) {
        ctx.fillRect(
          border + x * moduleSize,
          border + y * moduleSize,
          moduleSize,
          moduleSize
        );
      }
    }
  }

  return canvas.toBuffer("image/png").toString("base64");
}
