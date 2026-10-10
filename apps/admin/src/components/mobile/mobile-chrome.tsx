"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Estado compartido entre una pantalla del celular y la barra superior: la pantalla puede cambiar el título («Qué llevar a Avenida») y tomar el
 * botón «‹ Volver» cuando tiene pasos internos (lista → preparar → revisar). Sin esto la barra siempre volvería a la pantalla anterior y se
 * perderían los pasos. Es un store mínimo de módulo: vive sólo en el navegador y se limpia al salir de la pantalla.
 */
interface ChromeState { title: string | null; onBack: (() => void) | null }

const EMPTY: ChromeState = { title: null, onBack: null };
let current: ChromeState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: ChromeState) {
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChromeState(): ChromeState {
  return useSyncExternalStore(subscribe, () => current, () => EMPTY);
}

/** Una pantalla toma el título y (opcionalmente) el «‹ Volver» de la barra superior mientras está montada. */
export function useMobileChrome(title: string | null, onBack: (() => void) | null) {
  const latest = useRef(onBack);
  latest.current = onBack;
  const hasBack = onBack !== null;
  const stableBack = useCallback(() => { latest.current?.(); }, []);
  useEffect(() => {
    publish({ title, onBack: hasBack ? stableBack : null });
    return () => { publish(EMPTY); };
  }, [title, hasBack, stableBack]);
}

/**
 * Pasos internos de una pantalla (p. ej. lista → preparar → revisar) enganchados al historial del navegador: el botón «atrás» del celular (o el gesto)
 * vuelve al paso anterior en vez de sacar al usuario de la pantalla y hacerle perder lo que cargó.
 */
export function useInnerSteps<T extends string>(initial: T) {
  const [step, setStep] = useState<T>(initial);
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const state = event.state as { mobileStep?: unknown } | null;
      setStep(typeof state?.mobileStep === "string" ? state.mobileStep as T : initial);
    };
    window.addEventListener("popstate", onPop);
    return () => { window.removeEventListener("popstate", onPop); };
  }, [initial]);
  const go = useCallback((next: T) => {
    window.history.pushState({ mobileStep: next }, "");
    setStep(next);
  }, []);
  const back = useCallback(() => { window.history.back(); }, []);
  return { step, go, back, atStart: step === initial };
}

/** Si el navegador permite guardar (en un modo privado puede fallar), nunca rompe la pantalla. */
export function useStoredState(key: string): [string | null, (value: string | null) => void, boolean] {
  const [value, setValue] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try { setValue(window.localStorage.getItem(key)); } catch { setValue(null); }
    setLoaded(true);
  }, [key]);
  const save = useCallback((next: string | null) => {
    setValue(next);
    try {
      if (next === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, next);
    } catch { /* sin almacenamiento: la pantalla sigue funcionando, sólo no recuerda */ }
  }, [key]);
  return [value, save, loaded];
}
