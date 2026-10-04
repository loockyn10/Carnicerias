const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface ProductCategoryFieldProps {
  categories: { id: string; name: string }[];
  /** Modo controlado (la ficha del producto). */
  value?: string;
  onChange?: (categoryId: string) => void;
  /** Modo no controlado (alta de producto): categoría inicial, "" = ninguna elegida. */
  defaultValue?: string;
  /** Texto de la opción vacía (alta de producto); sin él no hay opción vacía. */
  placeholder?: string;
}

/**
 * La categoría de un producto: UNA sola (`products.category_id`). No hay categorías adicionales: el servidor tampoco las admite
 * (product_category_assignments es sólo una proyección de esta categoría).
 */
export function ProductCategoryField({ categories, value, onChange, defaultValue, placeholder }: ProductCategoryFieldProps) {
  const binding = value !== undefined ? { value, onChange: (event: { target: { value: string } }) => onChange?.(event.target.value) } : { defaultValue: defaultValue ?? "" };
  return (
    <label className="grid gap-1 text-sm font-medium" data-testid="product-category-field">
      Categoría
      <select className={input} name="category_id" required {...binding}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
    </label>
  );
}
