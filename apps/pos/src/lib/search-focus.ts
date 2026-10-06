/** What the search box needs after a product is added: empty, and focused for the next one. */
export interface SearchFocusTarget {
  focus(): void;
}

/**
 * Called once a product has actually been added to the ticket (never while a weight/quantity/price modal is still
 * open). `schedule` defers to after React has committed the closing of that modal, so its unmount cannot steal the focus.
 */
export function resetSearchForNextProduct(
  clearSearch: () => void,
  getInput: () => SearchFocusTarget | null,
  schedule: (callback: () => void) => void
): void {
  clearSearch();
  schedule(() => getInput()?.focus());
}
