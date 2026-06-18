// ============================================================
// useQRRelay — React hook for consuming the QR WebSocket
//
// Usage in Lovable / Next.js:
//
//   import { useQRRelay } from "@/hooks/useQRRelay";
//
//   function QRPanel({ instanceId }: { instanceId: string }) {
//     const { status, qrData, attempt, error, cancel } = useQRRelay(instanceId);
//
//     return (
//       <div>
//         {status === "waiting_for_qr" && <p>Waiting for QR...</p>}
//         {qrData && <QRCode value={qrData} size={256} />}
//         {status === "connected" && <p>🎉 Connected!</p>}
//         {error && <p className="text-red-500">{error}</p>}
//         <button onClick={cancel}>Cancel</button>
//       </div>
//     );
//   }
//
// Dependencies:
//   npm install qrcode.react
//
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";

interface QRRelayState {
  /** Current connection status */
  status:
    | "idle"
    | "connecting"
    | "waiting_for_qr"
    | "qr_ready"
    | "qr_expired"
    | "connected"
    | "error"
    | "timeout"
    | "cancelled";

  /** The QR data string — pass this to <QRCode value={qrData} /> */
  qrData: string | null;

  /** Which QR attempt this is (QR refreshes every ~20s) */
  attempt: number;

  /** Error message if something went wrong */
  error: string | null;

  /** Human-friendly status message for the UI */
  message: string;

  /** Cancel the QR relay */
  cancel: () => void;

  /** Retry the connection */
  retry: () => void;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
const PING_INTERVAL = 15_000;

export function useQRRelay(instanceId: string | null): QRRelayState {
  const [status, setStatus] = useState<QRRelayState["status"]>("idle");
  const [qrData, setQrData] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("Initializing...");

  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCount = useRef(0);

  const cleanup = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!instanceId) return;

    cleanup();
    setStatus("connecting");
    setMessage("Connecting to your server...");
    setError(null);

    // Build WebSocket URL
    const wsProtocol = BACKEND_URL.startsWith("https") ? "wss" : "ws";
    const wsHost = BACKEND_URL.replace(/^https?:\/\//, "");
    const wsUrl = `${wsProtocol}://${wsHost}/api/qr/${instanceId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      retryCount.current = 0;

      // Start ping keep-alive
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "ping" }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "pong") return; // Ignore pong replies

        if (msg.type === "status") {
          setStatus(msg.status);
          setMessage(msg.message);

          if (msg.status === "error") {
            setError(msg.message);
          }

          if (msg.status === "qr_expired") {
            // Don't clear qrData yet — new QR should arrive shortly
          }

          if (msg.status === "connected") {
            setQrData(null); // Clear QR on success
            cleanup();
          }
        }

        if (msg.type === "qr_data") {
          setStatus("qr_ready");
          setQrData(msg.data);
          setAttempt(msg.attempt);
          setMessage(
            msg.attempt === 1
              ? "Scan this QR code with WhatsApp"
              : `QR refreshed (attempt ${msg.attempt}) — scan again`
          );
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection error");
    };

    ws.onclose = (event) => {
      cleanup();

      // Don't retry if we intentionally cancelled or connected
      if (status === "connected" || status === "cancelled") return;

      // Auto-retry up to 3 times on unexpected disconnect
      if (retryCount.current < 3 && status !== "error") {
        retryCount.current++;
        setMessage(`Connection lost. Reconnecting (${retryCount.current}/3)...`);
        setTimeout(connect, 2000 * retryCount.current);
      }
    };
  }, [instanceId, cleanup]);

  const cancel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: "cancel" }));
    }
    setStatus("cancelled");
    setMessage("Cancelled");
    cleanup();
  }, [cleanup]);

  const retry = useCallback(() => {
    retryCount.current = 0;
    setQrData(null);
    setAttempt(0);
    setError(null);
    connect();
  }, [connect]);

  // Auto-connect when instanceId is provided
  useEffect(() => {
    if (instanceId) {
      connect();
    }
    return cleanup;
  }, [instanceId, connect, cleanup]);

  return {
    status,
    qrData,
    attempt,
    error,
    message,
    cancel,
    retry,
  };
}
