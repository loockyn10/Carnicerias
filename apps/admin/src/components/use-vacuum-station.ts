"use client";

import type { Json } from "@carnicerias/database";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createVacuumPackageAction, getVacuumStationSummaryAction, listVacuumStationProductsAction, recordVacuumPrintAction } from "../app/admin/vacuum/actions";
import { localDateString } from "../lib/date-range";
import { parseVacuumPackage, vacuumDims, type VacuumPackage, type VacuumSettings } from "../lib/vacuum";
import {
  approvePrintTest, browserStorage, DEFAULT_STATION_CONFIG, isAutoPrintEnabled, isPrintTestCurrent, loadStationConfig, saveStationConfig, setAutoPrint, setRotation,
  type LabelRotation, type StationConfig, type StationPrintKind
} from "../lib/vacuum-station/config";
import { bindScale, StationController, type PrintResult, type RegisterResult, type StationDeps } from "../lib/vacuum-station/controller";
import {
  parseStationProducts, parseStationSummary, productReadiness, type ProductionParams, type StationProduct, type StationSummary
} from "../lib/vacuum-station/data";
import { buildPackageJobs, buildTestJobs, printJobs } from "../lib/vacuum-station/label-print";
import { DEFAULT_STATION_TUNING, type StationOptions } from "../lib/vacuum-station/machine";
import { SerialScale } from "../lib/vacuum-station/serial-scale";
import { webSerialSupport, type ScaleLinkStatus, type ScaleSource } from "../lib/vacuum-station/scale-source";
import type { SimulatedScale } from "../lib/vacuum-station/simulator";

/**
 * Pegamento de la estación con el navegador: Web Serial, Internet, la impresora y el servidor. Toda la lógica de decisión vive en `lib/vacuum-station`
 * (probada sin navegador); acá sólo se conectan los dispositivos y se mantiene el estado que la pantalla muestra.
 */

export interface UseVacuumStationProps {
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  initialProducts: Json;
  initialSummary: Json;
  settings: VacuumSettings;
  timezone: string;
  /** Lo decide el servidor (`isSimulatorAllowed`): en producción normal es false y el simulador no se puede encender. */
  simulatorAllowed: boolean;
}

export interface ScaleLinkView {
  status: ScaleLinkStatus;
  message: string | null;
  /** Última trama que no se pudo interpretar (diagnóstico). */
  lastFrameError: string | null;
  lastSampleAtMs: number | null;
}

const HEARTBEAT_MS = 20_000;
const HEARTBEAT_OFFLINE_MS = 5_000;
const PRODUCTS_REFRESH_MS = 180_000;

const nowMs = () => Math.round(performance.now());

export function useVacuumStation(props: UseVacuumStationProps) {
  const { settings, timezone } = props;
  const dims = useMemo(() => vacuumDims(settings), [settings]);

  // --- configuración persistente (por dispositivo) ---
  const [config, setConfigState] = useState<StationConfig>(DEFAULT_STATION_CONFIG);
  const configRef = useRef<StationConfig>(DEFAULT_STATION_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configSaved, setConfigSaved] = useState(true);
  useEffect(() => {
    const loaded = loadStationConfig(browserStorage());
    configRef.current = loaded;
    setConfigState(loaded);
    setConfigLoaded(true);
  }, []);
  const updateConfig = useCallback((change: (current: StationConfig) => StationConfig) => {
    const next = change(configRef.current);
    configRef.current = next;
    setConfigState(next);
    setConfigSaved(saveStationConfig(browserStorage(), next));
  }, []);

  // --- sucursal, corte y parámetros de producción ---
  const validBranch = (id: string | null) => (id !== null && props.branches.some((branch) => branch.id === id) ? id : null);
  const branchId = validBranch(config.branchId) ?? props.defaultBranchId;
  const [products, setProducts] = useState<StationProduct[]>(() => parseStationProducts(props.initialProducts));
  const [productId, setProductId] = useState<string | null>(null);
  const [params, setParams] = useState<ProductionParams>({ packedOn: null, expiryByProduct: {} });
  const [summary, setSummary] = useState<StationSummary>(() => parseStationSummary(props.initialSummary));
  const [today, setToday] = useState(() => localDateString(timezone));
  const product = useMemo(() => products.find((candidate) => candidate.productId === productId) ?? null, [products, productId]);
  const readiness = useMemo(() => productReadiness(product, params, today, settings.ean), [product, params, today, settings.ean]);

  // La fecha de hoy sigue al reloj si la pantalla queda abierta pasada la medianoche.
  useEffect(() => {
    const timer = window.setInterval(() => { setToday(localDateString(timezone)); }, 60_000);
    return () => { window.clearInterval(timer); };
  }, [timezone]);

  // Referencias para que los dispositivos (creados una sola vez) siempre vean lo último.
  const live = useRef({ branchId, params, today, products, config, dims });
  live.current = { branchId, params, today, products, config, dims };

  const [printNotice, setPrintNotice] = useState<{ dialogShown: boolean; lastError: string | null }>({ dialogShown: false, lastError: null });

  // --- controlador (una sola instancia; sus dependencias leen `live`) ---
  const [controller] = useState(() => {
    const deps: StationDeps<VacuumPackage> = {
      now: nowMs,
      newKey: () => crypto.randomUUID(),
      sleep: (ms) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); }),
      register: async (input): Promise<RegisterResult<VacuumPackage>> => {
        const { branchId: branch, params: current, today: day, products: list } = live.current;
        const target = list.find((candidate) => candidate.productId === input.productId) ?? null;
        const check = productReadiness(target, current, day, settings.ean);
        if (!check.ready) return { ok: false, error: check.problems[0] ?? "El corte no está listo para envasar", transient: false };
        try {
          const result = await createVacuumPackageAction({
            branchId: branch, productId: input.productId, weightGrams: input.grams, packedOn: current.packedOn ?? day, expiresOn: check.expiresOnToSend, lot: null, requestKey: input.requestKey
          });
          if (!result.ok) return { ok: false, error: result.error, transient: false };
          const pkg = parseVacuumPackage(result.data);
          if (!pkg) return { ok: false, error: "No se pudo leer el paquete registrado", transient: false };
          return { ok: true, packageId: pkg.id, payload: pkg };
        } catch (error) {
          // Sin respuesta del servidor: el resultado es incierto. Se reintenta con la MISMA clave (el servidor devuelve el paquete si ya lo creó).
          return { ok: false, error: error instanceof Error ? error.message : "Sin conexión con el servidor", transient: true };
        }
      },
      print: async (packageId, pkg, kind): Promise<PrintResult> => {
        const { config: currentConfig } = live.current;
        const chosen: StationPrintKind = kind ?? currentConfig.print.kind;
        const outcome = await printJobs(buildPackageJobs(pkg, chosen, currentConfig.print.rotation, { logisticLabel: currentConfig.print.logisticLabel }));
        setPrintNotice({ dialogShown: outcome.dialogShown, lastError: outcome.error });
        if (!outcome.ok) return { ok: false, error: outcome.error ?? "No se pudo imprimir" };
        // La constancia de impresión es auxiliar: si falla no se da la impresión por mala (la etiqueta ya salió).
        void recordVacuumPrintAction(packageId, chosen).catch(() => undefined);
        return { ok: true };
      }
    };
    const options: StationOptions = { tuning: DEFAULT_STATION_TUNING, autoPrint: false };
    return new StationController<VacuumPackage>(deps, options);
  });
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const autoPrintOn = isAutoPrintEnabled(config, dims);
  const printTestCurrent = isPrintTestCurrent(config, dims);
  useEffect(() => {
    controller.setOptions({ tuning: config.tuning, autoPrint: autoPrintOn });
  }, [controller, config.tuning, autoPrintOn]);

  useEffect(() => {
    controller.start();
    return () => { controller.stop(); };
  }, [controller]);

  useEffect(() => { controller.dispatch({ type: "PRODUCT_SELECTED", productId }); }, [controller, productId]);
  useEffect(() => { controller.dispatch({ type: "READY", ready: readiness.ready }); }, [controller, readiness.ready]);

  // --- Internet y servidor ---
  const reachable = useRef({ browser: true, server: true });
  const applyOnline = useCallback(() => {
    controller.dispatch({ type: "ONLINE", online: reachable.current.browser && reachable.current.server });
  }, [controller]);
  useEffect(() => {
    reachable.current.browser = navigator.onLine;
    applyOnline();
    const up = () => { reachable.current.browser = true; applyOnline(); };
    const down = () => { reachable.current.browser = false; applyOnline(); };
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, [applyOnline]);

  const refreshSummary = useCallback(async () => {
    try {
      const result = await getVacuumStationSummaryAction(live.current.branchId);
      reachable.current.server = true;
      if ("data" in result) setSummary(parseStationSummary(result.data));
    } catch {
      reachable.current.server = false;
    }
    applyOnline();
  }, [applyOnline]);

  // Latido: el resumen del día es una consulta liviana; si falla por la red, la estación se pausa sola; al responder, se reanuda.
  const online = snapshot.state.online;
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const beat = () => {
      void refreshSummary().finally(() => {
        if (!cancelled) timer = window.setTimeout(beat, reachable.current.server ? HEARTBEAT_MS : HEARTBEAT_OFFLINE_MS);
      });
    };
    timer = window.setTimeout(beat, online ? HEARTBEAT_MS : HEARTBEAT_OFFLINE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refreshSummary, branchId, online]);

  // Después de cada paquete registrado se actualiza el resumen al instante.
  const lastPackageId = snapshot.lastPackage?.id ?? null;
  useEffect(() => {
    if (lastPackageId !== null) void refreshSummary();
  }, [lastPackageId, refreshSummary]);

  // Lista de cortes: se relee al cambiar de sucursal y cada tanto (los precios pueden cambiar con la estación abierta).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listVacuumStationProductsAction(branchId).then((result) => {
        if (!cancelled && "data" in result) setProducts(parseStationProducts(result.data));
      }).catch(() => undefined);
    };
    const first = window.setTimeout(load, 0);
    const timer = window.setInterval(load, PRODUCTS_REFRESH_MS);
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(timer); };
  }, [branchId]);

  // --- balanza ---
  // Se evalúa en el navegador (en el servidor no hay `navigator`): hasta entonces es null y la pantalla no muestra ningún aviso.
  const [support, setSupport] = useState<ReturnType<typeof webSerialSupport> | null>(null);
  useEffect(() => { setSupport(webSerialSupport()); }, []);
  const [link, setLink] = useState<ScaleLinkView>({ status: "DISCONNECTED", message: null, lastFrameError: null, lastSampleAtMs: null });
  const sourceRef = useRef<ScaleSource | null>(null);
  const serialRef = useRef<SerialScale | null>(null);
  const simulatorRef = useRef<SimulatedScale | null>(null);
  const [simulator, setSimulator] = useState<SimulatedScale | null>(null);

  const attachSource = useCallback((source: ScaleSource): (() => void) => {
    sourceRef.current = source;
    const unbind = bindScale(source, controller);
    const unsubscribe = source.subscribe((event) => {
      if (event.type === "status") setLink((current) => ({ ...current, status: event.status, message: event.message }));
      else if (event.type === "sample") setLink((current) => ({ ...current, lastSampleAtMs: event.atMs }));
      else setLink((current) => ({ ...current, lastFrameError: event.message }));
    });
    return () => { unbind(); unsubscribe(); if (sourceRef.current === source) sourceRef.current = null; };
  }, [controller]);

  const scaleKey = JSON.stringify([config.scale.protocol, config.scale.params, config.scale.autoReconnect, configLoaded]);
  useEffect(() => {
    if (!configLoaded || !support?.supported || simulatorRef.current) return;
    const serial = new SerialScale({
      serial: support.serial, protocol: config.scale.protocol, params: config.scale.params, autoReconnect: config.scale.autoReconnect, now: nowMs,
      sleep: (ms) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); })
    });
    serialRef.current = serial;
    const detach = attachSource(serial);
    // Reconexión silenciosa SÓLO con un puerto que el navegador ya autorizó; si no se puede, el operario usa «Conectar balanza».
    if (config.scale.autoReconnect) void serial.reconnectAuthorized(config.scale.port);
    return () => {
      detach();
      serialRef.current = null;
      void serial.dispose();
    };
  }, [scaleKey, support, attachSource]);

  /** Acción del operario (clic): pide el puerto al navegador y conecta. */
  const connectScale = useCallback(async () => {
    const sim = simulatorRef.current;
    if (sim) { sim.connect(); return; }
    const serial = serialRef.current;
    if (!serial) return;
    const connected = await serial.requestAndConnect();
    if (connected) {
      const port = serial.currentPortId();
      if (port) updateConfig((current) => ({ ...current, scale: { ...current.scale, port } }));
    }
  }, [updateConfig]);

  const disconnectScale = useCallback(async () => {
    await sourceRef.current?.disconnect();
  }, []);

  /** Sólo desarrollo/pruebas: reemplaza la balanza real por el simulador (nunca se ofrece en producción normal). */
  const enableSimulator = useCallback(async () => {
    if (!props.simulatorAllowed || simulatorRef.current) return;
    const module = await import("../lib/vacuum-station/simulator");
    await serialRef.current?.disconnect();
    const sim = new module.SimulatedScale({ now: nowMs, intervalMs: 500 }, { reportsStability: false });
    simulatorRef.current = sim;
    attachSource(sim);
    setSimulator(sim);
    sim.connect();
  }, [attachSource, props.simulatorAllowed]);

  const disableSimulator = useCallback(async () => {
    const sim = simulatorRef.current;
    if (!sim) return;
    await sim.disconnect();
    simulatorRef.current = null;
    setSimulator(null);
    window.location.reload();
  }, []);

  // --- acciones del operario ---
  const selectProduct = useCallback((id: string) => { setProductId(id); }, []);
  const setPackedOn = useCallback((value: string | null) => { setParams((current) => ({ ...current, packedOn: value })); }, []);
  const setExpiryFor = useCallback((id: string, value: string) => {
    setParams((current) => ({ ...current, expiryByProduct: { ...current.expiryByProduct, [id]: value } }));
  }, []);
  const toggleFavorite = useCallback((id: string) => {
    updateConfig((current) => ({ ...current, favorites: current.favorites.includes(id) ? current.favorites.filter((entry) => entry !== id) : [...current.favorites, id].slice(-60) }));
  }, [updateConfig]);
  const setBranch = useCallback((id: string) => {
    updateConfig((current) => ({ ...current, branchId: id }));
    setProductId(null);
  }, [updateConfig]);

  const pause = useCallback(() => { controller.dispatch({ type: "PAUSE" }); }, [controller]);
  const resume = useCallback(() => { controller.dispatch({ type: "RESUME" }); }, [controller]);
  const retry = useCallback(() => { controller.dispatch({ type: "RETRY" }); }, [controller]);
  const skipPrint = useCallback(() => { controller.dispatch({ type: "SKIP_PRINT" }); }, [controller]);
  const reprint = useCallback((kind: StationPrintKind | null) => controller.reprintLast(kind), [controller]);

  const [testOutcome, setTestOutcome] = useState<{ ok: boolean; error: string | null; dialogShown: boolean } | null>(null);
  const printTest = useCallback(async (kind: StationPrintKind) => {
    const { config: currentConfig, dims: currentDims } = live.current;
    const outcome = await printJobs(buildTestJobs(currentDims, kind, currentConfig.print.rotation));
    setTestOutcome({ ok: outcome.ok, error: outcome.error, dialogShown: outcome.dialogShown });
    if (outcome.dialogShown) setPrintNotice((current) => ({ ...current, dialogShown: true }));
    return outcome;
  }, []);
  const approveTest = useCallback(() => {
    updateConfig((current) => approvePrintTest(current, live.current.dims, new Date().toISOString()));
    setTestOutcome(null);
  }, [updateConfig]);
  const changeAutoPrint = useCallback((auto: boolean) => { updateConfig((current) => setAutoPrint(current, live.current.dims, auto)); }, [updateConfig]);
  const changeRotation = useCallback((rotation: LabelRotation) => { updateConfig((current) => setRotation(current, rotation)); }, [updateConfig]);

  return {
    config, configLoaded, configSaved, updateConfig, dims, branchId, branchName: props.branches.find((branch) => branch.id === branchId)?.name ?? "", timezone, setBranch,
    products, product, selectProduct, readiness, params, today, setPackedOn, setExpiryFor, toggleFavorite,
    snapshot, summary, support, link, connectScale, disconnectScale,
    simulator, simulatorAllowed: props.simulatorAllowed, enableSimulator, disableSimulator,
    pause, resume, retry, skipPrint, reprint, printTest, approveTest, testOutcome, printNotice, autoPrintOn, printTestCurrent, changeAutoPrint, changeRotation
  };
}

export type VacuumStationModel = ReturnType<typeof useVacuumStation>;
