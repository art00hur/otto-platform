// ============================================================
// QRPanel — Reference component for the Lovable frontend
//
// Shows the WhatsApp QR code with status indicators.
// Drop this into Lovable and adjust styling to match your design.
//
// Dependencies:
//   npm install qrcode.react lucide-react
// ============================================================

import { QRCodeSVG } from "qrcode.react";
import { useQRRelay } from "@/hooks/useQRRelay";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Smartphone,
} from "lucide-react";

interface QRPanelProps {
  instanceId: string;
  onConnected?: () => void;
}

export function QRPanel({ instanceId, onConnected }: QRPanelProps) {
  const { status, qrData, attempt, error, message, cancel, retry } =
    useQRRelay(instanceId);

  // Notify parent when connected
  if (status === "connected" && onConnected) {
    onConnected();
  }

  return (
    <div className="flex flex-col items-center gap-6 p-8 rounded-2xl bg-white shadow-lg max-w-md mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold text-gray-900">
          Link WhatsApp
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          {message}
        </p>
      </div>

      {/* QR Code Area */}
      <div className="relative w-64 h-64 flex items-center justify-center">
        {/* Loading state */}
        {(status === "connecting" || status === "waiting_for_qr") && (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
            <p className="text-sm text-gray-400">
              {status === "connecting" ? "Connecting..." : "Generating QR..."}
            </p>
          </div>
        )}

        {/* QR Code */}
        {qrData && status === "qr_ready" && (
          <div className="relative">
            <QRCodeSVG
              value={qrData}
              size={240}
              level="M"
              includeMargin={true}
              bgColor="#ffffff"
              fgColor="#000000"
            />
            {/* QR attempt badge */}
            {attempt > 1 && (
              <div className="absolute -top-2 -right-2 bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full">
                Refreshed
              </div>
            )}
          </div>
        )}

        {/* Connected state */}
        {status === "connected" && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 className="w-16 h-16 text-green-500" />
            <p className="text-lg font-medium text-green-700">Connected!</p>
          </div>
        )}

        {/* Error state */}
        {(status === "error" || status === "timeout") && (
          <div className="flex flex-col items-center gap-3">
            <XCircle className="w-12 h-12 text-red-400" />
            <p className="text-sm text-red-500 text-center">{error}</p>
          </div>
        )}
      </div>

      {/* Instructions */}
      {qrData && status === "qr_ready" && (
        <div className="w-full space-y-3">
          <div className="flex items-center gap-3 text-sm text-gray-600">
            <Smartphone className="w-5 h-5 shrink-0 text-gray-400" />
            <ol className="space-y-1.5">
              <li>1. Open WhatsApp on your phone</li>
              <li>2. Tap <strong>Settings → Linked Devices</strong></li>
              <li>3. Tap <strong>Link a Device</strong></li>
              <li>4. Point your camera at this QR code</li>
            </ol>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3">
        {(status === "error" || status === "timeout" || status === "cancelled") && (
          <button
            onClick={retry}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try Again
          </button>
        )}

        {status !== "connected" && status !== "cancelled" && status !== "error" && (
          <button
            onClick={cancel}
            className="px-4 py-2 text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
