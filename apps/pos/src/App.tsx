import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import {
  formatCurrency,
  formatWeight,
  parseWeightToGrams,
  priceForWeight,
  sumMoney
} from "@carnicerias/business-logic";
import type { PaymentMethod, TicketLine } from "@carnicerias/types";

import { supabase } from "./lib/supabase";

interface AuthUser {
  id: string;
  email: string;
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

    onAuthenticated({ id: data.user.id, email: data.user.email ?? email });
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
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [roleName, setRoleName] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
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

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const sessionUser = data.session?.user;
      setUser(
        sessionUser
          ? { id: sessionUser.id, email: sessionUser.email ?? sessionUser.id }
          : null
      );
      setAuthReady(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user;
      setUser(
        sessionUser
          ? { id: sessionUser.id, email: sessionUser.email ?? sessionUser.id }
          : null
      );
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setBranches([]);
      setBranchId("");
      setCatalog([]);
      setTicket([]);
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
      const firstBranch = visibleBranches[0];
      if (!firstBranch) throw new Error("No tenés una sucursal habilitada para operar");
      if (controller.signal.aborted) return;

      setRoleName(role?.name ?? "Operador");
      setBranches(visibleBranches);
      setBranchId((current) =>
        visibleBranches.some((branch) => branch.id === current) ? current : firstBranch.id
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
  }, [user]);

  useEffect(() => {
    if (!branchId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCategoryId("ALL");

    void (async () => {
      const { data, error: catalogError } = await supabase.rpc("get_pos_catalog", {
        p_branch_id: branchId
      });
        if (catalogError) throw catalogError;
        if (controller.signal.aborted) return;
        setCatalog(
          data.map((row) => ({
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
  }, [branchId]);

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
      const subtotal = priceForWeight(selectedProduct.pricePerKgCents, grams);
      const line: TicketLine = {
        id: editingLineId ?? crypto.randomUUID(),
        productId: selectedProduct.productId,
        productName: selectedProduct.productName,
        weightGrams: grams,
        pricePerKgCents: selectedProduct.pricePerKgCents,
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
    if (!branchId || ticket.length === 0) return;
    setLoading(true);
    setError(null);
    setNotice(null);

    const { data, error: saleError } = await supabase.rpc("complete_sale", {
      p_branch_id: branchId,
      p_items: ticket.map((line) => ({
        product_id: line.productId,
        weight_grams: line.weightGrams,
        expected_price_per_kg_cents: line.pricePerKgCents.toString()
      })),
      p_payment_method: paymentMethod
    });

    setLoading(false);
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
  }

  async function logout() {
    await supabase.auth.signOut();
    setUser(null);
  }

  if (!authReady) {
    return <main className="grid min-h-screen place-items-center bg-stone-950 text-stone-300">Cargando sesión…</main>;
  }

  if (!user) return <Login onAuthenticated={setUser} />;

  const activeBranch = branches.find((branch) => branch.id === branchId);

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-stone-800 bg-stone-900 px-5 py-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-400">POS online</p>
          <p className="text-lg font-black">{activeBranch?.name ?? "Seleccioná sucursal"}</p>
        </div>
        <div className="flex items-center gap-3">
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
          <div className="hidden text-right text-xs text-stone-400 sm:block">
            <p className="font-semibold text-stone-200">{roleName}</p>
            <p>{user.email}</p>
          </div>
          <button className="rounded-xl border border-stone-700 px-3 py-2 font-semibold hover:bg-stone-800" onClick={() => void logout()}>Salir</button>
        </div>
      </header>

      {error ? <div className="mx-4 mt-4 rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-red-100">{error}</div> : null}
      {notice ? <div className="mx-4 mt-4 rounded-xl border border-emerald-700 bg-emerald-950 px-4 py-3 text-emerald-100">{notice}</div> : null}

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
            <button className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-4 text-xl font-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40" disabled={loading || ticket.length === 0} onClick={() => void completeSale()}>
              {loading ? "Procesando…" : "Confirmar venta"}
            </button>
          </div>
        </aside>
      </div>

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
              <span className="text-sm text-stone-400">Subtotal</span>
              <strong className="block text-4xl font-black text-rose-400">
                {(() => {
                  try { return formatCurrency(priceForWeight(selectedProduct.pricePerKgCents, parseWeightToGrams(weightInput))); }
                  catch { return "$ 0"; }
                })()}
              </strong>
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
