import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  formatCurrency,
  formatWeight,
  parseWeightToGrams,
  priceForWeight,
  calculateSalePricing,
  calculateWeightPackSalePricing,
  calculateUnitPackSalePricing,
  advanceWeightStability,
  initialWeightStabilityState,
  sumMoney,
  type ScaleKind,
  type WeightStabilityState
} from "@carnicerias/business-logic";
import type { PaymentMethod, TicketLine } from "@carnicerias/types";
import { createOfflineSale, type BranchStockSnapshot, type SyncStatusSnapshot } from "@carnicerias/sync";

import { buildBarcodeIndex, buildCategoryTabs, hasStock, normalizeBarcode, partitionByStock, productMatchesCategory, resolveScan, stockForAvailability, type BranchStock, type CategoryDirectoryEntryLike } from "./lib/catalog";
import { CategoryPicker } from "./CategoryPicker";
import { emptyScanBuffer, feedScanKey, isEditableTarget } from "./lib/scanner";
import { describeCaughtValue, formatDiagnostics, resolveErrorMessage } from "./lib/error-messages";
import { filterPaymentMethodButtons, INITIAL_PAYMENT_METHOD, isSaleConfirmable, shouldDisplayTicketAmounts, validatePaymentMethodForSale } from "./lib/ticket-payment";
import { isDesktopRuntime, localDatabase, type LocalOperator, type LocalRuntime, type LocalShift, type OperatorRosterRow, type OutboxSummary, type PendingProviderPayment, type RecentLocalSale } from "./lib/local-database";
import { scaleBridge, useScaleSnapshot } from "./lib/scale";
import { supabase } from "./lib/supabase";
import { parseQuickCreateResult, parseScanResolveResult, readQuickProductCreate, type QuickCatalogRow } from "./lib/quick-product";
import { isPriceMissing, NO_PRICE_OFFLINE_MESSAGE, parseSetPriceResult, resolveProductRequest } from "./lib/product-price";
import { registerDesktopDevice, startBackgroundSyncPolling, synchronizeDesktop } from "./lib/sync-engine";
import { QuickProductModal } from "./QuickProductModal";
import { ProductPriceModal } from "./ProductPriceModal";
import { MercadoPagoPanel } from "./MercadoPagoPanel";
import { resolveStartupUser } from "./lib/startup-session";
import { cancelMercadoPagoOrder, fetchMercadoPagoConfig, fetchMercadoPagoStatus } from "./lib/mercadopago";
import { isManualTransferOffered, isSessionDegraded, resolveMercadoPagoAvailability } from "./lib/mercadopago-availability";
import { readManualTransferAllowed, readMercadoPagoEnabled, writeMercadoPagoEnabled } from "./lib/mercadopago-capability";
import { reconcilePendingMercadoPago } from "./lib/mercadopago-reconcile";
import { describeLocalPayment } from "./lib/mercadopago-state";

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

/** Cards rendered per step of the product grid (see gridLimit). */
const GRID_PAGE = 120;

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
  /** Scanner codes of the product, from the synced catalog (SQLite offline). */
  barcodes: string[];
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
// mismo comportamiento comercial: recargo por tarjeta sobre el precio base
// (ver D-044), así que "Tarjeta" usa DEBIT como representación interna — no
// se crea un método CARD nuevo.
const PAYMENT_METHOD_BUTTONS: { value: PaymentMethod; label: string; activeClass: string }[] = [
  { value: "CASH", label: "Efectivo", activeClass: "border-emerald-400 bg-emerald-950 text-emerald-100 ring-2 ring-emerald-400/60" },
  { value: "TRANSFER", label: "Transferencia", activeClass: "border-sky-400 bg-sky-950 text-sky-100 ring-2 ring-sky-400/60" },
  { value: "DEBIT", label: "Tarjeta", activeClass: "border-amber-400 bg-amber-950 text-amber-100 ring-2 ring-amber-400/60" }
];

const SHIFT_DURATION_REFRESH_MS = 60_000;
// Mercado Pago: cada cuánto se reconcilian los cobros pendientes, y desde cuándo una venta sin cobro vivo se da por abandonada.
const MP_RECONCILE_INTERVAL_MS = 60_000;
const MP_ABANDONED_AFTER_MS = 12 * 60 * 60 * 1000;
const SHIFT_HEARTBEAT_INTERVAL_MS = 30_000;

// Marks a failure already reported via reportStageError (message + diagnostics already set),
// so an outer catch around a staged sequence doesn't overwrite it with a less specific message.
class HandledStageError extends Error {}

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

/** The single active PACK_FIXED_TOTAL of a product for this branch (or global), if any. */
function findPackRule(discounts: DiscountRule[], productId: string, branchId: string): DiscountRule | null {
  return discounts.find((rule) => rule.productId === productId && rule.promotionMode === "PACK_FIXED_TOTAL"
    && (rule.branchId === branchId || rule.branchId === null)) ?? null;
}

/** A UNIT ticket line for `quantityUnits` of `product`. Shared by the manual quantity dialog and
 * the barcode scan so both price (packs, card surcharge) exactly the same way. */
function buildUnitTicketLine(
  product: CatalogProduct, quantityUnits: number, id: string, pack: DiscountRule | null,
  paymentMethod: PaymentMethod, cashDiscountBps: bigint
): TicketLine {
  const computed = computeUnitLine(product.pricePerKgCents, quantityUnits, pack, paymentMethod, cashDiscountBps);
  return {
    id, productId: product.productId, productName: product.productName,
    weightGrams: 0, quantityUnits, pricePerKgCents: computed.pricing.finalPriceCents,
    originalPricePerKgCents: product.pricePerKgCents, discountRuleId: computed.discountRuleId,
    discountType: computed.discountType, discountValue: computed.discountValue, promotionMode: computed.promotionMode,
    discountCents: computed.pricing.discountCents, cashDiscountBps: computed.pricing.cashDiscountBps,
    cashDiscountCents: computed.pricing.cashDiscountCents, cardSurchargeCents: computed.pricing.cardSurchargeCents,
    promotionDiscountCents: computed.pricing.promotionDiscountCents,
    subtotalCents: computed.pricing.subtotalCents
  };
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

function OperatorLogin({ operators, online, deviceId, onAuthenticated, onReconnect }: { operators: OperatorRosterRow[]; online: boolean; deviceId: string; onAuthenticated: (operator: LocalOperator) => Promise<void>; onReconnect?: (() => void) | undefined }) {
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
        {onReconnect ? (
          <div className="mt-4 rounded-xl border border-amber-700 bg-amber-950 p-3 text-sm text-amber-100">
            <p>Hay Internet pero esta caja no tiene sesión técnica en línea: vende con la autorización guardada, <strong>no sincroniza</strong> y no puede cobrar con Mercado Pago.</p>
            <button className="mt-2 rounded-lg border border-amber-500 px-3 py-2 font-black hover:bg-amber-900" onClick={onReconnect} type="button">Reconectar caja</button>
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
  const [scaleDetecting, setScaleDetecting] = useState(false);
  const [scaleDetectMessage, setScaleDetectMessage] = useState<string | null>(null);
  const [simulatedWeightInput, setSimulatedWeightInput] = useState("");
  const [weightStability, setWeightStability] = useState<WeightStabilityState>(initialWeightStabilityState());
  const weightModalOpenedAtMsRef = useRef<number | null>(null);
  const weightAutoConfirmedRef = useRef(false);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [categoryDirectory, setCategoryDirectory] = useState<CategoryDirectoryEntryLike[]>([]);
  // Stock real de la sucursal del dispositivo (no global de la organización); null = todavía nunca
  // sincronizado, en cuyo caso no se deshabilita nada (ver lib/catalog.ts).
  const [branchStock, setBranchStock] = useState<BranchStock>(null);
  const [outOfStockOpen, setOutOfStockOpen] = useState(false);
  // POS de Central (el servidor lo decide: sucursal productiva, ver lib/quick-product.ts): habilita el
  // alta rápida desde un scan desconocido y hace que la disponibilidad NO dependa del stock (ver
  // `stockGate` abajo y lib/catalog.ts `stockForAvailability`).
  const [centralPos, setCentralPos] = useState(false);
  const [quickCreateCode, setQuickCreateCode] = useState<string | null>(null);
  // Producto sin precio (precio 0) tocado o escaneado: nunca se agrega a $0, se pide el precio (lib/product-price.ts).
  const [pricePromptProduct, setPricePromptProduct] = useState<CatalogProduct | null>(null);
  // A Central with thousands of products must not render thousands of cards on a low-end POS: the grid
  // shows the first GRID_PAGE and grows on demand. Search and barcode scan always work on the WHOLE catalog.
  const [gridLimit, setGridLimit] = useState(GRID_PAGE);
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
  // Mercado Pago (D-054): se declara como proveedor sobre TRANSFER (mismo precio, sin recargo). El
  // botón sólo existe si el backend dice que esta sucursal lo tiene habilitado.
  const [paymentProvider, setPaymentProvider] = useState<"MERCADOPAGO" | null>(null);
  // Lo último que se supo de la sucursal: true/false (servidor o memoria local) o null = nunca consultado.
  const [mpKnownEnabled, setMpKnownEnabled] = useState<boolean | null>(null);
  // Política de la sucursal sobre la transferencia manual (false = prohibida: Mercado Pago obligatorio).
  const [mpManualTransferAllowed, setMpManualTransferAllowed] = useState<boolean | null>(null);
  const [mpLookupError, setMpLookupError] = useState<string | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [mpPanelSale, setMpPanelSale] = useState<{ saleId: string; totalCents: bigint } | null>(null);
  const [pendingMp, setPendingMp] = useState<PendingProviderPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDiagnostics, setErrorDiagnostics] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Barcode scan result ("Producto no encontrado", "Sin stock", "+1 Coca Cola"): transient, separate
  // from `error`/`notice` so a scan never clobbers (or is clobbered by) a sale/sync message.
  const [scanFeedback, setScanFeedback] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const ticketRef = useRef<TicketLine[]>([]);
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
  const [cancelTicketModalOpen, setCancelTicketModalOpen] = useState(false);
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
      syncedAt: sale.completed_at,
      provider: null,
      verificationStatus: null
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
      setUser(resolveStartupUser({
        browserOnline: navigator.onLine,
        session: sessionUser ? { id: sessionUser.id, email: sessionUser.email } : null,
        runtime,
        nowMs: Date.now()
      }));
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
          pricePerKgCents: BigInt(row.pricePerKgCents),
          barcodes: row.barcodes
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
            pricePerKgCents: BigInt(row.price_per_kg_cents),
            // An older server (migration not pushed yet) has no barcodes column: scans just never match.
            barcodes: (row.barcodes as string[] | undefined) ?? []
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

  const loadBranchStock = useCallback(async () => {
    if (!branchId) return;
    try {
      if (desktop) {
        if (localRuntime?.branchId !== branchId) { setBranchStock(null); return; }
        const local = await localDatabase.branchStock(branchId);
        setBranchStock(local.snapshotApplied ? new Map(local.items.map((item) => [item.productId, item.quantityGrams])) : null);
        return;
      }
      const { data, error: stockError } = await supabase.rpc("get_pos_branch_stock", { p_branch_id: branchId });
      if (stockError) throw stockError;
      const snapshot = data as unknown as BranchStockSnapshot;
      setBranchStock(new Map(snapshot.items.map((item) => [item.productId, Number(item.quantityGrams)])));
    } catch {
      // Sin stock conocido el catálogo sigue vendible como antes; nunca bloquear la venta por esto.
    }
  }, [branchId, desktop, localRuntime?.branchId]);

  useEffect(() => { setBranchStock(null); }, [branchId]);
  // La capacidad la refresca el sync (rara vez); acá sólo se lee lo recordado, también sin conexión.
  useEffect(() => {
    setCentralPos(desktop && readQuickProductCreate(localRuntime?.branchId ?? null));
  }, [desktop, localRuntime?.branchId, localRuntime?.lastSuccessfulSyncAt]);
  // Se recalcula con cada sync (lastSuccessfulSyncAt cambia en cada pull; el snapshot de stock ya
  // quedó aplicado antes de que runSync publique el runtime) y tras cada venta (explícito abajo).
  useEffect(() => { void loadBranchStock(); }, [loadBranchStock, localRuntime?.lastSuccessfulSyncAt, localRuntime?.catalogCursor]);

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

  // Presence heartbeat (docs/DOMAIN_RULES.md "Control horario"): while a shift is OPEN,
  // persist a lease tick locally every ~30s regardless of connectivity (so a crash/kill/
  // power loss leaves real evidence of the last moment this device was alive for the
  // next-startup reconciliation, see reconcile_stale_open_shifts in src-tauri), and
  // reflect it to the server best-effort when reachable (record_shift_heartbeat updates
  // the shift's own last_heartbeat_at in place, never a new row per tick). Failures here
  // are silent by design: the next tick retries, and nothing besides staleness detection
  // depends on any single heartbeat succeeding.
  useEffect(() => {
    if (!desktop || !operator || shift?.status !== "OPEN") return;
    let cancelled = false;
    const tick = async () => {
      try {
        await localDatabase.recordShiftHeartbeatLocal();
      } catch { /* best-effort, next tick retries */ }
      if (cancelled || !navigator.onLine || user?.offline || !localRuntime?.deviceId || !operator.operatorToken) return;
      try {
        await supabase.rpc("record_shift_heartbeat", {
          p_device_id: localRuntime.deviceId,
          p_employee_id: operator.profileId,
          p_operator_token: operator.operatorToken
        });
      } catch { /* best-effort, next tick retries */ }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), SHIFT_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [desktop, operator, shift?.status, localRuntime?.deviceId, user?.offline]);

  useEffect(() => {
    if (!exitModalOpen || shift?.status !== "OPEN") return;
    const interval = window.setInterval(() => setShiftNow(Date.now()), SHIFT_DURATION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [exitModalOpen, shift?.status]);

  useEffect(() => {
    if (!cancelTicketModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setCancelTicketModalOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelTicketModalOpen]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 1_800);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  // Weight auto-confirm: opening the WEIGHT modal (with a non-manual scale
  // configured) starts a fresh stability run; anything else (closing the
  // modal, a UNIT product, no scale) clears it. Never polls a clock — see
  // `advanceWeightStability` for why that used to cause UI flicker.
  useEffect(() => {
    if (selectedProduct?.unitType === "WEIGHT" && scale.config.kind !== "MANUAL") {
      weightModalOpenedAtMsRef.current = Date.now();
      weightAutoConfirmedRef.current = false;
      setWeightStability(initialWeightStabilityState());
    } else {
      weightModalOpenedAtMsRef.current = null;
    }
  }, [selectedProduct, scale.config.kind]);

  useEffect(() => {
    if (weightModalOpenedAtMsRef.current === null) return;
    if (scale.connectionState !== "CONNECTED") {
      setWeightStability((current) => advanceWeightStability(current, { type: "DISCONNECTED" }));
      return;
    }
    const reading = scale.reading;
    if (!reading) return;
    const openedAtMs = weightModalOpenedAtMsRef.current;
    const receivedAtMs = new Date(reading.receivedAt).getTime();
    if (!Number.isFinite(receivedAtMs)) return;
    setWeightStability((current) =>
      advanceWeightStability(current, { type: "READING", grams: reading.grams, receivedAtMs, openedAtMs })
    );
  }, [scale.reading, scale.connectionState]);

  useEffect(() => {
    if (weightStability.status !== "STABLE" || weightStability.grams === null) return;
    if (weightAutoConfirmedRef.current) return;
    if (selectedProduct?.unitType !== "WEIGHT") return;
    weightAutoConfirmedRef.current = true;
    commitSelectedProductLine(weightStability.grams);
  }, [weightStability]);

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

  async function detectScaleNow() {
    setScaleDetecting(true);
    setScaleDetectMessage(null);
    try {
      const detectedPort = await scaleBridge.detectPort();
      if (!detectedPort) {
        setScaleDetectMessage("No se detectó la balanza en ningún puerto disponible.");
        return;
      }
      await updateScaleConfig({ kind: "KRETZ_NOVEL_ECO_2", port: detectedPort });
      setScalePorts((current) => (current.includes(detectedPort) ? current : [...current, detectedPort].sort()));
      setScaleDetectMessage(`Balanza detectada en ${detectedPort}.`);
      await connectScaleNow();
    } catch (detectError) {
      setScaleDetectMessage(detectError instanceof Error ? detectError.message : "No se pudo detectar la balanza");
    } finally {
      setScaleDetecting(false);
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
    // Central: la búsqueda de texto es global (la categoría es un filtro secundario y no la limita).
    const effectiveCategoryId = centralPos && normalizedSearch ? "ALL" : categoryId;
    return catalog.filter(
      (product) =>
        productMatchesCategory(product, effectiveCategoryId) &&
        (!normalizedSearch ||
          product.productName.toLocaleLowerCase("es-AR").includes(normalizedSearch) ||
          product.productSku?.toLocaleLowerCase("es-AR").includes(normalizedSearch))
    );
  }, [catalog, categoryId, search, centralPos]);

  // Sobre qué stock se decide la disponibilidad: en Central NINGUNO (almacén sin stock confiable: todo
  // producto habilitado se ve y se vende, aunque figure en 0 o negativo); en el resto de las sucursales,
  // el stock real de la sucursal. Lo decide la capacidad del servidor (`centralPos`), no el nombre.
  const stockGate = useMemo(() => stockForAvailability(branchStock, centralPos), [branchStock, centralPos]);

  // Con stock primero; sin stock después (visibles, nunca eliminados del catálogo). La búsqueda
  // siempre incluye los sin stock, así se distingue "no existe" de "existe pero sin stock".
  // En Central `stockGate` es null: todo queda en "Disponibles", sin sección "Sin stock".
  const { available: availableProducts, outOfStock: outOfStockProducts } = useMemo(
    () => partitionByStock(filteredProducts, stockGate),
    [filteredProducts, stockGate]
  );
  const searching = search.trim() !== "";
  const showOutOfStock = searching || outOfStockOpen;
  useEffect(() => { setGridLimit(GRID_PAGE); }, [categoryId, search, branchId]);
  const visibleAvailable = availableProducts.slice(0, gridLimit);
  const visibleOutOfStock = outOfStockProducts.slice(0, Math.max(0, gridLimit - visibleAvailable.length));
  const hiddenCount = (availableProducts.length - visibleAvailable.length) + (showOutOfStock ? outOfStockProducts.length - visibleOutOfStock.length : 0);

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
  const ticketCardSurcharge = useMemo(() => sumMoney(ticket.map((line) => line.cardSurchargeCents ?? 0n)), [ticket]);
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
        // Línea UNIT: si tenía un pack, hay que recalcularlo contra el rule actual —
        // computeUnitLine siempre recalcula desde pack.packPriceCents (el precio fijo real del
        // pack), nunca desde line.subtotalCents, porque ese subtotal puede venir ya recargado por
        // tarjeta de un cálculo anterior con otro método de pago (D-044: el recargo se aplica al
        // total comercial completo, packs incluidos, sin excepción).
        const pack = line.discountRuleId ? discounts.find((rule) => rule.id === line.discountRuleId) ?? null : null;
        pricing = computeUnitLine(listPriceCents, line.quantityUnits, pack, method, BigInt(cashDiscountBps)).pricing;
      } else if (line.promotionMode === "PACK_FIXED_TOTAL" && line.discountRuleId) {
        // Línea pack WEIGHT: no escala con el peso — recalcularla como threshold perdería el
        // pack al cambiar el método de pago. El recargo por tarjeta SÍ se aplica sobre el total
        // del pack (D-044, sin excepción), así que subtotalCents de la línea puede ya venir
        // recargado de un cálculo anterior con otro método de pago — nunca se reutiliza
        // directamente como packPriceCents (eso compondría el recargo). Se busca el precio de
        // pack real y fijo en la regla vigente, igual que ya hace la rama UNIT de abajo.
        const pack = discounts.find((rule) => rule.id === line.discountRuleId && rule.promotionMode === "PACK_FIXED_TOTAL");
        if (!pack?.packPriceCents) return line;
        pricing = calculateWeightPackSalePricing({
          listPriceCents, weightGrams: line.weightGrams, paymentMethod: method,
          cashDiscountBps: BigInt(cashDiscountBps), packPriceCents: BigInt(pack.packPriceCents)
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
        cashDiscountCents: pricing.cashDiscountCents, cardSurchargeCents: pricing.cardSurchargeCents,
        promotionDiscountCents: pricing.promotionDiscountCents,
        discountCents: pricing.discountCents, subtotalCents: pricing.subtotalCents };
    }));
  }, [cashDiscountBps, paymentMethod]);

  // Producto sin precio: NUNCA se agrega a $0. Con conexión se abre el modal para fijar el precio; sin
  // conexión el mismo modal sólo avisa (no hay precio pendiente local ni venta a $0). Toda vía que agrega
  // una línea nueva (tocar la card, escanear, resultado del servidor) pasa por acá. Devuelve true si
  // interceptó el producto.
  function interceptMissingPrice(product: CatalogProduct): boolean {
    const online = Boolean(user) && !user?.offline && navigator.onLine;
    if (resolveProductRequest(product, online) === "ADD") return false;
    setScanFeedback(null);
    setError(null);
    setPricePromptProduct(product);
    return true;
  }

  function openWeight(product: CatalogProduct, line?: TicketLine) {
    // No confiar sólo en el estilo/disabled de la card: toda vía que agrega una línea nueva pasa por acá.
    // Editar una línea que ya está en el ticket (ya tiene precio) no se bloquea nunca.
    if (!line && interceptMissingPrice(product)) return;
    if (!line && !hasStock(stockGate, product.productId)) {
      setError(`${product.productName} no tiene stock en esta sucursal.`);
      return;
    }
    setSelectedProduct(product);
    setEditingLineId(line?.id ?? null);
    setWeightInput(line ? (line.weightGrams / 1_000).toFixed(3).replace(".", ",") : "");
    setQuantityInput(line?.quantityUnits ?? 1);
    setSellAsPack(line?.promotionMode === "PACK_FIXED_TOTAL");
    setError(null);
  }

  // Mismo markup de card de siempre (el CSS compacto depende del orden name / category / price);
  // una card sin stock es un <button disabled> — no dispara onClick aunque se fuerce el evento.
  function renderProductCard(product: CatalogProduct, outOfStock: boolean) {
    return (
      <button
        key={product.productId}
        type="button"
        disabled={outOfStock}
        aria-disabled={outOfStock}
        className={`pos-product-card min-h-32 rounded-2xl border border-l-4 border-stone-700 p-4 text-left shadow-lg transition ${outOfStock ? "cursor-not-allowed bg-stone-900/40 opacity-50 grayscale" : "bg-stone-900 hover:-translate-y-0.5 hover:bg-stone-800"}`}
        onClick={() => openWeight(product)}
        style={{ borderLeftColor: outOfStock ? undefined : categoryAccent(product.categoryColorHex) }}
      >
        <span className="block text-lg font-black">{product.productName}</span>
        <span className="pos-product-category mt-2 block text-sm text-stone-400">{product.categoryName}</span>
        {isPriceMissing(product)
          ? <span className="mt-3 block text-xl font-black text-amber-300">Sin precio</span>
          : <span className="mt-3 block text-xl font-black text-rose-400">{formatCurrency(product.pricePerKgCents)}<small className="text-xs text-stone-400"> / {product.unitType === "WEIGHT" ? "kg" : "u"}</small></span>}
        {outOfStock
          ? <span className="mt-1 block text-xs font-black uppercase tracking-wide text-stone-400">Sin stock</span>
          : discounts.filter((rule) => rule.productId === product.productId).slice(0, 1).map((rule) => {
              const label = discountBadgeLabel(rule);
              return label ? <span className="mt-1 block text-xs font-bold text-amber-300" key={rule.id}>{label}</span> : null;
            })}
      </button>
    );
  }

  // Único pack activo del producto seleccionado (la promoción garantiza como máximo uno vigente
  // por producto/sucursal — ver product_weight_discounts_pack_active_idx).
  const packRuleForSelectedProduct = useMemo(() => {
    if (!selectedProduct) return null;
    return findPackRule(discounts, selectedProduct.productId, branchId);
  }, [discounts, selectedProduct, branchId]);

  /**
   * Builds and commits the ticket line for `selectedProduct`. `explicitWeightGrams`
   * lets the scale auto-confirm path hand over the already-settled weight
   * directly (bypassing `weightInput`'s string parsing) instead of only
   * ever reading from the manual field; the manual/form path still goes
   * through `weightInput` as always.
   */
  function commitSelectedProductLine(explicitWeightGrams?: number) {
    if (!selectedProduct) return;
    if (!editingLineId && isPriceMissing(selectedProduct)) {
      // Defensa en profundidad: el precio pudo cambiar a 0 entre abrir el diálogo y confirmarlo.
      const missing = selectedProduct;
      setSelectedProduct(null);
      interceptMissingPrice(missing);
      return;
    }
    if (!editingLineId && !hasStock(stockGate, selectedProduct.productId)) {
      setError(`${selectedProduct.productName} ya no tiene stock en esta sucursal.`);
      setSelectedProduct(null);
      return;
    }

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
        line = buildUnitTicketLine(selectedProduct, quantityInput, editingLineId ?? crypto.randomUUID(), packRuleForSelectedProduct, method, BigInt(cashDiscountBps));
      } else {
        const grams = explicitWeightGrams ?? parseWeightToGrams(weightInput);
        const pack = sellAsPack ? packRuleForSelectedProduct : null;
        const computed = computeWeightLine(selectedProduct.pricePerKgCents, grams, sellAsPack, pack, discounts, selectedProduct.productId, branchId, method, BigInt(cashDiscountBps));
        line = {
          id: editingLineId ?? crypto.randomUUID(), productId: selectedProduct.productId, productName: selectedProduct.productName,
          weightGrams: grams, pricePerKgCents: computed.pricing.finalPriceCents, originalPricePerKgCents: selectedProduct.pricePerKgCents,
          discountRuleId: computed.discountRuleId, discountType: computed.discountType, discountValue: computed.discountValue,
          promotionMode: computed.promotionMode, discountCents: computed.pricing.discountCents, cashDiscountBps: computed.pricing.cashDiscountBps,
          cashDiscountCents: computed.pricing.cashDiscountCents, cardSurchargeCents: computed.pricing.cardSurchargeCents,
          promotionDiscountCents: computed.pricing.promotionDiscountCents,
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

  function saveLine(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    commitSelectedProductLine();
  }

  // ---- Barcode scanner (USB/HID keyboard wedge) ----------------------------------------------
  // Resolves against the branch catalog already loaded from SQLite (only products enabled in this
  // branch are in it) and the synced stock snapshot: no Supabase call per scan, works offline.
  ticketRef.current = ticket;
  const barcodeIndex = useMemo(() => buildBarcodeIndex(catalog), [catalog]);

  function addScannedUnit(product: CatalogProduct, note?: { created?: boolean; priceSet?: boolean }) {
    if (interceptMissingPrice(product)) return;
    // Read/write through a ref so two scans landing before React re-renders both count.
    const current = ticketRef.current;
    const existing = current.find((line) => line.productId === product.productId && line.quantityUnits != null);
    const quantity = (existing?.quantityUnits ?? 0) + 1;
    const line = buildUnitTicketLine(product, quantity, existing?.id ?? crypto.randomUUID(), findPackRule(discounts, product.productId, branchId), paymentMethod ?? "CASH", BigInt(cashDiscountBps));
    const next = existing ? current.map((candidate) => (candidate.id === existing.id ? line : candidate)) : [...current, line];
    ticketRef.current = next;
    setTicket(next);
    setError(null);
    setScanFeedback({ tone: "ok", text: `${note?.created ? "Producto creado: " : note?.priceSet ? `Precio guardado (${formatCurrency(product.pricePerKgCents)}): ` : ""}${product.productName} ×${String(quantity)}` });
  }

  function handleScan(rawCode: string) {
    // En Central `stockGate` es null: un producto habilitado se escanea y se vende aunque su stock figure en 0 o negativo.
    const outcome = resolveScan(barcodeIndex, stockGate, rawCode);
    if (!outcome) return;
    if (outcome.kind === "NOT_FOUND") {
      // Sólo el POS de Central ofrece el alta; en el resto un código desconocido sigue siendo "no encontrado".
      if (centralPos) { void resolveUnknownScan(outcome.code); return; }
      setScanFeedback({ tone: "warn", text: "Producto no encontrado" });
      return;
    }
    if (outcome.kind === "NO_STOCK") { setScanFeedback({ tone: "warn", text: `${outcome.product.productName}: Sin stock` }); return; }
    if (outcome.kind === "OPEN_WEIGHT") {
      setScanFeedback(null);
      openWeight(outcome.product);
      return;
    }
    addScannedUnit(outcome.product);
  }

  function toCatalogProduct(row: QuickCatalogRow): CatalogProduct {
    return { ...row, pricePerKgCents: BigInt(row.pricePerKgCents) };
  }

  // El POS sólo puede vender (confirm_local_sale) productos que ya están en su SQLite: tras el alta se
  // hace un sync (pull incremental) y se verifica que el producto haya quedado en el catálogo local.
  async function ensureProductInLocalCatalog(productId: string): Promise<boolean> {
    if (!localRuntime?.branchId) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await syncRunnerRef.current(); // si había un sync en curso (anterior al alta) espera y reintenta
      const rows = await localDatabase.catalog(localRuntime.branchId);
      if (rows.some((row) => row.productId === productId)) return true;
    }
    return false;
  }

  /** Resolves to an error message for the modal, or null when the product was created/resolved and added. */
  async function createQuickProduct(code: string, input: { name: string; priceCents: bigint; costCents: bigint | null }): Promise<string | null> {
    if (!desktop || !user || user.offline || !navigator.onLine) return "El alta requiere conexión a Internet.";
    if (!localRuntime?.deviceId || !operator?.operatorToken) return "Seleccioná un empleado autorizado antes de crear productos.";
    const { data, error: createError } = await supabase.rpc("create_pos_quick_product", {
      p_device_id: localRuntime.deviceId,
      p_operator_profile_id: operator.profileId,
      p_operator_token: operator.operatorToken,
      p_barcode: code,
      p_name: input.name,
      p_price_cents: Number(input.priceCents),
      ...(input.costCents === null ? {} : { p_cost_cents: Number(input.costCents) })
    });
    if (createError) return resolveErrorMessage(createError, "No se pudo crear el producto");
    const result = parseQuickCreateResult(data);
    if (result.status === "EXISTS_UNSELLABLE") {
      return `Ese código ya existe como "${result.productName}", pero hoy no se puede vender (inactivo o sin precio). Avisale al administrador.`;
    }
    if (!(await addServerProduct(result.product, result.status === "CREATED"))) {
      return result.status === "CREATED"
        ? "El producto se creó, pero esta caja todavía no pudo sincronizarlo. Revisá la conexión y tocá «Crear y agregar» otra vez (no se duplica)."
        : "El producto ya existe, pero esta caja todavía no pudo sincronizarlo. Revisá la conexión y probá de nuevo.";
    }
    setQuickCreateCode(null);
    return null;
  }

  /** Product the server created or habilitated for this branch: sync it into SQLite, then add it to the ticket
   * (UNIT +1, WEIGHT opens the weigh dialog). Returns false if this device could not sync it yet. */
  async function addServerProduct(row: QuickCatalogRow, created: boolean): Promise<boolean> {
    const product = toCatalogProduct(row);
    if (!(await ensureProductInLocalCatalog(product.productId))) return false;
    setCatalog((current) => (current.some((candidate) => candidate.productId === product.productId) ? current : [...current, product]));
    if (product.unitType === "UNIT") addScannedUnit(product, { created });
    else openWeight(product);
    return true;
  }

  // Central, código desconocido localmente: ANTES de ofrecer el alta se pregunta al servidor si ya existe
  // en la organización (sólo para códigos desconocidos; los scans normales nunca salen a la red). Si existía
  // sin estar en el surtido de Central el servidor lo habilita y se agrega al ticket sin abrir el modal.
  const scanLookupInFlight = useRef(false);
  async function resolveUnknownScan(code: string) {
    if (scanLookupInFlight.current) return;
    if (!desktop || !user || user.offline || !navigator.onLine || !localRuntime?.deviceId || !operator?.operatorToken) {
      setScanFeedback(null);
      setQuickCreateCode(code); // sin conexión el modal abre igual y avisa que el alta la necesita
      return;
    }
    scanLookupInFlight.current = true;
    setScanFeedback({ tone: "ok", text: "Buscando código…" });
    try {
      const { data, error: resolveError } = await supabase.rpc("resolve_pos_scan_barcode", {
        p_device_id: localRuntime.deviceId,
        p_operator_profile_id: operator.profileId,
        p_operator_token: operator.operatorToken,
        p_barcode: code
      });
      if (resolveError) throw resolveError;
      const result = parseScanResolveResult(data);
      if (result.status === "NOT_FOUND") { setScanFeedback(null); setQuickCreateCode(code); return; }
      if (result.status === "EXISTS_UNSELLABLE") {
        setScanFeedback({ tone: "warn", text: `"${result.productName}" existe pero hoy no se puede vender (inactivo o sin precio). Avisale al administrador.` });
        return;
      }
      if (!(await addServerProduct(result.product, false))) {
        setScanFeedback({ tone: "warn", text: `"${result.product.productName}" ya existe, pero esta caja todavía no pudo sincronizarlo. Escanealo de nuevo.` });
      }
    } catch {
      // Red caída a mitad de camino u otro fallo: se ofrece el alta (el servidor es idempotente por código).
      setScanFeedback(null);
      setQuickCreateCode(code);
    } finally {
      scanLookupInFlight.current = false;
    }
  }

  // El precio recién fijado tiene que estar en el SQLite de esta caja antes de vender (confirm_local_sale
  // sólo vende al precio del catálogo local): se sincroniza (pull incremental) y se verifica.
  async function ensurePriceInLocalCatalog(productId: string, priceCents: bigint): Promise<boolean> {
    if (!localRuntime?.branchId) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await syncRunnerRef.current(); // si había un sync en curso (anterior al cambio) espera y reintenta
      const rows = await localDatabase.catalog(localRuntime.branchId);
      if (rows.some((row) => row.productId === productId && row.pricePerKgCents === String(priceCents))) return true;
    }
    return false;
  }

  /** Resolves to an error message for the modal, or null when the price was saved and the product added. */
  async function setProductPrice(product: CatalogProduct, priceCents: bigint): Promise<string | null> {
    if (!desktop) return "El precio sólo se puede fijar desde la caja de escritorio.";
    if (!user || user.offline || !navigator.onLine) return NO_PRICE_OFFLINE_MESSAGE;
    if (!localRuntime?.deviceId || !operator?.operatorToken) return "Seleccioná un empleado autorizado antes de fijar precios.";
    const { data, error: priceError } = await supabase.rpc("set_pos_product_price", {
      p_device_id: localRuntime.deviceId,
      p_operator_profile_id: operator.profileId,
      p_operator_token: operator.operatorToken,
      p_product_id: product.productId,
      p_price_cents: Number(priceCents)
    });
    if (priceError) {
      void syncRunnerRef.current(); // p. ej. otra caja ya le puso precio: que el catálogo local se ponga al día
      return resolveErrorMessage(priceError, "No se pudo guardar el precio");
    }
    const result = parseSetPriceResult(data);
    if (!(await ensurePriceInLocalCatalog(product.productId, result.priceCents))) {
      return "El precio se guardó, pero esta caja todavía no pudo sincronizarlo. Revisá la conexión y tocá «Guardar precio y agregar» otra vez (no se duplica).";
    }
    const priced: CatalogProduct = { ...product, pricePerKgCents: result.priceCents };
    setCatalog((current) => current.map((candidate) => (candidate.productId === priced.productId ? priced : candidate)));
    setPricePromptProduct(null);
    // Un producto por unidad se agrega con 1 unidad (como un escaneo); uno por peso abre el diálogo de peso con el precio nuevo.
    if (priced.unitType === "UNIT") addScannedUnit(priced, { priceSet: true });
    else openWeight(priced);
    return null;
  }

  const scanHandlerRef = useRef(handleScan);
  scanHandlerRef.current = handleScan;
  const scannerEnabled = Boolean(user && branchId) && (!desktop || Boolean(operator)) && !clockInRequired
    && !selectedProduct && quickCreateCode === null && pricePromptProduct === null && !exitModalOpen && !cancelTicketModalOpen && !diagnosticsOpen && !recentSalesOpen && mpPanelSale === null && !loading;

  useEffect(() => {
    if (!scannerEnabled) return;
    let buffer = emptyScanBuffer();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      // Somebody typing in a field on purpose (search box, weight, PIN…) is never a scan here;
      // the search box has its own Enter handling below.
      if (isEditableTarget(event.target)) { buffer = emptyScanBuffer(); return; }
      const result = feedScanKey(buffer, event.key, event.timeStamp);
      buffer = result.buffer;
      if (result.scan !== null) {
        event.preventDefault(); // the terminating Enter must not activate a focused button
        scanHandlerRef.current(result.scan);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scannerEnabled]);

  useEffect(() => {
    if (!scanFeedback) return;
    const timeout = window.setTimeout(() => setScanFeedback(null), scanFeedback.tone === "warn" ? 3_500 : 1_800);
    return () => window.clearTimeout(timeout);
  }, [scanFeedback]);

  // ---- Mercado Pago (D-054) ---------------------------------------------------------------------
  const online = syncStatus.state !== "offline" && navigator.onLine;
  const mpDeviceId = localRuntime?.deviceId ?? null;
  const mpBranchId = localRuntime?.branchId ?? null;
  const hasOnlineSession = user !== null && !user.offline;
  // Hay Internet pero la sesión técnica no se pudo restaurar: la caja vende con la autorización en
  // caché, pero NO sincroniza ni puede consultar a Mercado Pago (ver lib/mercadopago-availability.ts).
  const sessionDegraded = isSessionDegraded({ desktop, sessionOffline: user?.offline ?? false, browserOnline: online });
  const mpAvailability = resolveMercadoPagoAvailability({
    desktop, hasDevice: mpDeviceId !== null, hasUser: user !== null, sessionOffline: user?.offline ?? false,
    browserOnline: online, knownEnabled: mpKnownEnabled, lookupFailed: mpLookupError !== null
  });

  // Sucursal con Mercado Pago obligatorio: no existe el botón "Transferencia" (la regla la decide la
  // configuración de la sucursal en el servidor, nunca el nombre de la sucursal).
  const manualTransferOffered = isManualTransferOffered({ mercadoPagoEnabled: mpKnownEnabled, manualTransferAllowed: mpManualTransferAllowed });
  const paymentButtons = filterPaymentMethodButtons(PAYMENT_METHOD_BUTTONS, manualTransferOffered);
  const paymentColumns = paymentButtons.length + (mpAvailability.visible ? 1 : 0);

  // Si la política llega con una Transferencia manual ya elegida, se deselecciona (no se cobra así).
  useEffect(() => {
    if (!manualTransferOffered && paymentMethod === "TRANSFER" && paymentProvider === null) setPaymentMethod(null);
  }, [manualTransferOffered, paymentMethod, paymentProvider]);

  // Cualquier reseteo del medio de pago (venta confirmada, ticket cancelado, cambio de operador...)
  // también limpia el proveedor: un ticket nuevo nunca arranca "Mercado Pago".
  useEffect(() => {
    if (paymentMethod === null) setPaymentProvider(null);
  }, [paymentMethod]);

  // ¿Esta caja cobra con Mercado Pago? Primero lo recordado (sirve sin Internet y tras reiniciar:
  // el botón queda visible pero deshabilitado) y después lo que diga el servidor.
  useEffect(() => {
    if (!desktop) return;
    setMpKnownEnabled(readMercadoPagoEnabled(mpDeviceId, mpBranchId));
    setMpManualTransferAllowed(readManualTransferAllowed(mpDeviceId, mpBranchId));
    setMpLookupError(null);
  }, [desktop, mpDeviceId, mpBranchId]);

  // Se consulta al servidor en cuanto hay dispositivo + sesión técnica EN LÍNEA + Internet, y de
  // nuevo si cualquiera de esas condiciones cambia (p. ej. al reconectar la caja). Un error ya no se
  // traga: queda en el diagnóstico (y en la consola en desarrollo, sin datos sensibles).
  useEffect(() => {
    if (!desktop || !mpDeviceId || !hasOnlineSession || !online) return;
    let cancelled = false;
    void fetchMercadoPagoConfig(mpDeviceId, mpBranchId).then((result) => {
      if (cancelled) return;
      if (result.status === "ok") {
        setMpKnownEnabled(result.enabled);
        setMpManualTransferAllowed(result.manualTransferAllowed);
        setMpLookupError(null);
        if (mpBranchId) {
          writeMercadoPagoEnabled(mpDeviceId, mpBranchId, result.enabled, result.manualTransferAllowed);
          // También en SQLite: la venta local se rechaza ahí mismo (sin Internet) si la transferencia manual está prohibida.
          void localDatabase.setManualTransferPolicy(mpBranchId, result.manualTransferAllowed).catch(() => undefined);
        }
      } else {
        setMpLookupError(`[${result.code}] ${result.message}`);
        if (import.meta.env.DEV) console.warn("[pos] mp_get_branch_config_failed", { code: result.code, message: result.message });
      }
    });
    return () => { cancelled = true; };
  }, [desktop, mpDeviceId, mpBranchId, hasOnlineSession, online]);

  const refreshPendingMp = useCallback(async () => {
    if (!desktop) return;
    try {
      setPendingMp(await localDatabase.pendingProviderPayments(10));
    } catch {
      setPendingMp([]);
    }
  }, [desktop]);
  useEffect(() => { void refreshPendingMp(); }, [refreshPendingMp, operator, mpPanelSale]);

  // El servidor informó un estado: se refleja en el caché local (sin retroceder una confirmación).
  const mirrorMercadoPagoVerification = useCallback((saleId: string, status: string) => {
    void localDatabase.setPaymentVerification(saleId, status).then(() => refreshPendingMp()).catch(() => undefined);
  }, [refreshPendingMp]);
  const closeMercadoPagoPanel = useCallback(() => { setMpPanelSale(null); }, []);
  const mpPanelSaleRef = useRef(mpPanelSale);
  mpPanelSaleRef.current = mpPanelSale;

  // El cobro terminó. Se avisa en pantalla y, si no hubo acreditación, se sincroniza para que el stock
  // restituido por el servidor (anulación de la venta) se refleje en la caja.
  const handleMercadoPagoSettled = useCallback((saleId: string, outcome: "PAID" | "NOT_PAID" | "NEEDS_ATTENTION", title: string) => {
    const short = saleId.slice(0, 8);
    if (outcome === "PAID") setNotice(`Venta ${short}: pago de Mercado Pago confirmado`);
    else if (outcome === "NOT_PAID") setNotice(`${title}. La venta ${short} quedó anulada: no se cobró y su stock se restituyó.`);
    else setNotice(`Venta ${short}: revisá el cobro de Mercado Pago (${title}) y avisá al administrador.`);
    void refreshPendingMp();
    if (outcome !== "PAID") {
      void loadBranchStock();
      void runSync();
    }
  }, [loadBranchStock, refreshPendingMp, runSync]);

  // Cobros que quedaron pendientes con la caja cerrada o sin Internet: se le pregunta al servidor
  // (que consulta a Mercado Pago) y se refleja el resultado, así uno que venció o se canceló sale de
  // "MP pendientes" y su venta queda anulada igual que si lo hubiera informado el webhook.
  useEffect(() => {
    if (!desktop || !mpDeviceId || !hasOnlineSession || !online) return;
    let cancelled = false;
    const sweep = async () => {
      if (mpPanelSaleRef.current) return;
      try {
        const summary = await reconcilePendingMercadoPago({
          list: () => localDatabase.pendingProviderPayments(25, true),
          fetchStatus: (saleId) => fetchMercadoPagoStatus(mpDeviceId, saleId),
          cancelUnpaid: (saleId) => cancelMercadoPagoOrder(mpDeviceId, saleId),
          mirror: (saleId, status) => localDatabase.setPaymentVerification(saleId, status),
          nowMs: Date.now(),
          abandonedAfterMs: MP_ABANDONED_AFTER_MS
        });
        if (!cancelled && summary.resolved > 0) {
          await refreshPendingMp();
          void loadBranchStock();
        }
      } catch {
        // Mejor esfuerzo: se reintenta en el próximo ciclo.
      }
    };
    void sweep();
    const timer = window.setInterval(() => { void sweep(); }, MP_RECONCILE_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [desktop, mpDeviceId, hasOnlineSession, online, refreshPendingMp, loadBranchStock]);

  async function completeSale() {
    // Guard defensivo: no confiar sólo en el disabled del botón. Sin método de
    // pago elegido, no se completa la venta bajo ninguna circunstancia.
    // (chequeo directo de null, no sólo el mensaje, para que TS angoste el tipo)
    if (!paymentMethod) { setError(validatePaymentMethodForSale(paymentMethod) ?? "Seleccioná un método de pago."); return; }
    if (!branchId || ticket.length === 0 || saleInFlight.current) return;
    const method = paymentMethod;
    const provider = paymentProvider;
    if (method === "TRANSFER" && provider === null && !manualTransferOffered) {
      setPaymentMethod(null);
      setError("Esta sucursal no admite transferencia manual: cobrá con Mercado Pago.");
      return;
    }
    // Mercado Pago necesita Internet y sesión real para generar el cobro: se rechaza ANTES de
    // registrar la venta, nunca se deja una venta "declarada MP" sin forma de cobrarse.
    if (provider === "MERCADOPAGO" && !mpAvailability.usable) {
      setError(mpAvailability.reason === "SESSION_NOT_ONLINE"
        ? "La caja no tiene sesión técnica en línea. Reconectala (Diagnóstico → Reconectar caja) para cobrar con Mercado Pago."
        : "Mercado Pago requiere conexión a Internet. Elegí otro medio de pago o esperá a reconectar.");
      return;
    }
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
          paymentMethod: method,
          ...(provider ? { paymentProvider: provider } : {})
        });
        const receipt = await localDatabase.confirmSale(sale);
        setTicket([]);
        setPaymentMethod(null);
        if (provider === "MERCADOPAGO") setMpPanelSale({ saleId: receipt.saleId, totalCents: BigInt(receipt.totalCents) });
        const runtime = await localDatabase.runtime();
        setLocalRuntime(runtime);
        void loadBranchStock();
        setSyncStatus((current) => ({
          ...current,
          state: navigator.onLine ? "online" : "offline",
          pendingCount: runtime.pendingCount
        }));
        setNotice(provider === "MERCADOPAGO"
          ? `Venta ${receipt.saleId.slice(0, 8)} registrada: falta confirmar el pago de Mercado Pago`
          : `Venta ${receipt.saleId.slice(0, 8)} confirmada localmente por ${formatCurrency(BigInt(receipt.totalCents))}`);
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
    void loadBranchStock();
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

  // Tauri v2's invoke() rejects Rust Result<T, String> commands with the raw string, not an
  // Error instance — the old `err instanceof Error ? err.message : "generic fallback"` catches
  // in this file silently dropped that message for every Tauri command failure (device/operator
  // context, local SQLite writes), which is exactly what made clock-in show only a generic error.
  // Reuses the same describeCaughtValue/resolveErrorMessage/formatDiagnostics helpers already
  // built for the PIN login diagnostics below (./lib/error-messages), tagged with which stage of
  // the operation failed so a real cause (device context vs online RPC vs local SQLite) is visible
  // instead of guessed at.
  function reportStageError(stage: string, err: unknown, fallback: string) {
    const caught = describeCaughtValue(err);
    console.error(`[pos] ${stage.toLowerCase()}_failed`, caught);
    setError(`[${stage}] ${resolveErrorMessage(err, fallback)}`);
    setErrorDiagnostics(formatDiagnostics(caught));
  }

  async function runStage<T>(stage: string, fallback: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err) {
      reportStageError(stage, err, fallback);
      throw new HandledStageError();
    }
  }

  async function selectOperator(active: LocalOperator) {
    setError(null); setErrorDiagnostics(null);
    try {
      const currentShift = await loadShift(active);
      setOperator(active);
      setClockInRequired(!currentShift);
    } catch (shiftError) {
      await localDatabase.clearActiveOperator().catch(() => undefined);
      const caught = describeCaughtValue(shiftError);
      console.error("[pos] load_shift_failed", caught);
      throw new Error(`[OPERATOR_CONTEXT] ${resolveErrorMessage(shiftError, "No se pudo recuperar el turno")}${caught.code || caught.details ? ` (${formatDiagnostics(caught)})` : ""}`);
    }
  }

  async function finishOperatorSession() {
    if (!operator || shiftInFlight.current) return;
    shiftInFlight.current = true;
    setError(null); setErrorDiagnostics(null);
    try {
      const result = await runStage("LOCAL_SQLITE", "No se pudo finalizar la sesión del operador", () => localDatabase.closeActiveOperatorShift());
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
      if (!(exitError instanceof HandledStageError)) reportStageError("LOCAL_SQLITE", exitError, "No se pudo finalizar la sesión del operador");
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
    if (!operator) { reportStageError("OPERATOR_CONTEXT", "No hay un operador con sesión activa", "No hay un operador con sesión activa"); return null; }
    if (!localRuntime) { reportStageError("DEVICE_CONTEXT", "No se pudo leer el contexto local del dispositivo (get_local_runtime)", "No se pudo leer el contexto del dispositivo"); return null; }
    if (shiftInFlight.current) return null;
    shiftInFlight.current = true; setError(null); setErrorDiagnostics(null);
    try {
      let updated: LocalShift;
      if (navigator.onLine && !user?.offline && operator.operatorToken) {
        const operatorToken = operator.operatorToken;
        const remote = await runStage("ONLINE_RPC", "No se pudo registrar el fichaje online", async () => {
          const { data, error: eventError } = await supabase.rpc("record_employee_time_event", { p_device_id: localRuntime.deviceId, p_event_id: crypto.randomUUID(), p_shift_id: shift?.shiftId ?? crypto.randomUUID(), p_employee_id: operator.profileId, p_operator_token: operatorToken, p_action: action });
          if (eventError) throw eventError;
          return data as unknown as Omit<LocalShift, "employeeId">;
        });
        updated = { ...remote, employeeId: operator.profileId };
        await runStage("LOCAL_SQLITE", "El fichaje se registró en el servidor pero no se pudo guardar localmente", () => localDatabase.applyServerShift(updated));
      } else {
        updated = await runStage("LOCAL_SQLITE", "No se pudo registrar el fichaje offline", () => localDatabase.recordOfflineTimeEvent(action));
      }
      setShift(updated.status === "CLOSED" ? null : updated);
      if (action === "CLOCK_IN" && updated.status === "OPEN") setClockInRequired(false);
      setNotice(action === "CLOCK_IN" ? "Entrada registrada" : updated.status === "REQUIRES_REVIEW" ? "El turno requiere revisión administrativa" : "Salida registrada");
      if (!navigator.onLine) setLocalRuntime(await localDatabase.runtime());
      return updated;
    } catch (timeError) {
      if (!(timeError instanceof HandledStageError)) reportStageError("LOCAL_SQLITE", timeError, "No se pudo registrar el fichaje");
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

  // Reconectar la caja: misma pantalla de la cuenta técnica del dispositivo que ya existe para
  // aprovisionar. Al autenticar, la sesión pasa a "en línea": arrancan la sync y la consulta de
  // Mercado Pago, sin reiniciar el POS.
  if (user.offline && reconnectOpen) {
    return (
      <DeviceProvisioningLogin
        onAuthenticated={(authenticatedUser) => {
          setReconnectOpen(false);
          setUser(authenticatedUser);
        }}
        onCancel={() => setReconnectOpen(false)}
      />
    );
  }

  const activeBranch = branches.find((branch) => branch.id === branchId);
  const deviceNeedsBinding = desktop && localRuntime?.deviceStatus === "UNREGISTERED";
  if (desktop && localRuntime?.deviceStatus === "ACTIVE" && localRuntime.branchId && !operator) {
    return <OperatorLogin deviceId={localRuntime.deviceId} online={navigator.onLine && !user.offline} onAuthenticated={selectOperator} onReconnect={sessionDegraded ? () => setReconnectOpen(true) : undefined} operators={operators} />;
  }
  const syncLabel = sessionDegraded
    ? "SIN SESIÓN EN LÍNEA · no sincroniza"
    : syncStatus.state === "syncing" && syncStatus.syncingTotal > 0
    ? `SINCRONIZANDO · ${String(syncStatus.syncingCurrent)} de ${String(syncStatus.syncingTotal)}`
    : syncStatus.state === "offline"
      ? `OFFLINE · ${String(syncStatus.pendingCount)} evento${syncStatus.pendingCount === 1 ? "" : "s"} pendiente${syncStatus.pendingCount === 1 ? "" : "s"}`
      : syncStatus.state === "error"
        ? "ERROR DE SINCRONIZACIÓN"
        : syncStatus.pendingCount > 0
          ? `ONLINE · ${String(syncStatus.pendingCount)} pendientes`
          : "SINCRONIZADO";
  const syncCompactLabel = sessionDegraded
    ? "! sesión"
    : syncStatus.state === "syncing"
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
          {pendingMp.length > 0 && !mpPanelSale ? (
            <button
              className="shrink-0 whitespace-nowrap rounded-xl border border-sky-700 bg-sky-950 px-3 py-2 text-xs font-black text-sky-200 hover:bg-sky-900"
              onClick={() => { const [first] = pendingMp; if (first) setMpPanelSale({ saleId: first.saleId, totalCents: BigInt(first.totalCents) }); }}
              title="Ventas con Mercado Pago que todavía no tienen el pago confirmado"
              type="button"
            >
              MP pendientes ({pendingMp.length})
            </button>
          ) : null}
          <button className="pos-recent-sales rounded-xl border border-stone-700 px-3 py-2 text-xs font-black hover:bg-stone-800" onClick={() => setRecentSalesOpen(true)}><span className="pos-label-full">Ventas recientes</span><span className="pos-label-compact">Ventas</span></button>
          {desktop ? (
            <button
              className={`pos-sync w-56 shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-center text-xs font-black tabular-nums ${syncStatus.state === "error" ? "border-red-700 bg-red-950 text-red-200" : syncStatus.state === "offline" || sessionDegraded ? "border-amber-700 bg-amber-950 text-amber-200" : "border-emerald-700 bg-emerald-950 text-emerald-200"}`}
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

      {error ? (
        <div className="mx-4 mt-4 rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-red-100">
          <p>{error}</p>
          {errorDiagnostics ? (
            <p className="mt-1 break-all text-xs text-red-300">
              <span className="font-bold uppercase tracking-wide">Diagnóstico</span> · {errorDiagnostics}
            </p>
          ) : null}
        </div>
      ) : null}
      {notice ? <div className="pos-toast" role="status">✓ {notice}</div> : null}
      {scanFeedback ? <div className={`pos-toast ${scanFeedback.tone === "warn" ? "pos-toast-warn" : ""}`} role="status">{scanFeedback.tone === "ok" ? "✓ " : "⚠ "}{scanFeedback.text}</div> : null}

      <div className="pos-workspace grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_410px]">
        <section className="pos-catalog min-w-0 border-stone-800 p-4 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden lg:border-r lg:p-5">
          {centralPos ? (
            <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
          ) : (
            <div className="pos-categories flex flex-wrap gap-2">
              <button className={`rounded-xl px-4 py-3 font-bold ${categoryId === "ALL" ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`} onClick={() => setCategoryId("ALL")}>Todos</button>
              {categories.map((category) => (
                <button key={category.id} className={`flex items-center gap-2 rounded-xl px-4 py-3 font-bold ${categoryId === category.id ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`} onClick={() => setCategoryId(category.id)}><span className="h-2.5 w-2.5 rounded-full bg-stone-500" style={{ backgroundColor: categoryAccent(category.color) }} />{category.name}</button>
              ))}
            </div>
          )}
          <input
            className="pos-search mt-4 w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-lg outline-none focus:border-rose-500"
            placeholder="Buscar producto o SKU…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // A scanner that typed into the focused search box: resolve it as a scan and clear the box.
              const code = normalizeBarcode(search);
              if (!code) return;
              // Known barcode, or a long numeric code that matches nothing in the catalog: resolve it as a
              // scan (unknown opens the quick create in Central, "no encontrado" everywhere else).
              if (barcodeIndex.has(code) || (/^\d{6,}$/.test(code) && filteredProducts.length === 0)) { event.preventDefault(); setSearch(""); handleScan(code); }
            }}
          />
          <div className="pos-product-grid mt-4 grid auto-rows-max content-start grid-cols-2 gap-3 md:grid-cols-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1 xl:grid-cols-4">
            {stockGate !== null && availableProducts.length > 0 ? <h3 className="col-span-full text-xs font-black uppercase tracking-widest text-stone-400">Disponibles</h3> : null}
            {visibleAvailable.map((product) => renderProductCard(product, false))}
            {outOfStockProducts.length > 0 ? (
              searching ? (
                <h3 className="col-span-full mt-2 text-xs font-black uppercase tracking-widest text-stone-500">Sin stock ({outOfStockProducts.length})</h3>
              ) : (
                <button
                  type="button"
                  className="col-span-full mt-2 flex items-center gap-2 text-left text-xs font-black uppercase tracking-widest text-stone-500 hover:text-stone-300"
                  aria-expanded={outOfStockOpen}
                  onClick={() => setOutOfStockOpen((open) => !open)}
                >
                  <span aria-hidden="true">{outOfStockOpen ? "▾" : "▸"}</span>Sin stock ({outOfStockProducts.length})
                </button>
              )
            ) : null}
            {showOutOfStock ? visibleOutOfStock.map((product) => renderProductCard(product, true)) : null}
            {hiddenCount > 0 ? <button className="col-span-full rounded-xl border border-stone-700 px-4 py-3 text-sm font-bold text-stone-300 hover:bg-stone-800" onClick={() => setGridLimit((limit) => limit + GRID_PAGE)} type="button">Mostrar más ({String(hiddenCount)} restantes) — o buscá por nombre / escaneá el código</button> : null}
          </div>
          {!loading && filteredProducts.length === 0 ? <p className="mt-10 text-center text-stone-500">No hay productos disponibles.</p> : null}
        </section>

        <aside className="pos-ticket flex min-h-[520px] flex-col bg-stone-900 p-4 lg:min-h-0 lg:overflow-hidden lg:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-black">Ticket actual</h2>
            {ticket.length ? (
              <button
                className="text-sm font-bold text-red-400 hover:text-red-300"
                onClick={() => setCancelTicketModalOpen(true)}
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
              <div className={`pos-payment-buttons grid ${paymentColumns === 4 ? "grid-cols-2" : "grid-cols-3"} gap-2`} role="group" aria-labelledby="payment-method-label">
                {paymentButtons.map((option) => {
                  const active = paymentMethod === option.value && !(option.value === "TRANSFER" && paymentProvider);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => { setPaymentProvider(null); setPaymentMethod(option.value); }}
                      className={`rounded-xl border-2 px-3 py-3 text-sm font-black transition ${active ? option.activeClass : "border-stone-700 bg-stone-950 text-stone-300 hover:bg-stone-800"}`}
                    >
                      {active ? "✓ " : ""}{option.label}
                    </button>
                  );
                })}
                {mpAvailability.visible ? (
                  <button
                    type="button"
                    aria-pressed={paymentProvider === "MERCADOPAGO"}
                    disabled={!mpAvailability.usable}
                    title={mpAvailability.usable ? undefined : mpAvailability.explanation}
                    onClick={() => { setPaymentProvider("MERCADOPAGO"); setPaymentMethod("TRANSFER"); }}
                    className={`rounded-xl border-2 px-3 py-3 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${paymentProvider === "MERCADOPAGO" ? "border-sky-400 bg-sky-950 text-sky-100 ring-2 ring-sky-400/60" : "border-stone-700 bg-stone-950 text-stone-300 hover:bg-stone-800"}`}
                  >
                    {paymentProvider === "MERCADOPAGO" ? "✓ " : ""}Mercado Pago{mpAvailability.usable ? "" : mpAvailability.reason === "SESSION_NOT_ONLINE" ? " (sin sesión)" : " (sin conexión)"}
                  </button>
                ) : null}
              </div>
            </div>
            {shouldDisplayTicketAmounts(paymentMethod) ? (
              <>
                <div className="mt-2 flex justify-between text-sm text-stone-300"><span>Subtotal/lista</span><span>{formatCurrency(ticketListSubtotal)}</span></div>
                {ticketCashDiscount > 0n ? <div className="mt-1 flex justify-between text-sm text-emerald-400"><span>Descuento por pago ({(cashDiscountBps / 100).toLocaleString("es-AR")}%)</span><span>-{formatCurrency(ticketCashDiscount)}</span></div> : null}
                {ticketCardSurcharge > 0n ? <div className="mt-1 flex justify-between text-sm text-amber-400"><span>Recargo tarjeta ({(cashDiscountBps / 100).toLocaleString("es-AR")}%)</span><span>+{formatCurrency(ticketCardSurcharge)}</span></div> : null}
                {ticketPromotionDiscount > 0n ? <div className="mt-1 flex justify-between text-sm text-emerald-400"><span>Promo por cantidad</span><span>-{formatCurrency(ticketPromotionDiscount)}</span></div> : null}
                <div className="mt-2 flex items-end justify-between"><span className="text-lg font-bold">TOTAL</span><strong className="text-4xl font-black text-rose-400">{formatCurrency(ticketTotal)}</strong></div>
              </>
            ) : null}
            <button
              className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-4 text-xl font-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!isSaleConfirmable({ paymentMethod, ticketLength: ticket.length, loading, deviceNeedsBinding }) || (paymentProvider === "MERCADOPAGO" && !mpAvailability.usable)}
              onClick={() => void completeSale()}
            >
              {loading ? "Procesando…" : paymentProvider === "MERCADOPAGO" ? "Confirmar y cobrar con Mercado Pago" : "Confirmar venta"}
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

      {cancelTicketModalOpen ? (
        <div
          className="pos-modal-backdrop fixed inset-0 z-[60] grid place-items-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-ticket-title"
          onClick={(event) => { if (event.target === event.currentTarget) setCancelTicketModalOpen(false); }}
        >
          <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-7 shadow-2xl">
            <h2 className="text-3xl font-black" id="cancel-ticket-title">Cancelar ticket</h2>
            <p className="mt-4 text-stone-300">¿Seguro que querés cancelar este ticket?<br />Se eliminarán todos los productos cargados.</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" onClick={() => setCancelTicketModalOpen(false)}>Volver</button>
              <button
                className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500"
                onClick={() => {
                  setTicket([]);
                  setPaymentMethod(null);
                  setCancelTicketModalOpen(false);
                }}
              >
                Cancelar ticket
              </button>
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
              <dt className="font-bold text-stone-400">Sesión técnica</dt><dd className={sessionDegraded ? "text-amber-300" : undefined}>{!user.offline ? "En línea" : sessionDegraded ? "Sin sesión en línea (autorización en caché): no sincroniza" : "Offline (autorización en caché)"}</dd>
              <dt className="font-bold text-stone-400">Mercado Pago</dt><dd className={mpAvailability.usable ? "text-emerald-300" : "text-amber-300"}>{mpAvailability.explanation}{mpLookupError ? ` · ${mpLookupError}` : ""}</dd>
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
              {sessionDegraded ? (
                <button className="rounded-xl bg-amber-600 px-4 py-3 font-black text-stone-950 hover:bg-amber-500" onClick={() => { setDiagnosticsOpen(false); setReconnectOpen(true); }} type="button">Reconectar caja</button>
              ) : null}
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
                  <button type="button" className="rounded-xl border border-stone-600 px-4 py-2 text-sm font-black disabled:opacity-40" disabled={scaleDetecting || scaleBusy || scale.connectionState !== "DISCONNECTED"} onClick={() => void detectScaleNow()}>{scaleDetecting ? "Detectando…" : "Detectar balanza"}</button>
                  <button type="button" className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black disabled:opacity-40" disabled={scaleBusy || scale.config.kind === "MANUAL"} onClick={() => void connectScaleNow()}>Conectar</button>
                  <button type="button" className="rounded-xl border border-stone-600 px-4 py-2 text-sm font-black disabled:opacity-40" disabled={scaleBusy || scale.connectionState === "DISCONNECTED"} onClick={() => void scaleBridge.disconnect()}>Desconectar</button>
                  <span className="text-xs text-stone-400">Estado: {scale.connectionState}{scale.lastError ? ` · ${scale.lastError}` : ""}</span>
                </div>
                {scaleDetectMessage ? <p className="text-xs font-bold text-amber-300">{scaleDetectMessage}</p> : null}
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
            <div className="mt-5 min-h-0 space-y-3 overflow-y-auto">{recentSales.map((sale) => <article className="flex items-center justify-between gap-4 rounded-xl border border-stone-700 bg-stone-950 p-4" key={sale.saleId}><div><strong>#{sale.saleId.slice(0, 8)}</strong><p className="text-sm text-stone-400">{new Date(sale.completedAt).toLocaleString("es-AR")} · {formatWeight(Number(sale.totalWeightGrams))}</p><p className={`text-xs font-bold ${sale.syncedAt ? "text-emerald-400" : "text-amber-300"}`}>{sale.syncedAt ? "Sincronizada" : "Pendiente de sincronización"}</p>{(() => { const payment = describeLocalPayment(sale.provider, sale.verificationStatus); return payment ? <p className={`text-xs font-bold ${payment.tone === "ok" ? "text-emerald-400" : payment.tone === "bad" ? "text-red-400" : "text-sky-300"}`}>{payment.label}</p> : null; })()}</div><strong className="text-xl text-rose-400">{formatCurrency(BigInt(sale.totalCents))}</strong></article>)}{!recentSales.length ? <p className="text-stone-400">Todavía no hay ventas en este equipo y sucursal.</p> : null}</div>
          </section>
        </div>
      ) : null}

      {mpPanelSale && operator?.operatorToken && localRuntime?.deviceId ? (
        <MercadoPagoPanel
          sale={mpPanelSale}
          context={{ deviceId: localRuntime.deviceId, operatorProfileId: operator.profileId, operatorToken: operator.operatorToken }}
          sessionOffline={user.offline}
          onClose={closeMercadoPagoPanel}
          onVerification={mirrorMercadoPagoVerification}
          onSettled={handleMercadoPagoSettled}
        />
      ) : null}

      {pricePromptProduct !== null ? (
        <ProductPriceModal
          productName={pricePromptProduct.productName}
          sessionOffline={user.offline}
          onCancel={() => setPricePromptProduct(null)}
          onSubmit={(priceCents) => setProductPrice(pricePromptProduct, priceCents)}
        />
      ) : null}

      {quickCreateCode !== null ? (
        <QuickProductModal
          code={quickCreateCode}
          sessionOffline={user.offline}
          onCancel={() => setQuickCreateCode(null)}
          onSubmit={(input) => createQuickProduct(quickCreateCode, input)}
        />
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
                  // Fixed layout (same three lines regardless of state) so a new
                  // scale://update event — arriving ~2/s while connected — never
                  // mounts/unmounts a different DOM structure; only the text and
                  // color inside each line change. This is what keeps the panel
                  // flicker-free (see `advanceWeightStability` in business-logic
                  // for the stability engine driving the status line below).
                  <div className="mt-5 rounded-2xl border border-stone-700 bg-stone-950 p-4">
                    <p className={`text-xs font-black uppercase tracking-wide ${scale.connectionState === "CONNECTED" ? "text-emerald-400" : scale.connectionState === "ERROR" ? "text-red-400" : "text-stone-500"}`}>
                      {scale.connectionState === "CONNECTED" ? "⚖ Balanza conectada" : scale.connectionState === "CONNECTING" ? "⚖ Conectando…" : scale.connectionState === "ERROR" ? "⚖ Balanza con error" : "⚖ Balanza desconectada"}
                    </p>
                    <p className="mt-2 text-3xl font-black text-stone-100">
                      {formatWeight(scale.connectionState === "CONNECTED" ? (scale.reading?.grams ?? 0) : 0)}
                    </p>
                    <p className="mt-1 text-sm text-stone-500">
                      {scale.connectionState !== "CONNECTED"
                        ? "Ingresá el peso manualmente."
                        : weightStability.status === "STABLE"
                          ? "Peso estable"
                          : weightStability.status === "STABILIZING"
                            ? "Estabilizando…"
                            : "Esperando peso…"}
                    </p>
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
                    {/* El recargo por tarjeta se aplica al total comercial completo, packs incluidos, sin excepción (D-044) — se muestra siempre que corresponda, no sólo fuera de un pack. */}
                    {preview.cardSurchargeCents > 0n ? <p className="mt-1 font-bold text-amber-400">Recargo tarjeta: +{formatCurrency(preview.cardSurchargeCents)}</p> : null}
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
