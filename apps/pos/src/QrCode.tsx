import { useMemo } from "react";

import { buildQrMatrix, qrPath } from "./lib/qr";

/** Zona de silencio estándar (4 módulos) sobre fondo blanco: se escanea bien aun en el tema oscuro del POS. */
const QUIET_ZONE = 4;

interface QrCodeProps {
  value: string;
  /** Lado en píxeles CSS. */
  size?: number;
  label: string;
}

/** QR como SVG generado en el equipo (`lib/qr.ts`). `data-qr-value` existe para pruebas: es el mismo texto del QR. */
export function QrCode({ value, size = 280, label }: QrCodeProps) {
  const { path, modules } = useMemo(() => {
    const matrix = buildQrMatrix(value);
    return { path: qrPath(matrix), modules: matrix.length };
  }, [value]);
  const total = modules + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-value={value}
      width={size}
      height={size}
      viewBox={`0 0 ${String(total)} ${String(total)}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path transform={`translate(${String(QUIET_ZONE)} ${String(QUIET_ZONE)})`} d={path} fill="#000000" />
    </svg>
  );
}
