import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  formatCurrency,
  formatWeight,
  parseWeightToGrams,
  priceForWeight,
  applyWeightDiscount,
  sumMoney
} from "@carnicerias/business-logic";
import type { PaymentMethod, TicketLine } from "@carnicerias/types";
import { createOfflineSale, type SyncStatusSnapshot } from "@carnicerias/sync";

import { isDesktopRuntime, localDatabase, type LocalRuntime, type OutboxSummary, type RecentLocalSale } from "./lib/local-database";
import { supabase } from "./lib/supabase";
import { registerDesktopDevice, synchronizeDesktop } from "./lib/sync-engine";

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
  categorySortOrder: number;
  productId: string;
  productName: string;
  productSku: string | null;
  pricePerKgCents: bigint;
}
interface DiscountRule { id: string; productId: string; branchId: string | null; minimumGrams: number; discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG"; discountValue: string }
interface Announcement { id: string; title: string; message: string; type: string; priority: number }

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Efectivo" },
  { value: "TRANSFER", label: "Transferencia" },
  { value: "DEBIT", label: "Débito" },
  { value: "CREDIT", label: "Crédito" },
  { value: "OTHER", label: "Otro" }
];

function Login({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
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
    <main className="grid min-h-screen place-items-center bg-stone-950 p-6 text-stone-100">
      <section className="w-full max-w-md rounded-3xl border border-stone-800 bg-stone-900 p-8 shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-[0.22em] text-rose-400">Carnicerías · POS</p>
        <h1 className="mt-3 text-4xl font-black">Abrir caja</h1>
        <p className="mt-3 text-stone-400">Ingresá con tu usuario autorizado de Supabase.</p>
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
            {loading ? "Ingresando…" : "Ingresar al POS"}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const desktop = isDesktopRuntime();
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [roleName, setRoleName] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [discounts, setDiscounts] = useState<DiscountRule[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [categoryId, setCategoryId] = useState("ALL");
  const [search, setSearch] = useState("");
  const [ticket, setTicket] = useState<TicketLine[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [weightInput, setWeightInput] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localRuntime, setLocalRuntime] = useState<LocalRuntime | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [recentSalesOpen, setRecentSalesOpen] = useState(false);
  const [recentSales, setRecentSales] = useState<RecentLocalSale[]>([]);
  const [outboxSummary, setOutboxSummary] = useState<OutboxSummary | null>(null);
  const [binding, setBinding] = useState(false);
  const saleInFlight = useRef(false);
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
  }, [desktop, localRuntime, user]);

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
          return;
        }
        const data = await localDatabase.catalog(branchId);
        if (controller.signal.aborted) return;
        setCatalog(data.filter((row) => row.unitType === "WEIGHT").map((row) => ({
          organizationId: row.organizationId,
          branchId: row.branchId,
          branchName: row.branchName,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          categorySortOrder: row.categorySortOrder,
          productId: row.productId,
          productName: row.productName,
          productSku: row.productSku,
          pricePerKgCents: BigInt(row.pricePerKgCents)
        })));
        return;
      }
      const { data, error: catalogError } = await supabase.rpc("get_pos_catalog", {
        p_branch_id: branchId
      });
        if (catalogError) throw catalogError;
        if (controller.signal.aborted) return;
        setCatalog(
          data.filter((row) => row.unit_type === "WEIGHT").map((row) => ({
            organizationId: row.organization_id,
            branchId: row.branch_id,
            branchName: row.branch_name,
            categoryId: row.category_id,
            categoryName: row.category_name,
            categorySortOrder: row.category_sort_order,
            productId: row.product_id,
            productName: row.product_name,
            productSku: row.product_sku,
            pricePerKgCents: BigInt(row.price_per_kg_cents)
          }))
        );
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
        setDiscounts(config.discounts); setAnnouncements(config.announcements);
      } else {
        const { data, error: configError } = await supabase.rpc("get_pos_commercial_config", { p_branch_id: branchId });
        if (configError) throw configError;
        const config = data as unknown as { discounts: DiscountRule[]; announcements: Announcement[] };
        setDiscounts(config.discounts);
        setAnnouncements(config.announcements);
      }
    })().catch((configError: unknown) => setError(configError instanceof Error ? configError.message : "No se pudo cargar promociones"));
  }, [branchId, desktop, localRuntime?.catalogCursor]);

  const runSync = useCallback(async () => {
    if (!desktop || !user || user.offline || !localRuntime?.branchId) return;
    try {
      const runtime = await synchronizeDesktop(user, setSyncStatus);
      setLocalRuntime(runtime);
      setOutboxSummary(await localDatabase.outboxSummary());
    } catch {
      setOutboxSummary(await localDatabase.outboxSummary().catch(() => null));
    }
  }, [desktop, localRuntime?.branchId, user]);

  useEffect(() => {
    if (!desktop || !user) return;

    const handleOffline = () => {
      setSyncStatus((current) => ({ ...current, state: "offline" }));
    };
    const handleOnline = () => {
      if (user.offline) {
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
        void runSync();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    if (!user.offline) void runSync();
    const interval = window.setInterval(() => {
      if (!user.offline) void runSync();
    }, 10_000);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [desktop, runSync, user]);

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

  const categories = useMemo(() => {
    const unique = new Map<string, { id: string; name: string; order: number }>();
    for (const product of catalog) {
      unique.set(product.categoryId, {
        id: product.categoryId,
        name: product.categoryName,
        order: product.categorySortOrder
      });
    }
    return [...unique.values()].sort((left, right) => left.order - right.order);
  }, [catalog]);

  const filteredProducts = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("es-AR");
    return catalog.filter(
      (product) =>
        (categoryId === "ALL" || product.categoryId === categoryId) &&
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

  function openWeight(product: CatalogProduct, line?: TicketLine) {
    setSelectedProduct(product);
    setEditingLineId(line?.id ?? null);
    setWeightInput(line ? (line.weightGrams / 1_000).toFixed(3).replace(".", ",") : "");
    setError(null);
  }

  function saveLine(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct) return;

    try {
      const grams = parseWeightToGrams(weightInput);
      const applicableRules = discounts.filter((rule) => rule.productId === selectedProduct.productId)
        .sort((left, right) => right.minimumGrams - left.minimumGrams || Number(right.branchId === branchId) - Number(left.branchId === branchId));
      const applied = applyWeightDiscount(selectedProduct.pricePerKgCents, grams, applicableRules.map((rule) => ({ ...rule, discountValue: BigInt(rule.discountValue) })));
      const subtotal = applied.subtotalCents;
      const line: TicketLine = {
        id: editingLineId ?? crypto.randomUUID(),
        productId: selectedProduct.productId,
        productName: selectedProduct.productName,
        weightGrams: grams,
        pricePerKgCents: applied.finalPricePerKgCents,
        originalPricePerKgCents: selectedProduct.pricePerKgCents,
        discountRuleId: applied.ruleId,
        discountType: applied.discountType,
        discountValue: applied.discountValue,
        discountCents: applied.discountCents,
        subtotalCents: subtotal
      };

      setTicket((current) =>
        editingLineId
          ? current.map((candidate) => (candidate.id === editingLineId ? line : candidate))
          : [...current, line]
      );
      setSelectedProduct(null);
      setEditingLineId(null);
      setWeightInput("");
    } catch (weightError) {
      setError(weightError instanceof Error ? weightError.message : "Peso inválido");
    }
  }

  async function completeSale() {
    if (!branchId || ticket.length === 0 || saleInFlight.current) return;
    saleInFlight.current = true;
    setLoading(true);
    setError(null);
    setNotice(null);

    if (desktop) {
      try {
        if (!localRuntime?.organizationId || !localRuntime.branchId || !localRuntime.profileId) {
          throw new Error("Este dispositivo todavía no está vinculado y autorizado");
        }
        const sale = createOfflineSale({
          organizationId: localRuntime.organizationId,
          branchId: localRuntime.branchId,
          profileId: localRuntime.profileId,
          deviceId: localRuntime.deviceId,
          ticket,
          paymentMethod
        });
        const receipt = await localDatabase.confirmSale(sale);
        setTicket([]);
        setPaymentMethod("CASH");
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
      p_items: ticket.map((line) => ({
        product_id: line.productId,
        weight_grams: line.weightGrams,
        expected_price_per_kg_cents: (line.originalPricePerKgCents ?? line.pricePerKgCents).toString()
      })),
      p_payment_method: paymentMethod
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
    setPaymentMethod("CASH");
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

  if (!authReady) {
    return <main className="grid min-h-screen place-items-center bg-stone-950 text-stone-300">Cargando sesión…</main>;
  }

  if (!user) return <Login onAuthenticated={setUser} />;

  const activeBranch = branches.find((branch) => branch.id === branchId);
  const deviceNeedsBinding = desktop && localRuntime?.deviceStatus === "UNREGISTERED";
  const syncLabel = syncStatus.state === "syncing"
    ? `SINCRONIZANDO · ${String(syncStatus.syncingCurrent)} de ${String(syncStatus.syncingTotal)}`
    : syncStatus.state === "offline"
      ? `OFFLINE · ${String(syncStatus.pendingCount)} venta${syncStatus.pendingCount === 1 ? "" : "s"} pendiente${syncStatus.pendingCount === 1 ? "" : "s"}`
      : syncStatus.state === "error"
        ? "ERROR DE SINCRONIZACIÓN"
        : syncStatus.pendingCount > 0
          ? `ONLINE · ${String(syncStatus.pendingCount)} pendientes`
          : "ONLINE · Todo sincronizado";

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-stone-800 bg-stone-900 px-5 py-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-400">{desktop ? "POS offline-first" : "POS online"}</p>
          <p className="text-lg font-black">{activeBranch?.name ?? "Seleccioná sucursal"}</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="rounded-xl border border-stone-700 px-3 py-2 text-xs font-black hover:bg-stone-800" onClick={() => setRecentSalesOpen(true)}>Ventas recientes</button>
          {desktop ? (
            <button
              className={`rounded-xl border px-3 py-2 text-xs font-black ${syncStatus.state === "error" ? "border-red-700 bg-red-950 text-red-200" : syncStatus.state === "offline" ? "border-amber-700 bg-amber-950 text-amber-200" : "border-emerald-700 bg-emerald-950 text-emerald-200"}`}
              onClick={() => setDiagnosticsOpen(true)}
            >
              {syncLabel}
            </button>
          ) : null}
          {branches.length > 1 ? (
            <select
              className="rounded-xl border border-stone-700 bg-stone-950 px-3 py-2 font-semibold"
              value={branchId}
              onChange={(event) => {
                if (ticket.length && !window.confirm("Cambiar de sucursal cancelará el ticket actual. ¿Continuar?")) return;
                setTicket([]);
                setBranchId(event.target.value);
              }}
            >
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          ) : null}
          <div className="text-right text-xs text-stone-400">
            <p className="font-semibold text-stone-200">{roleName}</p>
            <p>{user.email}</p>
          </div>
          <button className="rounded-xl border border-stone-700 px-3 py-2 font-semibold hover:bg-stone-800" onClick={() => void logout()}>Salir</button>
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
      {notice ? <div className="mx-4 mt-4 rounded-xl border border-emerald-700 bg-emerald-950 px-4 py-3 text-emerald-100">{notice}</div> : null}
      {announcements.length ? <div className="mx-4 mt-4 grid gap-2 md:grid-cols-2">{announcements.map((announcement) => <div key={announcement.id} className="rounded-xl border border-amber-700 bg-amber-950 px-4 py-3 text-sm text-amber-100"><strong>{announcement.title}</strong><p>{announcement.message}</p></div>)}</div> : null}

      <div className="grid min-h-[calc(100vh-4rem)] lg:grid-cols-[minmax(0,1fr)_410px]">
        <section className="min-w-0 border-stone-800 p-4 lg:border-r lg:p-5">
          <div className="flex flex-wrap gap-2">
            <button className={`rounded-xl px-4 py-3 font-bold ${categoryId === "ALL" ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`} onClick={() => setCategoryId("ALL")}>Todos</button>
            {categories.map((category) => (
              <button key={category.id} className={`rounded-xl px-4 py-3 font-bold ${categoryId === category.id ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`} onClick={() => setCategoryId(category.id)}>{category.name}</button>
            ))}
          </div>
          <input
            className="mt-4 w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-lg outline-none focus:border-rose-500"
            placeholder="Buscar producto o SKU…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {filteredProducts.map((product) => (
              <button
                key={product.productId}
                className="min-h-32 rounded-2xl border border-stone-700 bg-stone-900 p-4 text-left shadow-lg transition hover:-translate-y-0.5 hover:border-rose-500 hover:bg-stone-800"
                onClick={() => openWeight(product)}
              >
                <span className="block text-lg font-black">{product.productName}</span>
                <span className="mt-2 block text-sm text-stone-400">{product.categoryName}</span>
                <span className="mt-3 block text-xl font-black text-rose-400">{formatCurrency(product.pricePerKgCents)}<small className="text-xs text-stone-400"> / kg</small></span>
                {discounts.filter((rule) => rule.productId === product.productId).slice(0, 1).map((rule) => <span className="mt-1 block text-xs font-bold text-amber-300" key={rule.id}>{rule.discountType === "PERCENTAGE" ? `${String(Number(rule.discountValue) / 100)}% OFF` : `${formatCurrency(BigInt(rule.discountValue))}/kg`} desde {formatWeight(rule.minimumGrams)}</span>)}
              </button>
            ))}
          </div>
          {!loading && filteredProducts.length === 0 ? <p className="mt-10 text-center text-stone-500">No hay productos disponibles.</p> : null}
        </section>

        <aside className="flex min-h-[520px] flex-col bg-stone-900 p-4 lg:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-black">Ticket actual</h2>
            {ticket.length ? <button className="text-sm font-bold text-red-400 hover:text-red-300" onClick={() => window.confirm("¿Cancelar todo el ticket?") && setTicket([])}>Cancelar</button> : null}
          </div>
          <div className="mt-4 flex-1 space-y-3 overflow-y-auto">
            {ticket.length === 0 ? <div className="grid h-44 place-items-center rounded-2xl border border-dashed border-stone-700 text-center text-stone-500">Seleccioná un producto<br />para comenzar</div> : null}
            {ticket.map((line) => {
              const product = catalog.find((candidate) => candidate.productId === line.productId);
              return (
                <article key={line.id} className="rounded-2xl border border-stone-700 bg-stone-950 p-4">
                  <div className="flex justify-between gap-3">
                    <div>
                      <h3 className="font-black">{line.productName}</h3>
                      <p className="mt-1 text-sm text-stone-400">{formatWeight(line.weightGrams)} · {formatCurrency(line.pricePerKgCents)}/kg</p>
                    </div>
                    <strong className="text-lg text-rose-400">{formatCurrency(line.subtotalCents)}</strong>
                  </div>
                  <div className="mt-3 flex gap-3 text-sm font-bold">
                    <button className="text-amber-300" disabled={!product} onClick={() => product && openWeight(product, line)}>Modificar peso</button>
                    <button className="text-red-400" onClick={() => setTicket((current) => current.filter((candidate) => candidate.id !== line.id))}>Eliminar</button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-4 border-t border-stone-700 pt-4">
            <div className="flex justify-between text-sm text-stone-400"><span>Peso total</span><span>{formatWeight(ticketWeight)}</span></div>
            <div className="mt-2 flex items-end justify-between"><span className="text-lg font-bold">TOTAL</span><strong className="text-4xl font-black text-rose-400">{formatCurrency(ticketTotal)}</strong></div>
            <label className="mt-5 grid gap-2 text-sm font-bold text-stone-300">
              Método de pago
              <select className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-lg" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}>
                {PAYMENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-4 text-xl font-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40" disabled={loading || ticket.length === 0 || deviceNeedsBinding} onClick={() => void completeSale()}>
              {loading ? "Procesando…" : "Confirmar venta"}
            </button>
          </div>
        </aside>
      </div>

      {diagnosticsOpen && localRuntime ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true">
          <section className="w-full max-w-xl rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl">
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
          </section>
        </div>
      ) : null}

      {recentSalesOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true">
          <section className="w-full max-w-xl rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-wider text-rose-400">Comprobantes</p><h2 className="mt-1 text-3xl font-black">Ventas recientes</h2></div><button className="rounded-lg border border-stone-600 px-3 py-2" onClick={() => setRecentSalesOpen(false)}>Cerrar</button></div>
            <div className="mt-5 space-y-3">{recentSales.map((sale) => <article className="flex items-center justify-between gap-4 rounded-xl border border-stone-700 bg-stone-950 p-4" key={sale.saleId}><div><strong>#{sale.saleId.slice(0, 8)}</strong><p className="text-sm text-stone-400">{new Date(sale.completedAt).toLocaleString("es-AR")} · {formatWeight(Number(sale.totalWeightGrams))}</p><p className={`text-xs font-bold ${sale.syncedAt ? "text-emerald-400" : "text-amber-300"}`}>{sale.syncedAt ? "Sincronizada" : "Pendiente de sincronización"}</p></div><strong className="text-xl text-rose-400">{formatCurrency(BigInt(sale.totalCents))}</strong></article>)}{!recentSales.length ? <p className="text-stone-400">Todavía no hay ventas en este equipo y sucursal.</p> : null}</div>
          </section>
        </div>
      ) : null}

      {selectedProduct ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true">
          <form className="w-full max-w-lg rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl" onSubmit={saveLine}>
            <p className="text-sm font-bold uppercase tracking-wider text-rose-400">{editingLineId ? "Modificar línea" : "Agregar al ticket"}</p>
            <h2 className="mt-2 text-3xl font-black">{selectedProduct.productName}</h2>
            <p className="mt-2 text-xl text-stone-300">{formatCurrency(selectedProduct.pricePerKgCents)} / kg</p>
            <label className="mt-6 grid gap-2 text-sm font-bold text-stone-300">
              Peso manual en kg
              <input autoFocus className="rounded-2xl border border-stone-600 bg-stone-950 px-4 py-4 text-4xl font-black outline-none focus:border-rose-500" inputMode="decimal" placeholder="1,250" value={weightInput} onChange={(event) => setWeightInput(event.target.value)} />
            </label>
            <div className="mt-5 rounded-2xl bg-stone-950 p-4">
              {(() => { try {
                const grams = parseWeightToGrams(weightInput);
                const rules = discounts.filter((rule) => rule.productId === selectedProduct.productId).sort((left, right) => right.minimumGrams - left.minimumGrams || Number(right.branchId === branchId) - Number(left.branchId === branchId));
                const preview = applyWeightDiscount(selectedProduct.pricePerKgCents, grams, rules.map((rule) => ({ ...rule, discountValue: BigInt(rule.discountValue) })));
                return <><p className="text-sm text-stone-400">Precio normal: {formatCurrency(priceForWeight(selectedProduct.pricePerKgCents, grams))}</p>{preview.discountCents > 0n ? <p className="mt-1 font-bold text-emerald-400">Descuento: -{formatCurrency(preview.discountCents)}</p> : null}<span className="mt-2 block text-sm text-stone-400">Total</span><strong className="block text-4xl font-black text-rose-400">{formatCurrency(preview.subtotalCents)}</strong></>;
              } catch { return <strong className="block text-4xl font-black text-rose-400">$ 0</strong>; } })()}
            </div>
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
