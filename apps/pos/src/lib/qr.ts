import qrcode from "qrcode-generator";

/**
 * Matriz del código QR generada LOCALMENTE (librería `qrcode-generator`, sin red): el enlace con el token
 * jamás sale del equipo hacia un servicio externo de imágenes. Corrección de errores media (M): robusta y
 * compacta para una URL corta.
 */
export function buildQrMatrix(value: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => qr.isDark(row, column)));
}

/** Path SVG del QR: un rectángulo por tramo horizontal de módulos oscuros (compacto). */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const commands: string[] = [];
  matrix.forEach((cells, row) => {
    let column = 0;
    while (column < cells.length) {
      if (!cells[column]) { column += 1; continue; }
      const start = column;
      while (column < cells.length && cells[column]) column += 1;
      commands.push(`M${String(start)} ${String(row)}h${String(column - start)}v1h-${String(column - start)}z`);
    }
  });
  return commands.join("");
}
