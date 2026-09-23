import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  formatCurrency,
  formatWeight,
  parseWeightToGrams,
  priceForWeight,
  calculateSalePricing,
  calculateWeightPackSalePricing,
  calculateUnitPackSalePricing,
  isScaleReadingFresh,
  sumMoney,
  type ScaleKind
} from "@carnicerias/business-logic";
import type { PaymentMethod, TicketLine } from "@carnicerias/types";
import { createOfflineSale, type SyncStatusSnapshot } from "@carnicerias/sync";

import { buildCategoryTabs, productMatchesCategory, type CategoryDirectoryEntryLike } from "./lib/catalog";
import { describeCaughtValue, formatDiagnostics, resolveErrorMessage } from "./lib/error-messages";
import { INITIAL_PAYMENT_METHOD, isSaleConfirmable, shouldDisplayTicketAmounts, validatePaymentMethodForSale } from "./lib/ticket-payment";
import { isDesktopRuntime, localDatabase, type LocalOperator, type LocalRuntime, type LocalShift, type OperatorRosterRow, type OutboxSummary, type RecentLocalSale } from "./lib/local-database";
import { scaleBridge, useScaleSnapshot } from "./lib/scale";
import { supabase } from "./lib/supabase";
import { registerDesktopDevice, startBackgroundSyncPolling, synchronizeDesktop } from "./lib/sync-engine";

interface AuthUser {
  id: string;
  email: string;
  offline: boolean;
}

interface Branch {
  id: string;
  organization_id: string;
  name: string;
  code: string;
}

interface CatalogProduct {
  organizationId: string;
  branchId: string;
  branchName: string;
  categoryId: string;
  categoryName: string;
  categoryColorHex: string | null;
  categorySortOrder: number;
  /** Every active category this product is assigned to (principal included) — used only for
   * multi-category filtering; the card's color/name keep coming from categoryId/Name/ColorHex. */
  categoryIds: string[];
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  pricePerKgCents: bigint;
}
interface DiscountRule {
  id: string;
  productId: string;
  branchId: string | null;
  promotionMode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  minimumGrams: number | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: string | null;
  packQuantityGrams: number | null;
  packQuantityUnits: number | null;
  packPriceCents: string | null;
}
interface Announcement { id: string; title: string; message: string; type: string; priority: number }

// Sólo 3 métodos operativos se ofrecen para ventas nuevas. CREDIT/OTHER siguen
// siendo valores válidos de PaymentMethod (ventas históricas, no se migran),
// simplemente no se exponen en este selector. DEBIT y CREDIT hoy tienen el
// mismo comportamiento comercial (sin descuento por pago), así que "Tarjeta"
// usa DEBIT como representación interna — no se crea un método CARD nuevo.
const PAYMENT_METHOD_BUTTONS: { value: PaymentMethod; label: string; activeClass: string }[] = [
  { value: "CASH", label: "Efectivo", activeClass: "border-emerald-400 bg-emerald-950 text-emerald-100 ring-2 ring-emerald-400/60" },
  { value: "TRANSFER", label: "Transferencia", activeClass: "border-sky-400 bg-sky-950 text-sky-100 ring-2 ring-sky-400/60" },
  { value: "DEBIT", label: "Tarjeta", activeClass: "border-amber-400 bg-amber-950 text-amber-100 ring-2 ring-amber-400/60" }
];

const SHIFT_DURATION_REFRESH_MS = 60_000;

function categoryAccent(color: string | null | undefined): string | undefined {
  return color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : undefined;
}

/** "2 kg por $18.000" para un pack; "15% OFF desde 2 kg" / "$9.000/kg desde 2 kg" para un
 * threshold — mismo criterio que la lista de Promociones en Admin (nunca precio/kg calculado). */
function discountBadgeLabel(rule: DiscountRule): string | null {
  if (rule.promotionMode === "PACK_FIXED_TOTAL") {
    if (rule.packQuantityGrams == null || rule.packPriceCents == null) return null;
    return `${(rule.packQuantityGrams / 1_000).toLocaleString("es-AR")} kg por ${formatCurrency(BigInt(rule.packPriceCents))}`;
  }
  if (rule.discountType == null || rule.discountValue == null || rule.minimumGrams == null) return null;
  const value = rule.discountType === "PERCENTAGE" ? `${String(Number(rule.discountValue) / 100)}% OFF` : `${formatCurrency(BigInt(rule.discountValue))}/kg`;
  return `${value} desde ${formatWeight(rule.minimumGrams)}`;
}

interface ComputedLine {
  pricing: ReturnType<typeof calculateSalePricing>;
  discountRuleId: string | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: bigint | null;
  promotionMode: "THRESHOLD" | "PACK_FIXED_TOTAL" | null;
}

/** WEIGHT pricing: an explicit pack (sellAsPack, WEIGHT never auto-detects a pack — the real
 * weighed grams never land exactly on the nominal pack amount) takes priority; otherwise the
 * usual threshold lookup by weighed grams, unchanged from before packs existed. */
function computeWeightLine(
  listPriceCents: bigint, weightGrams: number, sellAsPack: boolean, pack: DiscountRule | null,
  discounts: DiscountRule[], productId: string, branchId: string, paymentMethod: PaymentMethod, cashDiscountBps: bigint
): ComputedLine {
  if (sellAsPack && pack?.packPriceCents != null) {
    const pricing = calculateWeightPackSalePricing({
      listPriceCents, weightGrams, paymentMethod, cashDiscountBps, packPriceCents: BigInt(pack.packPriceCents)
    });
    return { pricing, discountRuleId: pack.id, discountType: null, discountValue: null, promotionMode: "PACK_FIXED_TOTAL" };
  }
  const applicableRules = discounts.filter((rule) => rule.promotionMode === "THRESHOLD" && rule.productId === productId && rule.minimumGrams != null)
    .sort((left, right) => (right.minimumGrams ?? 0) - (left.minimumGrams ?? 0) || Number(right.branchId === branchId) - Number(left.branchId === branchId));
  const rule = applicableRules.find((candidate) => (candidate.minimumGrams ?? Infinity) <= weightGrams);
  const promotion = rule?.discountType && rule.discountValue != null ? { id: rule.id, discountType: rule.discountType, discountValue: BigInt(rule.discountValue) } : null;
  const pricing = calculateSalePricing({ listPriceCents, quantity: weightGrams, quantityDivisor: 1_000, paymentMethod, cashDiscountBps, promotion });
  return {
    pricing, discountRuleId: rule?.id ?? null, discountType: rule?.discountType ?? null,
    discountValue: rule?.discountValue != null ? BigInt(rule.discountValue) : null, promotionMode: null
  };
}

/** UNIT pricing: no balanza, no THRESHOLD (WEIGHT-only by design) — a pack applies automatically
 * on exact multiples of its quantity (no manual toggle, unlike WEIGHT: unit counts are exact, no
 * scale variance to worry about), with any remainder at the normal cash price. */
function computeUnitLine(
  listPriceCents: bigint, quantityUnits: number, pack: DiscountRule | null, paymentMethod: PaymentMethod, cashDiscountBps: bigint
): ComputedLine {
  const wholePacks = pack?.packQuantityUnits ? Math.floor(quantityUnits / pack.packQuantityUnits) : 0;
  if (pack?.packQuantityUnits != null && pack.packPriceCents != null && wholePacks >= 1) {
    const pricing = calculateUnitPackSalePricing({
      listPriceCents, quantityUnits, paymentMethod, cashDiscountBps,
      pack: { id: pack.id, packQuantityUnits: pack.packQuantityUnits, packPriceCents: BigInt(pack.packPriceCents) }
    });
    return { pricing, discountRuleId: pack.id, discountType: null, discountValue: null, promotionMode: "PACK_FIXED_TOTAL" };
  }
  const pricing = calculateSalePricing({ listPriceCents, quantity: quantityUnits, quantityDivisor: 1, paymentMethod, cashDiscountBps, promotion: null });
  return { pricing, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null };
}

function formatShiftTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function formatWorkedDuration(clockInAt: string, currentTime: number): string {
  const totalMinutes = Math.max(0, Math.floor((currentTime - new Date(clockInAt).getTime()) / 60_000));
  return `${String(Math.floor(totalMinutes / 60))} h ${String(totalMinutes % 60)} min`;
}

function DeviceProvisioningLogin({ onAuthenticated, onCancel }: { onAuthenticated: (user: AuthUser) => void; onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    onAuthenticated({ id: data.user.id, email: data.user.email ?? email, offline: false });
  }

  return (
    <main className="pos-auth-screen grid min-h-screen place-items-center bg-stone-950 p-6 text-stone-100">
      <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-800 bg-stone-900 p-8 shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-[0.22em] text-rose-400">Configuración administrativa</p>
        <h1 className="mt-3 text-4xl font-black">Autorizar esta caja</h1>
        <p className="mt-3 text-stone-400">Acceso exclusivo para configurar la identidad técnica del dispositivo.</p>
        {error ? <p className="mt-5 rounded-xl bg-red-950 p-3 text-sm text-red-200">{error}</p> : null}
        <form className="mt-7 grid gap-5" onSubmit={(event) => void submit(event)}>
          <label className="grid gap-2 text-sm font-semibold text-stone-300">
            Email
            <input
              className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-lg outline-none focus:border-rose-500"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-stone-300">
            Contraseña
            <input
              className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-lg outline-none focus:border-rose-500"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button
            className="rounded-xl bg-rose-600 px-5 py-4 text-lg font-black hover:bg-rose-500 disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Autorizando…" : "Autorizar dispositivo"}
          </button>
          <button className="rounded-xl border border-stone-700 px-5 py-3 font-bold hover:bg-stone-800" onClick={onCancel} type="button">Volver</button>
        </form>
      </section>
    </main>
  );
}

function DeviceSetupRequired({ onConfigure }: { onConfigure: () => void }) {
  return (
    <main className="pos-auth-screen grid min-h-screen place-items-center bg-stone-950 p-6 text-stone-100">
      <section className="pos-modal-panel w-full max-w-lg rounded-3xl border border-amber-800 bg-stone-900 p-8 text-center shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-[0.22em] text-amber-400">Caja no autorizada</p>
        <h1 className="mt-3 text-3xl font-black">Esta caja necesita ser configurada.</h1>
        <p className="mt-4 text-lg text-stone-300">Contactá al administrador.</p>
        <button className="mt-8 rounded-xl border border-stone-700 px-5 py-3 text-sm font-bold text-stone-300 hover:bg-stone-800" onClick={onConfigure} type="button">Configuración administrativa</button>
      </section>
    </main>
  );
}

function OperatorLogin({ operators, online, deviceId, onAuthenticated }: { operators: OperatorRosterRow[]; online: boolean; deviceId: string; onAuthenticated: (operator: LocalOperator) => Promise<void> }) {
  const [selected, setSelected] = useState(operators[0]?.profileId ?? "");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!selected && operators[0]) setSelected(operators[0].profileId); }, [operators, selected]);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setDiagnostics(null);
    try {
      if (!/^\d{4,6}$/.test(pin)) throw new Error("Ingresá un PIN de 4 a 6 dígitos");
      if (online) {
        const { data, error: verifyError } = await supabase.rpc("verify_pos_operator_pin", { p_device_id: deviceId, p_profile_id: selected, p_pin: pin });
        if (verifyError) throw verifyError;
        const verified = data as unknown as { ok: boolean; message?: string; profileId: string; displayName: string; roleName: string; operatorToken: string; validUntil: string };
        if (!verified.ok) throw new Error(verified.message ?? "PIN incorrecto");
        await onAuthenticated(await localDatabase.cacheVerifiedOperator(verified, pin));
      } else await onAuthenticated(await localDatabase.verifyLocalOperator(selected, pin));
      setPin("");
    } catch (loginError) {
      const caught = describeCaughtValue(loginError);
      console.error("[pos] pin_validation_failed", { online, profileId: selected, diagnostics: caught });
      setError(resolveErrorMessage(loginError, "No se pudo validar el PIN"));
      setDiagnostics(formatDiagnostics(caught));
    }
    finally { setBusy(false); }
  }
  return (
    <main className="pos-auth-screen grid min-h-screen place-items-center bg-stone-950 p-6 text-stone-100">
      <section className="pos-modal-panel w-full max-w-lg rounded-3xl border border-stone-800 bg-stone-900 p-7 shadow-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-400">Dispositivo autorizado</p>
        <h1 className="mt-2 text-3xl font-black">¿Quién está usando la caja?</h1>
        <div className="mt-5 grid grid-cols-2 gap-2">
          {operators.map((item) => (
            <button className={`rounded-xl border p-3 text-left ${selected === item.profileId ? "border-rose-500 bg-rose-950" : "border-stone-700 bg-stone-950"}`} key={item.profileId} onClick={() => { setSelected(item.profileId); setPin(""); }} type="button">
              <strong>{item.displayName}</strong>
              <span className="block text-xs text-stone-400">{item.roleName}{!item.hasPin ? " · sin PIN" : ""}</span>
            </button>
          ))}
        </div>
        {!operators.length ? (
          <p className="mt-5 rounded-xl bg-amber-950 p-4 text-amber-100">No hay empleados con acceso a esta sucursal. Configurá sus PIN desde Admin.</p>
        ) : (
          <form className="mt-5 grid gap-3" onSubmit={(event) => void submit(event)}>
            <input autoFocus className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-4 text-center text-2xl tracking-[0.5em]" inputMode="numeric" maxLength={6} name="pin" onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} placeholder="••••" type="password" value={pin} />
            <button className="rounded-xl bg-rose-600 px-4 py-3 font-black disabled:opacity-50" disabled={busy || !selected || !operators.find((item) => item.profileId === selected)?.hasPin}>{busy ? "Validando…" : online ? "Entrar" : "Entrar offline"}</button>
          </form>
        )}
        {error ? (
          <div className="mt-4 rounded-xl bg-red-950 p-3 text-sm text-red-200">
            <p>{error}</p>
            {diagnostics ? (
              <p className="mt-1 break-all text-xs text-red-300">
                <span className="font-bold uppercase tracking-wide">Diagnóstico PIN v2</span> · {diagnostics}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default function App() {
  const desktop = isDesktopRuntime();
  const scale = useScaleSnapshot(desktop);
  const [scalePorts, setScalePorts] = useState<string[]>([]);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [simulatedWeightInput, setSimulatedWeightInput] = useState("");
  const [scaleModalNow, setScaleModalNow] = useState(() => Date.now());
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [categoryDirectory, setCategoryDirectory] = useState<CategoryDirectoryEntryLike[]>([]);
  const [discounts, setDiscounts] = useState<DiscountRule[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [cashDiscountBps, setCashDiscountBps] = useState(0);
  const [categoryId, setCategoryId] = useState("ALL");
  const [search, setSearch] = useState("");
  const [ticket, setTicket] = useState<TicketLine[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [weightInput, setWeightInput] = useState("");
  const [quantityInput, setQuantityInput] = useState(1);
  const [sellAsPack, setSellAsPack] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(INITIAL_PAYMENT_METHOD);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localRuntime, setLocalRuntime] = useState<LocalRuntime | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [recentSalesOpen, setRecentSalesOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [recentSales, setRecentSales] = useState<RecentLocalSale[]>([]);
  const [outboxSummary, setOutboxSummary] = useState<OutboxSummary | null>(null);
  const [binding, setBinding] = useState(false);
  const [operators, setOperators] = useState<OperatorRosterRow[]>([]);
  const [operator, setOperator] = useState<LocalOperator | null>(null);
  const [shift, setShift] = useState<LocalShift | null>(null);
  const [clockInRequired, setClockInRequired] = useState(false);
  const [exitModalOpen, setExitModalOpen] = useState(false);
  const [shiftNow, setShiftNow] = useState(() => Date.now());
  const shiftInFlight = useRef(false);
  const saleInFlight = useRef(false);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const closeInFlight = useRef(false);
  const syncRunnerRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>({
    state: navigator.onLine ? "online" : "offline",
    pendingCount: 0,
    syncingCurrent: 0,
    syncingTotal: 0,
    lastSuccessfulSyncAt: null,
    lastError: null
  });

  const loadRecentSales = useCallback(async () => {
    if (!user || !branchId) return;
    if (desktop) {
      setRecentSales(await localDatabase.recentSales(10));
      return;
    }
    const { data, error: recentError } = await supabase
      .from("sales")
      .select("id, status, total_cents, total_weight_grams, completed_at")
      .eq("branch_id", branchId)
      .eq("profile_id", user.id)
      .order("completed_at", { ascending: false })
      .limit(10);
    if (recentError) throw recentError;
    setRecentSales(data.map((sale) => ({
      saleId: sale.id,
      status: sale.status,
      totalCents: String(sale.total_cents),
      totalWeightGrams: String(sale.total_weight_grams),
      completedAt: sale.completed_at ?? "",
      syncedAt: sale.completed_at
    })));
  }, [branchId, desktop, user]);

  const loadOperators = useCallback(async () => {
    if (!desktop || !localRuntime?.branchId) return;
    setOperators(await localDatabase.operators());
  }, [desktop, localRuntime?.branchId]);

  const loadShift = useCallback(async (active: LocalOperator) => {
    const deviceId = localRuntime?.deviceId;
    if (!desktop || !deviceId) return;
    let current = await localDatabase.currentShift(active.profileId);
    if (navigator.onLine && !user?.offline && active.operatorToken) {
      const { data, error: shiftError } = await supabase.rpc("get_current_employee_shift", { p_device_id: deviceId, p_employee_id: active.profileId, p_operator_token: active.operatorToken });
      if (shiftError) throw shiftError;
      if (data) {
        const remote = data as unknown as Omit<LocalShift, "employeeId">;
        current = { ...remote, employeeId: active.profileId };
        await localDatabase.applyServerShift(current);
      } else {
        await localDatabase.clearReconciledShift(active.profileId);
        current = await localDatabase.currentShift(active.profileId);
      }
    }
    setShift(current);
    return current;
  }, [desktop, localRuntime?.deviceId, user?.offline]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const runtime = desktop ? await localDatabase.runtime() : null;
      const { data } = await supabase.auth.getSession();
      if (controller.signal.aborted) return;
      if (runtime) {
        setLocalRuntime(runtime);
        setSyncStatus((current) => ({
          ...current,
          state: navigator.onLine ? current.state : "offline",
          pendingCount: runtime.pendingCount,
          lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
          lastError: runtime.lastError
        }));
      }
      const sessionUser = data.session?.user;
      const cachedUser = runtime?.profileId && runtime.userEmail &&
        runtime.deviceStatus === "ACTIVE" && runtime.authorizationExpiresAt &&
        new Date(runtime.authorizationExpiresAt).getTime() > Date.now()
        ? { id: runtime.profileId, email: runtime.userEmail, offline: true }
        : null;
      setUser(navigator.onLine && sessionUser
        ? { id: sessionUser.id, email: sessionUser.email ?? sessionUser.id, offline: false }
        : cachedUser);
      setAuthReady(true);
    })().catch((startupError: unknown) => {
      if (!controller.signal.aborted) {
        setError(startupError instanceof Error ? startupError.message : "No se pudo iniciar el POS");
        setAuthReady(true);
      }
    });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const sessionUser = session?.user;
      if (sessionUser && navigator.onLine) {
        setUser({ id: sessionUser.id, email: sessionUser.email ?? sessionUser.id, offline: false });
      } else if (event === "SIGNED_OUT" && navigator.onLine) {
        setUser(null);
      }
    });

    return () => {
      controller.abort();
      data.subscription.unsubscribe();
    };
  }, [desktop]);

  useEffect(() => {
    if (!user) {
      setBranches([]);
      setBranchId("");
      setCatalog([]);
      setTicket([]);
      setPaymentMethod(null);
      return;
    }

    if (desktop && user.offline) {
      if (!localRuntime?.organizationId || !localRuntime.branchId || !localRuntime.branchName) {
        setError("La autorización offline local no tiene una sucursal válida");
        return;
      }
      setRoleName(localRuntime.roleName ?? "Operador offline");
      setBranches([{
        id: localRuntime.branchId,
        organization_id: localRuntime.organizationId,
        name: localRuntime.branchName,
        code: localRuntime.branchName
      }]);
      setBranchId(localRuntime.branchId);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void (async () => {
      const { data: membership, error: membershipError } = await supabase
        .from("organization_members")
        .select("organization_id, role_id")
        .eq("profile_id", user.id)
        .eq("status", "ACTIVE")
        .limit(1)
        .maybeSingle();

      if (membershipError || !membership) {
        throw new Error(membershipError?.message ?? "El usuario no tiene una membresía activa");
      }

      const [{ data: role, error: roleError }, { data: visibleBranches, error: branchError }] =
        await Promise.all([
          supabase.from("roles").select("name").eq("id", membership.role_id).maybeSingle(),
          supabase
            .from("branches")
            .select("id, organization_id, name, code")
            .eq("organization_id", membership.organization_id)
            .eq("active", true)
            .order("name")
        ]);

      if (roleError || branchError) throw new Error(roleError?.message ?? branchError?.message);
      const authorizedBranches = desktop && localRuntime?.branchId
        ? visibleBranches.filter((branch) => branch.id === localRuntime.branchId)
        : visibleBranches;
      const firstBranch = authorizedBranches[0];
      if (!firstBranch) throw new Error("No tenés una sucursal habilitada para operar");
      if (controller.signal.aborted) return;

      setRoleName(role?.name ?? "Operador");
      setBranches(authorizedBranches);
      setBranchId((current) =>
        authorizedBranches.some((branch) => branch.id === current) ? current : firstBranch.id
      );
    })()
      .catch((contextError: unknown) => {
        if (!controller.signal.aborted) {
          setError(contextError instanceof Error ? contextError.message : "No se pudo abrir el POS");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [desktop, localRuntime?.branchId, localRuntime?.branchName, localRuntime?.organizationId, localRuntime?.roleName, user]);

  useEffect(() => {
    if (!branchId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCategoryId("ALL");

    void (async () => {
      if (desktop) {
        if (localRuntime?.branchId !== branchId) {
          setCatalog([]);
          setCategoryDirectory([]);
          return;
        }
        const [data, directory] = await Promise.all([localDatabase.catalog(branchId), localDatabase.categories()]);
        if (controller.signal.aborted) return;
        setCatalog(data.map((row) => ({
          organizationId: row.organizationId,
          branchId: row.branchId,
          branchName: row.branchName,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          categoryColorHex: row.categoryColorHex,
          categorySortOrder: row.categorySortOrder,
          categoryIds: row.categoryIds.length ? row.categoryIds : [row.categoryId],
          productId: row.productId,
          productName: row.productName,
          productSku: row.productSku,
          unitType: row.unitType,
          pricePerKgCents: BigInt(row.pricePerKgCents)
        })));
        setCategoryDirectory(directory);
        return;
      }
      const [{ data, error: catalogError }, { data: categoriesData, error: categoriesError }] = await Promise.all([
        supabase.rpc("get_pos_catalog", { p_branch_id: branchId }),
        supabase.rpc("get_pos_categories", { p_branch_id: branchId })
      ]);
        if (catalogError) throw catalogError;
        if (categoriesError) throw categoriesError;
        if (controller.signal.aborted) return;
        setCatalog(
          data.map((row) => ({
            organizationId: row.organization_id,
            branchId: row.branch_id,
            branchName: row.branch_name,
            categoryId: row.category_id,
            categoryName: row.category_name,
            categoryColorHex: row.category_color_hex,
            categorySortOrder: row.category_sort_order,
            categoryIds: row.category_ids.length ? row.category_ids : [row.category_id],
            productId: row.product_id,
            productName: row.product_name,
            productSku: row.product_sku,
            unitType: row.unit_type,
            pricePerKgCents: BigInt(row.price_per_kg_cents)
          }))
        );
        setCategoryDirectory(categoriesData.map((row) => ({ id: row.id, name: row.name, colorHex: row.color_hex, sortOrder: row.sort_order })));
      })()
      .catch((catalogError: unknown) => {
        if (!controller.signal.aborted) {
          setError(catalogError instanceof Error ? catalogError.message : "No se pudo cargar el catálogo");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [branchId, desktop, localRuntime?.catalogCursor]);

  useEffect(() => {
    void loadRecentSales().catch(() => setRecentSales([]));
  }, [loadRecentSales]);

  useEffect(() => {
    if (!branchId) return;
    void (async () => {
      if (desktop) {
        const config = await localDatabase.commercialConfig();
        setCashDiscountBps(config.cashDiscountBps); setDiscounts(config.discounts); setAnnouncements(config.announcements);
      } else {
        const { data, error: configError } = await supabase.rpc("get_pos_commercial_config", { p_branch_id: branchId });
        if (configError) throw configError;
        const config = data as unknown as { cashDiscountBps: number; discounts: DiscountRule[]; announcements: Announcement[] };
        setCashDiscountBps(config.cashDiscountBps);
        setDiscounts(config.discounts);
        setAnnouncements(config.announcements);
      }
    })().catch((configError: unknown) => setError(configError instanceof Error ? configError.message : "No se pudo cargar promociones"));
  }, [branchId, desktop, localRuntime?.catalogCursor]);

  const runSync = useCallback(async () => {
    if (!desktop || !user || user.offline || !localRuntime?.branchId) return;
    if (syncPromiseRef.current) return syncPromiseRef.current;
    const syncPromise = (async () => {
      try {
        const runtime = await synchronizeDesktop(user, setSyncStatus);
        setLocalRuntime(runtime);
        const config = await localDatabase.commercialConfig();
        setCashDiscountBps(config.cashDiscountBps);
        setDiscounts(config.discounts);
        setAnnouncements(config.announcements);
        setOutboxSummary(await localDatabase.outboxSummary());
        setOperators(await localDatabase.operators());
        if (operator) await loadShift(operator);
      } catch (syncError) {
        setOutboxSummary(await localDatabase.outboxSummary().catch(() => null));
        setError(syncError instanceof Error ? syncError.message : String(syncError));
      }
    })();
    syncPromiseRef.current = syncPromise;
    try { await syncPromise; }
    finally {
      if (syncPromiseRef.current === syncPromise) syncPromiseRef.current = null;
    }
  }, [desktop, loadShift, localRuntime?.branchId, operator, user]);

  useEffect(() => {
    syncRunnerRef.current = runSync;
  }, [runSync]);

  useEffect(() => { void loadOperators().catch(() => setOperators([])); }, [loadOperators, localRuntime?.catalogCursor]);

  useEffect(() => {
    if (!desktop || !user?.id) return;
    const userOffline = user.offline;

    const handleOffline = () => {
      setSyncStatus((current) => ({ ...current, state: "offline" }));
    };
    const handleOnline = () => {
      if (userOffline) {
        void supabase.auth.getUser().then(({ data, error: authError }) => {
          if (!authError) {
            setUser({
              id: data.user.id,
              email: data.user.email ?? data.user.id,
              offline: false
            });
          }
        });
      } else {
        void syncRunnerRef.current();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    const stopBackgroundSync = userOffline
      ? () => undefined
      : startBackgroundSyncPolling(() => syncRunnerRef.current());

    return () => {
      stopBackgroundSync();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [desktop, user?.id, user?.offline]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      const stopListening = await appWindow.onCloseRequested(async (event) => {
        if (closeInFlight.current) return;
        closeInFlight.current = true;
        try {
          await localDatabase.closeActiveOperatorShift();
          if (navigator.onLine) {
            await Promise.race([
              syncRunnerRef.current(),
              new Promise<void>((resolve) => window.setTimeout(resolve, 1_500))
            ]);
          }
        } catch (closeError) {
          event.preventDefault();
          closeInFlight.current = false;
          setError(closeError instanceof Error ? closeError.message : "No se pudo guardar la salida antes de cerrar");
        }
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  useEffect(() => {
    if (!exitModalOpen || shift?.status !== "OPEN") return;
    const interval = window.setInterval(() => setShiftNow(Date.now()), SHIFT_DURATION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [exitModalOpen, shift?.status]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 1_800);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!selectedProduct || scale.config.kind === "MANUAL") return;
    setScaleModalNow(Date.now());
    const interval = window.setInterval(() => setScaleModalNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [selectedProduct, scale.config.kind]);

  useEffect(() => {
    if (!diagnosticsOpen || !desktop) return;
    void scaleBridge.listPorts().then(setScalePorts).catch(() => setScalePorts([]));
  }, [diagnosticsOpen, desktop]);

  async function bindDevice() {
    if (!desktop || !localRuntime || !user || user.offline || !branchId) return;
    setBinding(true);
    setError(null);
    try {
      await registerDesktopDevice(localRuntime, branchId, user);
      const runtime = await localDatabase.runtime();
      setLocalRuntime(runtime);
      setNotice(`Dispositivo vinculado a ${runtime.branchName ?? "la sucursal"}`);
      await runSync();
    } catch (bindingError) {
      setError(bindingError instanceof Error ? bindingError.message : "No se pudo vincular el dispositivo");
    } finally {
      setBinding(false);
    }
  }

  async function updateScaleConfig(patch: Partial<{ kind: ScaleKind; port: string | null; autoconnect: boolean }>) {
    try {
      await scaleBridge.setConfig({ ...scale.config, ...patch });
    } catch (scaleConfigError) {
      setError(scaleConfigError instanceof Error ? scaleConfigError.message : "No se pudo guardar la configuración de la balanza");
    }
  }

  async function connectScaleNow() {
    setScaleBusy(true);
    try {
      await scaleBridge.connect();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "No se pudo conectar la balanza");
    } finally {
      setScaleBusy(false);
    }
  }

  async function retryLastEvent() {
    const eventId = await localDatabase.forceLastRetry();
    if (!eventId) {
      setNotice("Todavía no hay ventas locales para reintentar");
      return;
    }
    const runtime = await localDatabase.runtime();
    setLocalRuntime(runtime);
    await runSync();
  }

  // Los tabs salen del directorio de categorías sincronizado explícitamente (cualquier categoría
  // activa con al menos un producto asignado, principal o secundaria — ver
  // apps/pos/src/lib/catalog.ts), no de la categoría principal de un producto en particular. Una
  // categoría usada sólo como "también aparece en" sigue generando su propio tab.
  const categories = useMemo(() => buildCategoryTabs(categoryDirectory), [categoryDirectory]);

  const filteredProducts = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("es-AR");
    return catalog.filter(
      (product) =>
        productMatchesCategory(product, categoryId) &&
        (!normalizedSearch ||
          product.productName.toLocaleLowerCase("es-AR").includes(normalizedSearch) ||
          product.productSku?.toLocaleLowerCase("es-AR").includes(normalizedSearch))
    );
  }, [catalog, categoryId, search]);

  const ticketTotal = useMemo(
    () => sumMoney(ticket.map((line) => line.subtotalCents)),
    [ticket]
  );
  const ticketWeight = useMemo(
    () => ticket.reduce((total, line) => total + line.weightGrams, 0),
    [ticket]
  );
  const ticketListSubtotal = useMemo(() => sumMoney(ticket.map((line) => {
    const listPrice = line.originalPricePerKgCents ?? line.pricePerKgCents;
    return line.quantityUnits != null ? listPrice * BigInt(line.quantityUnits) : priceForWeight(listPrice, line.weightGrams);
  })), [ticket]);
  const ticketCashDiscount = useMemo(() => sumMoney(ticket.map((line) => line.cashDiscountCents ?? 0n)), [ticket]);
  const ticketPromotionDiscount = useMemo(() => sumMoney(ticket.map((line) => line.promotionDiscountCents ?? 0n)), [ticket]);

  useEffect(() => {
    // Recalcular importes sólo tiene sentido una vez que hay método elegido;
    // mientras paymentMethod sea null los importes no se muestran igual.
    if (!paymentMethod) return;
    const method = paymentMethod;
    setTicket((current) => current.map((line) => {
      const listPriceCents = line.originalPricePerKgCents ?? line.pricePerKgCents;
      let pricing: ReturnType<typeof calculateSalePricing>;
      if (line.quantityUnits != null) {
        // Línea UNIT: si tenía un pack, hay que recalcularlo contra el rule actual (el precio
        // total del pack sí puede necesitar re-derivar cash/promo discount con el nuevo método de
        // pago, aunque el TOTAL del pack en sí no cambie).
        const pack = line.discountRuleId ? discounts.find((rule) => rule.id === line.discountRuleId) ?? null : null;
        pricing = computeUnitLine(listPriceCents, line.quantityUnits, pack, method, BigInt(cashDiscountBps)).pricing;
      } else if (line.promotionMode === "PACK_FIXED_TOTAL" && line.discountRuleId) {
        // Línea pack WEIGHT: no escala con el peso ni con el descuento por pago (precio total
        // fijo, ver calculateWeightPackSalePricing) — recalcularla como threshold perdería el
        // pack al cambiar el método de pago. subtotalCents de una línea pack siempre ES el precio
        // del pack (nunca cambia con el método de pago), así que sirve directo como
        // packPriceCents al recalcular.
        pricing = calculateWeightPackSalePricing({
          listPriceCents, weightGrams: line.weightGrams, paymentMethod: method,
          cashDiscountBps: BigInt(cashDiscountBps), packPriceCents: line.subtotalCents
        });
      } else {
        pricing = calculateSalePricing({
          listPriceCents, quantity: line.weightGrams, quantityDivisor: 1_000, paymentMethod: method,
          cashDiscountBps: BigInt(cashDiscountBps),
          promotion: line.discountType && line.discountValue != null && line.discountRuleId
            ? { id: line.discountRuleId, discountType: line.discountType, discountValue: line.discountValue }
            : null
        });
      }
      return { ...line, pricePerKgCents: pricing.finalPriceCents, cashDiscountBps: pricing.cashDiscountBps,
        cashDiscountCents: pricing.cashDiscountCents, promotionDiscountCents: pricing.promotionDiscountCents,
        discountCents: pricing.discountCents, subtotalCents: pricing.subtotalCents };
    }));
  }, [cashDiscountBps, paymentMethod]);

  function openWeight(product: CatalogProduct, line?: TicketLine) {
    setSelectedProduct(product);
    setEditingLineId(line?.id ?? null);
    setWeightInput(line ? (line.weightGrams / 1_000).toFixed(3).replace(".", ",") : "");
    setQuantityInput(line?.quantityUnits ?? 1);
    setSellAsPack(line?.promotionMode === "PACK_FIXED_TOTAL");
    setError(null);
  }

  // Único pack activo del producto seleccionado (la promoción garantiza como máximo uno vigente
  // por producto/sucursal — ver product_weight_discounts_pack_active_idx).
  const packRuleForSelectedProduct = useMemo(() => {
    if (!selectedProduct) return null;
    return discounts.find((rule) => rule.productId === selectedProduct.productId && rule.promotionMode === "PACK_FIXED_TOTAL"
      && (rule.branchId === branchId || rule.branchId === null)) ?? null;
  }, [discounts, selectedProduct, branchId]);

  function saveLine(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct) return;

    try {
      // Todavía puede no haber método de pago elegido en este punto: se usa un
      // placeholder neutro sólo para completar el cálculo internamente — no se
      // muestra nada derivado de esto hasta que se elija un método real, y el
      // efecto de arriba recalcula todas las líneas en cuanto eso pase.
      const method = paymentMethod ?? "CASH";
      const isUnit = selectedProduct.unitType === "UNIT";

      let line: TicketLine;
      if (isUnit) {
        if (!Number.isInteger(quantityInput) || quantityInput <= 0) throw new Error("Cantidad inválida");
        const computed = computeUnitLine(selectedProduct.pricePerKgCents, quantityInput, packRuleForSelectedProduct, method, BigInt(cashDiscountBps));
        line = {
          id: editingLineId ?? crypto.randomUUID(), productId: selectedProduct.productId, productName: selectedProduct.productName,
          weightGrams: 0, quantityUnits: quantityInput, pricePerKgCents: computed.pricing.finalPriceCents,
          originalPricePerKgCents: selectedProduct.pricePerKgCents, discountRuleId: computed.discountRuleId,
          discountType: computed.discountType, discountValue: computed.discountValue, promotionMode: computed.promotionMode,
          discountCents: computed.pricing.discountCents, cashDiscountBps: computed.pricing.cashDiscountBps,
          cashDiscountCents: computed.pricing.cashDiscountCents, promotionDiscountCents: computed.pricing.promotionDiscountCents,
          subtotalCents: computed.pricing.subtotalCents
        };
      } else {
        const grams = parseWeightToGrams(weightInput);
        const pack = sellAsPack ? packRuleForSelectedProduct : null;
        const computed = computeWeightLine(selectedProduct.pricePerKgCents, grams, sellAsPack, pack, discounts, selectedProduct.productId, branchId, method, BigInt(cashDiscountBps));
        line = {
          id: editingLineId ?? crypto.randomUUID(), productId: selectedProduct.productId, productName: selectedProduct.productName,
          weightGrams: grams, pricePerKgCents: computed.pricing.finalPriceCents, originalPricePerKgCents: selectedProduct.pricePerKgCents,
          discountRuleId: computed.discountRuleId, discountType: computed.discountType, discountValue: computed.discountValue,
          promotionMode: computed.promotionMode, discountCents: computed.pricing.discountCents, cashDiscountBps: computed.pricing.cashDiscountBps,
          cashDiscountCents: computed.pricing.cashDiscountCents, promotionDiscountCents: computed.pricing.promotionDiscountCents,
          subtotalCents: computed.pricing.subtotalCents
        };
      }

      setTicket((current) =>
        editingLineId
          ? current.map((candidate) => (candidate.id === editingLineId ? line : candidate))
          : [...current, line]
      );
      setSelectedProduct(null);
      setEditingLineId(null);
      setWeightInput("");
      setQuantityInput(1);
      setSellAsPack(false);
    } catch (weightError) {
      setError(weightError instanceof Error ? weightError.message : "Cantidad inválida");
    }
  }

  async function completeSale() {
    // Guard defensivo: no confiar sólo en el disabled del botón. Sin método de
    // pago elegido, no se completa la venta bajo ninguna circunstancia.
    // (chequeo directo de null, no sólo el mensaje, para que TS angoste el tipo)
    if (!paymentMethod) { setError(validatePaymentMethodForSale(paymentMethod) ?? "Seleccioná un método de pago."); return; }
    if (!branchId || ticket.length === 0 || saleInFlight.current) return;
    const method = paymentMethod;
    saleInFlight.current = true;
    setLoading(true);
    setError(null);
    setNotice(null);

    if (desktop) {
      try {
        if (!localRuntime?.organizationId || !localRuntime.branchId || !operator?.operatorToken) {
          throw new Error("Seleccioná un empleado autorizado antes de vender");
        }
        const sale = createOfflineSale({
          organizationId: localRuntime.organizationId,
          branchId: localRuntime.branchId,
          profileId: operator.profileId,
          operatorToken: operator.operatorToken,
          deviceId: localRuntime.deviceId,
          ticket,
          paymentMethod: method
        });
        const receipt = await localDatabase.confirmSale(sale);
        setTicket([]);
        setPaymentMethod(null);
        const runtime = await localDatabase.runtime();
        setLocalRuntime(runtime);
        setSyncStatus((current) => ({
          ...current,
          state: navigator.onLine ? "online" : "offline",
          pendingCount: runtime.pendingCount
        }));
        setNotice(`Venta ${receipt.saleId.slice(0, 8)} confirmada localmente por ${formatCurrency(BigInt(receipt.totalCents))}`);
        void loadRecentSales().catch(() => undefined);
        void runSync();
      } catch (saleError) {
        setError(saleError instanceof Error ? saleError.message : `La venta local no pudo completarse: ${String(saleError)}`);
      } finally {
        saleInFlight.current = false;
        setLoading(false);
      }
      return;
    }

    const { data, error: saleError } = await supabase.rpc("complete_discounted_sale", {
      p_branch_id: branchId,
      p_items: ticket.map((line) => line.quantityUnits != null
        ? {
            product_id: line.productId,
            quantity_units: line.quantityUnits,
            expected_price_per_unit_cents: (line.originalPricePerKgCents ?? line.pricePerKgCents).toString(),
            pack_promotion_id: line.promotionMode === "PACK_FIXED_TOTAL" ? line.discountRuleId : null
          }
        : {
            product_id: line.productId,
            weight_grams: line.weightGrams,
            expected_price_per_kg_cents: (line.originalPricePerKgCents ?? line.pricePerKgCents).toString(),
            expected_cash_discount_bps: (line.cashDiscountBps ?? 0n).toString(),
            expected_final_price_per_kg_cents: line.pricePerKgCents.toString(),
            pack_promotion_id: line.promotionMode === "PACK_FIXED_TOTAL" ? line.discountRuleId : null
          }),
      p_payment_method: method
    });

    setLoading(false);
    saleInFlight.current = false;
    if (saleError) {
      setError(saleError.message);
      return;
    }

    const completedSale = data[0];
    if (!completedSale) {
      setError("La venta no pudo completarse");
      return;
    }

    setNotice(`Venta ${completedSale.sale_id.slice(0, 8)} confirmada por ${formatCurrency(BigInt(completedSale.total_cents))}`);
    setTicket([]);
    setPaymentMethod(null);
    void loadRecentSales().catch(() => undefined);
  }

  async function logout() {
    if (desktop) {
      await localDatabase.clearAuthorization();
      setLocalRuntime(await localDatabase.runtime());
    }
    await supabase.auth.signOut();
    setUser(null);
  }

  async function selectOperator(active: LocalOperator) {
    setError(null);
    try {
      const currentShift = await loadShift(active);
      setOperator(active);
      setClockInRequired(!currentShift);
    } catch (shiftError) {
      await localDatabase.clearActiveOperator().catch(() => undefined);
      throw new Error(shiftError instanceof Error ? shiftError.message : "No se pudo recuperar el turno");
    }
  }

  async function finishOperatorSession() {
    if (!operator || shiftInFlight.current) return;
    shiftInFlight.current = true;
    setError(null);
    try {
      const result = await localDatabase.closeActiveOperatorShift();
      setExitModalOpen(false);
      setClockInRequired(false);
      setOperator(null);
      setShift(null);
      setTicket([]);
      setPaymentMethod(null);
      setLocalRuntime(await localDatabase.runtime());
      if (result.clockOutCreated) {
        setNotice("Salida registrada");
        void runSync();
      } else if (result.shift?.status === "REQUIRES_REVIEW") {
        setNotice("El turno continúa pendiente de revisión administrativa");
      }
    } catch (exitError) {
      setError(exitError instanceof Error ? exitError.message : "No se pudo finalizar la sesión del operador");
    } finally {
      shiftInFlight.current = false;
    }
  }

  function requestOperatorExit() {
    if (shift?.status === "OPEN") {
      setShiftNow(Date.now());
      setExitModalOpen(true);
      return;
    }
    void finishOperatorSession();
  }

  async function recordTime(action: "CLOCK_IN" | "CLOCK_OUT"): Promise<LocalShift | null> {
    if (!operator || !localRuntime || shiftInFlight.current) return null;
    shiftInFlight.current = true; setError(null);
    try {
      let updated: LocalShift;
      if (navigator.onLine && !user?.offline && operator.operatorToken) {
        const { data, error: eventError } = await supabase.rpc("record_employee_time_event", { p_device_id: localRuntime.deviceId, p_event_id: crypto.randomUUID(), p_shift_id: shift?.shiftId ?? crypto.randomUUID(), p_employee_id: operator.profileId, p_operator_token: operator.operatorToken, p_action: action });
        if (eventError) throw eventError;
        const remote = data as unknown as Omit<LocalShift, "employeeId">;
        updated = { ...remote, employeeId: operator.profileId };
        await localDatabase.applyServerShift(updated);
      } else updated = await localDatabase.recordOfflineTimeEvent(action);
      setShift(updated.status === "CLOSED" ? null : updated);
      if (action === "CLOCK_IN" && updated.status === "OPEN") setClockInRequired(false);
      setNotice(action === "CLOCK_IN" ? "Entrada registrada" : updated.status === "REQUIRES_REVIEW" ? "El turno requiere revisión administrativa" : "Salida registrada");
      if (!navigator.onLine) setLocalRuntime(await localDatabase.runtime());
      return updated;
    } catch (timeError) {
      setError(timeError instanceof Error ? timeError.message : "No se pudo registrar el fichaje");
      return null;
    }
    finally { shiftInFlight.current = false; }
  }

  if (!authReady) {
    return <main className="grid min-h-screen place-items-center bg-stone-950 text-stone-300">Cargando sesión…</main>;
  }

  if (!user) {
    if (provisioningOpen) {
      return (
        <DeviceProvisioningLogin
          onAuthenticated={(authenticatedUser) => {
            setProvisioningOpen(false);
            setUser(authenticatedUser);
          }}
          onCancel={() => setProvisioningOpen(false)}
        />
      );
    }
    return <DeviceSetupRequired onConfigure={() => setProvisioningOpen(true)} />;
  }

  const activeBranch = branches.find((branch) => branch.id === branchId);
  const freshScaleReading = isScaleReadingFresh(scale.connectionState, scale.reading, scaleModalNow) ? scale.reading : null;
  const deviceNeedsBinding = desktop && localRuntime?.deviceStatus === "UNREGISTERED";
  if (desktop && localRuntime?.deviceStatus === "ACTIVE" && localRuntime.branchId && !operator) {
    return <OperatorLogin deviceId={localRuntime.deviceId} online={navigator.onLine && !user.offline} onAuthenticated={selectOperator} operators={operators} />;
  }
  const syncLabel = syncStatus.state === "syncing" && syncStatus.syncingTotal > 0
    ? `SINCRONIZANDO · ${String(syncStatus.syncingCurrent)} de ${String(syncStatus.syncingTotal)}`
    : syncStatus.state === "offline"
      ? `OFFLINE · ${String(syncStatus.pendingCount)} evento${syncStatus.pendingCount === 1 ? "" : "s"} pendiente${syncStatus.pendingCount === 1 ? "" : "s"}`
      : syncStatus.state === "error"
        ? "ERROR DE SINCRONIZACIÓN"
        : syncStatus.pendingCount > 0
          ? `ONLINE · ${String(syncStatus.pendingCount)} pendientes`
          : "SINCRONIZADO";
  const syncCompactLabel = syncStatus.state === "syncing"
    ? `↻ ${String(syncStatus.syncingCurrent)}/${String(syncStatus.syncingTotal)}`
    : syncStatus.state === "offline"
      ? `○ ${String(syncStatus.pendingCount)}`
      : syncStatus.state === "error"
        ? "!"
        : syncStatus.pendingCount > 0
          ? `● ${String(syncStatus.pendingCount)}`
          : "✓";
  const unreadNotifications = announcements.length;

  return (
    <main className="pos-shell min-h-screen bg-stone-950 text-stone-100 lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden">
      <header className="pos-header flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-stone-800 bg-stone-900 px-5 py-3">
        <div className="pos-brand min-w-0">
          <p className="pos-brand-eyebrow text-xs font-bold uppercase tracking-[0.2em] text-rose-400">{desktop ? "POS offline-first" : "POS online"}</p>
          <p className="truncate text-lg font-black">{activeBranch?.name ?? "Seleccioná sucursal"}</p>
        </div>
        <div className="pos-header-actions flex items-center gap-3">
          <div className="pos-notifications relative">
            <button
              className="rounded-xl border border-stone-700 px-3 py-2 text-xs font-black hover:bg-stone-800"
              onClick={() => setNotificationsOpen((open) => !open)}
              type="button"
              aria-haspopup="true"
              aria-expanded={notificationsOpen}
            >
              🔔{unreadNotifications > 0 ? ` ${String(unreadNotifications)}` : ""}
            </button>
            {notificationsOpen ? (
              <div className="pos-notifications-panel absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-stone-700 bg-stone-900 p-3 text-left shadow-2xl">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-black uppercase tracking-wide text-stone-400">Avisos</p>
                  <button className="text-xs font-bold text-stone-400 hover:text-stone-200" onClick={() => setNotificationsOpen(false)} type="button">Cerrar</button>
                </div>
                <div className="mt-2 grid gap-2">
                  {announcements.map((announcement) => (
                    <div key={announcement.id} className="rounded-lg border border-amber-700 bg-amber-950 px-3 py-2 text-xs text-amber-100">
                      <strong className="block">{announcement.title}</strong>
                      <p>{announcement.message}</p>
                    </div>
                  ))}
                  {!announcements.length ? <p className="text-xs text-stone-500">Sin avisos.</p> : null}
                </div>
              </div>
            ) : null}
          </div>
          <button className="pos-recent-sales rounded-xl border border-stone-700 px-3 py-2 text-xs font-black hover:bg-stone-800" onClick={() => setRecentSalesOpen(true)}><span className="pos-label-full">Ventas recientes</span><span className="pos-label-compact">Ventas</span></button>
          {desktop ? (
            <button
              className={`pos-sync w-56 shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-center text-xs font-black tabular-nums ${syncStatus.state === "error" ? "border-red-700 bg-red-950 text-red-200" : syncStatus.state === "offline" ? "border-amber-700 bg-amber-950 text-amber-200" : "border-emerald-700 bg-emerald-950 text-emerald-200"}`}
              onClick={() => setDiagnosticsOpen(true)}
              title={syncLabel}
            >
              <span className="pos-label-full">{syncLabel}</span>
              <span className="pos-label-compact">{syncCompactLabel}</span>
            </button>
          ) : null}
          {desktop && scale.config.kind !== "MANUAL" ? (
            <span className={`pos-scale-indicator shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-xs font-black ${scale.connectionState === "CONNECTED" ? "border-emerald-700 bg-emerald-950 text-emerald-200" : scale.connectionState === "ERROR" ? "border-red-700 bg-red-950 text-red-200" : "border-stone-700 bg-stone-800 text-stone-300"}`}>
              {scale.connectionState === "CONNECTED"
                ? `⚖ ${formatWeight(scale.reading?.grams ?? 0)}`
                : scale.connectionState === "CONNECTING"
                  ? "⚖ Conectando…"
                  : scale.connectionState === "ERROR"
                    ? "⚖ Error"
                    : "⚖ Desconectada"}
            </span>
          ) : null}
          {branches.length > 1 ? (
            <select
              className="rounded-xl border border-stone-700 bg-stone-950 px-3 py-2 font-semibold"
              value={branchId}
              onChange={(event) => {
                if (ticket.length && !window.confirm("Cambiar de sucursal cancelará el ticket actual. ¿Continuar?")) return;
                setTicket([]);
                setPaymentMethod(null);
                setBranchId(event.target.value);
              }}
            >
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          ) : null}
          {desktop && operator ? (
            <div className={`pos-operator min-w-32 rounded-xl px-3 py-2 text-right text-xs ${shift?.status === "REQUIRES_REVIEW" ? "bg-amber-950 text-amber-200" : "bg-stone-800 text-stone-300"}`}>
              <span className="font-black text-stone-100">{operator.displayName}</span>
              <span className="pos-operator-shift">{shift?.status === "OPEN" ? ` · ${formatShiftTime(shift.clockInAt)}` : shift?.status === "REQUIRES_REVIEW" ? " · A revisar" : " · Sin turno"}</span>
            </div>
          ) : (
            <div className="text-right text-xs text-stone-400"><p className="font-semibold text-stone-200">{roleName}</p><p>{user.email}</p></div>
          )}
          {desktop && operator ? (
            <button className="rounded-xl border border-stone-700 px-4 py-2 text-xs font-black hover:bg-stone-800 disabled:opacity-50" disabled={shiftInFlight.current} onClick={requestOperatorExit}>Salir</button>
          ) : !desktop || deviceNeedsBinding ? (
            <button className="rounded-xl border border-stone-700 px-3 py-2 font-semibold hover:bg-stone-800" onClick={() => void logout()}>Cerrar sesión</button>
          ) : null}
        </div>
      </header>

      {deviceNeedsBinding ? (
        <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-700 bg-amber-950 px-4 py-3 text-amber-100">
          <span>Elegí la sucursal definitiva de este equipo. Después de vincularlo no podrá operar otra sucursal.</span>
          <button
            className="rounded-lg bg-amber-300 px-4 py-2 font-black text-stone-950 disabled:opacity-50"
            disabled={binding || !navigator.onLine || !branchId}
            onClick={() => void bindDevice()}
          >
            {binding ? "Vinculando…" : "Vincular dispositivo"}
          </button>
        </div>
      ) : null}

      {error ? <div className="mx-4 mt-4 rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-red-100">{error}</div> : null}
      {notice ? <div className="pos-toast" role="status">✓ {notice}</div> : null}

      <div className="pos-workspace grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_410px]">
        <section className="pos-catalog min-w-0 border-stone-800 p-4 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden lg:border-r lg:p-5">
          <div className="pos-categories flex flex-wrap gap-2">
            <button className={`rounded-xl px-4 py-3 font-bold ${categoryId === "ALL" ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`} onClick={() => setCategoryId("ALL")}>Todos</button>
            {categories.map((category) => (
              <button key={category.id} className={`flex items-center gap-2 rounded-xl px-4 py-3 font-bold ${categoryId === category.id ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`} onClick={() => setCategoryId(category.id)}><span className="h-2.5 w-2.5 rounded-full bg-stone-500" style={{ backgroundColor: categoryAccent(category.color) }} />{category.name}</button>
            ))}
          </div>
          <input
            className="pos-search mt-4 w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-lg outline-none focus:border-rose-500"
            placeholder="Buscar producto o SKU…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="pos-product-grid mt-4 grid auto-rows-max content-start grid-cols-2 gap-3 md:grid-cols-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1 xl:grid-cols-4">
            {filteredProducts.map((product) => (
              <button
                key={product.productId}
                className="pos-product-card min-h-32 rounded-2xl border border-l-4 border-stone-700 bg-stone-900 p-4 text-left shadow-lg transition hover:-translate-y-0.5 hover:bg-stone-800"
                onClick={() => openWeight(product)}
                style={{ borderLeftColor: categoryAccent(product.categoryColorHex) }}
              >
                <span className="block text-lg font-black">{product.productName}</span>
                <span className="pos-product-category mt-2 block text-sm text-stone-400">{product.categoryName}</span>
                <span className="mt-3 block text-xl font-black text-rose-400">{formatCurrency(product.pricePerKgCents)}<small className="text-xs text-stone-400"> / {product.unitType === "WEIGHT" ? "kg" : "u"}</small></span>
                {discounts.filter((rule) => rule.productId === product.productId).slice(0, 1).map((rule) => {
                  const label = discountBadgeLabel(rule);
                  return label ? <span className="mt-1 block text-xs font-bold text-amber-300" key={rule.id}>{label}</span> : null;
                })}
              </button>
            ))}
          </div>
          {!loading && filteredProducts.length === 0 ? <p className="mt-10 text-center text-stone-500">No hay productos disponibles.</p> : null}
        </section>

        <aside className="pos-ticket flex min-h-[520px] flex-col bg-stone-900 p-4 lg:min-h-0 lg:overflow-hidden lg:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-black">Ticket actual</h2>
            {ticket.length ? (
              <button
                className="text-sm font-bold text-red-400 hover:text-red-300"
                onClick={() => {
                  if (!window.confirm("¿Cancelar todo el ticket?")) return;
                  setTicket([]);
                  setPaymentMethod(null);
                }}
              >
                Cancelar
              </button>
            ) : null}
          </div>
          <div className="pos-ticket-items mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
            {ticket.length === 0 ? <div className="grid h-44 place-items-center rounded-2xl border border-dashed border-stone-700 text-center text-stone-500">Seleccioná un producto<br />para comenzar</div> : null}
            {ticket.map((line) => {
              const product = catalog.find((candidate) => candidate.productId === line.productId);
              return (
                <article key={line.id} className="pos-ticket-item rounded-2xl border border-stone-700 bg-stone-950 p-4">
                  <div className="flex justify-between gap-3">
                    <div>
                      <h3 className="font-black">{line.productName}</h3>
                      {shouldDisplayTicketAmounts(paymentMethod) ? (
                        <>
                          <p className="mt-1 text-sm text-stone-400">
                            {line.quantityUnits != null
                              ? `${String(line.quantityUnits)} u × ${formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}/u`
                              : `${formatWeight(line.weightGrams)} × ${formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}/kg`}
                          </p>
                          {line.promotionMode === "PACK_FIXED_TOTAL" ? <p className="mt-1 text-xs font-bold text-amber-300">Promo pack</p> : null}
                          {(line.discountCents ?? 0n) > 0n ? <p className="mt-1 text-xs font-bold text-emerald-400">Descuento: -{formatCurrency(line.discountCents ?? 0n)}</p> : null}
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-stone-400">{line.quantityUnits != null ? `${String(line.quantityUnits)} u` : formatWeight(line.weightGrams)}</p>
                      )}
                    </div>
                    {shouldDisplayTicketAmounts(paymentMethod) ? <strong className="text-lg text-rose-400">{formatCurrency(line.subtotalCents)}</strong> : null}
                  </div>
                  <div className="mt-3 flex gap-3 text-sm font-bold">
                    <button className="text-amber-300" disabled={!product} onClick={() => product && openWeight(product, line)}>{line.quantityUnits != null ? "Modificar cantidad" : "Modificar peso"}</button>
                    <button className="text-red-400" onClick={() => setTicket((current) => current.filter((candidate) => candidate.id !== line.id))}>Eliminar</button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="pos-ticket-footer mt-4 shrink-0 border-t border-stone-700 pt-4">
            <div className="flex justify-between text-sm text-stone-400"><span>Peso total</span><span>{formatWeight(ticketWeight)}</span></div>
            <div className="pos-payment mt-5 grid gap-2 text-sm font-bold text-stone-300">
              <span id="payment-method-label">Método de pago</span>
              <div className="pos-payment-buttons grid grid-cols-3 gap-2" role="group" aria-labelledby="payment-method-label">
                {PAYMENT_METHOD_BUTTONS.map((option) => {
                  const active = paymentMethod === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setPaymentMethod(option.value)}
                      className={`rounded-xl border-2 px-3 py-3 text-sm font-black transition ${active ? option.activeClass : "border-stone-700 bg-stone-950 text-stone-300 hover:bg-stone-800"}`}
                    >
                      {active ? "✓ " : ""}{option.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {shouldDisplayTicketAmounts(paymentMethod) ? (
              <>
                <div className="mt-2 flex justify-between text-sm text-stone-300"><span>Subtotal/lista</span><span>{formatCurrency(ticketListSubtotal)}</span></div>
                {ticketCashDiscount > 0n ? <div className="mt-1 flex justify-between text-sm text-emerald-400"><span>Descuento por pago ({(cashDiscountBps / 100).toLocaleString("es-AR")}%)</span><span>-{formatCurrency(ticketCashDiscount)}</span></div> : null}
                {ticketPromotionDiscount > 0n ? <div className="mt-1 flex justify-between text-sm text-emerald-400"><span>Promo por cantidad</span><span>-{formatCurrency(ticketPromotionDiscount)}</span></div> : null}
                <div className="mt-2 flex items-end justify-between"><span className="text-lg font-bold">TOTAL</span><strong className="text-4xl font-black text-rose-400">{formatCurrency(ticketTotal)}</strong></div>
              </>
            ) : null}
            <button
              className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-4 text-xl font-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!isSaleConfirmable({ paymentMethod, ticketLength: ticket.length, loading, deviceNeedsBinding })}
              onClick={() => void completeSale()}
            >
              {loading ? "Procesando…" : "Confirmar venta"}
            </button>
          </div>
        </aside>
      </div>

      {clockInRequired && operator ? (
        <div className="pos-modal-backdrop fixed inset-0 z-[60] grid place-items-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="clock-in-title">
          <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-7 text-center shadow-2xl">
            <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Inicio de turno</p>
            <h2 className="mt-2 text-3xl font-black" id="clock-in-title">Marcar entrada</h2>
            <p className="mt-4 text-stone-300">Estás ingresando como <strong className="text-stone-100">{operator.displayName}</strong>.</p>
            {error ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-sm text-red-200">{error}</p> : null}
            <button className="mt-6 w-full rounded-xl bg-rose-600 px-5 py-4 text-lg font-black hover:bg-rose-500 disabled:opacity-50" disabled={shiftInFlight.current} onClick={() => void recordTime("CLOCK_IN")}>MARCAR ENTRADA</button>
          </section>
        </div>
      ) : null}

      {exitModalOpen && operator && shift?.status === "OPEN" ? (
        <div className="pos-modal-backdrop fixed inset-0 z-[60] grid place-items-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="clock-out-title">
          <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-7 shadow-2xl">
            <p className="text-sm font-bold uppercase tracking-wider text-rose-400">{operator.displayName}</p>
            <h2 className="mt-2 text-3xl font-black" id="clock-out-title">Finalizar turno</h2>
            <dl className="mt-6 grid gap-4 rounded-2xl bg-stone-950 p-5">
              <div className="flex items-center justify-between gap-4"><dt className="text-stone-400">Entrada</dt><dd className="font-black tabular-nums">{formatShiftTime(shift.clockInAt)}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-stone-400">Tiempo trabajado</dt><dd className="font-black tabular-nums">{formatWorkedDuration(shift.clockInAt, shiftNow)}</dd></div>
            </dl>
            {error ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-sm text-red-200">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" disabled={shiftInFlight.current} onClick={() => setExitModalOpen(false)}>Cancelar</button>
              <button className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500 disabled:opacity-50" disabled={shiftInFlight.current} onClick={() => void finishOperatorSession()}>Marcar salida y salir</button>
            </div>
          </section>
        </div>
      ) : null}

      {diagnosticsOpen && localRuntime ? (
        <div className="pos-modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true">
          <section className="pos-modal-panel w-full max-w-xl rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Diagnóstico</p>
                <h2 className="mt-1 text-3xl font-black">Estado del POS</h2>
              </div>
              <button className="rounded-lg border border-stone-600 px-3 py-2" onClick={() => setDiagnosticsOpen(false)}>Cerrar</button>
            </div>
            <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
              <dt className="font-bold text-stone-400">Internet</dt><dd>{navigator.onLine ? "Disponible" : "Sin conexión"}</dd>
              <dt className="font-bold text-stone-400">Supabase</dt><dd>{syncStatus.state === "error" ? "Error" : navigator.onLine ? "Disponible" : "No verificable"}</dd>
              <dt className="font-bold text-stone-400">SQLite</dt><dd>Operativo</dd>
              <dt className="font-bold text-stone-400">Última sync</dt><dd>{localRuntime.lastSuccessfulSyncAt ? new Date(localRuntime.lastSuccessfulSyncAt).toLocaleString("es-AR") : "Nunca"}</dd>
              <dt className="font-bold text-stone-400">Pendientes</dt><dd>{localRuntime.pendingCount}</dd>
              <dt className="font-bold text-stone-400">Pull</dt><dd>{syncStatus.pullReceived ?? 0} actualizaciones recibidas</dd>
              <dt className="font-bold text-stone-400">Push</dt><dd>Antes: {syncStatus.pushPendingBefore ?? 0} · enviadas: {syncStatus.pushSucceeded ?? 0} · fallidas: {syncStatus.pushFailed ?? 0} · después: {syncStatus.pushPendingAfter ?? localRuntime.pendingCount}</dd>
              <dt className="font-bold text-stone-400">Outbox</dt><dd>{outboxSummary ? `PENDING ${String(outboxSummary.pending)} · FAILED ${String(outboxSummary.failed)} · SYNCED ${String(outboxSummary.synced)}` : "Abrí Sincronizar ahora para actualizar"}</dd>
              <dt className="font-bold text-stone-400">Ventas locales</dt><dd>{localRuntime.localSalesCount}</dd>
              <dt className="font-bold text-stone-400">Device ID</dt><dd className="break-all font-mono text-xs">{localRuntime.deviceId}</dd>
              <dt className="font-bold text-stone-400">Sucursal</dt><dd>{localRuntime.branchName ?? "Sin vincular"}</dd>
              <dt className="font-bold text-stone-400">Autorización offline</dt><dd>{localRuntime.authorizationExpiresAt ? `Hasta ${new Date(localRuntime.authorizationExpiresAt).toLocaleString("es-AR")}` : "No disponible"}</dd>
              <dt className="font-bold text-stone-400">Último error</dt><dd className="break-words text-red-300">{syncStatus.lastError ?? outboxSummary?.lastError ?? localRuntime.lastError ?? "Ninguno"}</dd>
            </dl>
            <div className="mt-6 flex flex-wrap gap-3">
              <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black disabled:opacity-40" disabled={!navigator.onLine || user.offline} onClick={() => void runSync()}>Sincronizar ahora</button>
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-black disabled:opacity-40" disabled={!navigator.onLine || user.offline} onClick={() => void retryLastEvent()}>Reenviar último evento</button>
            </div>

            <div className="mt-6 border-t border-stone-700 pt-5">
              <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Balanza</p>
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1 text-sm font-bold text-stone-300">
                  Tipo
                  <select
                    className="rounded-xl border border-stone-700 bg-stone-950 px-3 py-2"
                    value={scale.config.kind}
                    onChange={(event) => void updateScaleConfig({ kind: event.target.value as ScaleKind, port: event.target.value === "KRETZ_NOVEL_ECO_2" ? scale.config.port : null })}
                  >
                    <option value="MANUAL">Manual (sin balanza)</option>
                    <option value="SIMULATED">Simulada (pruebas)</option>
                    <option value="KRETZ_NOVEL_ECO_2">KRETZ Novel Eco 2 (RS232)</option>
                  </select>
                </label>
                {scale.config.kind === "KRETZ_NOVEL_ECO_2" ? (
                  <label className="grid gap-1 text-sm font-bold text-stone-300">
                    Puerto
                    <div className="flex gap-2">
                      <select
                        className="flex-1 rounded-xl border border-stone-700 bg-stone-950 px-3 py-2"
                        value={scale.config.port ?? ""}
                        onChange={(event) => void updateScaleConfig({ port: event.target.value || null })}
                      >
                        <option value="">Elegí un puerto…</option>
                        {scalePorts.map((port) => <option key={port} value={port}>{port}</option>)}
                      </select>
                      <button type="button" className="rounded-xl border border-stone-600 px-3 py-2 text-xs font-bold hover:bg-stone-800" onClick={() => void scaleBridge.listPorts().then(setScalePorts).catch(() => setScalePorts([]))}>Actualizar</button>
                    </div>
                    {!scalePorts.length ? <span className="font-normal text-amber-300">No se detectaron puertos serie.</span> : null}
                  </label>
                ) : null}
                <label className="flex items-center gap-2 text-sm font-bold text-stone-300">
                  <input type="checkbox" checked={scale.config.autoconnect} onChange={(event) => void updateScaleConfig({ autoconnect: event.target.checked })} />
                  Conectar automáticamente al iniciar
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black disabled:opacity-40" disabled={scaleBusy || scale.config.kind === "MANUAL"} onClick={() => void connectScaleNow()}>Conectar</button>
                  <button type="button" className="rounded-xl border border-stone-600 px-4 py-2 text-sm font-black disabled:opacity-40" disabled={scaleBusy || scale.connectionState === "DISCONNECTED"} onClick={() => void scaleBridge.disconnect()}>Desconectar</button>
                  <span className="text-xs text-stone-400">Estado: {scale.connectionState}{scale.lastError ? ` · ${scale.lastError}` : ""}</span>
                </div>
                {scale.config.kind === "SIMULATED" ? (
                  <div className="rounded-xl border border-dashed border-stone-700 p-3">
                    <p className="text-xs font-bold uppercase text-stone-500">Herramienta de prueba (sólo para configuración/desarrollo)</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button type="button" className="rounded-lg bg-stone-800 px-3 py-2 text-xs font-bold hover:bg-stone-700" onClick={() => void scaleBridge.setSimulatedWeight(500)}>500 g</button>
                      <button type="button" className="rounded-lg bg-stone-800 px-3 py-2 text-xs font-bold hover:bg-stone-700" onClick={() => void scaleBridge.setSimulatedWeight(1_250)}>1,250 kg</button>
                      <input className="w-24 rounded-lg border border-stone-700 bg-stone-950 px-2 py-2 text-xs" placeholder="gramos" inputMode="numeric" value={simulatedWeightInput} onChange={(event) => setSimulatedWeightInput(event.target.value.replace(/\D/g, ""))} />
                      <button type="button" className="rounded-lg border border-stone-600 px-3 py-2 text-xs font-bold hover:bg-stone-800 disabled:opacity-40" disabled={!simulatedWeightInput} onClick={() => { void scaleBridge.setSimulatedWeight(Number(simulatedWeightInput)); setSimulatedWeightInput(""); }}>Fijar peso</button>
                      <button type="button" className="rounded-lg border border-amber-700 px-3 py-2 text-xs font-bold text-amber-300 hover:bg-amber-950" onClick={() => void scaleBridge.simulateDisconnect()}>Simular desconexión</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {recentSalesOpen ? (
        <div className="pos-modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true">
          <section className="pos-modal-panel flex w-full max-w-xl flex-col rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-wider text-rose-400">Comprobantes</p><h2 className="mt-1 text-3xl font-black">Ventas recientes</h2></div><button className="rounded-lg border border-stone-600 px-3 py-2" onClick={() => setRecentSalesOpen(false)}>Cerrar</button></div>
            <div className="mt-5 min-h-0 space-y-3 overflow-y-auto">{recentSales.map((sale) => <article className="flex items-center justify-between gap-4 rounded-xl border border-stone-700 bg-stone-950 p-4" key={sale.saleId}><div><strong>#{sale.saleId.slice(0, 8)}</strong><p className="text-sm text-stone-400">{new Date(sale.completedAt).toLocaleString("es-AR")} · {formatWeight(Number(sale.totalWeightGrams))}</p><p className={`text-xs font-bold ${sale.syncedAt ? "text-emerald-400" : "text-amber-300"}`}>{sale.syncedAt ? "Sincronizada" : "Pendiente de sincronización"}</p></div><strong className="text-xl text-rose-400">{formatCurrency(BigInt(sale.totalCents))}</strong></article>)}{!recentSales.length ? <p className="text-stone-400">Todavía no hay ventas en este equipo y sucursal.</p> : null}</div>
          </section>
        </div>
      ) : null}

      {selectedProduct ? (
        <div className="pos-modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true">
          <form className="pos-modal-panel pos-weight-modal w-full max-w-lg rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl" onSubmit={saveLine}>
            <p className="text-sm font-bold uppercase tracking-wider text-rose-400">{editingLineId ? "Modificar línea" : "Agregar al ticket"}</p>
            <h2 className="mt-2 text-3xl font-black">{selectedProduct.productName}</h2>
            {shouldDisplayTicketAmounts(paymentMethod) ? <p className="mt-2 text-xl text-stone-300">{formatCurrency(selectedProduct.pricePerKgCents)} / {selectedProduct.unitType === "WEIGHT" ? "kg" : "u"}</p> : null}
            {selectedProduct.unitType === "WEIGHT" ? (
              <>
                {desktop && scale.config.kind !== "MANUAL" ? (
                  <div className="mt-5 rounded-2xl border border-stone-700 bg-stone-950 p-4">
                    <p className={`text-xs font-black uppercase tracking-wide ${scale.connectionState === "CONNECTED" ? "text-emerald-400" : scale.connectionState === "ERROR" ? "text-red-400" : "text-stone-500"}`}>
                      {scale.connectionState === "CONNECTED" ? "⚖ Balanza conectada" : scale.connectionState === "CONNECTING" ? "⚖ Conectando…" : "⚖ Balanza desconectada"}
                    </p>
                    {freshScaleReading ? (
                      <button
                        type="button"
                        className="mt-2 flex w-full items-center justify-between rounded-xl bg-stone-800 px-4 py-3 text-left hover:bg-stone-700"
                        onClick={() => setWeightInput((freshScaleReading.grams / 1_000).toFixed(3).replace(".", ","))}
                      >
                        <span className="font-black text-stone-100">{formatWeight(freshScaleReading.grams)}</span>
                        <span className="text-xs font-bold text-rose-300">Usar este peso</span>
                      </button>
                    ) : (
                      <p className="mt-2 text-sm text-stone-500">
                        {scale.connectionState === "CONNECTED" ? "Esperando una lectura estable…" : "Ingresá el peso manualmente."}
                      </p>
                    )}
                  </div>
                ) : null}
                <label className="mt-6 grid gap-2 text-sm font-bold text-stone-300">
                  Peso manual en kg
                  <input autoFocus className="rounded-2xl border border-stone-600 bg-stone-950 px-4 py-4 text-4xl font-black outline-none focus:border-rose-500" inputMode="decimal" placeholder="1,250" value={weightInput} onChange={(event) => setWeightInput(event.target.value)} />
                </label>
                {packRuleForSelectedProduct?.packQuantityGrams != null && packRuleForSelectedProduct.packPriceCents != null ? (
                  <label className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-3 text-sm font-bold text-amber-200">
                    <span>Vender como pack ({(packRuleForSelectedProduct.packQuantityGrams / 1_000).toLocaleString("es-AR")} kg – {formatCurrency(BigInt(packRuleForSelectedProduct.packPriceCents))})</span>
                    <input checked={sellAsPack} onChange={(event) => setSellAsPack(event.target.checked)} type="checkbox" />
                  </label>
                ) : null}
              </>
            ) : (
              <>
                {/* UNIT: cantidad entera con [-] [+] + input manual — nunca balanza ni gramos. */}
                <label className="mt-6 grid gap-2 text-sm font-bold text-stone-300">
                  Cantidad de unidades
                  <div className="flex items-center gap-3">
                    <button
                      className="h-14 w-14 rounded-2xl border border-stone-600 bg-stone-950 text-2xl font-black hover:bg-stone-800 disabled:opacity-40"
                      disabled={quantityInput <= 1}
                      onClick={() => setQuantityInput((current) => Math.max(1, current - 1))}
                      type="button"
                    >
                      −
                    </button>
                    <input
                      autoFocus
                      className="w-full rounded-2xl border border-stone-600 bg-stone-950 px-4 py-4 text-center text-4xl font-black outline-none focus:border-rose-500"
                      inputMode="numeric"
                      onChange={(event) => {
                        const parsed = Number(event.target.value.replace(/[^0-9]/g, ""));
                        setQuantityInput(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
                      }}
                      value={quantityInput}
                    />
                    <button
                      className="h-14 w-14 rounded-2xl border border-stone-600 bg-stone-950 text-2xl font-black hover:bg-stone-800"
                      onClick={() => setQuantityInput((current) => current + 1)}
                      type="button"
                    >
                      +
                    </button>
                  </div>
                </label>
                {packRuleForSelectedProduct?.packQuantityUnits != null && packRuleForSelectedProduct.packPriceCents != null ? (
                  <p className="mt-3 rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-3 text-sm font-bold text-amber-200">
                    Pack: {packRuleForSelectedProduct.packQuantityUnits} u por {formatCurrency(BigInt(packRuleForSelectedProduct.packPriceCents))} — se aplica automáticamente en múltiplos exactos.
                  </p>
                ) : null}
              </>
            )}
            {shouldDisplayTicketAmounts(paymentMethod) ? (
              <div className="mt-5 rounded-2xl bg-stone-950 p-4">
                {(() => { if (!paymentMethod) return null; try {
                  const computed = selectedProduct.unitType === "WEIGHT"
                    ? computeWeightLine(selectedProduct.pricePerKgCents, parseWeightToGrams(weightInput), sellAsPack, packRuleForSelectedProduct, discounts, selectedProduct.productId, branchId, paymentMethod, BigInt(cashDiscountBps))
                    : computeUnitLine(selectedProduct.pricePerKgCents, quantityInput, packRuleForSelectedProduct, paymentMethod, BigInt(cashDiscountBps));
                  const preview = computed.pricing;
                  return <><p className="text-sm text-stone-400">Precio lista: {formatCurrency(preview.listSubtotalCents)}</p>
                    {computed.promotionMode === "PACK_FIXED_TOTAL" ? <p className="mt-1 font-bold text-amber-300">Promo pack</p> : <>
                      {preview.cashDiscountCents > 0n ? <p className="mt-1 font-bold text-emerald-400">Descuento por pago: -{formatCurrency(preview.cashDiscountCents)}</p> : null}
                      {preview.promotionDiscountCents > 0n ? <p className="mt-1 font-bold text-emerald-400">Promo: -{formatCurrency(preview.promotionDiscountCents)}</p> : null}
                    </>}
                    <span className="mt-2 block text-sm text-stone-400">Total</span><strong className="block text-4xl font-black text-rose-400">{formatCurrency(preview.subtotalCents)}</strong></>;
                } catch { return <strong className="block text-4xl font-black text-rose-400">$ 0</strong>; } })()}
              </div>
            ) : null}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={() => setSelectedProduct(null)}>Volver</button>
              <button className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500" type="submit">Confirmar línea</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
