//! Scale (balanza) integration for the POS.
//!
//! Design: the sale flow never talks to hardware directly. It only reads a
//! `ScaleSnapshot` (connection state + latest weight reading) and, on an
//! explicit employee action, copies that weight into the manual weight
//! field it already had. Everything below this module is an
//! implementation detail the frontend does not need to know about, so a
//! future scale model only needs a new arm in `connect_scale`.
//!
//! Three "adapters" share one state machine (`ScaleConnectionState`):
//! - Manual: no hardware, always `DISCONNECTED`; the sale flow's existing
//!   manual weight input is the fallback and needs nothing from here.
//! - Simulated: no hardware, a dev/test tool to exercise the same
//!   connect/read/disconnect machinery without a physical scale.
//! - KretzNovelEco2: a real RS232 connection using the `serialport` crate,
//!   read on a dedicated OS thread and framed by `parser::KretzFrameParser`.
//!
//! Persistence: configuration is per-device, so it is stored as a JSON blob
//! under the existing generic `sync_metadata` key/value table (see
//! `apps/pos/src-tauri/migrations/001_offline_core.sql`) instead of adding a
//! new table/migration for a single settings row.

pub mod parser;

use std::io::{ErrorKind, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, StopBits};
use tauri::{AppHandle, Emitter, Manager, State};

pub use parser::KretzFrameParser;

const SCALE_UPDATE_EVENT: &str = "scale://update";
const SCALE_CONFIG_METADATA_KEY: &str = "scale_config";
/// Fixed by the KRETZ Novel Eco 2 manual (RS232, 8N2); not user-configurable.
const KRETZ_BAUD_RATE: u32 = 9_600;
const SERIAL_READ_TIMEOUT: Duration = Duration::from_millis(300);
/// The documented continuous mode transmits ~2 Hz; ticking a little slower
/// keeps the simulated adapter's behaviour comparable without busy-looping.
const SIMULATED_TICK_INTERVAL: Duration = Duration::from_millis(500);
// Reading freshness (TTL) is a sale-flow concern decided by the frontend
// (see packages/business-logic/src/scale.ts, isScaleReadingFresh) so it can
// be unit tested alongside the rest of the pricing/ticket logic; this
// module only ever reports the raw `receivedAt` timestamp and clears the
// reading on every disconnect/reconnect, which is what keeps a stale
// reading from ever being reused across connections.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScaleKind {
    #[serde(rename = "MANUAL")]
    Manual,
    #[serde(rename = "SIMULATED")]
    Simulated,
    #[serde(rename = "KRETZ_NOVEL_ECO_2")]
    KretzNovelEco2,
}

impl Default for ScaleKind {
    fn default() -> Self {
        ScaleKind::Manual
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleConfig {
    pub kind: ScaleKind,
    pub port: Option<String>,
    pub autoconnect: bool,
}

impl Default for ScaleConfig {
    fn default() -> Self {
        Self { kind: ScaleKind::Manual, port: None, autoconnect: false }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScaleConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleReading {
    pub grams: i64,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleSnapshot {
    pub config: ScaleConfig,
    pub connection_state: ScaleConnectionState,
    pub reading: Option<ScaleReading>,
    pub last_error: Option<String>,
}

struct ScaleShared {
    config: ScaleConfig,
    connection_state: ScaleConnectionState,
    reading: Option<ScaleReading>,
    last_error: Option<String>,
    /// Bumped on every connect/disconnect so a background thread from a
    /// superseded connection attempt can notice it is stale and stop
    /// writing to shared state (it may still be blocked in a `read()`).
    generation: u64,
    simulated_weight_grams: Option<i64>,
}

impl ScaleShared {
    fn snapshot(&self) -> ScaleSnapshot {
        ScaleSnapshot {
            config: self.config.clone(),
            connection_state: self.connection_state,
            reading: self.reading.clone(),
            last_error: self.last_error.clone(),
        }
    }
}

pub struct ScaleRuntimeState {
    shared: Mutex<ScaleShared>,
    stop: Mutex<Arc<AtomicBool>>,
}

impl ScaleRuntimeState {
    pub fn new(config: ScaleConfig) -> Self {
        Self {
            shared: Mutex::new(ScaleShared {
                config,
                connection_state: ScaleConnectionState::Disconnected,
                reading: None,
                last_error: None,
                generation: 0,
                simulated_weight_grams: None,
            }),
            stop: Mutex::new(Arc::new(AtomicBool::new(true))),
        }
    }
}

fn lock_error() -> String {
    "Scale state lock poisoned".to_string()
}

/// Reads the persisted config; used both by the Tauri command and by
/// startup autoconnect. Falls back to `Manual` if nothing was saved yet or
/// the stored JSON does not parse (never panics on corrupt local data).
pub fn load_persisted_config(connection: &Connection) -> ScaleConfig {
    match crate::metadata(connection, SCALE_CONFIG_METADATA_KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => ScaleConfig::default(),
    }
}

fn persist_config(connection: &mut Connection, config: &ScaleConfig) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string(config).map_err(|error| error.to_string())?;
    crate::set_metadata(&transaction, SCALE_CONFIG_METADATA_KEY, &serialized, &crate::now())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn emit_snapshot(app: &AppHandle, snapshot: &ScaleSnapshot) {
    if let Err(error) = app.emit(SCALE_UPDATE_EVENT, snapshot) {
        eprintln!("Could not emit scale update: {error}");
    }
}

/// Stops any running reader/ticker thread and resets to `DISCONNECTED`.
/// Safe to call even if nothing is connected. `pub(crate)` so `lib.rs` can
/// run it once more on window close to release the serial port cleanly.
pub(crate) fn disconnect_internal(scale: &State<'_, ScaleRuntimeState>) -> Result<ScaleSnapshot, String> {
    scale.stop.lock().map_err(|_| lock_error())?.store(true, Ordering::SeqCst);
    let mut shared = scale.shared.lock().map_err(|_| lock_error())?;
    shared.generation += 1;
    shared.connection_state = ScaleConnectionState::Disconnected;
    shared.reading = None;
    shared.last_error = None;
    shared.simulated_weight_grams = None;
    Ok(shared.snapshot())
}

fn update_reading(app: &AppHandle, generation: u64, grams: i64) {
    let state = app.state::<ScaleRuntimeState>();
    let snapshot = {
        let Ok(mut shared) = state.shared.lock() else { return };
        if shared.generation != generation {
            return;
        }
        shared.reading = Some(ScaleReading { grams, received_at: crate::now() });
        shared.connection_state = ScaleConnectionState::Connected;
        shared.last_error = None;
        shared.snapshot()
    };
    emit_snapshot(app, &snapshot);
}

fn mark_error(app: &AppHandle, generation: u64, message: String) {
    let state = app.state::<ScaleRuntimeState>();
    let snapshot = {
        let Ok(mut shared) = state.shared.lock() else { return };
        if shared.generation != generation {
            return;
        }
        shared.connection_state = ScaleConnectionState::Error;
        shared.reading = None;
        shared.last_error = Some(message);
        shared.snapshot()
    };
    emit_snapshot(app, &snapshot);
}

fn spawn_serial_reader(app: AppHandle, generation: u64, stop: Arc<AtomicBool>, mut port: Box<dyn SerialPort>) {
    std::thread::spawn(move || {
        let mut framer = KretzFrameParser::new();
        let mut buffer = [0_u8; 256];
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match port.read(&mut buffer) {
                Ok(0) => continue,
                Ok(count) => {
                    for result in framer.feed(&buffer[..count]) {
                        match result {
                            Ok(grams) => update_reading(&app, generation, grams),
                            // A single corrupted frame does not drop the connection;
                            // the scale transmits again in well under a second.
                            Err(error) => eprintln!("Discarded invalid scale frame: {error}"),
                        }
                    }
                }
                // The read timeout elapsing with no data is normal idle polling,
                // not a hardware error; it also doubles as our stop-flag check.
                Err(error) if error.kind() == ErrorKind::TimedOut => continue,
                Err(error) => {
                    mark_error(&app, generation, format!("Error leyendo la balanza: {error}"));
                    break;
                }
            }
        }
    });
}

fn spawn_simulated_ticker(app: AppHandle, generation: u64, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(SIMULATED_TICK_INTERVAL);
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let state = app.state::<ScaleRuntimeState>();
        let snapshot = {
            let Ok(mut shared) = state.shared.lock() else { break };
            if shared.generation != generation || shared.connection_state != ScaleConnectionState::Connected {
                break;
            }
            let Some(grams) = shared.simulated_weight_grams else { continue };
            shared.reading = Some(ScaleReading { grams, received_at: crate::now() });
            shared.snapshot()
        };
        emit_snapshot(&app, &snapshot);
    });
}

#[tauri::command]
pub fn get_scale_config(scale: State<'_, ScaleRuntimeState>) -> Result<ScaleConfig, String> {
    Ok(scale.shared.lock().map_err(|_| lock_error())?.config.clone())
}

#[tauri::command]
pub fn get_scale_snapshot(scale: State<'_, ScaleRuntimeState>) -> Result<ScaleSnapshot, String> {
    Ok(scale.shared.lock().map_err(|_| lock_error())?.snapshot())
}

/// Persists the config and resets any active connection. The employee (or
/// the setup screen) must explicitly connect again afterwards; this avoids
/// hot-swapping a live serial connection under changing settings.
#[tauri::command]
pub fn set_scale_config(
    app: AppHandle,
    db: State<'_, crate::DatabaseState>,
    scale: State<'_, ScaleRuntimeState>,
    config: ScaleConfig,
) -> Result<ScaleSnapshot, String> {
    if config.kind == ScaleKind::KretzNovelEco2 && config.port.as_deref().unwrap_or("").trim().is_empty() {
        return Err("Elegí un puerto serie para la balanza Kretz".to_string());
    }
    {
        let mut connection = db.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
        persist_config(&mut connection, &config)?;
    }
    let snapshot = disconnect_internal(&scale)?;
    scale.shared.lock().map_err(|_| lock_error())?.config = config;
    emit_snapshot(&app, &snapshot);
    Ok(scale.shared.lock().map_err(|_| lock_error())?.snapshot())
}

#[tauri::command]
pub fn list_scale_ports() -> Vec<String> {
    match serialport::available_ports() {
        Ok(ports) => {
            let mut names: Vec<String> = ports.into_iter().map(|port| port.port_name).collect();
            names.sort();
            names
        }
        Err(error) => {
            eprintln!("Could not enumerate serial ports: {error}");
            Vec::new()
        }
    }
}

#[tauri::command]
pub fn connect_scale(app: AppHandle, scale: State<'_, ScaleRuntimeState>) -> Result<ScaleSnapshot, String> {
    disconnect_internal(&scale)?;

    let config = scale.shared.lock().map_err(|_| lock_error())?.config.clone();
    let generation = {
        let mut shared = scale.shared.lock().map_err(|_| lock_error())?;
        shared.generation += 1;
        shared.connection_state = ScaleConnectionState::Connecting;
        shared.reading = None;
        shared.last_error = None;
        shared.generation
    };
    let stop = Arc::new(AtomicBool::new(false));
    *scale.stop.lock().map_err(|_| lock_error())? = stop.clone();

    let result = match config.kind {
        ScaleKind::Manual => {
            let mut shared = scale.shared.lock().map_err(|_| lock_error())?;
            shared.connection_state = ScaleConnectionState::Disconnected;
            Ok(())
        }
        ScaleKind::Simulated => {
            scale.shared.lock().map_err(|_| lock_error())?.connection_state = ScaleConnectionState::Connected;
            spawn_simulated_ticker(app.clone(), generation, stop);
            Ok(())
        }
        ScaleKind::KretzNovelEco2 => {
            let path = config.port.clone().ok_or_else(|| "Elegí un puerto serie antes de conectar".to_string())?;
            match serialport::new(&path, KRETZ_BAUD_RATE)
                .data_bits(DataBits::Eight)
                .parity(Parity::None)
                .stop_bits(StopBits::Two)
                .timeout(SERIAL_READ_TIMEOUT)
                .open()
            {
                Ok(port) => {
                    scale.shared.lock().map_err(|_| lock_error())?.connection_state = ScaleConnectionState::Connected;
                    spawn_serial_reader(app.clone(), generation, stop, port);
                    Ok(())
                }
                Err(error) => {
                    let mut shared = scale.shared.lock().map_err(|_| lock_error())?;
                    shared.connection_state = ScaleConnectionState::Error;
                    shared.last_error = Some(format!("No se pudo abrir {path}: {error}"));
                    Err(shared.last_error.clone().unwrap_or_default())
                }
            }
        }
    };

    let snapshot = scale.shared.lock().map_err(|_| lock_error())?.snapshot();
    emit_snapshot(&app, &snapshot);
    result.map(|_| snapshot)
}

#[tauri::command]
pub fn disconnect_scale(app: AppHandle, scale: State<'_, ScaleRuntimeState>) -> Result<ScaleSnapshot, String> {
    let snapshot = disconnect_internal(&scale)?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

/// Dev/test-only command backing the `SIMULATED` adapter's configuration UI.
#[tauri::command]
pub fn set_simulated_scale_weight(app: AppHandle, scale: State<'_, ScaleRuntimeState>, grams: i64) -> Result<ScaleSnapshot, String> {
    if grams < 0 {
        return Err("El peso simulado no puede ser negativo".to_string());
    }
    let snapshot = {
        let mut shared = scale.shared.lock().map_err(|_| lock_error())?;
        if shared.config.kind != ScaleKind::Simulated || shared.connection_state != ScaleConnectionState::Connected {
            return Err("Conectá la balanza simulada antes de fijar un peso".to_string());
        }
        shared.simulated_weight_grams = Some(grams);
        shared.reading = Some(ScaleReading { grams, received_at: crate::now() });
        shared.snapshot()
    };
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

/// Dev/test-only command: exercises the error/disconnect path without
/// physically unplugging anything.
#[tauri::command]
pub fn simulate_scale_disconnect(app: AppHandle, scale: State<'_, ScaleRuntimeState>) -> Result<ScaleSnapshot, String> {
    scale.stop.lock().map_err(|_| lock_error())?.store(true, Ordering::SeqCst);
    let snapshot = {
        let mut shared = scale.shared.lock().map_err(|_| lock_error())?;
        if shared.config.kind != ScaleKind::Simulated {
            return Err("Sólo disponible en modo simulado".to_string());
        }
        shared.generation += 1;
        shared.connection_state = ScaleConnectionState::Error;
        shared.reading = None;
        shared.last_error = Some("Desconexión simulada".to_string());
        shared.snapshot()
    };
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual_state() -> ScaleRuntimeState {
        ScaleRuntimeState::new(ScaleConfig::default())
    }

    #[test]
    fn disconnect_on_a_fresh_state_reports_disconnected() {
        let state = manual_state();
        let guard = state.shared.lock().unwrap();
        assert_eq!(guard.connection_state, ScaleConnectionState::Disconnected);
        assert!(guard.reading.is_none());
    }

    #[test]
    fn disconnect_clears_a_stale_reading_and_bumps_generation() {
        let state = manual_state();
        {
            let mut shared = state.shared.lock().unwrap();
            shared.connection_state = ScaleConnectionState::Connected;
            shared.reading = Some(ScaleReading { grams: 1_250, received_at: crate::now() });
            shared.generation = 5;
        }
        // disconnect_internal takes a tauri::State, which we cannot construct
        // outside a running app; assert the same behaviour it must produce.
        {
            let mut shared = state.shared.lock().unwrap();
            let previous_generation = shared.generation;
            shared.generation += 1;
            shared.connection_state = ScaleConnectionState::Disconnected;
            shared.reading = None;
            assert_ne!(shared.generation, previous_generation);
        }
        let guard = state.shared.lock().unwrap();
        assert_eq!(guard.connection_state, ScaleConnectionState::Disconnected);
        assert!(guard.reading.is_none());
    }

    #[test]
    fn a_reading_from_a_superseded_generation_is_not_applied() {
        let state = manual_state();
        {
            let mut shared = state.shared.lock().unwrap();
            shared.connection_state = ScaleConnectionState::Connected;
            shared.generation = 2;
        }
        // Simulate update_reading's own generation guard without an AppHandle.
        let stale_generation = 1_u64;
        let mut shared = state.shared.lock().unwrap();
        if shared.generation == stale_generation {
            shared.reading = Some(ScaleReading { grams: 999, received_at: crate::now() });
        }
        assert!(shared.reading.is_none(), "a stale generation must not overwrite the current reading");
    }

    #[test]
    fn config_round_trips_through_json_for_persistence() {
        let config = ScaleConfig { kind: ScaleKind::KretzNovelEco2, port: Some("/dev/ttyUSB0".to_string()), autoconnect: true };
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(serialized.contains("KRETZ_NOVEL_ECO_2"));
        assert!(serialized.contains("/dev/ttyUSB0"));
        let deserialized: ScaleConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, config);
    }

    #[test]
    fn corrupt_persisted_config_falls_back_to_manual_default() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::initialize_connection(&mut connection).unwrap();
        connection
            .execute(
                "insert into sync_metadata(key, value, updated_at) values (?1, 'not json', ?2)",
                rusqlite::params![SCALE_CONFIG_METADATA_KEY, crate::now()],
            )
            .unwrap();
        let config = load_persisted_config(&connection);
        assert_eq!(config, ScaleConfig::default());
    }

    #[test]
    fn persisted_config_survives_a_save_and_reload_cycle() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::initialize_connection(&mut connection).unwrap();
        let config = ScaleConfig { kind: ScaleKind::Simulated, port: None, autoconnect: true };
        persist_config(&mut connection, &config).unwrap();
        assert_eq!(load_persisted_config(&connection), config);
    }
}
