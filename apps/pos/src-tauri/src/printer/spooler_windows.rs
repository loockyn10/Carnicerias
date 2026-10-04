//! Backend de Windows: API nativa del spooler (`winspool.drv`). Sin PowerShell, sin procesos externos
//! y sin software residente: el trabajo se entrega como datatype `RAW`, o sea que el driver no lo
//! reinterpreta y los bytes ESC/POS llegan tal cual a la térmica.

use std::ffi::c_void;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, GetDefaultPrinterW, OpenPrinterW, StartDocPrinterW,
    StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
};

use super::{PrintError, PrinterBackend, PrinterInfo};

pub struct WindowsSpooler;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Lee un `PWSTR` terminado en cero que vive dentro del buffer de `EnumPrintersW`.
///
/// # Safety
/// `pointer` debe ser nulo o apuntar a una cadena UTF-16 terminada en cero válida.
unsafe fn read_wide(pointer: *const u16) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let mut length = 0usize;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    Some(String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length)))
}

fn default_printer_name() -> Option<String> {
    let mut size: u32 = 0;
    // Primer llamado: sólo informa el tamaño necesario (falla con ERROR_INSUFFICIENT_BUFFER).
    unsafe { GetDefaultPrinterW(null_mut(), &mut size) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize];
    let ok = unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut size) };
    if ok == 0 {
        return None;
    }
    unsafe { read_wide(buffer.as_ptr()) }
}

impl PrinterBackend for WindowsSpooler {
    fn list_printers(&self) -> Result<Vec<PrinterInfo>, PrintError> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        // Nivel 4: sólo nombre y atributos (rápido, no consulta a la impresora ni a su driver).
        unsafe { EnumPrintersW(flags, null(), 4, null_mut(), 0, &mut needed, &mut returned) };
        if needed == 0 {
            return Ok(Vec::new()); // sin impresoras instaladas
        }
        // u64: el buffer se reinterpreta como PRINTER_INFO_4W (punteros), que exige alineación de 8.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let ok = unsafe {
            EnumPrintersW(flags, null(), 4, buffer.as_mut_ptr().cast::<u8>(), needed, &mut needed, &mut returned)
        };
        if ok == 0 {
            return Err(PrintError::Failed(format!("no se pudo listar las impresoras (código de Windows {}).", unsafe { GetLastError() })));
        }
        let default_name = default_printer_name().map(|name| name.to_lowercase());
        let infos = buffer.as_ptr().cast::<PRINTER_INFO_4W>();
        let mut printers: Vec<PrinterInfo> = (0..returned as usize)
            .filter_map(|index| {
                let name = unsafe { read_wide((*infos.add(index)).pPrinterName) }?;
                let is_default = default_name.as_deref() == Some(name.to_lowercase().as_str());
                Some(PrinterInfo { name, is_default })
            })
            .collect();
        printers.sort_by_key(|printer| printer.name.to_lowercase());
        printers.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
        Ok(printers)
    }

    fn send_raw(&self, printer_name: &str, job_name: &str, data: &[u8]) -> Result<(), PrintError> {
        let name = wide(printer_name);
        let mut handle = PRINTER_HANDLE { Value: null_mut() };
        if unsafe { OpenPrinterW(name.as_ptr(), &mut handle, null()) } == 0 {
            return Err(PrintError::Failed(format!("no se pudo abrir la impresora \"{printer_name}\" (código de Windows {}).", unsafe { GetLastError() })));
        }
        let result = write_job(handle, job_name, data);
        unsafe { ClosePrinter(handle) };
        result
    }
}

fn write_job(handle: PRINTER_HANDLE, job_name: &str, data: &[u8]) -> Result<(), PrintError> {
    let mut document_name = wide(job_name);
    let mut datatype = wide("RAW");
    let info = DOC_INFO_1W { pDocName: document_name.as_mut_ptr(), pOutputFile: null_mut(), pDatatype: datatype.as_mut_ptr() };
    if unsafe { StartDocPrinterW(handle, 1, &info) } == 0 {
        return Err(PrintError::Failed(format!("la impresora no aceptó el trabajo (código de Windows {}).", unsafe { GetLastError() })));
    }
    let outcome = (|| {
        if unsafe { StartPagePrinter(handle) } == 0 {
            return Err(PrintError::Failed(format!("la impresora no pudo iniciar la página (código de Windows {}).", unsafe { GetLastError() })));
        }
        let mut written: u32 = 0;
        let length = u32::try_from(data.len()).map_err(|_| PrintError::Failed("el ticket es demasiado grande.".to_string()))?;
        let ok = unsafe { WritePrinter(handle, data.as_ptr().cast::<c_void>(), length, &mut written) };
        unsafe { EndPagePrinter(handle) };
        if ok == 0 || written != length {
            return Err(PrintError::Failed(format!("no se pudo enviar el ticket a la impresora (código de Windows {}).", unsafe { GetLastError() })));
        }
        Ok(())
    })();
    unsafe { EndDocPrinter(handle) };
    outcome
}
