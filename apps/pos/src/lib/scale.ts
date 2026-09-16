import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ScaleConnectionState, ScaleKind, ScaleReading } from "@carnicerias/business-logic";

import { isDesktopRuntime } from "./local-database";

export interface ScaleConfig {
  kind: ScaleKind;
  port: string | null;
  autoconnect: boolean;
}

export interface ScaleSnapshot {
  config: ScaleConfig;
  connectionState: ScaleConnectionState;
  reading: ScaleReading | null;
  lastError: string | null;
}

const SCALE_UPDATE_EVENT = "scale://update";

const DISCONNECTED_MANUAL_SNAPSHOT: ScaleSnapshot = {
  config: { kind: "MANUAL", port: null, autoconnect: false },
  connectionState: "DISCONNECTED",
  reading: null,
  lastError: null
};

function desktopOnly<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) throw new Error("This operation requires the Tauri desktop runtime");
  return invoke<T>(command, args);
}

export const scaleBridge = {
  getConfig: () => desktopOnly<ScaleConfig>("get_scale_config"),
  setConfig: (config: ScaleConfig) => desktopOnly<ScaleSnapshot>("set_scale_config", { config }),
  listPorts: () => desktopOnly<string[]>("list_scale_ports"),
  snapshot: () => desktopOnly<ScaleSnapshot>("get_scale_snapshot"),
  connect: () => desktopOnly<ScaleSnapshot>("connect_scale"),
  disconnect: () => desktopOnly<ScaleSnapshot>("disconnect_scale"),
  setSimulatedWeight: (grams: number) => desktopOnly<ScaleSnapshot>("set_simulated_scale_weight", { grams }),
  simulateDisconnect: () => desktopOnly<ScaleSnapshot>("simulate_scale_disconnect")
};

/**
 * Keeps a live `ScaleSnapshot` backed by the native scale event stream.
 * On the web build (no Tauri bridge) it stays at the manual/disconnected
 * default and never calls into `invoke`, per the "no explotar sin bridge"
 * requirement for running the POS outside Tauri during development.
 */
export function useScaleSnapshot(desktop: boolean): ScaleSnapshot {
  const [snapshot, setSnapshot] = useState<ScaleSnapshot>(DISCONNECTED_MANUAL_SNAPSHOT);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!desktop) return;

    let unlisten: (() => void) | undefined;
    void scaleBridge.snapshot().then((current) => {
      if (mounted.current) setSnapshot(current);
    }).catch(() => undefined);
    void listen<ScaleSnapshot>(SCALE_UPDATE_EVENT, (event) => {
      if (mounted.current) setSnapshot(event.payload);
    }).then((stop) => {
      unlisten = stop;
    });

    return () => {
      mounted.current = false;
      unlisten?.();
    };
  }, [desktop]);

  return snapshot;
}
