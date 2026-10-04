//! Impresión directa de tickets (NO fiscales) desde el POS de escritorio.
//!
//! Arquitectura:
//! - **TypeScript** arma el contenido (layout de texto por ancho de columnas) y lo manda como un
//!   `PrintDocument` neutro (líneas + estilo). No hay HTML, ni `window.print()`, ni diálogo del navegador.
//! - **Rust** (`escpos`) lo codifica a ESC/POS y (`PrinterBackend`) lo entrega **RAW** a una impresora
//!   instalada. En Windows el backend es la API nativa del spooler (`winspool.drv`: `OpenPrinterW` →
//!   `StartDocPrinterW(RAW)` → `WritePrinter`), sin PowerShell ni procesos externos. Otras plataformas
//!   responden `PRINTER_UNSUPPORTED` (el backend es un trait: se agrega CUPS sin tocar el resto).
//! - La impresora pertenece a **esta computadora**: la configuración vive en SQLite local
//!   (`sync_metadata`, clave `printer_settings`, igual que la balanza), nunca en Supabase.
//!
//! Un error de impresión jamás afecta una venta: acá nada toca `local_sales` ni `sync_outbox`.

pub mod escpos;
#[cfg(windows)]
mod spooler_windows;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

pub use escpos::{CodePage, PrintDocument};

use crate::DatabaseState;

const PRINTER_SETTINGS_KEY: &str = "printer_settings";
const SPOOLER_JOB_NAME: &str = "Ticket POS";
const DEFAULT_BUSINESS_NAME: &str = "Carnicerías Fran";
const MAX_BUSINESS_NAME_CHARS: usize = 40;
const SUPPORTED_PAPER_WIDTHS_MM: [u32; 2] = [58, 80];

/// Errores de impresión con un código estable al comienzo del mensaje (mismo patrón que `PRICE_REQUIRED:`):
/// el POS los traduce a un texto para el cajero.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PrintError {
    #[error("PRINTER_DISABLED: la impresora de tickets no está habilitada en esta caja.")]
    Disabled,
    #[error("PRINTER_NOT_CONFIGURED: todavía no se eligió una impresora de tickets.")]
    NotConfigured,
    #[error("PRINTER_NOT_FOUND: la impresora \"{0}\" no está instalada en esta computadora.")]
    NotFound(String),
    /// Sólo lo construye el backend no-Windows: en Windows nunca se usa.
    #[cfg_attr(windows, allow(dead_code))]
    #[error("PRINTER_UNSUPPORTED: la impresión directa todavía no está disponible en este sistema operativo.")]
    Unsupported,
    #[error("PRINT_FAILED: {0}")]
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    /// La predeterminada de Windows (sólo informativa: el POS nunca imprime en "la predeterminada").
    pub is_default: bool,
}

/// Lo que una plataforma necesita para listar impresoras y entregarles bytes RAW.
pub trait PrinterBackend {
    fn list_printers(&self) -> Result<Vec<PrinterInfo>, PrintError>;
    /// Un único trabajo de impresión RAW (los bytes ya son ESC/POS) hacia una impresora instalada.
    fn send_raw(&self, printer_name: &str, job_name: &str, data: &[u8]) -> Result<(), PrintError>;
}

/// Plataformas sin backend de impresión directa (hoy todo lo que no es Windows).
#[cfg(not(windows))]
struct UnsupportedBackend;

#[cfg(not(windows))]
impl PrinterBackend for UnsupportedBackend {
    fn list_printers(&self) -> Result<Vec<PrinterInfo>, PrintError> { Err(PrintError::Unsupported) }
    fn send_raw(&self, _printer_name: &str, _job_name: &str, _data: &[u8]) -> Result<(), PrintError> { Err(PrintError::Unsupported) }
}

fn platform_backend() -> Box<dyn PrinterBackend> {
    #[cfg(windows)]
    { Box::new(spooler_windows::WindowsSpooler) }
    #[cfg(not(windows))]
    { Box::new(UnsupportedBackend) }
}

/// Configuración local de la impresora de ESTA computadora.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrinterSettings {
    /// Interruptor general: sin esto el POS no ofrece imprimir.
    pub enabled: bool,
    pub printer_name: Option<String>,
    pub paper_width_mm: u32,
    /// Imprimir sola al completar una venta (una vez por venta).
    pub auto_print: bool,
    pub auto_cut: bool,
    pub code_page: CodePage,
    /// Encabezado del ticket. La organización no se guarda localmente: es un dato de esta computadora.
    pub business_name: String,
}

impl Default for PrinterSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            printer_name: None,
            paper_width_mm: 80,
            auto_print: false,
            auto_cut: true,
            code_page: CodePage::default(),
            business_name: DEFAULT_BUSINESS_NAME.to_string(),
        }
    }
}

/// Valida y deja en forma canónica lo que mandó la pantalla de configuración.
pub fn normalize_settings(raw: PrinterSettings) -> Result<PrinterSettings, String> {
    let printer_name = raw.printer_name.as_deref().map(str::trim).filter(|name| !name.is_empty()).map(str::to_string);
    if !SUPPORTED_PAPER_WIDTHS_MM.contains(&raw.paper_width_mm) {
        return Err("El ancho de papel debe ser de 58 mm o de 80 mm.".to_string());
    }
    if raw.enabled && printer_name.is_none() {
        return Err(PrintError::NotConfigured.to_string());
    }
    let business_name: String = raw.business_name.chars().filter(|character| !character.is_control()).collect::<String>().trim().chars().take(MAX_BUSINESS_NAME_CHARS).collect();
    Ok(PrinterSettings {
        enabled: raw.enabled,
        printer_name,
        paper_width_mm: raw.paper_width_mm,
        // Imprimir sola sin impresora habilitada no tiene sentido: queda apagado.
        auto_print: raw.auto_print && raw.enabled,
        auto_cut: raw.auto_cut,
        code_page: raw.code_page,
        business_name: if business_name.is_empty() { DEFAULT_BUSINESS_NAME.to_string() } else { business_name },
    })
}

/// Lee lo guardado; una fila corrupta o inexistente devuelve el valor por defecto (nunca falla un arranque por esto).
pub fn load_settings(connection: &Connection) -> PrinterSettings {
    match crate::metadata(connection, PRINTER_SETTINGS_KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => PrinterSettings::default(),
    }
}

fn save_settings(connection: &mut Connection, settings: &PrinterSettings) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string(settings).map_err(|error| error.to_string())?;
    crate::set_metadata(&transaction, PRINTER_SETTINGS_KEY, &serialized, &crate::now())?;
    transaction.commit().map_err(|error| error.to_string())
}

/// Destino explícito de un trabajo (la prueba de impresión usa lo que está en pantalla, aunque no se haya guardado).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintTarget {
    pub printer_name: String,
    pub auto_cut: bool,
    #[serde(default)]
    pub code_page: CodePage,
}

/// Imprime un documento. Sin `target` usa la configuración guardada (y exige que esté habilitada).
/// La impresora tiene que existir ahora mismo: si la configurada se desinstaló, el error es
/// `PRINTER_NOT_FOUND` (el cajero elige otra) y no se intenta escribir a ciegas.
pub fn print_with(
    backend: &dyn PrinterBackend,
    settings: &PrinterSettings,
    target: Option<PrintTarget>,
    document: &PrintDocument,
) -> Result<(), PrintError> {
    if document.lines.is_empty() || document.lines.len() > escpos::MAX_LINES {
        return Err(PrintError::Failed("el documento a imprimir está vacío o es demasiado largo.".to_string()));
    }
    let (requested_name, auto_cut, code_page) = match target {
        Some(target) => (target.printer_name, target.auto_cut, target.code_page),
        None => {
            if !settings.enabled { return Err(PrintError::Disabled); }
            let name = settings.printer_name.clone().ok_or(PrintError::NotConfigured)?;
            (name, settings.auto_cut, settings.code_page)
        }
    };
    let installed = backend.list_printers()?;
    let wanted = requested_name.trim().to_lowercase();
    let printer = installed
        .iter()
        .find(|printer| printer.name.to_lowercase() == wanted)
        .ok_or_else(|| PrintError::NotFound(requested_name.clone()))?;
    let bytes = escpos::encode_document(document, code_page, auto_cut);
    backend.send_raw(&printer.name, SPOOLER_JOB_NAME, &bytes)
}

#[tauri::command(async)]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    platform_backend().list_printers().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_printer_settings(state: State<'_, DatabaseState>) -> Result<PrinterSettings, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    Ok(load_settings(&connection))
}

#[tauri::command]
pub fn set_printer_settings(state: State<'_, DatabaseState>, settings: PrinterSettings) -> Result<PrinterSettings, String> {
    let normalized = normalize_settings(settings)?;
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    save_settings(&mut connection, &normalized)?;
    Ok(normalized)
}

/// `async`: el spooler puede tardar (cola llena, impresora apagada) y no debe congelar la ventana del POS.
#[tauri::command(async)]
pub fn print_document(state: State<'_, DatabaseState>, document: PrintDocument, target: Option<PrintTarget>) -> Result<(), String> {
    // La conexión SQLite se suelta antes de hablar con el spooler: una impresora lenta no bloquea las ventas.
    let settings = {
        let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
        load_settings(&connection)
    };
    print_with(platform_backend().as_ref(), &settings, target, &document).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use escpos::{LineStyle, PrintLine};
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeBackend {
        installed: Vec<&'static str>,
        fail_spooler: Option<PrintError>,
        sent: RefCell<Vec<(String, String, Vec<u8>)>>,
    }

    impl PrinterBackend for FakeBackend {
        fn list_printers(&self) -> Result<Vec<PrinterInfo>, PrintError> {
            Ok(self.installed.iter().enumerate().map(|(index, name)| PrinterInfo { name: (*name).to_string(), is_default: index == 0 }).collect())
        }
        fn send_raw(&self, printer_name: &str, job_name: &str, data: &[u8]) -> Result<(), PrintError> {
            if let Some(error) = &self.fail_spooler { return Err(error.clone()); }
            self.sent.borrow_mut().push((printer_name.to_string(), job_name.to_string(), data.to_vec()));
            Ok(())
        }
    }

    fn document() -> PrintDocument {
        PrintDocument { lines: vec![PrintLine { text: "Ñandú".to_string(), style: LineStyle::Normal }] }
    }

    fn configured(name: &str, cut: bool) -> PrinterSettings {
        PrinterSettings { enabled: true, printer_name: Some(name.to_string()), auto_cut: cut, ..PrinterSettings::default() }
    }

    #[test]
    fn a_configured_printer_receives_one_raw_job_with_the_encoded_ticket() {
        let backend = FakeBackend { installed: vec!["POS-80 Printer", "Otra"], ..Default::default() };
        print_with(&backend, &configured("POS-80 Printer", true), None, &document()).unwrap();
        let sent = backend.sent.borrow();
        assert_eq!(sent.len(), 1, "exactly one spooler job");
        assert_eq!(sent[0].0, "POS-80 Printer");
        assert_eq!(sent[0].1, SPOOLER_JOB_NAME);
        assert_eq!(sent[0].2, escpos::encode_document(&document(), CodePage::Cp858, true));
        assert!(sent[0].2.windows(5).any(|window| window == [0xA5, b'a', b'n', b'd', 0xA3]), "Ñandú is encoded with the code page, not as UTF-8");
    }

    #[test]
    fn the_printer_name_is_matched_case_insensitively_and_the_installed_spelling_is_used() {
        let backend = FakeBackend { installed: vec!["POS-80 Printer"], ..Default::default() };
        print_with(&backend, &configured("pos-80 printer", true), None, &document()).unwrap();
        assert_eq!(backend.sent.borrow()[0].0, "POS-80 Printer");
    }

    #[test]
    fn a_printer_that_is_no_longer_installed_is_a_clear_error_and_nothing_is_spooled() {
        let backend = FakeBackend { installed: vec!["Otra"], ..Default::default() };
        let error = print_with(&backend, &configured("POS-80 Printer", true), None, &document()).unwrap_err();
        assert_eq!(error, PrintError::NotFound("POS-80 Printer".to_string()));
        assert!(error.to_string().starts_with("PRINTER_NOT_FOUND:"));
        assert!(backend.sent.borrow().is_empty());
    }

    #[test]
    fn auto_cut_on_and_off_change_only_the_trailer_of_the_job() {
        let backend = FakeBackend { installed: vec!["P"], ..Default::default() };
        print_with(&backend, &configured("P", true), None, &document()).unwrap();
        print_with(&backend, &configured("P", false), None, &document()).unwrap();
        let sent = backend.sent.borrow();
        assert!(sent[0].2.ends_with(&[0x1D, b'V', 1]), "cut at the end");
        assert!(!sent[1].2.windows(3).any(|window| window == [0x1D, b'V', 1]), "no cut command");
        assert!(sent[1].2.ends_with(&[0x1B, b'd', escpos::FEED_LINES_WITHOUT_CUT]), "only feeds the paper");
    }

    #[test]
    fn a_disabled_or_unconfigured_printer_never_prints() {
        let backend = FakeBackend { installed: vec!["P"], ..Default::default() };
        assert_eq!(print_with(&backend, &PrinterSettings::default(), None, &document()).unwrap_err(), PrintError::Disabled);
        let enabled_without_name = PrinterSettings { enabled: true, ..PrinterSettings::default() };
        assert_eq!(print_with(&backend, &enabled_without_name, None, &document()).unwrap_err(), PrintError::NotConfigured);
        assert!(backend.sent.borrow().is_empty());
    }

    #[test]
    fn the_test_page_target_overrides_the_saved_settings_even_when_disabled() {
        let backend = FakeBackend { installed: vec!["Nueva"], ..Default::default() };
        let target = PrintTarget { printer_name: "Nueva".to_string(), auto_cut: false, code_page: CodePage::Wpc1252 };
        print_with(&backend, &PrinterSettings::default(), Some(target), &document()).unwrap();
        assert_eq!(backend.sent.borrow()[0].2, escpos::encode_document(&document(), CodePage::Wpc1252, false));
    }

    #[test]
    fn a_spooler_failure_is_reported_and_an_empty_document_is_refused() {
        let backend = FakeBackend { installed: vec!["P"], fail_spooler: Some(PrintError::Failed("cola detenida".to_string())), ..Default::default() };
        let error = print_with(&backend, &configured("P", true), None, &document()).unwrap_err();
        assert_eq!(error.to_string(), "PRINT_FAILED: cola detenida");
        let empty = PrintDocument { lines: vec![] };
        assert!(matches!(print_with(&backend, &configured("P", true), None, &empty), Err(PrintError::Failed(_))));
    }

    #[test]
    fn settings_are_local_survive_a_save_and_reload_and_a_corrupt_row_falls_back_to_the_default() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::initialize_connection(&mut connection).unwrap();
        assert_eq!(load_settings(&connection), PrinterSettings::default(), "nothing saved yet");
        let saved = normalize_settings(PrinterSettings { enabled: true, printer_name: Some("  POS-80 Printer ".to_string()), auto_print: true, auto_cut: false, ..PrinterSettings::default() }).unwrap();
        assert_eq!(saved.printer_name.as_deref(), Some("POS-80 Printer"));
        save_settings(&mut connection, &saved).unwrap();
        assert_eq!(load_settings(&connection), saved);
        connection.execute("update sync_metadata set value = 'not json' where key = ?1", [PRINTER_SETTINGS_KEY]).unwrap();
        assert_eq!(load_settings(&connection), PrinterSettings::default());
    }

    #[test]
    fn settings_json_from_an_older_or_partial_save_gets_defaults_for_the_rest() {
        let parsed: PrinterSettings = serde_json::from_str(r#"{"enabled":true,"printerName":"P"}"#).unwrap();
        assert_eq!(parsed.paper_width_mm, 80);
        assert!(parsed.auto_cut);
        assert!(!parsed.auto_print);
        assert_eq!(parsed.code_page, CodePage::Cp858);
    }

    #[test]
    fn normalization_rejects_bad_widths_and_an_enabled_printer_without_name_and_keeps_auto_print_off_when_disabled() {
        assert!(normalize_settings(PrinterSettings { paper_width_mm: 72, ..PrinterSettings::default() }).is_err());
        assert!(normalize_settings(PrinterSettings { enabled: true, printer_name: Some("   ".to_string()), ..PrinterSettings::default() }).unwrap_err().starts_with("PRINTER_NOT_CONFIGURED:"));
        let disabled = normalize_settings(PrinterSettings { auto_print: true, ..PrinterSettings::default() }).unwrap();
        assert!(!disabled.auto_print);
        let empty_name = normalize_settings(PrinterSettings { business_name: "  \n ".to_string(), ..PrinterSettings::default() }).unwrap();
        assert_eq!(empty_name.business_name, DEFAULT_BUSINESS_NAME);
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_spooler_enumerates_installed_printers_without_error() {
        // Depende de la máquina (puede no haber impresoras), pero la enumeración nativa nunca debe fallar.
        let printers = spooler_windows::WindowsSpooler.list_printers().expect("EnumPrintersW must succeed");
        assert!(printers.iter().all(|printer| !printer.name.is_empty()));
        assert!(printers.iter().filter(|printer| printer.is_default).count() <= 1);
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_spooler_refuses_a_printer_that_does_not_exist() {
        let error = print_with(
            &spooler_windows::WindowsSpooler,
            &PrinterSettings::default(),
            Some(PrintTarget { printer_name: "Impresora que no existe 9f3a".to_string(), auto_cut: true, code_page: CodePage::Cp858 }),
            &document(),
        )
        .unwrap_err();
        assert!(matches!(error, PrintError::NotFound(_)), "{error}");
    }
}
